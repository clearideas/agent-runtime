import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentManifest,
  ConversationMessage,
  JsonObject,
  JsonValue,
  MessagesSignature,
  RunEvent,
  RunResult,
} from "@clearideas/agent-runtime-contracts";
import {
  messagesSignatureSchema,
  parseAgentVariableOverrides,
  parseConversationMessages,
} from "@clearideas/agent-runtime-contracts";
import {
  AgentRuntime,
  type EventSink,
  type RunStore,
} from "@clearideas/agent-runtime-core";
import {
  EXECUTION_PROTOCOL_VERSION,
  parseWorkerInvocation,
  serializeWorkerMessage,
  type ExecutionRequest,
  type WorkerInvocation,
  type WorkerMessage,
} from "@clearideas/agent-runtime-execution";
import {
  discoverMcpConnectionTools,
  loadAgentRuntimeConfig,
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
  type ConfiguredMcpToolAdapterOptions,
  type McpDiscoveredTool,
  type ModelAuthorizationPolicy,
  validateRuntimeConfiguration,
  type WorkspaceCompositionOptions,
} from "@clearideas/agent-runtime-config";
import {
  composeHostRuntime,
  hostRuntimeDependencies,
  loadHostRunStore,
  loadHostRuntime,
  resolveAgentRuntimeConfig,
  runServe,
  validateHostRuntime,
  type HostRuntime,
  type HostRuntimeModule,
  type InputSourceConfig,
  type ServeOptions,
} from "@clearideas/agent-runtime-server";
import {
  FileArtifactStore,
  FileAgentManifestSource,
  FileAgentRunManifestSource,
  FileRunStore,
  JsonlEventSink,
} from "@clearideas/agent-runtime-store-local";
import {
  Document as YamlDocument,
  YAMLMap,
  isPair,
  isScalar,
  parse as parseYamlDocument,
} from "yaml";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const usage = `Clear Ideas Agent Runtime

Usage:
  agent-runtime validate <manifest.json|manifest.yaml> [--config <config.yaml>]
  agent-runtime config validate <config.json|config.yaml>
  agent-runtime connections inspect <config.json|config.yaml> [--connection <name>] [--runtime-module <local-js-file>] [--format <json|yaml>]
  agent-runtime run <manifest.json|manifest.yaml> [--variables <overrides.json>] [--messages <messages.json|messages.yaml>] [--messages-scope <scope>] [--messages-out <file>] [--max-total-tokens <count>] [--config <config.yaml>] [--run-id <id>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-js-file>] [--stream] [--format <json|pretty|ndjson>] [--show-reasoning]
  agent-runtime run-manifest <run.json|run.yaml> [--messages-scope <scope>] [--messages-out <file>] [--config <config.yaml>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-js-file>] [--stream] [--format <json|pretty|ndjson>] [--show-reasoning]
  agent-runtime resume <run-id> [--max-total-tokens <count>] [--config <config.yaml>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-js-file>] [--stream] [--format <json|pretty|ndjson>] [--show-reasoning]
  agent-runtime inspect <run-id> [--store <path>] [--store-driver <file|sqlite>] [--runtime-module <local-js-file>]
  agent-runtime events <events.jsonl> [--run <run-id>] [--type <event-type>] [--tail <count>]
  agent-runtime examples list
  agent-runtime examples show <variables|conditions|loops>
  agent-runtime examples run <variables|conditions|loops> [run options]
  agent-runtime worker [--store <path>] [--store-driver <file|sqlite>] [--config <config.yaml>] [--runtime-module <local-js-file>]
  agent-runtime serve [<manifest>] [--server-config <server.yaml>] [--no-server-config] [--served-model-name <name>] [--config <runtime.yaml>] [--runtime-module <local-js-file>] [--host <host>] [--port <port>] [--api-key-env <VAR>] [--allow-unauthenticated] [--input <variable>=<source>]... [--output <final|step:id|variable:name>] [--stream-mode <auto|live|committed>] [--progress <none|status>] [--store-driver <memory|sqlite>] [--store <path>] [--ledger <memory|sqlite:path>] [--on-unrecognized <unsigned|reject|restart>] [--client-tools <ignore|reject>] [--max-concurrent-runs <count>] [--request-timeout <ms>] [--warmup] [--check]

Options accept --name value or --name=value.
`;

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const bundledExamplesDirectory = path.join(packageDirectory, "examples");
const exampleCatalog = {
  variables: {
    file: "variables.agent.yaml",
    description: "Variables, nested values, system prompts, and step outputs.",
  },
  conditions: {
    file: "conditions.agent.yaml",
    description:
      "Conditional step execution using variables and prior outputs.",
  },
  loops: {
    file: "loops.agent.yaml",
    description: "A filtered collection loop with scoped item variables.",
  },
} as const;

type ExampleName = keyof typeof exampleCatalog;

const isExampleName = (value: string): value is ExampleName =>
  value in exampleCatalog;

interface ParsedOptions {
  positional: string[];
  options: Map<string, string>;
  /** Every value of a repeatable option, in order. */
  repeated: Map<string, string[]>;
}

export type CliStoreDriver = "file" | "sqlite";

interface ResolvedCliStoreLocation {
  driver: CliStoreDriver;
  location: string;
  baseDirectory: string;
}

interface ResolvedCliStore extends ResolvedCliStoreLocation {
  store: RunStore;
  close(): void;
}

const resolveCliStoreLocation = (
  parsed: ParsedOptions,
  workerMode = false,
): ResolvedCliStoreLocation => {
  const requestedDriver = parsed.options.get("store-driver") ?? "file";
  if (requestedDriver !== "file" && requestedDriver !== "sqlite") {
    throw new Error("--store-driver must be file or sqlite.");
  }
  const driver = requestedDriver as CliStoreDriver;
  const defaultLocation = workerMode
    ? ".agent-runtime-worker"
    : ".agent-runtime";
  const location = path.resolve(
    parsed.options.get("store") ??
      (driver === "sqlite"
        ? path.join(defaultLocation, "runs.sqlite")
        : defaultLocation),
  );
  return {
    driver,
    location,
    baseDirectory: driver === "sqlite" ? path.dirname(location) : location,
  };
};

const resolveCliStore = async (
  parsed: ParsedOptions,
): Promise<ResolvedCliStore> => {
  const resolved = resolveCliStoreLocation(parsed);
  const store =
    resolved.driver === "sqlite"
      ? new (
          await import("@clearideas/agent-runtime-store-sqlite")
        ).SqliteRunStore(resolved.location)
      : new FileRunStore(resolved.location);
  return {
    ...resolved,
    store,
    close: () => {
      if ("close" in store) store.close();
    },
  };
};

/**
 * Parse `--name value` and `--name=value` options. Flags take no value;
 * repeatable options may appear more than once.
 */
const parseOptions = (
  args: string[],
  allowed: ReadonlySet<string>,
  flags: ReadonlySet<string> = new Set(),
  repeatable: ReadonlySet<string> = new Set(),
): ParsedOptions => {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const separator = value.indexOf("=");
    const name = value.slice(2, separator < 0 ? undefined : separator);
    const option = `--${name}`;
    if (!allowed.has(name)) throw new Error(`Unknown option: ${option}`);
    if (flags.has(name)) {
      if (separator >= 0)
        throw new Error(`Option ${option} does not take a value.`);
      if (options.has(name))
        throw new Error(`Option ${option} may only be provided once.`);
      options.set(name, "true");
      continue;
    }
    let optionValue: string | undefined;
    if (separator >= 0) {
      optionValue = value.slice(separator + 1);
    } else {
      optionValue = args[index + 1];
      if (optionValue?.startsWith("--")) optionValue = undefined;
      index += 1;
    }
    if (!optionValue) throw new Error(`Option ${option} requires a value.`);
    if (repeatable.has(name)) {
      repeated.set(name, [...(repeated.get(name) ?? []), optionValue]);
      options.set(name, optionValue);
      continue;
    }
    if (options.has(name))
      throw new Error(`Option ${option} may only be provided once.`);
    options.set(name, optionValue);
  }
  return { positional, options, repeated };
};

const requireOnePositional = (parsed: ParsedOptions, label: string): string => {
  if (parsed.positional.length !== 1)
    throw new Error(`Expected exactly one ${label}.`);
  return parsed.positional[0]!;
};

const positiveSafeIntegerOption = (
  parsed: ParsedOptions,
  name: string,
): number | undefined => {
  const value = parsed.options.get(name);
  if (value == null) return undefined;
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`--${name} must be a positive safe integer.`);
  }
  return parsedValue;
};

const validateManifest = async (args: string[], io: CliIo): Promise<void> => {
  const parsed = parseOptions(args, new Set(["config"]));
  const file = path.resolve(requireOnePositional(parsed, "manifest path"));
  const manifest = await new FileAgentManifestSource(
    path.dirname(file),
    path.basename(file),
  ).loadManifest();
  const configFile = parsed.options.get("config");
  if (configFile)
    validateRuntimeConfiguration(
      manifest,
      await loadAgentRuntimeConfig(configFile),
    );
  io.stdout(
    `${JSON.stringify(
      {
        valid: true,
        schemaVersion: manifest.schemaVersion,
        ...(manifest.id ? { id: manifest.id } : {}),
        ...(manifest.name ? { name: manifest.name } : {}),
        stepCount: manifest.steps.length,
      },
      null,
      2,
    )}\n`,
  );
};

const validateConfig = async (args: string[], io: CliIo): Promise<void> => {
  const [subcommand, ...subcommandArgs] = args;
  if (subcommand !== "validate")
    throw new Error("Expected config validate <Agent Runtime config path>.");
  const file = path.resolve(
    requireOnePositional(
      parseOptions(subcommandArgs, new Set()),
      "Agent Runtime config path",
    ),
  );
  const config = await loadAgentRuntimeConfig(file);
  io.stdout(
    `${JSON.stringify(
      {
        valid: true,
        version: config.version,
        providerCount: Object.keys(config.providers).length,
        modelCount: Object.keys(config.models).length,
        connectionCount: Object.keys(config.connections).length,
        workspaceCount: Object.keys(config.workspaces ?? {}).length,
        ...(config.sandbox ? { sandbox: config.sandbox.driver } : {}),
      },
      null,
      2,
    )}\n`,
  );
};

const firstLine = (value: string | undefined): string | undefined =>
  value?.split(/\r?\n/u)[0]?.trim().slice(0, 100);

/** Renders a paste-ready toolIntegrity block with tool descriptions as comments. */
const toolIntegrityYaml = (
  discovered: Record<string, McpDiscoveredTool[]>,
): string => {
  const document = new YamlDocument({
    connections: Object.fromEntries(
      Object.entries(discovered).map(([name, tools]) => [
        name,
        {
          toolIntegrity: {
            digests: Object.fromEntries(
              tools
                .filter((tool) => tool.allowed)
                .map((tool) => [tool.name, tool.digest]),
            ),
          },
        },
      ]),
    ),
  });
  for (const [name, tools] of Object.entries(discovered)) {
    const digests = document.getIn([
      "connections",
      name,
      "toolIntegrity",
      "digests",
    ]);
    if (!(digests instanceof YAMLMap)) continue;
    for (const item of digests.items) {
      if (!isPair(item)) continue;
      const key: unknown = item.key;
      if (!isScalar(key)) continue;
      const tool = tools.find((candidate) => candidate.name === key.value);
      const summary = firstLine(tool?.description ?? tool?.title);
      if (summary) key.commentBefore = ` ${summary}`;
    }
  }
  return document.toString({ lineWidth: 0 });
};

const inspectConnections = async (args: string[], io: CliIo): Promise<void> => {
  const [subcommand, ...subcommandArgs] = args;
  if (subcommand !== "inspect")
    throw new Error(
      "Expected connections inspect <Agent Runtime config path>.",
    );
  const parsed = parseOptions(
    subcommandArgs,
    new Set(["connection", "runtime-module", "format"]),
  );
  const file = path.resolve(
    requireOnePositional(parsed, "Agent Runtime config path"),
  );
  const format = parsed.options.get("format") ?? "json";
  if (format !== "json" && format !== "yaml")
    throw new Error("--format must be json or yaml.");
  const config = await loadAgentRuntimeConfig(file);
  const requested = parsed.options.get("connection");
  const names = requested ? [requested] : Object.keys(config.connections);
  for (const name of names) {
    if (!config.connections[name])
      throw new Error(`Unknown connection "${name}".`);
  }
  const runtimeModulePath = parsed.options.get("runtime-module");
  const moduleRuntime = await loadHostRuntime(runtimeModulePath, {
    manifest: {
      schemaVersion: "1.0",
      connections: names.map((ref) => ({ ref })),
      steps: [],
    },
    storeDirectory: resolveCliStoreLocation(parsed).baseDirectory,
  });
  let shutdownError: unknown;
  const discovered: Record<string, McpDiscoveredTool[]> = {};
  try {
    for (const name of names) {
      discovered[name] = await discoverMcpConnectionTools(
        config,
        name,
        {},
        moduleRuntime.connectionCredentials
          ? { credentialProvider: moduleRuntime.connectionCredentials }
          : {},
      );
    }
  } finally {
    try {
      await moduleRuntime.shutdown?.();
    } catch (error) {
      shutdownError = error;
    }
  }
  if (shutdownError) throw shutdownError;
  if (format === "yaml") {
    io.stdout(toolIntegrityYaml(discovered));
    return;
  }
  io.stdout(
    `${JSON.stringify(
      {
        connections: Object.fromEntries(
          Object.entries(discovered).map(([name, tools]) => [
            name,
            {
              tools,
              toolIntegrity: {
                digests: Object.fromEntries(
                  tools
                    .filter((tool) => tool.allowed)
                    .map((tool) => [tool.name, tool.digest]),
                ),
              },
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
};

const inspect = async (args: string[], io: CliIo): Promise<void> => {
  const parsed = parseOptions(
    args,
    new Set(["store", "store-driver", "runtime-module"]),
  );
  const runId = requireOnePositional(parsed, "run id");
  const resolved = await resolveCliStore(parsed);
  try {
    const store =
      (await loadHostRunStore(parsed.options.get("runtime-module"), {
        runId,
        storeDirectory: resolved.baseDirectory,
        storeDriver: resolved.driver,
        storeLocation: resolved.location,
      })) ?? resolved.store;
    const run = await store.loadRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const checkpoint = await store.loadLatestCheckpoint(runId);
    io.stdout(`${JSON.stringify({ run, checkpoint }, null, 2)}\n`);
  } finally {
    resolved.close();
  }
};

const events = async (args: string[], io: CliIo): Promise<void> => {
  const parsed = parseOptions(args, new Set(["run", "type", "tail"]));
  const file = path.resolve(requireOnePositional(parsed, "event file"));
  const lines = (await readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean);
  let selected = lines.map((line, index): RunEvent => {
    try {
      return JSON.parse(line) as RunEvent;
    } catch {
      throw new Error(`Invalid JSON on event line ${index + 1}.`);
    }
  });
  const runId = parsed.options.get("run");
  const eventType = parsed.options.get("type");
  if (runId) selected = selected.filter((event) => event.runId === runId);
  if (eventType)
    selected = selected.filter((event) => event.type === eventType);

  const tailText = parsed.options.get("tail");
  if (tailText) {
    const count = Number(tailText);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("--tail must be a non-negative integer.");
    selected = count === 0 ? [] : selected.slice(-count);
  }
  for (const event of selected) io.stdout(`${JSON.stringify(event)}\n`);
};

/** Adapters a local runtime module may contribute to CLI execution. */
export type CliRuntime = HostRuntime;

export interface CliRuntimeContext {
  manifest: AgentManifest;
  runId?: string;
  storeDirectory: string;
  storeDriver?: CliStoreDriver;
  storeLocation?: string;
  eventFile?: string;
  artifactDirectory?: string;
}

export type CliStoreContext = Omit<CliRuntimeContext, "manifest">;

export type CliRuntimeModule = HostRuntimeModule;

const sensitiveKey =
  /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/iu;

const redactValue = (value: JsonValue, key = ""): JsonValue => {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ]),
    );
  }
  return value;
};

/**
 * Local lifecycle logs exclude transient model content and common secret
 * fields. A host-supplied event sink is trusted code and receives raw events.
 */
class SafeLocalEventSink implements EventSink {
  readonly #delegate: EventSink;

  constructor(delegate: EventSink) {
    this.#delegate = delegate;
  }

  emit(event: RunEvent): Promise<void> | void {
    if (
      event.type === "model.text.delta" ||
      event.type === "model.reasoning.delta"
    ) {
      return;
    }
    let data = event.data ? (redactValue(event.data) as JsonObject) : undefined;
    if (
      (event.type === "run.failed" || event.type === "step.failed") &&
      data?.error
    ) {
      const error = data.error;
      data = {
        ...data,
        error:
          error && typeof error === "object" && !Array.isArray(error)
            ? {
                ...("code" in error ? { code: error.code } : {}),
                ...("retryable" in error ? { retryable: error.retryable } : {}),
              }
            : "[REDACTED]",
      };
    }
    return this.#delegate.emit({
      ...event,
      ...(data ? { data } : {}),
    });
  }
}

type CliOutputFormat = "json" | "pretty" | "ndjson";

class CliStreamingEventSink implements EventSink {
  readonly #io: CliIo;
  readonly #format: Exclude<CliOutputFormat, "json">;
  readonly #showReasoning: boolean;
  #streamedText = false;

  constructor(
    io: CliIo,
    format: Exclude<CliOutputFormat, "json">,
    showReasoning: boolean,
  ) {
    this.#io = io;
    this.#format = format;
    this.#showReasoning = showReasoning;
  }

  get streamedText(): boolean {
    return this.#streamedText;
  }

  emit(event: RunEvent): void {
    if (this.#format === "ndjson") {
      this.#io.stdout(`${JSON.stringify({ type: "event", event })}\n`);
      return;
    }
    if (event.type === "model.text.delta") {
      const delta =
        typeof event.data?.delta === "string" ? event.data.delta : "";
      if (delta) {
        this.#streamedText = true;
        this.#io.stdout(delta);
      }
      return;
    }
    if (event.type === "model.reasoning.delta") {
      if (!this.#showReasoning) return;
      const delta =
        typeof event.data?.delta === "string" ? event.data.delta : "";
      if (delta) this.#io.stderr(`  reasoning: ${delta}`);
      return;
    }
    const label = (() => {
      switch (event.type) {
        case "run.started":
          return `● run started (${event.runId})`;
        case "run.resumed":
          return `● run resumed (${event.runId})`;
        case "step.started":
          return `● step started${event.stepId ? `: ${event.stepId}` : ""}`;
        case "step.skipped":
          return `○ step skipped${event.stepId ? `: ${event.stepId}` : ""}`;
        case "step.completed":
          return `✓ step completed${event.stepId ? `: ${event.stepId}` : ""}`;
        case "model.started":
          return `  model: ${String(event.data?.model ?? "unknown")}`;
        case "model.tool.started":
          return `  tool started: ${String(event.data?.toolName ?? "unknown")}`;
        case "model.tool.completed":
          return `  tool completed: ${String(event.data?.toolName ?? "unknown")}`;
        case "checkpoint.saved":
          return `  checkpoint saved: ${String(event.data?.nextStepIndex ?? "")}`.trimEnd();
        case "artifact.created":
          return `  artifact created: ${String(event.data?.name ?? event.data?.artifactId ?? "")}`.trimEnd();
        case "run.completed":
          return `✓ run completed (${event.runId})`;
        case "run.failed":
          return `✗ run failed (${event.runId})`;
        case "run.suspended":
          return `Ⅱ run suspended (${event.runId}): ${String(event.data?.reason ?? "awaiting input")}; resume with agent-runtime resume ${event.runId}`;
        case "run.interrupted":
          return `↯ run interrupted (${event.runId}): ${String(event.data?.reason ?? "interrupted")}; resume with agent-runtime resume ${event.runId}`;
        case "step.failed":
          return event.data?.handled === true
            ? `! step failed, continuing (onError: continue)${event.stepId ? `: ${event.stepId}` : ""}`
            : undefined;
        case "context.reduced":
          return `  context reduced: ${String(event.data?.scope ?? "")} by ${String(event.data?.strategy ?? "")}, ${String(event.data?.bytesBefore ?? "?")} → ${String(event.data?.bytesAfter ?? "?")} bytes`;
        case "model.retry":
          return `  model retry: ${String(event.data?.reason ?? "retry")}${event.data?.delayMs != null ? `, waiting ${String(event.data.delayMs)}ms` : ""}`;
        case "webhook.retry.scheduled":
          return `  webhook retry: ${String(event.data?.reason ?? "transient failure")}, waiting ${String(event.data?.delayMs ?? "unknown")}ms`;
        case "run.cancelled":
          return `■ run cancelled (${event.runId})`;
        default:
          return undefined;
      }
    })();
    if (label) this.#io.stderr(`${label}\n`);
  }
}

/**
 * Read `--messages`: a JSON or YAML array of messages, or `{ messages,
 * signature }` as written by `--messages-out`.
 */
const readMessagesFile = async (
  file: string,
): Promise<{
  messages: ConversationMessage[];
  signature?: MessagesSignature;
}> => {
  const source = await readFile(file, "utf8");
  let value: unknown;
  try {
    value = file.endsWith(".json")
      ? JSON.parse(source)
      : (parseYamlDocument(source) as unknown);
  } catch (error) {
    throw new Error(
      `Could not parse conversation messages ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const envelope =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as { messages?: unknown; signature?: unknown })
      : { messages: value };
  return {
    messages: parseConversationMessages(envelope.messages),
    ...(envelope.signature != null
      ? { signature: messagesSignatureSchema.parse(envelope.signature) }
      : {}),
  };
};

const executionOptions = new Set([
  "config",
  "variables",
  "messages",
  "messages-scope",
  "messages-out",
  "run-id",
  "store",
  "store-driver",
  "events",
  "artifacts",
  "runtime-module",
  "stream",
  "format",
  "show-reasoning",
  "max-total-tokens",
]);

const executionFlags = new Set(["stream", "show-reasoning"]);

const execute = async (
  command: "run" | "run-manifest" | "resume",
  args: string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<void> => {
  const parsed = parseOptions(args, executionOptions, executionFlags);
  const target = requireOnePositional(
    parsed,
    command === "run"
      ? "agent manifest path"
      : command === "run-manifest"
        ? "agent run manifest path"
        : "run id",
  );
  if (command === "resume" && parsed.options.has("run-id")) {
    throw new Error("--run-id is only valid with the run command.");
  }
  if (command === "resume" && parsed.options.has("variables")) {
    throw new Error("--variables is only valid with the run command.");
  }
  if (
    command === "resume" &&
    (parsed.options.has("messages") ||
      parsed.options.has("messages-scope") ||
      parsed.options.has("messages-out"))
  ) {
    throw new Error(
      "Conversation messages are fixed when a run is created; --messages, --messages-scope, and --messages-out are not valid with resume.",
    );
  }
  if (command === "run-manifest" && parsed.options.has("messages")) {
    throw new Error(
      "--messages cannot be combined with an agent run manifest; declare messages in the agent run manifest.",
    );
  }
  if (
    command === "run-manifest" &&
    (parsed.options.has("variables") ||
      parsed.options.has("run-id") ||
      parsed.options.has("max-total-tokens"))
  ) {
    throw new Error(
      "--variables, --run-id, and --max-total-tokens cannot be combined with an agent run manifest; declare them in the agent run manifest.",
    );
  }

  const agentRunManifestFile =
    command === "run-manifest" ? path.resolve(target) : undefined;
  const agentRunManifestSource = agentRunManifestFile
    ? new FileAgentRunManifestSource(
        path.dirname(agentRunManifestFile),
        path.basename(agentRunManifestFile),
      )
    : undefined;
  const agentRunManifest = agentRunManifestSource
    ? await agentRunManifestSource.loadAgentRunManifest()
    : undefined;
  const agentManifestSource = agentRunManifestFile
    ? new FileAgentManifestSource(path.dirname(agentRunManifestFile))
    : undefined;

  const resolvedStore = await resolveCliStore(parsed);
  let shutdown: CliRuntime["shutdown"];
  try {
    const storeDirectory = resolvedStore.baseDirectory;
    const runId =
      command === "resume"
        ? target
        : (agentRunManifest?.runId ?? parsed.options.get("run-id"));
    const maxTotalTokens = positiveSafeIntegerOption(
      parsed,
      "max-total-tokens",
    );
    const runtimeModulePath = parsed.options.get("runtime-module");
    const runtimeStore =
      command === "resume"
        ? await loadHostRunStore(runtimeModulePath, {
            runId: target,
            storeDirectory,
            storeDriver: resolvedStore.driver,
            storeLocation: resolvedStore.location,
          })
        : undefined;
    const store = runtimeStore ?? resolvedStore.store;
    let manifest: AgentManifest;
    const variableOverrides =
      command === "run" && parsed.options.has("variables")
        ? parseAgentVariableOverrides(
            JSON.parse(
              await readFile(
                path.resolve(parsed.options.get("variables")!),
                "utf8",
              ),
            ),
          )
        : undefined;
    const suppliedMessages =
      command === "run" && parsed.options.has("messages")
        ? await readMessagesFile(path.resolve(parsed.options.get("messages")!))
        : undefined;
    const messagesScope = parsed.options.get("messages-scope");
    let configSearchDirectory = process.cwd();
    if (command === "run") {
      const manifestFile = path.resolve(target);
      configSearchDirectory = path.dirname(manifestFile);
      manifest = await new FileAgentManifestSource(
        path.dirname(manifestFile),
        path.basename(manifestFile),
      ).loadManifest();
    } else if (
      command === "run-manifest" &&
      agentRunManifest &&
      agentManifestSource
    ) {
      configSearchDirectory = path.dirname(agentRunManifestFile!);
      manifest = await agentManifestSource.loadManifest(
        agentRunManifest.agent.ref,
      );
    } else {
      const record = await store.loadRun(target);
      if (!record) throw new Error(`Run not found: ${target}`);
      manifest = record.manifest;
    }

    const eventsOption = parsed.options.get("events");
    const eventFile =
      eventsOption === "none"
        ? undefined
        : path.resolve(
            eventsOption ?? path.join(storeDirectory, "events.jsonl"),
          );
    const artifactsOption = parsed.options.get("artifacts");
    const artifactDirectory =
      artifactsOption === "none"
        ? undefined
        : path.resolve(artifactsOption ?? storeDirectory);
    const context: CliRuntimeContext = {
      manifest,
      ...(runId ? { runId } : {}),
      storeDirectory,
      storeDriver: resolvedStore.driver,
      storeLocation: resolvedStore.location,
      ...(eventFile ? { eventFile } : {}),
      ...(artifactDirectory ? { artifactDirectory } : {}),
    };
    const loadedModuleRuntime = await loadHostRuntime(
      runtimeModulePath,
      context,
    );
    shutdown = loadedModuleRuntime.shutdown;
    const moduleRuntime = runtimeStore
      ? validateHostRuntime({ ...loadedModuleRuntime, runStore: runtimeStore })
      : loadedModuleRuntime;
    const config = await resolveAgentRuntimeConfig(
      parsed.options.get("config"),
      configSearchDirectory,
    );
    const runtime = composeHostRuntime(manifest, config, [moduleRuntime]);
    const jsonlSink = eventFile ? new JsonlEventSink(eventFile) : undefined;
    const requestedFormat =
      parsed.options.get("format") ??
      (parsed.options.has("stream") ? "pretty" : "json");
    if (!["json", "pretty", "ndjson"].includes(requestedFormat)) {
      throw new Error("--format must be json, pretty, or ndjson.");
    }
    const outputFormat = requestedFormat as CliOutputFormat;
    const streamingSink =
      outputFormat === "json"
        ? undefined
        : new CliStreamingEventSink(
            io,
            outputFormat,
            parsed.options.has("show-reasoning"),
          );
    const warnedSinks = new Set<EventSink>();
    const runner = new AgentRuntime(
      hostRuntimeDependencies(runtime, {
        // The operator runs manifests they chose on their own machine.
        trust: "local-operator",
        onEventSinkError(_error, _event, sink) {
          if (warnedSinks.has(sink)) return;
          warnedSinks.add(sink);
          io.stderr(
            `Warning: event delivery failed for ${sink instanceof SafeLocalEventSink ? `local log ${eventFile}` : sink.constructor.name}. Check permissions and available disk space. Execution continues.\n`,
          );
        },
        runStore: runtime.runStore ?? store,
        agentManifestSource,
        eventSinks: [
          ...(jsonlSink ? [new SafeLocalEventSink(jsonlSink)] : []),
          ...(streamingSink ? [streamingSink] : []),
        ],
        artifacts:
          runtime.artifactStore ??
          (artifactDirectory
            ? new FileArtifactStore(artifactDirectory)
            : undefined),
      }),
    );

    try {
      const result = await runner.run(
        command === "run-manifest" && agentRunManifest
          ? {
              agentRunManifest,
              ...(messagesScope != null ? { messagesScope } : {}),
              ...(signal ? { signal } : {}),
            }
          : {
              manifest,
              ...(runId ? { runId } : {}),
              ...(variableOverrides ? { variables: variableOverrides } : {}),
              ...(suppliedMessages
                ? { messages: suppliedMessages.messages }
                : {}),
              ...(suppliedMessages?.signature
                ? { messagesSignature: suppliedMessages.signature }
                : {}),
              ...(messagesScope != null ? { messagesScope } : {}),
              ...(maxTotalTokens ? { budget: { maxTotalTokens } } : {}),
              ...(signal ? { signal } : {}),
              ...(command === "resume" ? { resume: true } : {}),
            },
      );
      // The output history contains model output, so it is written only to
      // an explicitly requested file, in the format --messages reads.
      const messagesOut = parsed.options.get("messages-out");
      if (messagesOut) {
        if (!result.messages) {
          throw new Error(
            "--messages-out requires an agent manifest that declares messages.",
          );
        }
        await writeFile(
          path.resolve(messagesOut),
          `${JSON.stringify(
            {
              messages: result.messages,
              ...(result.messagesSignature
                ? { signature: result.messagesSignature }
                : {}),
            },
            null,
            2,
          )}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      }
      // Deliberately exclude variables, transcript and model output. They may
      // contain secrets; inspect is an explicit command for persisted details.
      if (outputFormat === "ndjson") {
        io.stdout(
          `${JSON.stringify({
            type: "result",
            result,
          })}\n`,
        );
      } else if (outputFormat === "pretty") {
        if (streamingSink?.streamedText) io.stdout("\n");
        else if (result.output !== undefined) {
          io.stdout(
            `${typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}\n`,
          );
        }
        io.stderr(
          `run ${result.runId}: ${result.stepResults.length} step(s), ${result.artifacts.length} artifact(s)\n`,
        );
      } else {
        io.stdout(
          `${JSON.stringify(
            {
              runId: result.runId,
              status: "completed",
              stepCount: result.stepResults.length,
              artifactCount: result.artifacts.length,
              ...(result.messages
                ? {
                    messageCount: result.messages.length,
                    messagesSigned: result.messagesSignature != null,
                  }
                : {}),
            },
            null,
            2,
          )}\n`,
        );
      }
    } finally {
      await jsonlSink?.flush();
    }
  } finally {
    try {
      await shutdown?.();
    } catch {
      io.stderr("Warning: runtime shutdown failed. Check adapter cleanup.\n");
    }
    try {
      resolvedStore.close();
    } catch {
      io.stderr("Warning: local store cleanup failed.\n");
    }
  }
};

export interface PortableWorkerOptions {
  storeDirectory: string;
  storeDriver?: CliStoreDriver;
  /** Maximum number of independent agent steps executed concurrently. */
  maxParallelSteps?: number;
  configFile?: string;
  runtimeModule?: string;
  /**
   * Resolve an opaque request runtime ID to a trusted host module. Request
   * filesystem paths are rejected when this callback is absent.
   */
  resolveRuntimeReference?: (
    reference: string,
    request: ExecutionRequest,
  ) => string | Promise<string>;
  /**
   * Resolve an opaque request configuration ID through trusted host policy.
   * Request filesystem paths are rejected when this callback is absent.
   */
  resolveConfigReference?: (
    reference: string,
    request: ExecutionRequest,
  ) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>;
  /**
   * Permit inline configuration from an already authenticated and
   * integrity-protected invocation. Defaults to false.
   */
  allowRequestConfiguration?: boolean;
  /**
   * Environment values visible to request-supplied configuration. Pass an
   * explicit allowlist; the process environment is never used for that path.
   */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Host policy applied before configured model adapters are created. */
  modelPolicy?: ModelAuthorizationPolicy;
  /** Host policy and credentials applied to configured MCP adapters. */
  toolOptions?: ConfiguredMcpToolAdapterOptions;
  /** Host policy, hooks, and providers applied to configured workspaces and the run sandbox. */
  workspaceOptions?: WorkspaceCompositionOptions;
  /** Host-supplied adapters for embedded workers such as managed compute runtimes. */
  runtime?: CliRuntime;
  eventSinkFailurePolicy?: "continue" | "fail-run";
  signal?: AbortSignal;
  onMessage(message: WorkerMessage): void | Promise<void>;
}

const assertSafeInlineWorkerConfiguration = (
  config: AgentRuntimeConfig,
): void => {
  const customDestinationProvider = Object.entries(config.providers).find(
    ([, definition]) => definition.baseURL != null,
  );
  if (customDestinationProvider) {
    throw new Error(
      `Inline worker configuration cannot define provider baseURL values; use a trusted configReference for provider "${customDestinationProvider[0]}".`,
    );
  }
  if (Object.keys(config.connections).length > 0) {
    throw new Error(
      "Inline worker configuration cannot define MCP connections; use a trusted configReference.",
    );
  }
  if (Object.keys(config.workspaces ?? {}).length > 0 || config.sandbox) {
    throw new Error(
      "Inline worker configuration cannot define workspaces or a sandbox; use a trusted configReference.",
    );
  }
  if (config.messages?.signing) {
    throw new Error(
      "Inline worker configuration cannot define message signing keys; use a trusted configReference.",
    );
  }
};

const MAXIMUM_WORKER_INPUT_BYTES = 16 * 1024 * 1024;

class PortableWorkerEventSink implements EventSink {
  readonly #onMessage: PortableWorkerOptions["onMessage"];

  constructor(onMessage: PortableWorkerOptions["onMessage"]) {
    this.#onMessage = onMessage;
  }

  emit(event: RunEvent): Promise<void> | void {
    return this.#onMessage({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      type: "event",
      event,
    });
  }
}

/** Runs one provider-neutral worker invocation in the current process. */
export const executeWorkerInvocation = async (
  invocation: WorkerInvocation,
  options: PortableWorkerOptions,
): Promise<RunResult> => {
  const request = invocation.request;
  const invocationVariables =
    invocation.action === "run"
      ? (request as ExecutionRequest).variables
      : undefined;
  const invocationMessages =
    invocation.action === "run" ? (request as ExecutionRequest) : undefined;
  const manifest = request.manifest;
  const storeLocation = path.resolve(options.storeDirectory);
  const storeDriver = options.storeDriver ?? "file";
  const storeDirectory =
    storeDriver === "sqlite" ? path.dirname(storeLocation) : storeLocation;
  const context: CliRuntimeContext = {
    manifest,
    ...(request.runId ? { runId: request.runId } : {}),
    storeDirectory,
    storeDriver,
    storeLocation,
    artifactDirectory: storeDirectory,
  };
  const runtimeReference = options.runtimeModule
    ? options.runtimeModule
    : request.runtimeReference
      ? options.resolveRuntimeReference
        ? await options.resolveRuntimeReference(
            request.runtimeReference,
            request,
          )
        : (() => {
            throw new Error(
              "Worker request runtimeReference requires a host resolveRuntimeReference callback.",
            );
          })()
      : undefined;
  const moduleRuntime = await loadHostRuntime(runtimeReference, context);
  const hostRuntime = validateHostRuntime(options.runtime ?? {});
  let requestSuppliedConfiguration = false;
  const config = options.configFile
    ? await loadAgentRuntimeConfig(options.configFile)
    : request.configuration
      ? options.allowRequestConfiguration === true
        ? ((requestSuppliedConfiguration = true),
          parseAgentRuntimeConfig(request.configuration))
        : (() => {
            throw new Error(
              "Worker request configuration requires allowRequestConfiguration and an explicit environment allowlist.",
            );
          })()
      : request.configReference
        ? options.resolveConfigReference
          ? await options.resolveConfigReference(
              request.configReference,
              request,
            )
          : (() => {
              throw new Error(
                "Worker request configReference requires a host resolveConfigReference callback.",
              );
            })()
        : await resolveAgentRuntimeConfig(undefined, process.cwd());
  if (requestSuppliedConfiguration) {
    assertSafeInlineWorkerConfiguration(config);
  }
  const runtime = composeHostRuntime(
    manifest,
    config,
    [moduleRuntime, hostRuntime],
    {
      ...(requestSuppliedConfiguration
        ? { environment: options.environment ?? {} }
        : options.environment
          ? { environment: options.environment }
          : {}),
      ...(options.modelPolicy ? { modelPolicy: options.modelPolicy } : {}),
      ...(options.toolOptions ? { toolOptions: options.toolOptions } : {}),
      ...(options.workspaceOptions
        ? { workspaceOptions: options.workspaceOptions }
        : {}),
    },
  );
  const store =
    runtime.runStore ??
    (storeDriver === "sqlite"
      ? new (
          await import("@clearideas/agent-runtime-store-sqlite")
        ).SqliteRunStore(storeLocation)
      : new FileRunStore(storeLocation));
  try {
    const artifacts =
      runtime.artifactStore ?? new FileArtifactStore(storeDirectory);

    if (
      invocation.action === "resume" &&
      "checkpoint" in request &&
      request.checkpoint
    ) {
      const existing = await store.loadRun(request.runId);
      if (!existing) {
        const checkpointAttempt =
          request.checkpoint.attempt ?? request.attempt - 1;
        const importedCheckpoint = {
          ...request.checkpoint,
          ...(request.checkpoint.sequence === 1
            ? {}
            : {
                id: `${request.checkpoint.id}:imported`,
                sequence: 1,
                metadata: {
                  ...(request.checkpoint.metadata ?? {}),
                  importedCheckpointId: request.checkpoint.id,
                  importedCheckpointSequence: request.checkpoint.sequence,
                },
              }),
        };
        await store.createRun({
          runId: request.runId,
          manifest,
          status: "suspended",
          attempt: checkpointAttempt,
          state: structuredClone(importedCheckpoint.state),
          createdAt: importedCheckpoint.createdAt,
          updatedAt: importedCheckpoint.createdAt,
        });
        // A transferred checkpoint is a complete snapshot, not a partial log.
        // Rebase its local sequence when the destination store has no history;
        // preserve the source cursor in metadata for audit/debugging.
        await store.saveCheckpoint(importedCheckpoint);
      }
    }

    const runner = new AgentRuntime(
      hostRuntimeDependencies(runtime, {
        // Webhook execution is host-supplied in worker mode so destination
        // policy cannot be bypassed by a remote manifest.
        trust: "untrusted-request",
        runStore: store,
        eventSinks: [new PortableWorkerEventSink(options.onMessage)],
        artifacts,
        maxParallelSteps: options.maxParallelSteps,
        eventSinkFailurePolicy: options.eventSinkFailurePolicy,
      }),
    );
    return await runner.run({
      manifest,
      ...(request.runId ? { runId: request.runId } : {}),
      ...(invocationVariables ? { variables: invocationVariables } : {}),
      ...(invocationMessages?.messages
        ? { messages: invocationMessages.messages }
        : {}),
      ...(invocationMessages?.messagesSignature
        ? { messagesSignature: invocationMessages.messagesSignature }
        : {}),
      ...(invocationMessages?.messagesScope != null
        ? { messagesScope: invocationMessages.messagesScope }
        : {}),
      ...(request.execution ? { execution: request.execution } : {}),
      ...(request.budget ? { budget: request.budget } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(invocation.action === "resume"
        ? {
            resume: true,
            ...("allowRunningTakeover" in request &&
            request.allowRunningTakeover
              ? { allowRunningTakeover: true }
              : {}),
          }
        : {}),
    });
  } finally {
    if (
      !runtime.runStore &&
      "close" in store &&
      typeof store.close === "function"
    )
      store.close();
  }
};

const readStandardInput = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let source = "";
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    byteLength += Buffer.byteLength(chunk, "utf8");
    if (byteLength > MAXIMUM_WORKER_INPUT_BYTES) {
      throw new Error("Worker invocation exceeds the input size limit.");
    }
    source += chunk;
  }
  return source;
};

const worker = async (
  args: string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<boolean> => {
  const parsed = parseOptions(
    args,
    new Set(["store", "store-driver", "config", "runtime-module"]),
  );
  if (parsed.positional.length > 0)
    throw new Error("The worker command reads its invocation from stdin.");
  const onMessage = (message: WorkerMessage): void =>
    io.stdout(serializeWorkerMessage(message));
  try {
    const resolvedStore = resolveCliStoreLocation(parsed, true);
    const invocation = parseWorkerInvocation(
      (await readStandardInput()).trim(),
    );
    await onMessage({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      type: "ready",
    });
    const result = await executeWorkerInvocation(invocation, {
      storeDirectory: resolvedStore.location,
      storeDriver: resolvedStore.driver,
      ...(parsed.options.get("config")
        ? { configFile: parsed.options.get("config")! }
        : {}),
      ...(parsed.options.get("runtime-module")
        ? { runtimeModule: parsed.options.get("runtime-module")! }
        : {}),
      ...(signal ? { signal } : {}),
      onMessage,
    });
    await onMessage({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      type: "result",
      result,
    });
    return true;
  } catch (error) {
    await onMessage({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      type: "error",
      error: {
        code: "WORKER_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    });
    return false;
  }
};

const serveOptionNames = new Set([
  "server-config",
  "no-server-config",
  "served-model-name",
  "config",
  "runtime-config",
  "runtime-module",
  "host",
  "port",
  "api-key-env",
  "allow-unauthenticated",
  "input",
  "output",
  "stream-mode",
  "progress",
  "store-driver",
  "store",
  "ledger",
  "on-unrecognized",
  "client-tools",
  "max-concurrent-runs",
  "request-timeout",
  "warmup",
  "check",
]);
const serveFlags = new Set([
  "no-server-config",
  "allow-unauthenticated",
  "warmup",
  "check",
]);

const INPUT_SOURCES = new Set([
  "last-user",
  "transcript",
  "system",
  "json",
  "client",
]);

const oneOf = <T extends string>(
  parsed: ParsedOptions,
  name: string,
  values: readonly T[],
): T | undefined => {
  const value = parsed.options.get(name);
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value))
    throw new Error(`--${name} must be one of ${values.join(", ")}.`);
  return value as T;
};

/** Parse `agent-runtime serve` arguments into server options. */
export const parseServeArguments = (
  args: string[],
): ServeOptions & { check?: boolean } => {
  const parsed = parseOptions(
    args,
    serveOptionNames,
    serveFlags,
    new Set(["input"]),
  );
  if (parsed.positional.length > 1)
    throw new Error("Serve one manifest, or use --server-config for several.");
  if (parsed.options.has("config") && parsed.options.has("runtime-config"))
    throw new Error("--runtime-config is an alias of --config; use one.");
  const manifest = parsed.positional[0];
  const input: Record<string, InputSourceConfig> = {};
  for (const entry of parsed.repeated.get("input") ?? []) {
    const separator = entry.indexOf("=");
    const variable = entry.slice(0, separator);
    const source = entry.slice(separator + 1);
    if (separator <= 0 || !INPUT_SOURCES.has(source)) {
      throw new Error(
        `--input expects <variable>=<source> with source last-user, transcript, system, json, or client; got ${JSON.stringify(entry)}.`,
      );
    }
    if (input[variable]) throw new Error(`--input maps ${variable} twice.`);
    input[variable] = source as InputSourceConfig;
  }
  const port = parsed.options.get("port");
  const portNumber = port === undefined ? undefined : Number(port);
  if (
    portNumber !== undefined &&
    (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65_535)
  )
    throw new Error("--port must be an integer from 0 to 65535.");
  const runtimeConfig =
    parsed.options.get("config") ?? parsed.options.get("runtime-config");
  const streamMode = oneOf(parsed, "stream-mode", [
    "auto",
    "live",
    "committed",
  ] as const);
  const progress = oneOf(parsed, "progress", ["none", "status"] as const);
  const storeDriver = oneOf(parsed, "store-driver", [
    "memory",
    "sqlite",
  ] as const);
  const onUnrecognized = oneOf(parsed, "on-unrecognized", [
    "unsigned",
    "reject",
    "restart",
  ] as const);
  const clientTools = oneOf(parsed, "client-tools", [
    "ignore",
    "reject",
  ] as const);
  const maxConcurrentRuns = positiveSafeIntegerOption(
    parsed,
    "max-concurrent-runs",
  );
  const requestTimeoutMs = positiveSafeIntegerOption(parsed, "request-timeout");
  if (storeDriver === "sqlite" && !parsed.options.has("store"))
    throw new Error("--store-driver sqlite requires --store <path>.");
  const value = (name: string): string | undefined => parsed.options.get(name);
  return {
    ...(manifest ? { manifest } : {}),
    ...(value("server-config")
      ? { serverConfig: value("server-config")! }
      : {}),
    ...(parsed.options.has("no-server-config") ? { noServerConfig: true } : {}),
    ...(value("served-model-name")
      ? { servedModelName: value("served-model-name")! }
      : {}),
    ...(runtimeConfig ? { runtimeConfig } : {}),
    ...(value("runtime-module")
      ? { runtimeModule: value("runtime-module")! }
      : {}),
    ...(value("host") ? { host: value("host")! } : {}),
    ...(portNumber !== undefined ? { port: portNumber } : {}),
    ...(value("api-key-env") ? { apiKeyEnv: value("api-key-env")! } : {}),
    ...(parsed.options.has("allow-unauthenticated")
      ? { allowUnauthenticated: true }
      : {}),
    ...(Object.keys(input).length > 0 ? { input } : {}),
    ...(value("output") ? { output: value("output")! } : {}),
    ...(streamMode ? { streamMode } : {}),
    ...(progress ? { progress } : {}),
    ...(storeDriver ? { storeDriver } : {}),
    ...(value("store") ? { store: value("store")! } : {}),
    ...(value("ledger") ? { ledger: value("ledger")! } : {}),
    ...(onUnrecognized ? { onUnrecognized } : {}),
    ...(clientTools ? { clientTools } : {}),
    ...(maxConcurrentRuns ? { maxConcurrentRuns } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    ...(parsed.options.has("warmup") ? { warmup: true } : {}),
    ...(parsed.options.has("check") ? { check: true } : {}),
  };
};

const serve = async (
  args: string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<void> => {
  await runServe(parseServeArguments(args), io, signal);
};

const examples = async (
  args: string[],
  io: CliIo,
  signal?: AbortSignal,
): Promise<void> => {
  const [subcommand, name, ...remaining] = args;
  if (subcommand === "list") {
    if (name || remaining.length > 0)
      throw new Error("The examples list command takes no arguments.");
    for (const [exampleName, example] of Object.entries(exampleCatalog)) {
      io.stdout(`${exampleName.padEnd(12)} ${example.description}\n`);
    }
    return;
  }
  if (subcommand !== "show" && subcommand !== "run") {
    throw new Error(
      "Expected examples list, examples show <name>, or examples run <name>.",
    );
  }
  if (!name || !isExampleName(name)) {
    throw new Error(
      `Unknown example: ${name ?? "(missing)"}. Choose variables, conditions, or loops.`,
    );
  }
  const manifestFile = path.join(
    bundledExamplesDirectory,
    exampleCatalog[name].file,
  );
  if (subcommand === "show") {
    if (remaining.length > 0)
      throw new Error("The examples show command takes exactly one name.");
    io.stdout(await readFile(manifestFile, "utf8"));
    return;
  }
  await execute("run", [manifestFile, ...remaining], io, signal);
};

export interface CliRunOptions {
  signal?: AbortSignal;
}

export const runCli = async (
  args: string[],
  io: CliIo = defaultIo,
  options: CliRunOptions = {},
): Promise<number> => {
  const [command, ...commandArgs] = args;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    io.stdout(usage);
    return 0;
  }

  try {
    if (command === "validate") await validateManifest(commandArgs, io);
    else if (command === "config") await validateConfig(commandArgs, io);
    else if (command === "connections")
      await inspectConnections(commandArgs, io);
    else if (command === "inspect") await inspect(commandArgs, io);
    else if (command === "events") await events(commandArgs, io);
    else if (command === "examples")
      await examples(commandArgs, io, options.signal);
    else if (
      command === "run" ||
      command === "run-manifest" ||
      command === "resume"
    ) {
      await execute(command, commandArgs, io, options.signal);
    } else if (command === "worker")
      return (await worker(commandArgs, io, options.signal)) ? 0 : 1;
    else if (command === "serve") await serve(commandArgs, io, options.signal);
    else {
      io.stderr(`Unknown command: ${command}\n\n${usage}`);
      return 2;
    }
    return 0;
  } catch (error) {
    io.stderr(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
};
