import type {
  AgentManifest,
  JsonObject,
  JsonValue,
  AgentConnectionBinding,
  ToolCall,
  ToolResult,
} from "@clearideas/agent-runtime-contracts";
import type {
  ConnectionCredentialProvider,
  ConnectionCredentialRequest,
  AgentTool,
  ToolAdapter,
  ToolExecutionContext,
} from "@clearideas/agent-runtime-core/ports";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpConnectionDefinition, AgentRuntimeConfig } from "./config.js";
import {
  resolveEnvironmentReference,
  resolveHeaders,
  resolveValueSource,
  type ValueResolutionContext,
} from "./values.js";

interface McpToolDescription {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

interface ResolvedToolBinding {
  runtimeName: string;
  toolName: string;
  connectionName: string;
  connection: McpConnectionDefinition;
  binding: AgentConnectionBinding;
}

export interface ConfiguredMcpToolAdapterOptions {
  credentialProvider?: ConnectionCredentialProvider;
  /** Applied to every MCP request. Defaults to fetch with redirects disabled. */
  fetch?: FetchLike;
  /** Throws to reject use of a configured connection by this agent. */
  authorizeConnection?: (input: {
    binding: AgentConnectionBinding;
    connection: McpConnectionDefinition;
  }) => void | Promise<void>;
  /** Throws to reject an individual model-requested tool call. */
  authorizeTool?: (
    input: {
      binding: AgentConnectionBinding;
      connection: McpConnectionDefinition;
      toolName: string;
      call: ToolCall;
    },
    context: ToolExecutionContext,
  ) => void | Promise<void>;
}

export class ConnectionAuthorizationRequiredError extends Error {
  readonly connectionRef: string;
  readonly authorizationUrl: string | undefined;

  constructor(connectionRef: string, authorizationUrl?: string) {
    super(`Connection "${connectionRef}" requires authorization.`);
    this.name = "ConnectionAuthorizationRequiredError";
    this.connectionRef = connectionRef;
    this.authorizationUrl = authorizationUrl;
  }
}

const withTimeout = async <T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${milliseconds}ms.`)),
          milliseconds,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const jsonValue = (value: unknown): JsonValue => {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
};

const inputSchema = (value: unknown): JsonObject => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return jsonValue(value) as JsonObject;
  }
  return { type: "object", properties: {}, additionalProperties: false };
};

const sanitizeToolPart = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || "tool";
};

const runtimeToolName = (alias: string, toolName: string): string =>
  `${sanitizeToolPart(alias)}__${sanitizeToolPart(toolName)}`.slice(0, 64);

const effectiveMode = (
  connection: McpConnectionDefinition,
  binding: AgentConnectionBinding,
): "read" | "read_write" => {
  if (connection.mode === "read") {
    if (binding.mode === "read_write") {
      throw new Error(
        `Connection "${binding.ref}" is read-only and cannot be elevated by an agent.`,
      );
    }
    return "read";
  }
  return binding.mode ?? connection.mode;
};

const allowedToolNames = (
  connection: McpConnectionDefinition,
  binding: AgentConnectionBinding,
  mode: "read" | "read_write",
): Set<string> | undefined => {
  const configured = new Set(connection.tools);
  const requested = binding.tools ? new Set(binding.tools) : undefined;
  const allowed = requested
    ? new Set([...requested].filter((name) => configured.has(name)))
    : configured;
  if (mode === "read") {
    const readTools = new Set(connection.readTools);
    return new Set([...allowed].filter((name) => readTools.has(name)));
  }
  return allowed;
};

const assertUrl = (value: string, connectionName: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Connection "${connectionName}" URL is invalid.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(
      `Connection "${connectionName}" must use HTTP or HTTPS without URL credentials.`,
    );
  }
  return url;
};

const connectionAuthType = (definition: McpConnectionDefinition): string =>
  definition.auth?.type ?? (definition.bearerToken ? "bearer" : "none");

const credentialRequest = (
  name: string,
  definition: McpConnectionDefinition,
  context: Partial<
    Pick<ToolExecutionContext, "runId" | "stepId" | "signal">
  > = {},
  forceRefresh = false,
): ConnectionCredentialRequest => ({
  connectionRef: name,
  authType: connectionAuthType(definition),
  ...(definition.auth?.type === "oauth" && definition.auth.profile
    ? { credentialProfile: definition.auth.profile }
    : {}),
  ...(context.runId ? { runId: context.runId } : {}),
  ...(context.stepId ? { stepId: context.stepId } : {}),
  ...(forceRefresh ? { forceRefresh: true } : {}),
  ...(context.signal ? { signal: context.signal } : {}),
});

const isUnauthorizedError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (
    value.name === "UnauthorizedError" ||
    value.status === 401 ||
    value.statusCode === 401 ||
    value.code === 401
  ) {
    return true;
  }
  const message =
    typeof value.message === "string" ? value.message.toLowerCase() : "";
  return (
    message.includes("unauthorized") ||
    message.includes("invalid_token") ||
    message.includes("invalid access token") ||
    message.includes("expired access token") ||
    message.includes("access token expired")
  );
};

const isUnauthorizedResult = (result: unknown): boolean => {
  if (
    !result ||
    typeof result !== "object" ||
    (result as { isError?: unknown }).isError !== true
  ) {
    return false;
  }
  const serialized = JSON.stringify(result).toLowerCase();
  return (
    serialized.includes("unauthorized") ||
    serialized.includes("invalid_token") ||
    serialized.includes("invalid access token") ||
    serialized.includes("expired access token") ||
    serialized.includes("access token expired")
  );
};

const createClient = async (
  name: string,
  definition: McpConnectionDefinition,
  context: ValueResolutionContext,
  options: {
    credentialProvider?: ConnectionCredentialProvider;
    clientCredentialsProvider?: OAuthClientProvider;
    fetch?: FetchLike;
    executionContext?: Partial<
      Pick<ToolExecutionContext, "runId" | "stepId" | "signal">
    >;
    forceRefresh?: boolean;
  } = {},
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
  const url = assertUrl(
    resolveValueSource(definition.url, context, `Connection ${name} URL`),
    name,
  );
  const headers = resolveHeaders(definition.headers, context) ?? {};
  if (definition.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${resolveEnvironmentReference(
      definition.auth.token,
      context,
      `Connection ${name}`,
    )}`;
  } else if (definition.bearerToken) {
    headers.Authorization = `Bearer ${resolveEnvironmentReference(
      definition.bearerToken,
      context,
      `Connection ${name}`,
    )}`;
  } else if (definition.auth?.type === "oauth") {
    if (!options.credentialProvider) {
      throw new Error(
        `Connection "${name}" requires a ConnectionCredentialProvider.`,
      );
    }
    const request = credentialRequest(
      name,
      definition,
      options.executionContext,
      options.forceRefresh,
    );
    const credential = await options.credentialProvider.getCredential(request);
    if (credential.status === "authorization_required") {
      throw new ConnectionAuthorizationRequiredError(
        name,
        credential.authorizationUrl,
      );
    }
    if (credential.status === "unavailable") {
      throw new Error(
        credential.message ||
          `Connection "${name}" credentials are unavailable.`,
      );
    }
    Object.assign(headers, credential.headers);
  }
  const client = new Client({ name: "agent-runtime", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    ...(options.clientCredentialsProvider
      ? { authProvider: options.clientCredentialsProvider }
      : {}),
    ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
    fetch:
      options.fetch ??
      ((input, init) =>
        globalThis.fetch(input, { ...init, redirect: "error" })),
  });
  return { client, transport };
};

const closeClient = async (client: Client): Promise<void> => {
  await client.close().catch(() => undefined);
};

export class ConfiguredMcpToolAdapter implements ToolAdapter {
  readonly #config: AgentRuntimeConfig;
  readonly #bindings: AgentConnectionBinding[];
  readonly #context: ValueResolutionContext;
  readonly #options: ConfiguredMcpToolAdapterOptions;
  readonly #clientCredentialsProviders = new Map<string, OAuthClientProvider>();
  #resolvedTools = new Map<string, ResolvedToolBinding>();

  constructor(
    config: AgentRuntimeConfig,
    bindings: AgentConnectionBinding[],
    context: ValueResolutionContext = {},
    options: ConfiguredMcpToolAdapterOptions = {},
  ) {
    this.#config = config;
    this.#bindings = bindings;
    this.#context = context;
    this.#options = options;
  }

  async listTools(): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];
    const resolved = new Map<string, ResolvedToolBinding>();

    for (const binding of this.#bindings) {
      const connection = this.#config.connections[binding.ref];
      if (!connection) {
        if (binding.required !== false)
          throw new Error(`Unknown connection "${binding.ref}".`);
        continue;
      }
      try {
        await this.#options.authorizeConnection?.({ binding, connection });
        const result = (await this.#withClient(
          binding.ref,
          connection,
          {},
          false,
          async (client) =>
            await withTimeout(
              client.listTools(),
              connection.connectTimeoutMs,
              `Connection ${binding.ref} tool discovery`,
            ),
        )) as { tools?: McpToolDescription[] };
        const mode = effectiveMode(connection, binding);
        const allowlist = allowedToolNames(connection, binding, mode);
        for (const tool of result.tools ?? []) {
          if (!tool.name || (allowlist && !allowlist.has(tool.name))) continue;
          const name = runtimeToolName(binding.alias ?? binding.ref, tool.name);
          if (resolved.has(name)) {
            throw new Error(
              `Connection tool name collision: ${name}. Use a distinct connection alias.`,
            );
          }
          resolved.set(name, {
            runtimeName: name,
            toolName: tool.name,
            connectionName: binding.ref,
            connection,
            binding,
          });
          tools.push({
            name,
            ...(tool.description || tool.title
              ? { description: tool.description ?? tool.title }
              : {}),
            inputSchema: inputSchema(tool.inputSchema),
            metadata: {
              connection: binding.ref,
              connectionAlias: binding.alias ?? binding.ref,
              sourceTool: tool.name,
              readOnly: tool.annotations?.readOnlyHint === true,
              destructive: tool.annotations?.destructiveHint === true,
            },
          });
        }
      } catch (error) {
        if (binding.required === true || connection.required === true)
          throw error;
      }
    }

    this.#resolvedTools = resolved;
    return tools;
  }

  async executeTool(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (this.#resolvedTools.size === 0) await this.listTools();
    const binding = this.#resolvedTools.get(call.name);
    if (!binding) {
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: "tool_not_allowed",
          message: `Tool "${call.name}" is not available.`,
        },
      };
    }
    try {
      await this.#options.authorizeTool?.(
        {
          binding: binding.binding,
          connection: binding.connection,
          toolName: binding.toolName,
          call,
        },
        context,
      );
    } catch {
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: "tool_not_authorized",
          message: `Tool "${call.name}" is not authorized for this run.`,
          retryable: false,
        },
      };
    }
    try {
      const result = await this.#withClient(
        binding.connectionName,
        binding.connection,
        context,
        false,
        async (client) => {
          const toolResult = await withTimeout(
            client.callTool({ name: binding.toolName, arguments: call.input }),
            binding.connection.toolTimeoutMs,
            `Tool ${call.name}`,
          );
          if (isUnauthorizedResult(toolResult)) {
            const error = new Error(
              `Connection "${binding.connectionName}" is unauthorized.`,
            );
            error.name = "UnauthorizedError";
            throw error;
          }
          return toolResult;
        },
      );
      if (result.isError) {
        return {
          callId: call.id,
          name: call.name,
          error: {
            code: "mcp_tool_error",
            message: `MCP tool "${call.name}" returned an error.`,
            details: { result: jsonValue(result) },
          },
        };
      }
      return {
        callId: call.id,
        name: call.name,
        output: jsonValue(result),
        metadata: {
          connection: binding.connectionName,
          sourceTool: binding.toolName,
        },
      };
    } catch (error) {
      if (error instanceof ConnectionAuthorizationRequiredError) {
        return {
          callId: call.id,
          name: call.name,
          error: {
            code: "connection_authorization_required",
            message: error.message,
            retryable: false,
          },
        };
      }
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: "mcp_tool_failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  }

  #clientCredentialsProvider(
    name: string,
    connection: McpConnectionDefinition,
  ): OAuthClientProvider | undefined {
    if (connection.auth?.type !== "client_credentials") return undefined;
    const existing = this.#clientCredentialsProviders.get(name);
    if (existing) return existing;
    const provider = new ClientCredentialsProvider({
      clientId: resolveEnvironmentReference(
        connection.auth.clientId,
        this.#context,
        `Connection ${name} client id`,
      ),
      clientSecret: resolveEnvironmentReference(
        connection.auth.clientSecret,
        this.#context,
        `Connection ${name} client secret`,
      ),
      ...(connection.auth.scopes?.length
        ? { scope: connection.auth.scopes.join(" ") }
        : {}),
    });
    this.#clientCredentialsProviders.set(name, provider);
    return provider;
  }

  async #withClient<T>(
    name: string,
    connection: McpConnectionDefinition,
    executionContext: Partial<
      Pick<ToolExecutionContext, "runId" | "stepId" | "signal">
    >,
    forceRefresh: boolean,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    let client: Client | undefined;
    try {
      const clientCredentialsProvider = this.#clientCredentialsProvider(
        name,
        connection,
      );
      const resources = await createClient(name, connection, this.#context, {
        ...this.#options,
        ...(clientCredentialsProvider ? { clientCredentialsProvider } : {}),
        executionContext,
        forceRefresh,
      });
      client = resources.client;
      await withTimeout(
        client.connect(resources.transport as never),
        connection.connectTimeoutMs,
        `Connection ${name}`,
      );
      return await operation(client);
    } catch (error) {
      if (
        !forceRefresh &&
        connection.auth?.type === "oauth" &&
        isUnauthorizedError(error) &&
        this.#options.credentialProvider
      ) {
        const request = credentialRequest(
          name,
          connection,
          executionContext,
          true,
        );
        await this.#options.credentialProvider.invalidateCredential?.({
          ...request,
          reason: "unauthorized",
        });
        return await this.#withClient(
          name,
          connection,
          executionContext,
          true,
          operation,
        );
      }
      throw error;
    } finally {
      if (client) await closeClient(client);
    }
  }
}

export const createConfiguredToolAdapter = (
  manifest: AgentManifest,
  config: AgentRuntimeConfig,
  context: ValueResolutionContext = {},
  options: ConfiguredMcpToolAdapterOptions = {},
): ToolAdapter | undefined => {
  if (!manifest.connections?.length) return undefined;
  return new ConfiguredMcpToolAdapter(
    config,
    manifest.connections,
    context,
    options,
  );
};
