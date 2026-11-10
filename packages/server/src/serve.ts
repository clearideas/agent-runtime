/**
 * `agent-runtime serve`: resolve the server configuration from a file, a
 * discovered file, or command-line options; start; and stop on a signal.
 */
import path from "node:path";

import { FileAgentManifestSource } from "@clearideas/agent-runtime-store-local";

import {
  defaultServedModelName,
  discoverServerConfigFile,
  loadServerConfig,
  SERVER_CONFIG_FILE_NAMES,
  singleManifestServerConfig,
  type InputSourceConfig,
  type LoadedServerConfig,
  type ServerConfig,
} from "./config.js";
import { listen } from "./http.js";
import type { HostRuntime } from "./host.js";
import { AgentServer, jsonLogger, type ServerLogger } from "./service.js";

export interface ServeOptions {
  /** Serve one manifest. Mutually exclusive with `serverConfig`. */
  manifest?: string;
  /** Server configuration file. Without it, one is discovered in `cwd`. */
  serverConfig?: string;
  /** Do not look for a server configuration file (single-manifest mode). */
  noServerConfig?: boolean;
  cwd?: string;
  host?: string;
  port?: number;
  /** Environment variable holding an API key that may use every model. */
  apiKeyEnv?: string;
  allowUnauthenticated?: boolean;
  servedModelName?: string;
  runtimeConfig?: string;
  runtimeModule?: string;
  input?: Record<string, InputSourceConfig>;
  output?: string;
  streamMode?: "auto" | "live" | "committed";
  progress?: "none" | "status";
  storeDriver?: "memory" | "sqlite";
  store?: string;
  ledger?: string;
  onUnrecognized?: "unsigned" | "reject" | "restart";
  clientTools?: "ignore" | "reject";
  maxConcurrentRuns?: number;
  requestTimeoutMs?: number;
  warmup?: boolean;
}

/** The environment variable read for an API key when none is named. */
export const DEFAULT_API_KEY_ENV = "AGENT_RUNTIME_API_KEY";

/**
 * Resolve the configuration `serve` would use, and notes worth telling the
 * operator. An explicit argument always beats a discovered file.
 */
export const resolveServeConfig = async (
  options: ServeOptions,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ loaded: LoadedServerConfig; notes: string[] }> => {
  const cwd = options.cwd ?? process.cwd();
  const notes: string[] = [];
  if (options.manifest && options.serverConfig) {
    throw new Error(
      "Serve either one manifest or a server configuration, not both.",
    );
  }

  let loaded: LoadedServerConfig;
  if (options.serverConfig) {
    loaded = await loadServerConfig(path.resolve(cwd, options.serverConfig));
  } else if (options.manifest) {
    if (!options.noServerConfig) {
      const discovered = await discoverServerConfigFile(cwd);
      if (discovered) {
        notes.push(
          `Ignoring ${path.basename(discovered)}: a manifest argument selects single-manifest mode.`,
        );
      }
    }
    const manifestFile = path.resolve(cwd, options.manifest);
    const manifest = await new FileAgentManifestSource(
      path.dirname(manifestFile),
      path.basename(manifestFile),
    ).loadManifest();
    const ledger = options.ledger
      ? parseLedgerOption(options.ledger, cwd)
      : undefined;
    loaded = singleManifestServerConfig({
      manifest: manifestFile,
      servedModelName:
        options.servedModelName ??
        defaultServedModelName(manifestFile, manifest.id),
      ...(options.runtimeConfig
        ? { runtimeConfig: path.resolve(cwd, options.runtimeConfig) }
        : {}),
      ...(options.runtimeModule
        ? { runtimeModule: path.resolve(cwd, options.runtimeModule) }
        : {}),
      ...(options.input ? { input: options.input } : {}),
      ...(options.output ? { output: options.output } : {}),
      ...(options.streamMode ? { streamMode: options.streamMode } : {}),
      ...(options.progress ? { progress: options.progress } : {}),
      ...(options.storeDriver
        ? {
            store: {
              driver: options.storeDriver,
              ...(options.store
                ? { path: path.resolve(cwd, options.store) }
                : {}),
            },
          }
        : {}),
      ...(ledger ? { ledger } : {}),
      ...(options.onUnrecognized
        ? { onUnrecognized: options.onUnrecognized }
        : {}),
      ...(options.clientTools ? { clientTools: options.clientTools } : {}),
    });
  } else {
    const discovered = await discoverServerConfigFile(cwd);
    if (!discovered) {
      throw new Error(
        `No server configuration found. Looked for ${SERVER_CONFIG_FILE_NAMES.join(", ")} in ${cwd}. Pass --server-config <file>, or serve one manifest: agent-runtime serve ./agent.yaml`,
      );
    }
    loaded = await loadServerConfig(discovered);
    notes.push(`Using ${discovered}.`);
  }

  if (
    options.manifest === undefined &&
    (options.servedModelName ||
      options.input ||
      options.output ||
      options.streamMode ||
      options.progress ||
      options.storeDriver ||
      options.ledger ||
      options.onUnrecognized ||
      options.clientTools)
  ) {
    throw new Error(
      "Model, store, and ledger options apply to single-manifest mode; set them in the server configuration file instead.",
    );
  }

  // Command-line overrides of the server section.
  const server = {
    ...loaded.config.server,
    ...(options.host ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.maxConcurrentRuns
      ? { maxConcurrentRuns: options.maxConcurrentRuns }
      : {}),
    ...(options.requestTimeoutMs
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options.allowUnauthenticated ? { allowUnauthenticated: true } : {}),
  };

  // An API key from the environment: always when named, otherwise only when
  // the configuration defines no keys.
  let apiKeys = loaded.config.auth.apiKeys;
  const keyEnv = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  if (options.apiKeyEnv && !environment[options.apiKeyEnv]) {
    throw new Error(
      `--api-key-env names ${options.apiKeyEnv}, which is not set.`,
    );
  }
  if (
    environment[keyEnv] &&
    (options.apiKeyEnv !== undefined || apiKeys.length === 0)
  ) {
    if (apiKeys.some((key) => key.id === "default")) {
      throw new Error(
        `The configuration already defines an API key with id "default"; remove it or omit --api-key-env.`,
      );
    }
    apiKeys = [
      ...apiKeys,
      { id: "default", key: { env: keyEnv }, models: "*" },
    ];
    notes.push(`Requiring the API key in ${keyEnv}.`);
  }

  // Host-level overrides that apply to a configuration file as well.
  const runtimeOverrides =
    options.manifest === undefined
      ? {
          ...(options.runtimeConfig
            ? { runtimeConfig: path.resolve(cwd, options.runtimeConfig) }
            : {}),
          ...(options.runtimeModule
            ? { runtimeModule: path.resolve(cwd, options.runtimeModule) }
            : {}),
        }
      : {};
  const config: ServerConfig = {
    ...loaded.config,
    ...runtimeOverrides,
    server,
    auth: { ...loaded.config.auth, apiKeys },
  };
  return { loaded: { ...loaded, config }, notes };
};

const parseLedgerOption = (
  value: string,
  cwd: string,
): { driver: "memory" } | { driver: "sqlite"; path: string } => {
  if (value === "memory") return { driver: "memory" };
  if (value.startsWith("sqlite:") && value.length > "sqlite:".length)
    return { driver: "sqlite", path: path.resolve(cwd, value.slice(7)) };
  throw new Error("--ledger must be memory or sqlite:<path>.");
};

export interface RunServeIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface RunServeHooks {
  /** Adapters supplied in code (embedding, tests). */
  runtime?: HostRuntime;
  logger?: ServerLogger;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Called once listening, with the base URL. */
  onListening?(url: string): void;
}

/**
 * Start serving and return when `signal` aborts, after a graceful shutdown.
 * With `check`, validate everything, print a summary, and return.
 */
export const runServe = async (
  options: ServeOptions & { check?: boolean },
  io: RunServeIo,
  signal: AbortSignal | undefined,
  hooks: RunServeHooks = {},
): Promise<void> => {
  const environment = hooks.environment ?? process.env;
  const { loaded, notes } = await resolveServeConfig(options, environment);
  for (const note of notes) io.stderr(`${note}\n`);
  const server = await AgentServer.create({
    loaded,
    environment,
    logger: hooks.logger ?? jsonLogger((line) => io.stderr(line)),
    ...(hooks.runtime ? { runtime: hooks.runtime } : {}),
    ...(options.warmup ? { warmup: true } : {}),
  });
  const summary = {
    models: server.models.map((model) => ({
      name: model.name,
      mode: model.mode,
      manifest: model.manifestFile,
      ...(model.mode === "conversation"
        ? {
            signaturesRequired: model.signaturesRequired,
            onUnrecognized: model.onUnrecognized,
          }
        : {
            input: model.input.map(
              (entry) => `${entry.variable}=${entry.source}`,
            ),
          }),
    })),
    authentication: server.authenticated ? "required" : "none",
  };
  if (options.check) {
    await server.shutdown(0);
    io.stdout(`${JSON.stringify({ valid: true, ...summary }, null, 2)}\n`);
    return;
  }
  if (signal?.aborted) {
    await server.shutdown(0);
    return;
  }
  const listening = await listen(server);
  io.stderr(
    `Agent Runtime server listening on ${listening.url}/v1 (${summary.models
      .map((model) => model.name)
      .join(", ")}; authentication ${summary.authentication})\n`,
  );
  hooks.onListening?.(listening.url);
  await new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  io.stderr("Shutting down: finishing active runs.\n");
  await listening.close();
};
