import { randomUUID } from "node:crypto";

import type {
  AgentManifest,
  AgentWorkspaceBinding,
  JsonObject,
  JsonValue,
  ToolCall,
  ToolResult,
} from "@clearideas/agent-runtime-contracts";
import { resolveAgentWorkspaces } from "@clearideas/agent-runtime-core";
import type {
  AgentTool,
  ResolvedWorkspace,
  RunSandboxCommandResult,
  RunSandboxProvider,
  RunSandboxSession,
  ToolAdapter,
  ToolExecutionContext,
  WorkspaceProvider,
} from "@clearideas/agent-runtime-core/ports";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

const RUN_META_KEY = "agent-runtime/call";
const BUILTIN_NAMES = new Set([
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "delete_file",
]);

const sanitizeToolPart = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || "tool";
};

export const workspaceToolName = (alias: string, toolName: string): string =>
  `${sanitizeToolPart(alias)}__${sanitizeToolPart(toolName)}`.slice(0, 64);

const toolKind = (tool: AgentTool): "builtin" | "command" | "shell" => {
  const kind = tool.metadata?.kind;
  if (kind === "builtin" || kind === "command" || kind === "shell") return kind;
  if (BUILTIN_NAMES.has(tool.name)) return "builtin";
  return tool.name === "shell" ? "shell" : "command";
};

export interface WorkspaceToolAdapterOptions {
  /** Throws to reject use of a workspace by this agent. */
  authorizeWorkspace?: (input: {
    binding: AgentWorkspaceBinding;
    workspace: ResolvedWorkspace;
  }) => void | Promise<void>;
  /** Throws to reject an individual model-requested tool call before it reaches the sandbox. */
  authorizeTool?: (
    input: {
      binding: AgentWorkspaceBinding;
      workspace: ResolvedWorkspace;
      toolName: string;
      call: ToolCall;
    },
    context: ToolExecutionContext,
  ) => void | Promise<void>;
}

interface PendingCall {
  session: RunSandboxSession;
  context: ToolExecutionContext;
  call: ToolCall;
  result?: RunSandboxCommandResult;
  failure?: { code: string; message: string };
}

interface WorkspaceRelay {
  workspace: ResolvedWorkspace;
  tools: AgentTool[];
  server: Server;
  client: Client;
}

interface ResolvedTool {
  runtimeName: string;
  toolName: string;
  kind: "builtin" | "command" | "shell";
  relay: WorkspaceRelay;
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.length > 0
    ? code
    : "sandbox_command_failed";
};

/**
 * Exposes manifest-bound workspaces to models as MCP tools. Each binding is
 * served by an in-process MCP server that relays every call to the run
 * sandbox session for the current run: the server holds no policy, touches no
 * workspace content, and only forwards the validated request. Tool names are
 * prefixed with the workspace alias.
 */
export class WorkspaceToolAdapter implements ToolAdapter {
  readonly #manifest: AgentManifest;
  readonly #workspaces: WorkspaceProvider;
  readonly #runSandbox: RunSandboxProvider;
  readonly #options: WorkspaceToolAdapterOptions;
  readonly #pending = new Map<string, PendingCall>();
  #relays: Promise<WorkspaceRelay[]> | undefined;
  #resolvedTools = new Map<string, ResolvedTool>();

  constructor(
    manifest: AgentManifest,
    workspaces: WorkspaceProvider,
    runSandbox: RunSandboxProvider,
    options: WorkspaceToolAdapterOptions = {},
  ) {
    this.#manifest = manifest;
    this.#workspaces = workspaces;
    this.#runSandbox = runSandbox;
    this.#options = options;
  }

  async listTools(): Promise<AgentTool[]> {
    const relays = await this.#connect();
    const tools: AgentTool[] = [];
    const resolved = new Map<string, ResolvedTool>();
    for (const relay of relays) {
      const listed = await relay.client.listTools();
      for (const tool of listed.tools) {
        const source = relay.tools.find(
          (candidate) => candidate.name === tool.name,
        );
        if (!source) continue;
        const name = workspaceToolName(relay.workspace.alias, tool.name);
        if (resolved.has(name)) {
          throw new Error(
            `Workspace tool name collision: ${name}. Use a distinct workspace alias.`,
          );
        }
        resolved.set(name, {
          runtimeName: name,
          toolName: tool.name,
          kind: toolKind(source),
          relay,
        });
        tools.push({
          name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: JSON.parse(
            JSON.stringify(tool.inputSchema),
          ) as JsonObject,
          metadata: {
            workspace: relay.workspace.binding.ref,
            workspaceAlias: relay.workspace.alias,
            workspaceMode: relay.workspace.mode,
            sourceTool: tool.name,
            kind: toolKind(source),
            readOnly: source.metadata?.readOnly === true,
            destructive: source.metadata?.destructive === true,
            sandboxed: true,
          },
        });
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
    const tool = this.#resolvedTools.get(call.name);
    if (!tool) {
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: "tool_not_allowed",
          message: `Tool "${call.name}" is not available.`,
        },
      };
    }
    const { workspace } = tool.relay;
    try {
      await this.#options.authorizeTool?.(
        {
          binding: workspace.binding,
          workspace,
          toolName: tool.toolName,
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
    if (!context.runSandbox) {
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: "sandbox_unavailable",
          message:
            "This run has no run sandbox; workspace tools cannot execute.",
          retryable: false,
        },
      };
    }
    let session: RunSandboxSession;
    try {
      session = await context.runSandbox();
    } catch (error) {
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: "sandbox_unavailable",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }
    const token = randomUUID();
    const pending: PendingCall = { session, context, call };
    this.#pending.set(token, pending);
    try {
      const mcpResult = (await tool.relay.client.callTool(
        {
          name: tool.toolName,
          arguments: call.input,
          _meta: { [RUN_META_KEY]: token },
        },
        undefined,
        context.signal ? { signal: context.signal } : undefined,
      )) as CallToolResult;
      const metadata: JsonObject = {
        workspace: workspace.binding.ref,
        workspaceAlias: workspace.alias,
        sourceTool: tool.toolName,
        ...(pending.result
          ? {
              command: JSON.parse(
                JSON.stringify(pending.result.record),
              ) as JsonValue,
            }
          : {}),
      };
      if (mcpResult.isError || pending.failure) {
        const failure = pending.failure ?? {
          code: "sandbox_command_failed",
          message: textOf(mcpResult) || "Workspace tool failed.",
        };
        return {
          callId: call.id,
          name: call.name,
          error: {
            code: failure.code,
            message: failure.message,
            retryable: false,
          },
          metadata,
        };
      }
      const output =
        pending.result?.output ??
        (mcpResult.structuredContent != null
          ? (JSON.parse(
              JSON.stringify(mcpResult.structuredContent),
            ) as JsonValue)
          : (textOf(mcpResult) ?? null));
      return {
        callId: call.id,
        name: call.name,
        output,
        ...(pending.result?.artifacts?.length
          ? { artifacts: pending.result.artifacts }
          : {}),
        metadata,
      };
    } catch (error) {
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: errorCode(error),
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    } finally {
      this.#pending.delete(token);
    }
  }

  /** Disconnect every in-process MCP relay. */
  async close(): Promise<void> {
    const relays = this.#relays ? await this.#relays.catch(() => []) : [];
    this.#relays = undefined;
    this.#resolvedTools = new Map();
    for (const relay of relays) {
      await relay.client.close().catch(() => undefined);
      await relay.server.close().catch(() => undefined);
    }
  }

  #connect(): Promise<WorkspaceRelay[]> {
    if (this.#relays) return this.#relays;
    this.#relays = (async () => {
      const workspaces = await resolveAgentWorkspaces(
        this.#manifest,
        this.#workspaces,
      );
      const relays: WorkspaceRelay[] = [];
      try {
        for (const workspace of workspaces) {
          await this.#options.authorizeWorkspace?.({
            binding: workspace.binding,
            workspace,
          });
          const tools = await this.#runSandbox.tools(workspace);
          const server = this.#createServer(workspace, tools);
          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport);
          const client = new Client({
            name: "agent-runtime",
            version: "0.1.0",
          });
          await client.connect(clientTransport);
          relays.push({ workspace, tools, server, client });
        }
      } catch (error) {
        for (const relay of relays) {
          await relay.client.close().catch(() => undefined);
          await relay.server.close().catch(() => undefined);
        }
        throw error;
      }
      return relays;
    })();
    this.#relays.catch(() => {
      this.#relays = undefined;
    });
    return this.#relays;
  }

  #createServer(workspace: ResolvedWorkspace, tools: AgentTool[]): Server {
    const server = new Server(
      { name: `agent-runtime-workspace-${workspace.alias}`, version: "0.1.0" },
      {
        capabilities: { tools: {} },
        instructions: `Workspace "${workspace.alias}" (${workspace.mode}). Paths are relative POSIX paths. Every call executes as one command in the run sandbox.`,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as {
          type: "object";
          [key: string]: unknown;
        },
        annotations: {
          readOnlyHint: tool.metadata?.readOnly === true,
          destructiveHint: tool.metadata?.destructive === true,
        },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const token = request.params._meta?.[RUN_META_KEY];
      const pending =
        typeof token === "string" ? this.#pending.get(token) : undefined;
      const tool = tools.find(
        (candidate) => candidate.name === request.params.name,
      );
      if (!pending || !tool) {
        return {
          content: [
            {
              type: "text",
              text: "Tool call is not associated with an active run.",
            },
          ],
          isError: true,
        } satisfies CallToolResult;
      }
      try {
        const result = await pending.session.execute({
          stepId: pending.context.stepId,
          toolCallId: pending.call.id,
          ...(pending.context.idempotencyKey
            ? { idempotencyKey: pending.context.idempotencyKey }
            : {}),
          alias: workspace.alias,
          kind: toolKind(tool),
          name: request.params.name,
          arguments: (request.params.arguments ?? {}) as JsonObject,
          ...(extra.signal ? { signal: extra.signal } : {}),
        });
        pending.result = result;
        const structured =
          result.output != null &&
          typeof result.output === "object" &&
          !Array.isArray(result.output)
            ? (result.output as JsonObject)
            : { output: result.output ?? null };
        return {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
        } satisfies CallToolResult;
      } catch (error) {
        pending.failure = {
          code: errorCode(error),
          message: error instanceof Error ? error.message : String(error),
        };
        return {
          content: [{ type: "text", text: pending.failure.message }],
          isError: true,
        } satisfies CallToolResult;
      }
    });
    return server;
  }
}

const textOf = (result: CallToolResult): string | undefined => {
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  return text || undefined;
};

export const createConfiguredWorkspaceToolAdapter = (
  manifest: AgentManifest,
  workspaces: WorkspaceProvider | undefined,
  runSandbox: RunSandboxProvider | undefined,
  options: WorkspaceToolAdapterOptions = {},
): ToolAdapter | undefined => {
  if (!manifest.workspaces?.length || !workspaces || !runSandbox)
    return undefined;
  return new WorkspaceToolAdapter(manifest, workspaces, runSandbox, options);
};
