import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

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
});

export type McpConnectionDefinition = z.infer<
  typeof mcpConnectionDefinitionSchema
>;
export type ConnectionDefinition = McpConnectionDefinition;

export const agentRuntimeConfigSchema = z
  .strictObject({
    version: z.literal(AGENT_RUNTIME_CONFIG_SCHEMA_VERSION),
    providers: z.record(nameSchema, providerDefinitionSchema).default({}),
    models: z.record(nameSchema, configuredModelDefinitionSchema).default({}),
    connections: z
      .record(nameSchema, mcpConnectionDefinitionSchema)
      .default({}),
  })
  .superRefine((config, context) => {
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
  try {
    return parseAgentRuntimeConfig(parsed);
  } catch (error) {
    throw new Error(
      `Invalid Agent Runtime configuration ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const emptyAgentRuntimeConfig = (): AgentRuntimeConfig =>
  parseAgentRuntimeConfig({ version: AGENT_RUNTIME_CONFIG_SCHEMA_VERSION });
