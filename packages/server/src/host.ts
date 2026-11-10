/**
 * Host composition shared by every Agent Runtime host: the CLI's `run` and
 * `worker` commands and the OpenAI-compatible server.
 *
 * This module decides what a manifest may use. It loads a trusted runtime
 * module, validates the adapters it supplies, composes the runtime
 * configuration, merges the two with host-supplied adapters, selects step
 * executors for a trust mode, and assembles `AgentRuntime` dependencies. Keep
 * it the only place that does so, so the host boundary is reviewed once.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { JexlConditionEvaluator } from "@clearideas/agent-runtime-condition-jexl";
import {
  composeRuntime,
  emptyAgentRuntimeConfig,
  loadAgentRuntimeConfig,
  type AgentRuntimeConfig,
  type ConfiguredMcpToolAdapterOptions,
  type ModelAuthorizationPolicy,
  type WorkspaceCompositionOptions,
} from "@clearideas/agent-runtime-config";
import type {
  AgentManifest,
  ExecutionPolicies,
  RunEvent,
} from "@clearideas/agent-runtime-contracts";
import { executionPoliciesSchema } from "@clearideas/agent-runtime-contracts";
import type {
  AgentManifestSource,
  AgentRuntimeDependencies,
  AgentRuntimeMessagesOptions,
  ApprovalAdapter,
  ArtifactStore,
  ConnectionCredentialProvider,
  ContextSummarizerAdapter,
  EventSink,
  ModelAdapter,
  RunSandboxProvider,
  RunStore,
  SandboxAdapter,
  StepExecutor,
  SubRunAdapter,
  ToolAdapter,
  WorkspaceProvider,
} from "@clearideas/agent-runtime-core";
import type { SandboxProvider } from "@clearideas/agent-runtime-sandbox";
import { LoopStepExecutor } from "@clearideas/agent-runtime-step-loop";
import {
  PromptMessageHistoryCompactor,
  PromptStepExecutor,
} from "@clearideas/agent-runtime-step-prompt";
import {
  ApprovalStepExecutor,
  CodeStepExecutor,
  SubRunStepExecutor,
  WebhookStepExecutor,
} from "@clearideas/agent-runtime-step-standard";

/** Adapters a trusted runtime module may contribute to a host. */
export interface HostRuntime {
  /** Called once after execution, including failed setup. Own only module-created resources. */
  shutdown?: () => void | Promise<void>;
  runStore?: RunStore;
  artifactStore?: ArtifactStore;
  model?: ModelAdapter;
  tools?: ToolAdapter;
  connectionCredentials?: ConnectionCredentialProvider;
  approvals?: ApprovalAdapter;
  sandbox?: SandboxAdapter;
  subRuns?: SubRunAdapter;
  /** Resolves manifest workspace bindings instead of the configuration's `workspaces` section. */
  workspaces?: WorkspaceProvider;
  /** Opens run sandboxes instead of the configuration's `sandbox` section. */
  runSandbox?: RunSandboxProvider;
  /** Backs `sandbox.driver: host` in the configuration. */
  sandboxProvider?: SandboxProvider;
  eventSinks?: EventSink[];
  stepExecutors?: StepExecutor[];
  /** Host default execution policies; manifests and steps override them. */
  policies?: ExecutionPolicies;
  /** Host execution policies applied last; manifests cannot override them. */
  enforcedPolicies?: ExecutionPolicies;
  /** Observes, changes, or replaces context summarization. */
  summarizer?: ContextSummarizerAdapter;
  /**
   * Conversation message options, merged over the configuration's `messages`
   * section: for example `authorizeArtifact` or a KMS-backed signer.
   */
  messages?: AgentRuntimeMessagesOptions;
}

/** Where a host keeps run state. */
export type HostStoreDriver = "file" | "sqlite" | "memory" | "module";

/** What a runtime module's `createRuntime` receives. */
export interface HostRuntimeContext {
  manifest: AgentManifest;
  runId?: string;
  storeDirectory: string;
  storeDriver?: HostStoreDriver;
  storeLocation?: string;
  eventFile?: string;
  artifactDirectory?: string;
}

/** What a runtime module's `createRunStore` receives. */
export type HostStoreContext = Omit<HostRuntimeContext, "manifest">;

/** The exports a runtime module may use, including accepted aliases. */
export interface HostRuntimeModule extends HostRuntime {
  store?: RunStore;
  artifacts?: ArtifactStore;
  modelAdapter?: ModelAdapter;
  toolAdapter?: ToolAdapter;
  credentialProvider?: ConnectionCredentialProvider;
  approvalAdapter?: ApprovalAdapter;
  sandboxAdapter?: SandboxAdapter;
  subRunAdapter?: SubRunAdapter;
  workspaceProvider?: WorkspaceProvider;
  runSandboxProvider?: RunSandboxProvider;
  eventSink?: EventSink;
  executors?: StepExecutor[];
}

type ImportedRuntimeModule = HostRuntimeModule & {
  default?: HostRuntimeModule;
  runtime?: HostRuntimeModule;
  createRuntime?: (
    context: HostRuntimeContext,
  ) => HostRuntime | Promise<HostRuntime>;
  createRunStore?: (context: HostStoreContext) => RunStore | Promise<RunStore>;
};

/**
 * How far the host trusts the manifests it runs.
 *
 * - `local-operator`: an operator runs manifests they wrote on their own
 *   machine (`agent-runtime run`). Webhook steps may reach any destination.
 * - `untrusted-request`: manifests or inputs arrive from another party (the
 *   worker protocol, the HTTP server). Webhook steps run only with a
 *   host-supplied executor that authorizes destinations.
 */
export type HostTrustMode = "local-operator" | "untrusted-request";

const adapterMethod = (value: unknown, name: string): boolean =>
  value != null &&
  typeof value === "object" &&
  typeof (value as Record<string, unknown>)[name] === "function";

/** Reject adapters that do not implement their port. */
export const validateHostRuntime = (runtime: HostRuntime): HostRuntime => {
  if (runtime.shutdown !== undefined && typeof runtime.shutdown !== "function")
    throw new Error("Runtime shutdown must be a function.");
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
  if (runtime.summarizer && !adapterMethod(runtime.summarizer, "summarize"))
    throw new Error(
      "Runtime summarizer must implement ContextSummarizerAdapter.summarize().",
    );
  if (
    runtime.workspaces &&
    !adapterMethod(runtime.workspaces, "resolveWorkspace")
  ) {
    throw new Error(
      "Runtime workspaces must implement WorkspaceProvider.resolveWorkspace().",
    );
  }
  if (
    runtime.runSandbox &&
    (!adapterMethod(runtime.runSandbox, "open") ||
      !adapterMethod(runtime.runSandbox, "validate") ||
      !adapterMethod(runtime.runSandbox, "tools"))
  ) {
    throw new Error(
      "Runtime runSandbox must implement RunSandboxProvider.tools(), validate(), and open().",
    );
  }
  if (
    runtime.sandboxProvider &&
    (!adapterMethod(runtime.sandboxProvider, "create") ||
      !adapterMethod(runtime.sandboxProvider, "execute") ||
      !adapterMethod(runtime.sandboxProvider, "terminate"))
  ) {
    throw new Error(
      "Runtime sandboxProvider must implement the SandboxProvider lifecycle methods.",
    );
  }
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

/** Resolve the accepted export aliases of a static runtime module. */
const normalizeRuntime = (runtime: HostRuntimeModule): HostRuntime => ({
  ...(runtime.shutdown ? { shutdown: runtime.shutdown } : {}),
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
  ...((runtime.workspaces ?? runtime.workspaceProvider)
    ? { workspaces: runtime.workspaces ?? runtime.workspaceProvider }
    : {}),
  ...((runtime.runSandbox ?? runtime.runSandboxProvider)
    ? { runSandbox: runtime.runSandbox ?? runtime.runSandboxProvider }
    : {}),
  ...(runtime.sandboxProvider
    ? { sandboxProvider: runtime.sandboxProvider }
    : {}),
  ...(runtime.policies
    ? { policies: executionPoliciesSchema.parse(runtime.policies) }
    : {}),
  ...(runtime.enforcedPolicies
    ? {
        enforcedPolicies: executionPoliciesSchema.parse(
          runtime.enforcedPolicies,
        ),
      }
    : {}),
  ...(runtime.summarizer ? { summarizer: runtime.summarizer } : {}),
  ...(runtime.messages ? { messages: runtime.messages } : {}),
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

const defaultStepExecutors = (trust: HostTrustMode): StepExecutor[] => [
  new PromptStepExecutor(),
  new LoopStepExecutor(),
  // Only a local operator's own manifests may reach arbitrary webhook
  // destinations. Other hosts supply a WebhookStepExecutor with
  // authorizeDestination through the runtime module's stepExecutors.
  ...(trust === "local-operator"
    ? [new WebhookStepExecutor({ allowUnsafeDestinations: true })]
    : []),
  new ApprovalStepExecutor(),
  new CodeStepExecutor(),
  new SubRunStepExecutor(),
];

/**
 * The step executors for a trust mode. Executors supplied by the runtime
 * replace the default for their step type.
 */
export const resolveHostStepExecutors = (
  runtime: HostRuntime,
  trust: HostTrustMode,
): StepExecutor[] => {
  const byType = new Map(
    defaultStepExecutors(trust).map((executor) => [executor.type, executor]),
  );
  for (const executor of runtime.stepExecutors ?? [])
    byType.set(executor.type, executor);
  return [...byType.values()];
};

const importRuntimeModule = async (
  modulePath: string,
): Promise<{ absolutePath: string; imported: ImportedRuntimeModule }> => {
  const absolutePath = path.resolve(modulePath);
  try {
    return {
      absolutePath,
      imported: (await import(
        pathToFileURL(absolutePath).href
      )) as ImportedRuntimeModule,
    };
  } catch (error) {
    throw new Error(
      `Could not load runtime module ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Load a trusted local ESM runtime module and return its validated
 * adapters. A module exports adapters directly, as `default` or `runtime`,
 * or through `createRuntime(context)`. Without a path, returns no adapters.
 * A host that manages its own run store passes `createRunStore: false`, so a
 * module's `createRunStore` is not called for every run.
 */
export const loadHostRuntime = async (
  modulePath: string | undefined,
  context: HostRuntimeContext,
  options: { createRunStore?: boolean } = {},
): Promise<HostRuntime> => {
  if (!modulePath) return {};
  const { absolutePath, imported } = await importRuntimeModule(modulePath);
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
    !composedRuntime.runStore &&
    imported.createRunStore &&
    options.createRunStore !== false
      ? { ...composedRuntime, runStore: await imported.createRunStore(context) }
      : composedRuntime;
  return validateHostRuntime(runtime);
};

/** Load only a runtime module's run store, for commands that need no manifest. */
export const loadHostRunStore = async (
  modulePath: string | undefined,
  context: HostStoreContext,
): Promise<RunStore | undefined> => {
  if (!modulePath) return undefined;
  const { imported } = await importRuntimeModule(modulePath);
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

/** Runtime configuration files discovered beside a manifest, in order. */
export const RUNTIME_CONFIG_FILE_NAMES = [
  "agent-runtime.config.yaml",
  "agent-runtime.config.yml",
  "agent-runtime.config.json",
] as const;

/**
 * Load the requested runtime configuration, or the first discovered
 * `agent-runtime.config.*` in `searchDirectory`, or an empty configuration.
 */
export const resolveAgentRuntimeConfig = async (
  requested?: string,
  searchDirectory = process.cwd(),
): Promise<AgentRuntimeConfig> => {
  if (requested) return loadAgentRuntimeConfig(requested);
  for (const candidate of RUNTIME_CONFIG_FILE_NAMES) {
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

/**
 * Workspace and sandbox adapters from runtimes, highest precedence first.
 * Host-supplied adapters take precedence over the configuration.
 */
export const hostWorkspaceCompositionOptions = (
  ...runtimes: HostRuntime[]
): WorkspaceCompositionOptions => {
  const options: WorkspaceCompositionOptions = {};
  for (const runtime of runtimes) {
    if (runtime.workspaces && !options.provider)
      options.provider = runtime.workspaces;
    if (runtime.runSandbox && !options.runSandbox)
      options.runSandbox = runtime.runSandbox;
    if (runtime.sandboxProvider && !options.sandboxProvider)
      options.sandboxProvider = runtime.sandboxProvider;
  }
  return options;
};

/** Overlay a runtime on another; message options and event sinks combine. */
export const mergeHostRuntimes = (
  base: HostRuntime,
  overlay: HostRuntime,
): HostRuntime =>
  validateHostRuntime({
    ...base,
    ...overlay,
    ...(base.messages || overlay.messages
      ? { messages: { ...base.messages, ...overlay.messages } }
      : {}),
    ...((base.eventSinks?.length ?? 0) > 0 ||
    (overlay.eventSinks?.length ?? 0) > 0
      ? {
          eventSinks: [
            ...(base.eventSinks ?? []),
            ...(overlay.eventSinks ?? []),
          ],
        }
      : {}),
  });

export interface ComposeHostRuntimeOptions {
  /** Environment visible to the configuration's references. Defaults to the process environment. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Host policy applied before configured model adapters are created. */
  modelPolicy?: ModelAuthorizationPolicy;
  /** Host policy and credentials applied to configured MCP adapters. */
  toolOptions?: ConfiguredMcpToolAdapterOptions;
  /** Host policy, hooks, and providers applied to configured workspaces and the run sandbox. */
  workspaceOptions?: WorkspaceCompositionOptions;
}

/**
 * Compose a manifest's runtime: adapters from the configuration, overlaid by
 * supplied runtimes in increasing precedence (for example, the runtime
 * module, then adapters an embedding host passes in code). A supplied model
 * or tool adapter replaces the configured one.
 */
export const composeHostRuntime = (
  manifest: AgentManifest,
  config: AgentRuntimeConfig,
  supplied: readonly HostRuntime[],
  options: ComposeHostRuntimeOptions = {},
): HostRuntime => {
  const highestFirst = [...supplied].reverse();
  const credentialProvider = highestFirst.find(
    (runtime) => runtime.connectionCredentials,
  )?.connectionCredentials;
  const configured = composeRuntime(
    manifest,
    config,
    options.environment ? { environment: options.environment } : {},
    {
      model: !supplied.some((runtime) => runtime.model),
      tools: !supplied.some((runtime) => runtime.tools),
      workspaceOptions: {
        ...options.workspaceOptions,
        ...hostWorkspaceCompositionOptions(...highestFirst),
      },
      ...(options.modelPolicy ? { modelPolicy: options.modelPolicy } : {}),
      ...(options.toolOptions || credentialProvider
        ? {
            toolOptions: {
              ...options.toolOptions,
              ...(credentialProvider ? { credentialProvider } : {}),
            },
          }
        : {}),
    },
  );
  return supplied.reduce<HostRuntime>(
    (merged, runtime) => mergeHostRuntimes(merged, runtime),
    validateHostRuntime(configured),
  );
};

/**
 * A runtime's message options with the prompt package's history compactor,
 * so summarizing history policies pass preflight.
 */
export const withHistoryCompactor = (
  options: AgentRuntimeMessagesOptions | undefined,
): AgentRuntimeMessagesOptions => ({
  compactor: new PromptMessageHistoryCompactor(),
  ...options,
});

export interface HostRuntimeDependencyOptions {
  trust: HostTrustMode;
  runStore: RunStore;
  artifacts?: ArtifactStore | undefined;
  agentManifestSource?: AgentManifestSource | undefined;
  /** Host sinks that receive events before the runtime's own sinks. */
  eventSinks?: EventSink[];
  maxParallelSteps?: number | undefined;
  eventSinkFailurePolicy?: "continue" | "fail-run" | undefined;
  onEventSinkError?: (error: unknown, event: RunEvent, sink: EventSink) => void;
}

/** `AgentRuntime` dependencies for a composed host runtime. */
export const hostRuntimeDependencies = (
  runtime: HostRuntime,
  options: HostRuntimeDependencyOptions,
): AgentRuntimeDependencies => ({
  ...(options.onEventSinkError
    ? { onEventSinkError: options.onEventSinkError }
    : {}),
  runStore: options.runStore,
  ...(options.agentManifestSource
    ? { agentManifestSource: options.agentManifestSource }
    : {}),
  stepExecutors: resolveHostStepExecutors(runtime, options.trust),
  conditionEvaluator: new JexlConditionEvaluator(),
  eventSinks: [...(options.eventSinks ?? []), ...(runtime.eventSinks ?? [])],
  ...(runtime.model ? { model: runtime.model } : {}),
  ...(runtime.tools ? { tools: runtime.tools } : {}),
  ...(runtime.approvals ? { approvals: runtime.approvals } : {}),
  ...(runtime.sandbox ? { sandbox: runtime.sandbox } : {}),
  ...(runtime.subRuns ? { subRuns: runtime.subRuns } : {}),
  ...(runtime.workspaces ? { workspaces: runtime.workspaces } : {}),
  ...(runtime.runSandbox ? { runSandbox: runtime.runSandbox } : {}),
  ...(runtime.policies ? { policies: runtime.policies } : {}),
  ...(runtime.enforcedPolicies
    ? { enforcedPolicies: runtime.enforcedPolicies }
    : {}),
  ...(runtime.summarizer ? { summarizer: runtime.summarizer } : {}),
  messages: withHistoryCompactor(runtime.messages),
  ...(options.artifacts ? { artifacts: options.artifacts } : {}),
  ...(options.maxParallelSteps
    ? { maxParallelSteps: options.maxParallelSteps }
    : {}),
  ...(options.eventSinkFailurePolicy
    ? { eventSinkFailurePolicy: options.eventSinkFailurePolicy }
    : {}),
});
