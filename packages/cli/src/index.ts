import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JexlConditionEvaluator } from "@clearideas/agent-runtime-condition-jexl";
import type {
  AgentManifest,
  JsonObject,
  JsonValue,
  RunEvent,
  RunResult,
} from "@clearideas/agent-runtime-contracts";
import { parseAgentVariableOverrides } from "@clearideas/agent-runtime-contracts";
import {
  type ArtifactStore,
  type ApprovalAdapter,
  type ConnectionCredentialProvider,
  type EventSink,
  type ModelAdapter,
  AgentRuntime,
  type RunStore,
  type SandboxAdapter,
  type StepExecutor,
  type SubRunAdapter,
  type ToolAdapter,
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
  composeRuntime,
  emptyAgentRuntimeConfig,
  loadAgentRuntimeConfig,
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
  type ConfiguredMcpToolAdapterOptions,
  type ModelAuthorizationPolicy,
  validateRuntimeConfiguration,
} from "@clearideas/agent-runtime-config";
import { LoopStepExecutor } from "@clearideas/agent-runtime-step-loop";
import { PromptStepExecutor } from "@clearideas/agent-runtime-step-prompt";
import {
  ApprovalStepExecutor,
  CodeStepExecutor,
  SubRunStepExecutor,
  WebhookStepExecutor,
} from "@clearideas/agent-runtime-step-standard";
import {
  FileArtifactStore,
  FileAgentManifestSource,
  FileAgentRunManifestSource,
  FileRunStore,
  JsonlEventSink,
} from "@clearideas/agent-runtime-store-local";

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
  agent-runtime run <manifest.json|manifest.yaml> [--variables <overrides.json>] [--config <config.yaml>] [--run-id <id>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-js-file>] [--stream] [--format <json|pretty|ndjson>] [--show-reasoning]
  agent-runtime run-manifest <run.json|run.yaml> [--config <config.yaml>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-js-file>] [--stream] [--format <json|pretty|ndjson>] [--show-reasoning]
  agent-runtime resume <run-id> [--config <config.yaml>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-js-file>] [--stream] [--format <json|pretty|ndjson>] [--show-reasoning]
  agent-runtime inspect <run-id> [--store <path>] [--store-driver <file|sqlite>] [--runtime-module <local-js-file>]
  agent-runtime events <events.jsonl> [--run <run-id>] [--type <event-type>] [--tail <count>]
  agent-runtime examples list
  agent-runtime examples show <variables|conditions|loops>
  agent-runtime examples run <variables|conditions|loops> [run options]
  agent-runtime worker [--store <path>] [--store-driver <file|sqlite>] [--config <config.yaml>] [--runtime-module <local-js-file>]
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
}

export type CliStoreDriver = "file" | "sqlite";

interface ResolvedCliStoreLocation {
  driver: CliStoreDriver;
  location: string;
  baseDirectory: string;
}

interface ResolvedCliStore extends ResolvedCliStoreLocation {
  store: RunStore;
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
  return {
    ...resolved,
    store:
      resolved.driver === "sqlite"
        ? new (
            await import("@clearideas/agent-runtime-store-sqlite")
          ).SqliteRunStore(resolved.location)
        : new FileRunStore(resolved.location),
  };
};

const parseOptions = (
  args: string[],
  allowed: ReadonlySet<string>,
  flags: ReadonlySet<string> = new Set(),
): ParsedOptions => {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option: ${value}`);
    if (flags.has(name)) {
      if (options.has(name))
        throw new Error(`Option ${value} may only be provided once.`);
      options.set(name, "true");
      continue;
    }
    const optionValue = args[index + 1];
    if (!optionValue || optionValue.startsWith("--"))
      throw new Error(`Option ${value} requires a value.`);
    if (options.has(name))
      throw new Error(`Option ${value} may only be provided once.`);
    options.set(name, optionValue);
    index += 1;
  }
  return { positional, options };
};

const requireOnePositional = (parsed: ParsedOptions, label: string): string => {
  if (parsed.positional.length !== 1)
    throw new Error(`Expected exactly one ${label}.`);
  return parsed.positional[0]!;
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
  const store =
    (await loadRuntimeStore(parsed.options.get("runtime-module"), {
      runId,
      storeDirectory: resolved.baseDirectory,
      storeDriver: resolved.driver,
      storeLocation: resolved.location,
    })) ?? resolved.store;
  const run = await store.loadRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const checkpoint = await store.loadLatestCheckpoint(runId);
  io.stdout(`${JSON.stringify({ run, checkpoint }, null, 2)}\n`);
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
export interface CliRuntime {
  runStore?: RunStore;
  artifactStore?: ArtifactStore;
  model?: ModelAdapter;
  tools?: ToolAdapter;
  connectionCredentials?: ConnectionCredentialProvider;
  approvals?: ApprovalAdapter;
  sandbox?: SandboxAdapter;
  subRuns?: SubRunAdapter;
  eventSinks?: EventSink[];
  stepExecutors?: StepExecutor[];
}

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

export interface CliRuntimeModule extends CliRuntime {
  store?: RunStore;
  artifacts?: ArtifactStore;
  modelAdapter?: ModelAdapter;
  toolAdapter?: ToolAdapter;
  credentialProvider?: ConnectionCredentialProvider;
  approvalAdapter?: ApprovalAdapter;
  sandboxAdapter?: SandboxAdapter;
  subRunAdapter?: SubRunAdapter;
  eventSink?: EventSink;
  executors?: StepExecutor[];
}

type ImportedRuntimeModule = CliRuntimeModule & {
  default?: CliRuntimeModule;
  runtime?: CliRuntimeModule;
  createRuntime?: (
    context: CliRuntimeContext,
  ) => CliRuntime | Promise<CliRuntime>;
  createRunStore?: (context: CliStoreContext) => RunStore | Promise<RunStore>;
};

const adapterMethod = (value: unknown, name: string): boolean =>
  value != null &&
  typeof value === "object" &&
  typeof (value as Record<string, unknown>)[name] === "function";

const validateRuntime = (runtime: CliRuntime): CliRuntime => {
  if (
    runtime.runStore &&
    (!adapterMethod(runtime.runStore, "createRun") ||
      !adapterMethod(runtime.runStore, "loadRun") ||
      !adapterMethod(runtime.runStore, "saveCheckpoint"))
  ) {
    throw new Error(
      "Runtime runStore must implement the RunStore lifecycle methods.",
    );
  }
  if (
    runtime.artifactStore &&
    (!adapterMethod(runtime.artifactStore, "put") ||
      !adapterMethod(runtime.artifactStore, "get"))
  ) {
    throw new Error(
      "Runtime artifactStore must implement ArtifactStore.put() and get().",
    );
  }
  if (runtime.model && !adapterMethod(runtime.model, "generate"))
    throw new Error("Runtime model must implement ModelAdapter.generate().");
  if (
    runtime.tools &&
    (!adapterMethod(runtime.tools, "listTools") ||
      !adapterMethod(runtime.tools, "executeTool"))
  ) {
    throw new Error(
      "Runtime tools must implement ToolAdapter.listTools() and executeTool().",
    );
  }
  if (
    runtime.connectionCredentials &&
    !adapterMethod(runtime.connectionCredentials, "getCredential")
  ) {
    throw new Error(
      "Runtime connectionCredentials must implement ConnectionCredentialProvider.getCredential().",
    );
  }
  if (runtime.approvals && !adapterMethod(runtime.approvals, "requestApproval"))
    throw new Error(
      "Runtime approvals must implement ApprovalAdapter.requestApproval().",
    );
  if (runtime.sandbox && !adapterMethod(runtime.sandbox, "execute"))
    throw new Error("Runtime sandbox must implement SandboxAdapter.execute().");
  if (runtime.subRuns && !adapterMethod(runtime.subRuns, "execute"))
    throw new Error("Runtime subRuns must implement SubRunAdapter.execute().");
  if (
    runtime.eventSinks &&
    (!Array.isArray(runtime.eventSinks) ||
      runtime.eventSinks.some((sink) => !adapterMethod(sink, "emit")))
  ) {
    throw new Error("Runtime eventSinks must be an array of EventSink values.");
  }
  if (
    runtime.stepExecutors &&
    (!Array.isArray(runtime.stepExecutors) ||
      runtime.stepExecutors.some(
        (executor) =>
          !executor ||
          typeof executor !== "object" ||
          typeof executor.type !== "string" ||
          !adapterMethod(executor, "execute"),
      ))
  ) {
    throw new Error("Runtime stepExecutors must implement StepExecutor.");
  }
  return runtime;
};

const normalizeRuntime = (runtime: CliRuntimeModule): CliRuntime => ({
  ...((runtime.runStore ?? runtime.store)
    ? { runStore: runtime.runStore ?? runtime.store }
    : {}),
  ...((runtime.artifactStore ?? runtime.artifacts)
    ? { artifactStore: runtime.artifactStore ?? runtime.artifacts }
    : {}),
  ...((runtime.model ?? runtime.modelAdapter)
    ? { model: runtime.model ?? runtime.modelAdapter }
    : {}),
  ...((runtime.tools ?? runtime.toolAdapter)
    ? { tools: runtime.tools ?? runtime.toolAdapter }
    : {}),
  ...((runtime.connectionCredentials ?? runtime.credentialProvider)
    ? {
        connectionCredentials:
          runtime.connectionCredentials ?? runtime.credentialProvider,
      }
    : {}),
  ...((runtime.approvals ?? runtime.approvalAdapter)
    ? { approvals: runtime.approvals ?? runtime.approvalAdapter }
    : {}),
  ...((runtime.sandbox ?? runtime.sandboxAdapter)
    ? { sandbox: runtime.sandbox ?? runtime.sandboxAdapter }
    : {}),
  ...((runtime.subRuns ?? runtime.subRunAdapter)
    ? { subRuns: runtime.subRuns ?? runtime.subRunAdapter }
    : {}),
  ...((runtime.eventSinks?.length ?? 0) > 0 || runtime.eventSink
    ? {
        eventSinks: [
          ...(runtime.eventSinks ?? []),
          ...(runtime.eventSink ? [runtime.eventSink] : []),
        ],
      }
    : {}),
  ...((runtime.stepExecutors?.length ?? 0) > 0 ||
  (runtime.executors?.length ?? 0) > 0
    ? { stepExecutors: runtime.stepExecutors ?? runtime.executors }
    : {}),
});

const defaultStepExecutors = (allowUnsafeWebhooks: boolean): StepExecutor[] => [
  new PromptStepExecutor(),
  new LoopStepExecutor(),
  ...(allowUnsafeWebhooks
    ? [new WebhookStepExecutor({ allowUnsafeDestinations: true })]
    : []),
  new ApprovalStepExecutor(),
  new CodeStepExecutor(),
  new SubRunStepExecutor(),
];

const resolveStepExecutors = (
  runtime: CliRuntime,
  options: { allowUnsafeWebhooks?: boolean } = {},
): StepExecutor[] => {
  const byType = new Map(
    defaultStepExecutors(options.allowUnsafeWebhooks === true).map(
      (executor) => [executor.type, executor],
    ),
  );
  for (const executor of runtime.stepExecutors ?? [])
    byType.set(executor.type, executor);
  return [...byType.values()];
};

const loadRuntime = async (
  modulePath: string | undefined,
  context: CliRuntimeContext,
): Promise<CliRuntime> => {
  if (!modulePath) return {};
  const absolutePath = path.resolve(modulePath);
  let imported: ImportedRuntimeModule;
  try {
    imported = (await import(
      pathToFileURL(absolutePath).href
    )) as ImportedRuntimeModule;
  } catch (error) {
    throw new Error(
      `Could not load runtime module ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const staticRuntime = imported.default ?? imported.runtime ?? imported;
  const composedRuntime = imported.createRuntime
    ? await imported.createRuntime(context)
    : normalizeRuntime(staticRuntime);
  if (!composedRuntime || typeof composedRuntime !== "object") {
    throw new Error(
      `Runtime module ${absolutePath} did not export a runtime object.`,
    );
  }
  const runtime =
    !composedRuntime.runStore && imported.createRunStore
      ? { ...composedRuntime, runStore: await imported.createRunStore(context) }
      : composedRuntime;
  return validateRuntime(runtime);
};

const loadRuntimeStore = async (
  modulePath: string | undefined,
  context: CliStoreContext,
): Promise<RunStore | undefined> => {
  if (!modulePath) return undefined;
  const absolutePath = path.resolve(modulePath);
  let imported: ImportedRuntimeModule;
  try {
    imported = (await import(
      pathToFileURL(absolutePath).href
    )) as ImportedRuntimeModule;
  } catch (error) {
    throw new Error(
      `Could not load runtime module ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const staticRuntime = imported.default ?? imported.runtime ?? imported;
  const store = imported.createRunStore
    ? await imported.createRunStore(context)
    : (staticRuntime.runStore ?? staticRuntime.store);
  if (
    store &&
    (!adapterMethod(store, "createRun") ||
      !adapterMethod(store, "loadRun") ||
      !adapterMethod(store, "saveCheckpoint"))
  ) {
    throw new Error(
      "Runtime runStore must implement the RunStore lifecycle methods.",
    );
  }
  return store;
};

const defaultConfigNames = [
  "agent-runtime.config.yaml",
  "agent-runtime.config.yml",
  "agent-runtime.config.json",
] as const;

const resolveConfig = async (
  requested?: string,
  searchDirectory = process.cwd(),
): Promise<AgentRuntimeConfig> => {
  if (requested) return loadAgentRuntimeConfig(requested);
  for (const candidate of defaultConfigNames) {
    const absolute = path.resolve(searchDirectory, candidate);
    try {
      await access(absolute);
      return await loadAgentRuntimeConfig(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return emptyAgentRuntimeConfig();
};

const mergeRuntimes = (
  configured: CliRuntime,
  moduleRuntime: CliRuntime,
): CliRuntime =>
  validateRuntime({
    ...configured,
    ...moduleRuntime,
    ...((configured.eventSinks?.length ?? 0) > 0 ||
    (moduleRuntime.eventSinks?.length ?? 0) > 0
      ? {
          eventSinks: [
            ...(configured.eventSinks ?? []),
            ...(moduleRuntime.eventSinks ?? []),
          ],
        }
      : {}),
  });

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
        case "run.cancelled":
          return `■ run cancelled (${event.runId})`;
        default:
          return undefined;
      }
    })();
    if (label) this.#io.stderr(`${label}\n`);
  }
}

const executionOptions = new Set([
  "config",
  "variables",
  "run-id",
  "store",
  "store-driver",
  "events",
  "artifacts",
  "runtime-module",
  "stream",
  "format",
  "show-reasoning",
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
    command === "run-manifest" &&
    (parsed.options.has("variables") || parsed.options.has("run-id"))
  ) {
    throw new Error(
      "--variables and --run-id cannot be combined with an agent run manifest; declare them in the agent run manifest.",
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
  const storeDirectory = resolvedStore.baseDirectory;
  const runId =
    command === "resume"
      ? target
      : (agentRunManifest?.runId ?? parsed.options.get("run-id"));
  const runtimeModulePath = parsed.options.get("runtime-module");
  const runtimeStore =
    command === "resume"
      ? await loadRuntimeStore(runtimeModulePath, {
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
      : path.resolve(eventsOption ?? path.join(storeDirectory, "events.jsonl"));
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
  const loadedModuleRuntime = await loadRuntime(runtimeModulePath, context);
  const moduleRuntime = runtimeStore
    ? validateRuntime({ ...loadedModuleRuntime, runStore: runtimeStore })
    : loadedModuleRuntime;
  const config = await resolveConfig(
    parsed.options.get("config"),
    configSearchDirectory,
  );
  const configuredRuntime = composeRuntime(
    manifest,
    config,
    {},
    {
      model: !moduleRuntime.model,
      tools: !moduleRuntime.tools,
      ...(moduleRuntime.connectionCredentials
        ? { connectionCredentials: moduleRuntime.connectionCredentials }
        : {}),
    },
  );
  const runtime = mergeRuntimes(configuredRuntime, moduleRuntime);
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
  const runner = new AgentRuntime({
    runStore: runtime.runStore ?? store,
    ...(agentManifestSource ? { agentManifestSource } : {}),
    stepExecutors: resolveStepExecutors(runtime, { allowUnsafeWebhooks: true }),
    conditionEvaluator: new JexlConditionEvaluator(),
    eventSinks: [
      ...(jsonlSink ? [new SafeLocalEventSink(jsonlSink)] : []),
      ...(streamingSink ? [streamingSink] : []),
      ...(runtime.eventSinks ?? []),
    ],
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.tools ? { tools: runtime.tools } : {}),
    ...(runtime.approvals ? { approvals: runtime.approvals } : {}),
    ...(runtime.sandbox ? { sandbox: runtime.sandbox } : {}),
    ...(runtime.subRuns ? { subRuns: runtime.subRuns } : {}),
    ...(runtime.artifactStore
      ? { artifacts: runtime.artifactStore }
      : artifactDirectory
        ? { artifacts: new FileArtifactStore(artifactDirectory) }
        : {}),
  });

  try {
    const result = await runner.run(
      command === "run-manifest" && agentRunManifest
        ? {
            agentRunManifest,
            ...(signal ? { signal } : {}),
          }
        : {
            manifest,
            ...(runId ? { runId } : {}),
            ...(variableOverrides ? { variables: variableOverrides } : {}),
            ...(signal ? { signal } : {}),
            ...(command === "resume" ? { resume: true } : {}),
          },
    );
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
          },
          null,
          2,
        )}\n`,
      );
    }
  } finally {
    await jsonlSink?.flush();
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
  /** Host-supplied adapters for embedded workers such as managed compute runtimes. */
  runtime?: CliRuntime;
  eventSinkFailurePolicy?: "continue" | "fail-run";
  signal?: AbortSignal;
  onMessage(message: WorkerMessage): void | Promise<void>;
}

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
  const moduleRuntime = await loadRuntime(runtimeReference, context);
  const hostRuntime = validateRuntime(options.runtime ?? {});
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
        : await resolveConfig(undefined, process.cwd());
  const configuredRuntime = composeRuntime(
    manifest,
    config,
    requestSuppliedConfiguration
      ? { environment: options.environment ?? {} }
      : options.environment
        ? { environment: options.environment }
        : {},
    {
      model: !moduleRuntime.model && !hostRuntime.model,
      tools: !moduleRuntime.tools && !hostRuntime.tools,
      ...(options.modelPolicy ? { modelPolicy: options.modelPolicy } : {}),
      ...(options.toolOptions ||
      hostRuntime.connectionCredentials ||
      moduleRuntime.connectionCredentials
        ? {
            toolOptions: {
              ...options.toolOptions,
              ...((hostRuntime.connectionCredentials ??
              moduleRuntime.connectionCredentials)
                ? {
                    credentialProvider:
                      hostRuntime.connectionCredentials ??
                      moduleRuntime.connectionCredentials,
                  }
                : {}),
            },
          }
        : {}),
    },
  );
  const runtime = mergeRuntimes(
    mergeRuntimes(configuredRuntime, moduleRuntime),
    hostRuntime,
  );
  const store =
    runtime.runStore ??
    (storeDriver === "sqlite"
      ? new (
          await import("@clearideas/agent-runtime-store-sqlite")
        ).SqliteRunStore(storeLocation)
      : new FileRunStore(storeLocation));
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

  const runner = new AgentRuntime({
    runStore: store,
    // Webhook execution is host-supplied in worker mode so destination policy
    // cannot be bypassed by a remote manifest.
    stepExecutors: resolveStepExecutors(runtime),
    conditionEvaluator: new JexlConditionEvaluator(),
    eventSinks: [
      new PortableWorkerEventSink(options.onMessage),
      ...(runtime.eventSinks ?? []),
    ],
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.tools ? { tools: runtime.tools } : {}),
    ...(runtime.approvals ? { approvals: runtime.approvals } : {}),
    ...(runtime.sandbox ? { sandbox: runtime.sandbox } : {}),
    ...(runtime.subRuns ? { subRuns: runtime.subRuns } : {}),
    artifacts,
    ...(options.maxParallelSteps
      ? { maxParallelSteps: options.maxParallelSteps }
      : {}),
    ...(options.eventSinkFailurePolicy
      ? { eventSinkFailurePolicy: options.eventSinkFailurePolicy }
      : {}),
  });
  return runner.run({
    manifest,
    ...(request.runId ? { runId: request.runId } : {}),
    ...(invocationVariables ? { variables: invocationVariables } : {}),
    ...(request.execution ? { execution: request.execution } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(invocation.action === "resume"
      ? {
          resume: true,
          ...("allowRunningTakeover" in request && request.allowRunningTakeover
            ? { allowRunningTakeover: true }
            : {}),
        }
      : {}),
  });
};

const readStandardInput = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
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
