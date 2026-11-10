/**
 * Server configuration: the operator-trusted description of what the server
 * exposes, to whom, and with which limits. Nothing here is ever read from a
 * request.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  agentRunExecutionSchema,
  executionPoliciesSchema,
} from "@clearideas/agent-runtime-contracts";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const SERVER_CONFIG_SCHEMA_VERSION = "1.0" as const;

/** Server configuration files discovered in the working directory, in order. */
export const SERVER_CONFIG_FILE_NAMES = [
  "agent-runtime.server.yaml",
  "agent-runtime.server.yml",
  "agent-runtime.server.json",
] as const;

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse `250ms`, `15s`, `5m`, `1h`, `7d`, or a number of milliseconds. */
export const parseDuration = (value: number | string): number => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Duration must be a positive integer of milliseconds.`);
    return value;
  }
  const match = /^(\d+)(ms|s|m|h|d)$/u.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${value}"; use a number of milliseconds or a value such as 500ms, 15s, 5m, 1h, or 7d.`,
    );
  }
  const milliseconds = Number(match[1]) * DURATION_UNITS[match[2]!]!;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
    throw new Error(`Duration "${value}" is out of range.`);
  return milliseconds;
};

const durationSchema = z
  .union([z.number(), z.string()])
  .transform((value, context) => {
    try {
      return parseDuration(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });

const positiveInteger = z.number().int().positive().safe();
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const storeName = z.string().regex(/^[a-z][a-z0-9-]*$/u);
const variableKey = z.string().min(1).max(100);

/** An OpenAI model id: letters, digits, and `.`, `_`, `-`, `:`, `/`. */
export const servedModelNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u,
    "Model names may contain letters, digits, and . _ - : / characters.",
  );

const keyValueStoreSchema = z.discriminatedUnion("driver", [
  z.strictObject({
    driver: z.literal("memory"),
    /** Upper bound on entries; the least recently used are evicted. */
    maxEntries: positiveInteger.default(100_000),
  }),
  z.strictObject({
    driver: z.literal("sqlite"),
    path: z.string().min(1),
  }),
]);
export type KeyValueStoreConfig = z.infer<typeof keyValueStoreSchema>;

/** Where one variable of a run gets its value from a chat request. */
const inputSourceSchema = z.union([
  z.enum(["last-user", "transcript", "system", "json", "client"]),
  z.strictObject({
    source: z.literal("last-user"),
  }),
  z.strictObject({
    source: z.literal("transcript"),
    /** Only the newest earlier messages. */
    maxMessages: positiveInteger.optional(),
  }),
  z.strictObject({
    source: z.literal("system"),
  }),
  z.strictObject({
    source: z.literal("json"),
    /** Field of the JSON object in the newest user message. Defaults to the variable's key. */
    key: z.string().min(1).optional(),
  }),
  z.strictObject({
    source: z.literal("client"),
    /** Field of the request's `variables` object. Defaults to the variable's key. */
    key: z.string().min(1).optional(),
  }),
]);

export type InputSourceConfig = z.infer<typeof inputSourceSchema>;

/** A normalized input mapping entry. */
export type InputMapping =
  | { variable: string; source: "last-user" }
  | { variable: string; source: "transcript"; maxMessages?: number }
  | { variable: string; source: "system" }
  | { variable: string; source: "json"; key: string }
  | { variable: string; source: "client"; key: string };

export const normalizeInputMapping = (
  variable: string,
  source: InputSourceConfig,
): InputMapping => {
  const value = typeof source === "string" ? { source } : source;
  switch (value.source) {
    case "json":
    case "client":
      return {
        variable,
        source: value.source,
        key: ("key" in value ? value.key : undefined) ?? variable,
      };
    case "transcript":
      return {
        variable,
        source: "transcript",
        ...("maxMessages" in value && value.maxMessages != null
          ? { maxMessages: value.maxMessages }
          : {}),
      };
    default:
      return { variable, source: value.source };
  }
};

const outputSchema = z.strictObject({
  /** `final`, `step:<id>`, or `variable:<name>`. Variable mode only. */
  from: z
    .string()
    .regex(
      /^(final|step:.+|variable:.+)$/u,
      "output.from must be final, step:<id>, or variable:<name>.",
    )
    .default("final"),
});

const streamSchema = z.strictObject({
  mode: z.enum(["auto", "live", "committed"]).default("auto"),
  progress: z.enum(["none", "status"]).default("none"),
  reasoning: z.enum(["none", "answer-step"]).default("none"),
  progressField: z
    .enum(["reasoning_content", "reasoning"])
    .default("reasoning_content"),
});

export const servedModelConfigSchema = z.strictObject({
  name: servedModelNameSchema,
  /** Path to the agent manifest, relative to the configuration file. */
  manifest: z.string().min(1),
  description: z.string().optional(),
  /** What happens to client system and developer messages. */
  clientInstructions: z
    .string()
    .regex(
      /^(drop|variable:.+)$/u,
      "clientInstructions must be drop or variable:<name>.",
    )
    .default("drop"),
  /** Run variables filled from the request, by variable key. */
  input: z.record(variableKey, inputSourceSchema).optional(),
  output: outputSchema.default({ from: "final" }),
  stream: streamSchema.default({
    mode: "auto",
    progress: "none",
    reasoning: "none",
    progressField: "reasoning_content",
  }),
  budget: z.strictObject({ maxTotalTokens: positiveInteger }).optional(),
  execution: agentRunExecutionSchema.optional(),
  policies: executionPoliciesSchema.optional(),
  enforcedPolicies: executionPoliciesSchema.optional(),
  /** What a client disconnect does to its run. */
  onDisconnect: z.enum(["cancel", "continue"]).default("cancel"),
  /** `budget` maps max_tokens to the run's token budget, capped by the host. */
  maxTokens: z.enum(["ignore", "budget"]).default("ignore"),
  /**
   * Client-defined tools are never exposed or executed. `ignore` drops them,
   * and client tool history, from the request (chat front ends such as Open
   * WebUI attach their own tools to every request); `reject` refuses them.
   */
  clientTools: z.enum(["ignore", "reject"]).default("ignore"),
});

export type ServedModelConfig = z.infer<typeof servedModelConfigSchema>;

const apiKeySchema = z.strictObject({
  /** Stable identifier used in logs, metrics, and the conversation scope. */
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  key: z.union([
    z.strictObject({ env: environmentName }),
    z.strictObject({
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/u, "sha256 must be 64 lowercase hex digits."),
    }),
  ]),
  /** Served model names this key may use, or `"*"` for all. */
  models: z.union([z.literal("*"), z.array(servedModelNameSchema).min(1)]),
  maxConcurrentRuns: positiveInteger.optional(),
  maxTotalTokensPerRequest: positiveInteger.optional(),
});

export type ApiKeyConfig = z.infer<typeof apiKeySchema>;

const serverSectionDefaults = {
  host: "127.0.0.1",
  port: 8000,
  maxRequestBytes: 20 * 1024 * 1024,
  requestTimeoutMs: 600_000,
  shutdownGraceMs: 30_000,
  heartbeatMs: 15_000,
  maxConcurrentRuns: 32,
  maxQueuedRequests: 64,
  queueTimeoutMs: 30_000,
  cors: { origins: [] as string[] },
  exposeErrors: false,
  allowUnauthenticated: false,
};

export const serverConfigSchema = z
  .strictObject({
    version: z.literal(SERVER_CONFIG_SCHEMA_VERSION),
    server: z
      .strictObject({
        host: z.string().min(1).default(serverSectionDefaults.host),
        port: z
          .number()
          .int()
          .min(0)
          .max(65_535)
          .default(serverSectionDefaults.port),
        maxRequestBytes: positiveInteger.default(
          serverSectionDefaults.maxRequestBytes,
        ),
        requestTimeoutMs: durationSchema.default(
          serverSectionDefaults.requestTimeoutMs,
        ),
        shutdownGraceMs: durationSchema.default(
          serverSectionDefaults.shutdownGraceMs,
        ),
        heartbeatMs: durationSchema.default(serverSectionDefaults.heartbeatMs),
        maxConcurrentRuns: positiveInteger.default(
          serverSectionDefaults.maxConcurrentRuns,
        ),
        maxQueuedRequests: z
          .number()
          .int()
          .nonnegative()
          .default(serverSectionDefaults.maxQueuedRequests),
        queueTimeoutMs: durationSchema.default(
          serverSectionDefaults.queueTimeoutMs,
        ),
        cors: z
          .strictObject({ origins: z.array(z.string().min(1)).default([]) })
          .default({ origins: [] }),
        exposeErrors: z.boolean().default(false),
        /** Required to serve without authentication on a non-loopback address. */
        allowUnauthenticated: z.boolean().default(false),
      })
      .default(serverSectionDefaults),
    /** Runtime configuration: providers, models, connections, workspaces, sandbox, messages. */
    runtimeConfig: z.string().min(1).optional(),
    /** Trusted runtime module supplying adapters and hooks. */
    runtimeModule: z.string().min(1).optional(),
    store: z
      .strictObject({
        driver: z.enum(["memory", "sqlite", "module"]).default("memory"),
        path: z.string().min(1).optional(),
        retention: z
          .strictObject({
            completed: durationSchema.default(86_400_000),
            failed: durationSchema.default(604_800_000),
          })
          .default({ completed: 86_400_000, failed: 604_800_000 }),
      })
      .default({
        driver: "memory",
        retention: { completed: 86_400_000, failed: 604_800_000 },
      }),
    artifacts: z
      .strictObject({ path: z.string().min(1).optional() })
      .default({}),
    /** Named key-value stores for server state. `default` is used unless another is named. */
    stores: z.record(storeName, keyValueStoreSchema).default({}),
    conversations: z
      .strictObject({
        ledger: z
          .strictObject({
            store: storeName.default("default"),
            ttl: durationSchema.default(2_592_000_000),
          })
          .default({ store: "default", ttl: 2_592_000_000 }),
        scope: z
          .strictObject({ includeUser: z.boolean().default(false) })
          .default({ includeUser: false }),
        match: z.enum(["exact", "user-turns"]).default("exact"),
        /** Defaults to `reject` when signatures are required, otherwise `unsigned`. */
        onUnrecognized: z.enum(["unsigned", "reject", "restart"]).optional(),
        onManifestChange: z.enum(["continue", "restart"]).default("continue"),
        media: z
          .strictObject({
            urls: z.enum(["reject", "allow"]).default("reject"),
            allowOrigins: z.array(z.url()).default([]),
          })
          .default({ urls: "reject", allowOrigins: [] }),
      })
      .default({
        ledger: { store: "default", ttl: 2_592_000_000 },
        scope: { includeUser: false },
        match: "exact",
        onManifestChange: "continue",
        media: { urls: "reject", allowOrigins: [] },
      }),
    auth: z
      .strictObject({ apiKeys: z.array(apiKeySchema).default([]) })
      .default({ apiKeys: [] }),
    models: z.array(servedModelConfigSchema).min(1),
  })
  .superRefine((config, context) => {
    const names = new Set<string>();
    config.models.forEach((model, index) => {
      if (names.has(model.name)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate served model name: ${model.name}`,
          path: ["models", index, "name"],
        });
      }
      names.add(model.name);
    });
    const ids = new Set<string>();
    config.auth.apiKeys.forEach((key, index) => {
      if (ids.has(key.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate API key id: ${key.id}`,
          path: ["auth", "apiKeys", index, "id"],
        });
      }
      ids.add(key.id);
      if (key.models !== "*") {
        key.models.forEach((model, modelIndex) => {
          if (!names.has(model)) {
            context.addIssue({
              code: "custom",
              message: `API key ${key.id} names unknown model ${model}.`,
              path: ["auth", "apiKeys", index, "models", modelIndex],
            });
          }
        });
      }
    });
    if (config.store.driver === "sqlite" && !config.store.path) {
      context.addIssue({
        code: "custom",
        message: "store.path is required for the sqlite store driver.",
        path: ["store", "path"],
      });
    }
    if (
      config.conversations.ledger.store !== "default" &&
      !config.stores[config.conversations.ledger.store]
    ) {
      context.addIssue({
        code: "custom",
        message: `conversations.ledger.store names unknown store "${config.conversations.ledger.store}".`,
        path: ["conversations", "ledger", "store"],
      });
    }
    if (
      config.conversations.media.urls === "allow" &&
      config.conversations.media.allowOrigins.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "conversations.media.urls: allow requires at least one allowOrigins entry.",
        path: ["conversations", "media", "allowOrigins"],
      });
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ServerConfigInput = z.input<typeof serverConfigSchema>;

export const parseServerConfig = (input: unknown): ServerConfig =>
  serverConfigSchema.parse(input);

const formatIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");

/**
 * Resolve paths in a configuration against the directory it was loaded
 * from, so a server file works wherever the server is started.
 */
export const resolveServerConfigPaths = (
  config: ServerConfig,
  baseDirectory: string,
): ServerConfig => {
  const resolve = (value: string): string => path.resolve(baseDirectory, value);
  return {
    ...config,
    ...(config.runtimeConfig
      ? { runtimeConfig: resolve(config.runtimeConfig) }
      : {}),
    ...(config.runtimeModule
      ? { runtimeModule: resolve(config.runtimeModule) }
      : {}),
    store: {
      ...config.store,
      ...(config.store.path ? { path: resolve(config.store.path) } : {}),
    },
    artifacts: {
      ...(config.artifacts.path
        ? { path: resolve(config.artifacts.path) }
        : {}),
    },
    stores: Object.fromEntries(
      Object.entries(config.stores).map(([name, store]) => [
        name,
        store.driver === "sqlite"
          ? { ...store, path: resolve(store.path) }
          : store,
      ]),
    ),
    models: config.models.map((model) => ({
      ...model,
      manifest: resolve(model.manifest),
    })),
  };
};

/** A loaded server configuration and where it came from. */
export interface LoadedServerConfig {
  config: ServerConfig;
  /** The file it was loaded from; undefined when built from command-line options. */
  file?: string;
  /** The directory relative paths and runtime-configuration discovery use. */
  baseDirectory: string;
}

/** Where a configuration file keeps durable state unless it says otherwise. */
export const SERVER_STATE_DIRECTORY = ".agent-runtime/serve";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/**
 * A configuration file describes a deployment, so what it leaves out is
 * durable: runs and server state (the conversation ledger and media index)
 * in SQLite, and stored media in a directory, all under
 * `.agent-runtime/serve` beside the file. Conversations and the media they
 * reference therefore survive restarts together.
 */
const withDurableDefaults = (input: unknown): unknown => {
  if (!isObject(input)) return input;
  const store = isObject(input.store) ? input.store : {};
  const stores = isObject(input.stores) ? input.stores : {};
  const artifacts = isObject(input.artifacts) ? input.artifacts : {};
  return {
    ...input,
    store:
      store.driver === undefined
        ? {
            ...store,
            driver: "sqlite",
            path: store.path ?? `${SERVER_STATE_DIRECTORY}/runs.sqlite`,
          }
        : store,
    stores: {
      ...stores,
      default: stores.default ?? {
        driver: "sqlite",
        path: `${SERVER_STATE_DIRECTORY}/state.sqlite`,
      },
    },
    artifacts: {
      ...artifacts,
      path: artifacts.path ?? `${SERVER_STATE_DIRECTORY}/artifacts`,
    },
  };
};

/** Load and validate a server configuration file (YAML or JSON). */
export const loadServerConfig = async (
  file: string,
): Promise<LoadedServerConfig> => {
  const absolute = path.resolve(file);
  let source: string;
  try {
    source = await readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Server configuration not found: ${absolute}`);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = absolute.endsWith(".json")
      ? JSON.parse(source)
      : parseYaml(source);
  } catch (error) {
    throw new Error(
      `Could not parse server configuration ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = serverConfigSchema.safeParse(withDurableDefaults(parsed));
  if (!result.success) {
    throw new Error(
      `Invalid server configuration ${absolute}: ${formatIssues(result.error)}`,
    );
  }
  const baseDirectory = path.dirname(absolute);
  return {
    config: resolveServerConfigPaths(result.data, baseDirectory),
    file: absolute,
    baseDirectory,
  };
};

/** The first discovered server configuration file in a directory, if any. */
export const discoverServerConfigFile = async (
  directory: string,
): Promise<string | undefined> => {
  for (const name of SERVER_CONFIG_FILE_NAMES) {
    const candidate = path.resolve(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
};

/** Command-line options for serving one manifest without a configuration file. */
export interface SingleManifestOptions {
  manifest: string;
  servedModelName?: string;
  runtimeConfig?: string;
  runtimeModule?: string;
  input?: Record<string, InputSourceConfig>;
  output?: string;
  streamMode?: "auto" | "live" | "committed";
  progress?: "none" | "status";
  store?: { driver: "memory" | "sqlite"; path?: string };
  ledger?: { driver: "memory" } | { driver: "sqlite"; path: string };
  onUnrecognized?: "unsigned" | "reject" | "restart";
  clientTools?: "ignore" | "reject";
}

/** The served model name a manifest gets when none is given: its id, else the file name. */
export const defaultServedModelName = (
  manifestFile: string,
  manifestId?: string,
): string => {
  if (manifestId && servedModelNameSchema.safeParse(manifestId).success)
    return manifestId;
  const base = path
    .basename(manifestFile)
    .replace(/\.(agent\.)?(ya?ml|json)$/iu, "")
    .replace(/[^A-Za-z0-9._:/-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "");
  return base || "agent";
};

/**
 * Build a one-model configuration from command-line options. Single-manifest
 * mode keeps runs, the ledger, and stored media for the life of the process
 * unless told otherwise; a SQLite ledger keeps stored media beside it, so
 * conversations and their media survive restarts together.
 */
export const singleManifestServerConfig = (
  options: SingleManifestOptions & { servedModelName: string },
): LoadedServerConfig => {
  const manifest = path.resolve(options.manifest);
  const baseDirectory = path.dirname(manifest);
  const ledgerStore: KeyValueStoreConfig =
    options.ledger?.driver === "sqlite"
      ? { driver: "sqlite", path: path.resolve(options.ledger.path) }
      : { driver: "memory", maxEntries: 100_000 };
  const config = parseServerConfig({
    version: SERVER_CONFIG_SCHEMA_VERSION,
    ...(options.runtimeConfig
      ? { runtimeConfig: path.resolve(options.runtimeConfig) }
      : {}),
    ...(options.runtimeModule
      ? { runtimeModule: path.resolve(options.runtimeModule) }
      : {}),
    store: {
      driver: options.store?.driver ?? "memory",
      ...(options.store?.path
        ? { path: path.resolve(options.store.path) }
        : {}),
    },
    stores: { default: ledgerStore },
    ...(ledgerStore.driver === "sqlite"
      ? {
          artifacts: {
            path: path.join(path.dirname(ledgerStore.path), "artifacts"),
          },
        }
      : {}),
    conversations: {
      ...(options.onUnrecognized
        ? { onUnrecognized: options.onUnrecognized }
        : {}),
    },
    models: [
      {
        name: options.servedModelName,
        manifest,
        ...(options.input ? { input: options.input } : {}),
        ...(options.output ? { output: { from: options.output } } : {}),
        stream: {
          ...(options.streamMode ? { mode: options.streamMode } : {}),
          ...(options.progress ? { progress: options.progress } : {}),
        },
        ...(options.clientTools ? { clientTools: options.clientTools } : {}),
      },
    ],
  });
  return { config, baseDirectory };
};
