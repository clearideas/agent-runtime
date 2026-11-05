import { readFile } from "node:fs/promises";
import path from "node:path";

import { WORKSPACE_MODES } from "@clearideas/agent-runtime-contracts";
import { resolveRunSandboxPolicy } from "@clearideas/agent-runtime-sandbox";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { mcpToolDigestPattern } from "./mcp-integrity.js";

export const AGENT_RUNTIME_CONFIG_SCHEMA_VERSION = "1.0" as const;

const nameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9-]*$/u);
const environmentNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const environmentReferenceSchema = z.strictObject({
  env: environmentNameSchema,
});

export const valueSourceSchema = z.union([
  z.string(),
  environmentReferenceSchema,
]);

export type EnvironmentReference = z.infer<typeof environmentReferenceSchema>;
export type ValueSource = z.infer<typeof valueSourceSchema>;

export const modelCapabilitiesSchema = z.strictObject({
  streaming: z.boolean().optional(),
  tools: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  imageInput: z.boolean().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const providerDefinitionSchema = z.strictObject({
  driver: z.enum([
    "openai",
    "anthropic",
    "google",
    "xai",
    "groq",
    "cohere",
    "openai-compatible",
  ]),
  baseURL: valueSourceSchema.optional(),
  apiKey: environmentReferenceSchema.optional(),
  headers: z.record(z.string(), environmentReferenceSchema).optional(),
  includeUsage: z.boolean().optional(),
  supportsStructuredOutputs: z.boolean().optional(),
});

export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;

export const configuredModelDefinitionSchema = z.strictObject({
  provider: nameSchema,
  model: z.string().min(1),
  options: z.record(z.string(), z.unknown()).optional(),
  capabilities: modelCapabilitiesSchema.optional(),
});

export type ConfiguredModelDefinition = z.infer<
  typeof configuredModelDefinitionSchema
>;

export const mcpConnectionAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("none"),
  }),
  z.strictObject({
    type: z.literal("bearer"),
    token: environmentReferenceSchema,
  }),
  z.strictObject({
    type: z.literal("oauth"),
    profile: nameSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("client_credentials"),
    clientId: environmentReferenceSchema,
    clientSecret: environmentReferenceSchema,
    scopes: z.array(z.string().trim().min(1)).optional(),
  }),
]);

export type McpConnectionAuth = z.infer<typeof mcpConnectionAuthSchema>;

/**
 * Host-approved tool metadata digests. When present, every tool the
 * connection exposes to a model must match its digest; an unpinned or
 * changed definition follows `onFailure`.
 */
export const mcpToolIntegritySchema = z.strictObject({
  digests: z.record(
    z.string().min(1),
    z
      .string()
      .regex(mcpToolDigestPattern, "Expected a sha256:<64 hex> tool digest."),
  ),
  onFailure: z.enum(["fail", "exclude"]).default("fail"),
});

export type McpToolIntegrity = z.infer<typeof mcpToolIntegritySchema>;

export const mcpConnectionDefinitionSchema = z.strictObject({
  driver: z.literal("mcp"),
  transport: z.literal("streamable-http").default("streamable-http"),
  url: valueSourceSchema,
  auth: mcpConnectionAuthSchema.optional(),
  /** @deprecated Use auth.type: bearer with auth.token. */
  bearerToken: environmentReferenceSchema.optional(),
  headers: z.record(z.string(), environmentReferenceSchema).optional(),
  mode: z.enum(["read", "read_write"]).default("read"),
  tools: z.array(z.string().min(1)).min(1),
  readTools: z.array(z.string().min(1)).default([]),
  required: z.boolean().default(false),
  connectTimeoutMs: z.number().int().positive().default(10_000),
  toolTimeoutMs: z.number().int().positive().default(30_000),
  toolIntegrity: mcpToolIntegritySchema.optional(),
});

export type McpConnectionDefinition = z.infer<
  typeof mcpConnectionDefinitionSchema
>;
export type ConnectionDefinition = McpConnectionDefinition;

const positiveIntegerSchema = z.number().int().positive().safe();
const commandNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);

export const workspaceDefinitionSchema = z.discriminatedUnion("driver", [
  z.strictObject({
    driver: z.literal("local"),
    /** Host directory; literal paths loaded from a file resolve against that file. */
    root: valueSourceSchema,
    mode: z.enum(WORKSPACE_MODES).default("read"),
    include: z.array(z.string().trim().min(1)).optional(),
    exclude: z.array(z.string().trim().min(1)).optional(),
    maxFiles: positiveIntegerSchema.optional(),
    maxFileBytes: positiveIntegerSchema.optional(),
    maxTotalBytes: positiveIntegerSchema.optional(),
    /** auto: bind read-only when the provider supports it; never: always stage a copy. */
    attach: z.enum(["auto", "never"]).default("never"),
  }),
  z.strictObject({
    /** The host supplies the store through composition options. */
    driver: z.literal("host"),
    mode: z.enum(WORKSPACE_MODES).default("read"),
    attach: z.enum(["auto", "never"]).default("never"),
  }),
]);

export type WorkspaceDefinition = z.infer<typeof workspaceDefinitionSchema>;

export const sandboxCommandDefinitionSchema = z
  .strictObject({
    description: z.string().optional(),
    argv: z.array(z.string().min(1)).min(1).optional(),
    program: z.string().min(1).optional(),
    args: z
      .strictObject({
        maxCount: z.number().int().nonnegative().optional(),
        allowPatterns: z.array(z.string().min(1)).optional(),
        denyPatterns: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    inputs: z.array(z.string().min(1)).optional(),
    workspaces: z.array(nameSchema).optional(),
    modes: z.array(z.enum(WORKSPACE_MODES)).min(1).optional(),
    timeoutMs: positiveIntegerSchema.optional(),
  })
  .refine((entry) => (entry.argv == null) !== (entry.program == null), {
    message: "A sandbox command requires exactly one of argv or program.",
  });

export type SandboxCommandDefinition = z.infer<
  typeof sandboxCommandDefinitionSchema
>;

export const sandboxLimitsSchema = z.strictObject({
  memoryMb: positiveIntegerSchema.optional(),
  cpuCount: z.number().positive().max(1024).optional(),
  processLimit: positiveIntegerSchema.optional(),
  workspaceTmpfsMb: positiveIntegerSchema.optional(),
  commandTimeoutMs: positiveIntegerSchema.optional(),
  maxCommandTimeoutMs: positiveIntegerSchema.optional(),
  maxCommandsPerRun: positiveIntegerSchema.optional(),
  maxTotalSandboxSeconds: positiveIntegerSchema.optional(),
  maxStdoutBytes: positiveIntegerSchema.optional(),
  maxStderrBytes: positiveIntegerSchema.optional(),
  maxArgs: positiveIntegerSchema.optional(),
  maxArgBytes: positiveIntegerSchema.optional(),
  maxTotalStagedBytes: positiveIntegerSchema.optional(),
  maxOutputFiles: positiveIntegerSchema.optional(),
  maxOutputBytes: positiveIntegerSchema.optional(),
});

export const sandboxDefinitionSchema = z
  .strictObject({
    /** docker and bubblewrap are created from configuration; host uses a SandboxProvider supplied by code. */
    driver: z.enum(["docker", "bubblewrap", "host"]),
    /** Container image for docker and host drivers. */
    image: z.string().min(1).optional(),
    /** Docker image allowlist; defaults to [image]. */
    allowedImages: z.array(z.string().min(1)).optional(),
    /** Host directories bound read-only by the bubblewrap driver. */
    binds: z.array(z.string().min(1)).optional(),
    helper: z
      .strictObject({
        command: z.array(z.string().min(1)).min(1).optional(),
        source: z
          .union([
            z.literal("bundled"),
            z.strictObject({ path: z.string().min(1) }),
          ])
          .optional(),
      })
      .optional(),
    limits: sandboxLimitsSchema.optional(),
    commands: z
      .record(commandNameSchema, sandboxCommandDefinitionSchema)
      .default({}),
    shell: z
      .strictObject({
        enabled: z.boolean().default(false),
        program: z.array(z.string().min(1)).min(1).optional(),
        timeoutMs: positiveIntegerSchema.optional(),
        modes: z.array(z.enum(WORKSPACE_MODES)).min(1).optional(),
      })
      .default({ enabled: false }),
    /** Environment variable names code steps may forward into the run sandbox. */
    allowedEnvironment: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u))
      .optional(),
  })
  .superRefine((sandbox, context) => {
    if (sandbox.driver === "docker" && !sandbox.image) {
      context.addIssue({
        code: "custom",
        message: "Docker sandboxes require an image.",
        path: ["image"],
      });
    }
    if (
      sandbox.driver === "docker" &&
      sandbox.image &&
      sandbox.allowedImages &&
      !sandbox.allowedImages.includes(sandbox.image)
    ) {
      context.addIssue({
        code: "custom",
        message: "The sandbox image must be included in allowedImages.",
        path: ["allowedImages"],
      });
    }
    try {
      resolveRunSandboxPolicy({
        commands: sandbox.commands,
        shell: sandbox.shell,
        ...(sandbox.limits ? { limits: sandbox.limits } : {}),
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
        path: ["commands"],
      });
    }
  });

export type SandboxDefinition = z.infer<typeof sandboxDefinitionSchema>;

export const agentRuntimeConfigSchema = z
  .strictObject({
    version: z.literal(AGENT_RUNTIME_CONFIG_SCHEMA_VERSION),
    providers: z.record(nameSchema, providerDefinitionSchema).default({}),
    models: z.record(nameSchema, configuredModelDefinitionSchema).default({}),
    connections: z
      .record(nameSchema, mcpConnectionDefinitionSchema)
      .default({}),
    workspaces: z.record(nameSchema, workspaceDefinitionSchema).default({}),
    sandbox: sandboxDefinitionSchema.optional(),
  })
  .superRefine((config, context) => {
    for (const [name, entry] of Object.entries(
      config.sandbox?.commands ?? {},
    )) {
      for (const workspace of entry.workspaces ?? []) {
        if (!config.workspaces[workspace]) {
          context.addIssue({
            code: "custom",
            message: `Sandbox command "${name}" references unknown workspace "${workspace}".`,
            path: ["sandbox", "commands", name, "workspaces"],
          });
        }
      }
    }
    for (const [name, model] of Object.entries(config.models)) {
      if (
        !config.providers[model.provider] &&
        !isBuiltInProviderName(model.provider)
      ) {
        context.addIssue({
          code: "custom",
          message: `Model "${name}" references unknown provider "${model.provider}".`,
          path: ["models", name, "provider"],
        });
      }
    }
    for (const [name, provider] of Object.entries(config.providers)) {
      if (provider.driver === "openai-compatible" && provider.baseURL == null) {
        context.addIssue({
          code: "custom",
          message: `OpenAI-compatible provider "${name}" requires baseURL.`,
          path: ["providers", name, "baseURL"],
        });
      }
    }
    for (const [name, connection] of Object.entries(config.connections)) {
      const allowedTools = new Set(connection.tools);
      for (const tool of connection.readTools) {
        if (!allowedTools.has(tool)) {
          context.addIssue({
            code: "custom",
            message: `Connection "${name}" readTools must be included in tools.`,
            path: ["connections", name, "readTools"],
          });
        }
      }
      for (const tool of Object.keys(connection.toolIntegrity?.digests ?? {})) {
        if (!allowedTools.has(tool)) {
          context.addIssue({
            code: "custom",
            message: `Connection "${name}" toolIntegrity.digests may only name tools included in tools.`,
            path: ["connections", name, "toolIntegrity", "digests", tool],
          });
        }
      }
      if (connection.mode === "read" && connection.readTools.length === 0) {
        context.addIssue({
          code: "custom",
          message: `Read-only connection "${name}" requires an explicit readTools allowlist.`,
          path: ["connections", name, "readTools"],
        });
      }
      if (connection.auth && connection.bearerToken) {
        context.addIssue({
          code: "custom",
          message: `Connection "${name}" cannot define both auth and bearerToken.`,
          path: ["connections", name, "auth"],
        });
      }
      if (
        connection.auth?.type !== undefined &&
        Object.keys(connection.headers ?? {}).some(
          (header) => header.toLowerCase() === "authorization",
        )
      ) {
        context.addIssue({
          code: "custom",
          message: `Connection "${name}" cannot define both auth and an Authorization header.`,
          path: ["connections", name, "headers"],
        });
      }
    }
  });

export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>;

const BUILT_IN_PROVIDER_DRIVERS = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  xai: "xai",
  grok: "xai",
  groq: "groq",
  cohere: "cohere",
} as const satisfies Record<string, ProviderDefinition["driver"]>;

export const isBuiltInProviderName = (
  name: string,
): name is keyof typeof BUILT_IN_PROVIDER_DRIVERS =>
  name in BUILT_IN_PROVIDER_DRIVERS;

export const builtInProviderDefinition = (
  name: string,
): ProviderDefinition | undefined => {
  if (!isBuiltInProviderName(name)) return undefined;
  return { driver: BUILT_IN_PROVIDER_DRIVERS[name] };
};

export const parseAgentRuntimeConfig = (input: unknown): AgentRuntimeConfig =>
  agentRuntimeConfigSchema.parse(input);

export const loadAgentRuntimeConfig = async (
  file: string,
): Promise<AgentRuntimeConfig> => {
  const absolute = path.resolve(file);
  const source = await readFile(absolute, "utf8");
  let parsed: unknown;
  try {
    parsed = absolute.endsWith(".json")
      ? JSON.parse(source)
      : parseYaml(source);
  } catch (error) {
    throw new Error(
      `Could not parse Agent Runtime configuration ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let config: AgentRuntimeConfig;
  try {
    config = parseAgentRuntimeConfig(parsed);
  } catch (error) {
    throw new Error(
      `Invalid Agent Runtime configuration ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return resolveConfigurationPaths(config, path.dirname(absolute));
};

/**
 * Resolve literal workspace roots and helper paths against the directory of
 * the configuration file they were loaded from. Environment references are
 * resolved later, at composition time.
 */
export const resolveConfigurationPaths = (
  config: AgentRuntimeConfig,
  baseDirectory: string,
): AgentRuntimeConfig => {
  const workspaces = Object.fromEntries(
    Object.entries(config.workspaces ?? {}).map(([name, definition]) => [
      name,
      definition.driver === "local" && typeof definition.root === "string"
        ? { ...definition, root: path.resolve(baseDirectory, definition.root) }
        : definition,
    ]),
  );
  const helperSource = config.sandbox?.helper?.source;
  const sandbox =
    config.sandbox && helperSource && typeof helperSource === "object"
      ? {
          ...config.sandbox,
          helper: {
            ...config.sandbox.helper,
            source: { path: path.resolve(baseDirectory, helperSource.path) },
          },
        }
      : config.sandbox;
  return {
    ...config,
    workspaces,
    ...(sandbox ? { sandbox } : {}),
  };
};

export const emptyAgentRuntimeConfig = (): AgentRuntimeConfig =>
  parseAgentRuntimeConfig({ version: AGENT_RUNTIME_CONFIG_SCHEMA_VERSION });
