import { RUNTIME_VERSION } from "./version.js";
import type {
  ArtifactRef,
  AgentManifest,
  AgentRunBudget,
  AgentRunExecution,
  AgentRunManifest,
  ExecutionCursor,
  JsonObject,
  JsonValue,
  ModelUsage,
  RunCheckpoint,
  RunBudgetState,
  RunError,
  RunEvent,
  AgentStep,
  AgentVariableOverride,
  ExecutionPolicies,
  RunResult,
  StatePatch,
  StepResult,
  TranscriptItem,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import {
  agentRunBudgetSchema,
  agentManifestSchema,
  parseAgentRunManifest,
  parseRunCheckpoint,
  valueMatchesAgentVariableType,
} from "@clearideas/agent-runtime-contracts";
import { parse as parseYaml } from "yaml";

import type {
  ApprovalAdapter,
  ArtifactStore,
  Clock,
  ContextSummarizerAdapter,
  CompletedRunRecord,
  EventSink,
  IdGenerator,
  AgentManifestSource,
  ModelAdapter,
  ResolvedWorkspace,
  RunRecord,
  RunSandboxProvider,
  RunSandboxSession,
  RunStore,
  SandboxAdapter,
  SandboxBudgetState,
  SubRunAdapter,
  ToolAdapter,
  WorkspaceProvider,
  WorkspaceResolutionContext,
} from "./ports/index.js";
import {
  cryptoIdGenerator,
  restrictWorkspace,
  systemClock,
} from "./ports/index.js";
import { buildExecutionWaves } from "./execution-plan.js";
import { resolveStepPolicies } from "./policies.js";
import { applyStatePatch, snapshotState } from "./state.js";

const countManifestSteps = (steps: readonly AgentStep[]): number => {
  const pending = [...steps];
  let count = 0;
  while (pending.length > 0) {
    const step = pending.pop()!;
    count += 1;
    if (step.type === "loop") pending.push(...step.steps);
  }
  return count;
};

export interface StepExecutionResult {
  output?: JsonValue;
  statePatch?: StatePatch;
  transcript?: TranscriptItem[];
  artifacts?: ArtifactRef[];
  metadata?: JsonObject;
  /** Complete the run after committing this step; later steps do not run. */
  endRun?: boolean;
}

export interface StepExecutionContext {
  runId: string;
  manifest: AgentManifest;
  step: AgentStep;
  stepIndex: number;
  stepPath?: string;
  variables: Readonly<VariableState>;
  /** Prior committed top-level results, in execution order. */
  stepResults?: Readonly<StepResult[]>;
  signal?: AbortSignal | undefined;
  model?: ModelAdapter | undefined;
  tools?: ToolAdapter | undefined;
  artifacts?: ArtifactStore | undefined;
  approvals?: ApprovalAdapter | undefined;
  sandbox?: SandboxAdapter | undefined;
  subRuns?: SubRunAdapter | undefined;
  /** Host workspaces bound by the manifest, resolved before the run started. */
  workspaces?: readonly ResolvedWorkspace[] | undefined;
  /** Opens (once per run) and returns the run sandbox session. */
  runSandbox?: (() => Promise<RunSandboxSession>) | undefined;
  tokenBudget?: TokenBudgetContext | undefined;
  /** Effective policies: host defaults, then manifest, then step, then host-enforced. */
  policies?: ExecutionPolicies | undefined;
  /** The host's context summarizer, when it supplies one. */
  summarizer?: ContextSummarizerAdapter | undefined;
  emit(type: string, data?: JsonObject): Promise<RunEvent>;
  /** Present when this step is resuming from a nested checkpoint. */
  resume?: {
    cursor: ExecutionCursor;
    continuation?: JsonObject;
    transcript?: TranscriptItem[];
    artifacts?: ArtifactRef[];
  };
  /** Execute a registered child step without committing the parent step. */
  executeChild?(
    step: AgentStep,
    variables: Readonly<VariableState>,
    stepPath: string,
  ): Promise<StepExecutionResult>;
  /** Commit resumable state while a nested step remains active. */
  checkpoint?(input: NestedCheckpointInput): Promise<void>;
  evaluateCondition?(
    expression: string,
    variables: Readonly<VariableState>,
  ): Promise<boolean>;
}

export interface TokenBudgetContext {
  readonly maxTotalTokens: number;
  readonly consumedTokens: number;
  consume(usage: ModelUsage): RunBudgetState;
}

export interface NestedCheckpointInput {
  state: VariableState;
  cursor?: Omit<ExecutionCursor, "stepIndex">;
  continuation?: JsonObject;
  /** Cumulative transcript produced by this step since it began or resumed. */
  transcript?: TranscriptItem[];
  /** Cumulative artifacts produced by this step since it began or resumed. */
  artifacts?: ArtifactRef[];
}

/** What a step executor can check before a run starts. */
export interface StepPreflightContext {
  manifest: AgentManifest;
  model?: ModelAdapter | undefined;
  tools?: ToolAdapter | undefined;
  artifacts?: ArtifactStore | undefined;
  approvals?: ApprovalAdapter | undefined;
  sandbox?: SandboxAdapter | undefined;
  subRuns?: SubRunAdapter | undefined;
  runSandbox?: RunSandboxProvider | undefined;
}

export interface StepExecutor<TStep extends AgentStep = AgentStep> {
  readonly type: TStep["type"];
  execute(
    context: StepExecutionContext & { step: TStep },
  ): Promise<StepExecutionResult>;
  /**
   * Report host configuration this step needs but does not have, before the
   * run starts. Return one message per problem; an empty list means ready.
   */
  preflight?(
    step: TStep,
    context: StepPreflightContext,
  ): string[] | Promise<string[]>;
}

export interface ConditionEvaluator {
  evaluate(
    expression: string,
    variables: Readonly<VariableState>,
  ): boolean | Promise<boolean>;
  /** Throw when an expression cannot be evaluated; used before a run starts. */
  validate?(expression: string): void | Promise<void>;
}

export interface ManifestHasher {
  hash(manifest: AgentManifest): string | Promise<string>;
}

export interface AgentRuntimeDependencies {
  runStore: RunStore;
  agentManifestSource?: AgentManifestSource;
  eventSinks?: EventSink[];
  stepExecutors: Iterable<StepExecutor>;
  model?: ModelAdapter;
  tools?: ToolAdapter;
  artifacts?: ArtifactStore;
  approvals?: ApprovalAdapter;
  sandbox?: SandboxAdapter;
  subRuns?: SubRunAdapter;
  /** Resolves manifest workspace bindings to host-authorized stores. */
  workspaces?: WorkspaceProvider;
  /** Opens the per-run sandbox in which every workspace operation executes. */
  runSandbox?: RunSandboxProvider;
  conditionEvaluator?: ConditionEvaluator;
  clock?: Clock;
  idGenerator?: IdGenerator;
  manifestHasher?: ManifestHasher;
  runtimeVersion?: string;
  /** Host ceiling for dependency-safe top-level step concurrency. Defaults to 8. */
  maxParallelSteps?: number;
  /** Host default execution policies; manifests and steps override them. */
  policies?: ExecutionPolicies;
  /**
   * Host execution policies applied after the manifest and step: a manifest
   * cannot override them. Use them for limits an agent must not raise.
   */
  enforcedPolicies?: ExecutionPolicies;
  /** Observes, changes, or replaces context summarization. */
  summarizer?: ContextSummarizerAdapter;
  /** Event sinks are observational by default and cannot invalidate a commit. */
  eventSinkFailurePolicy?: "continue" | "fail-run";
  onEventSinkError?: (error: unknown, event: RunEvent, sink: EventSink) => void;
}

export interface RunRequest {
  /** Portable agent run contract. The referenced agent is loaded through AgentManifestSource. */
  agentRunManifest?: AgentRunManifest;
  /** Resolved-agent embedding convenience; mutually exclusive with agentRunManifest. */
  manifest?: AgentManifest;
  manifestReference?: string;
  runId?: string;
  variables?: AgentVariableOverride[];
  /** Step scheduling for resolved-agent embedding and execution adapters. */
  execution?: AgentRunExecution;
  /** Replaces the persisted cumulative token limit for this run or resume attempt. */
  budget?: AgentRunBudget;
  signal?: AbortSignal;
  /** Resume from the latest committed checkpoint for runId. */
  resume?: boolean;
  /** Allow recovery to supersede a run still marked running. Host orchestration must prove ownership expired. */
  allowRunningTakeover?: boolean;
}

export interface AgentExecutionResult extends RunResult {
  /** Backward-compatible alias for state. */
  variables: VariableState;
}

interface ChildExecutionInput {
  runId: string;
  manifest: AgentManifest;
  parentStepIndex: number;
  step: AgentStep;
  stepPath: string;
  variables: Readonly<VariableState>;
  workspaces: readonly ResolvedWorkspace[];
  runSandbox: (() => Promise<RunSandboxSession>) | undefined;
  signal?: AbortSignal | undefined;
  latestCheckpoint: RunCheckpoint | null;
  stepResults: Readonly<StepResult[]>;
  checkpoint: (input: NestedCheckpointInput) => Promise<void>;
}

interface TopLevelStepOutcome {
  step: AgentStep;
  stepIndex: number;
  skipped: boolean;
  result?: StepExecutionResult;
  stepResult?: StepResult;
  /** Set when the step failed and its onError policy continued the run. */
  handledError?: RunError;
}

/**
 * Errors that always end the attempt, whatever a step's onError policy says:
 * suspension, interruption, cancellation, and an aborted run signal.
 */
const isControlFlowError = (
  error: unknown,
  signal: AbortSignal | undefined,
): boolean =>
  signal?.aborted === true ||
  isRunSuspendedError(error) ||
  isRunInterruptedError(error) ||
  isRunCancelledError(error);

/** The output and state a step records when onError: continue handles a failure. */
const handledErrorResult = (
  step: AgentStep,
  error: RunError,
): StepExecutionResult => {
  const output: JsonObject = {
    error: { code: error.code, message: error.message },
  };
  return {
    output,
    ...(step.outputVariable
      ? { statePatch: { set: { [step.outputVariable]: output } } }
      : {}),
    metadata: {
      failed: true,
      handled: true,
      error: { code: error.code, message: error.message },
    },
  };
};

class TopLevelStepExecutionError extends Error {
  readonly step: AgentStep;
  readonly cause: unknown;

  constructor(step: AgentStep, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TopLevelStepExecutionError";
    this.step = step;
    this.cause = cause;
  }
}

/**
 * Cooperative control-flow signal used by executors after committing a
 * resumable checkpoint. Agent Runtime persists a suspended lifecycle state
 * instead of treating the yielded attempt as a failure.
 */
export class RunSuspendedError extends Error {
  readonly code = "RUN_SUSPENDED";
  readonly reason: string;
  readonly details: JsonObject | undefined;

  constructor(reason: string, details?: JsonObject) {
    super(`Run suspended: ${reason}`);
    this.name = "RunSuspendedError";
    this.reason = reason;
    this.details = details;
  }
}

export const isRunSuspendedError = (
  error: unknown,
): error is RunSuspendedError =>
  error instanceof RunSuspendedError ||
  (error instanceof Error &&
    error.name === "RunSuspendedError" &&
    (error as Error & { code?: string }).code === "RUN_SUSPENDED");

/** Suspension reason used when a host pauses a run through its abort signal. */
export const RUN_PAUSED_REASON = "paused";

/**
 * A pause request. Abort a run's signal with this reason to suspend the run
 * at its latest checkpoint instead of cancelling it.
 */
export const createRunPauseRequest = (
  details?: JsonObject,
): RunSuspendedError => new RunSuspendedError(RUN_PAUSED_REASON, details);

export type RunSuspensionKind =
  "awaiting-input" | "awaiting-child" | "awaiting-budget" | "paused" | "other";

/** Classify a suspension reason for hosts and user interfaces. */
export const suspensionKind = (reason: string): RunSuspensionKind => {
  switch (reason) {
    case "approval":
      return "awaiting-input";
    case "sub-run":
      return "awaiting-child";
    case "token-budget":
      return "awaiting-budget";
    case RUN_PAUSED_REASON:
      return "paused";
    default:
      return "other";
  }
};

/**
 * Infrastructure stopped the attempt (an execution timeout, a shutdown, a
 * lost lease). Abort a run's signal with this reason, or throw it, to leave
 * the run `interrupted` and resumable rather than cancelled.
 */
export class RunInterruptedError extends Error {
  readonly code = "RUN_INTERRUPTED";
  readonly retryable = true;
  readonly reason: string;
  readonly details: JsonObject | undefined;

  constructor(reason: string, details?: JsonObject) {
    super(`Run interrupted: ${reason}`);
    this.name = "RunInterruptedError";
    this.reason = reason;
    this.details = details;
  }
}

/**
 * True for RunInterruptedError and for any error that marks itself as an
 * interruption with a string `interruption` reason (for example an execution
 * engine's timeout), so engines need not depend on this package.
 */
export const isRunInterruptedError = (
  error: unknown,
): error is Error & { reason?: string; details?: JsonObject } =>
  error instanceof RunInterruptedError ||
  (error instanceof Error &&
    ((error as Error & { code?: string }).code === "RUN_INTERRUPTED" ||
      typeof (error as Error & { interruption?: unknown }).interruption ===
        "string"));

const interruptionReason = (error: Error): string => {
  const marked = error as Error & { reason?: unknown; interruption?: unknown };
  if (typeof marked.reason === "string") return marked.reason;
  if (typeof marked.interruption === "string") return marked.interruption;
  return "interrupted";
};

/** A step ended the run as cancelled (for example, a rejected approval with onReject: cancel). */
export class RunCancelledError extends Error {
  readonly code = "RUN_CANCELLED";
  readonly details: JsonObject | undefined;

  constructor(message: string, details?: JsonObject) {
    super(message);
    this.name = "RunCancelledError";
    this.details = details;
  }
}

export const isRunCancelledError = (
  error: unknown,
): error is RunCancelledError =>
  error instanceof RunCancelledError ||
  (error instanceof Error &&
    (error as Error & { code?: string }).code === "RUN_CANCELLED");

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** A deterministic cryptographic manifest fingerprint for checkpoint safety. */
export const defaultManifestHasher: ManifestHasher = {
  hash: async (manifest) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stableStringify(manifest)),
    );
    return `sha256:${[...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
  },
};

/** A classified adapter failure. Retrying still requires an idempotent operation. */
export class AgentRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    readonly suggestedAction?: string,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

const toRunError = (error: unknown): RunError => {
  const source = error instanceof Error ? error : new Error(String(error));
  const classified = source as Error & { code?: unknown; retryable?: unknown };
  const code =
    typeof classified.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,79}$/.test(classified.code)
      ? classified.code
      : "AGENT_EXECUTION_FAILED";
  return {
    code,
    message: source.message,
    retryable:
      code !== "AGENT_EXECUTION_FAILED" && classified.retryable === true,
    ...(source.name !== "Error" || source instanceof AgentRuntimeError
      ? {
          details: {
            ...(source.name === "Error" ? {} : { name: source.name }),
            ...(source instanceof AgentRuntimeError && source.suggestedAction
              ? { suggestedAction: source.suggestedAction }
              : {}),
          },
        }
      : {}),
  };
};

const isAbortError = (signal?: AbortSignal): boolean =>
  signal?.aborted === true;

const assertParallelWaveStatePatches = (
  outcomes: TopLevelStepOutcome[],
): void => {
  if (outcomes.length < 2) return;
  for (const outcome of outcomes) {
    if (outcome.skipped || !outcome.result?.statePatch) continue;
    const patch = outcome.result.statePatch;
    const allowed = outcome.step.outputVariable;
    const writes = Object.keys(patch.set ?? {});
    const hasUnexpectedWrite =
      writes.some((key) => key !== allowed) || (patch.unset?.length ?? 0) > 0;
    if (hasUnexpectedWrite) {
      throw new Error(
        `Parallel step ${outcome.step.id} attempted to mutate state outside its outputVariable`,
      );
    }
  }
};

export const resolveAgentVariables = (
  manifest: AgentManifest,
  supplied: AgentVariableOverride[] | undefined,
): VariableState => {
  const definitions = manifest.variables ?? [];
  const definitionsByKey = new Map(
    definitions.map((definition) => [definition.key, definition]),
  );
  const state: VariableState = {};

  for (const definition of definitions) {
    if (definition.value !== undefined) {
      state[definition.key] = structuredClone(definition.value);
    }
  }

  const overrideKeys = new Set<string>();
  for (const override of supplied ?? []) {
    const normalizedKey = override.key.toLowerCase();
    if (overrideKeys.has(normalizedKey)) {
      throw new Error(`Duplicate run variable override: ${override.key}`);
    }
    overrideKeys.add(normalizedKey);

    const definition = definitionsByKey.get(override.key);
    if (!definition) {
      throw new Error(
        `Run variable is not declared by the agent: ${override.key}`,
      );
    }
    if (!valueMatchesAgentVariableType(override.value, definition.type)) {
      throw new Error(
        `Run variable ${override.key} must be ${definition.type}`,
      );
    }
    state[definition.key] = structuredClone(override.value);
  }

  const missing = definitions
    .filter(
      (definition) =>
        definition.requiresOverride === true &&
        !overrideKeys.has(definition.key.toLowerCase()),
    )
    .map((definition) => definition.key);
  if (missing.length > 0) {
    throw new Error(
      `Missing required runtime variable overrides: ${missing.join(", ")}`,
    );
  }
  return state;
};

/**
 * Resolve manifest workspace bindings against the host provider. Required
 * bindings that cannot be resolved fail before any run state is created, and
 * an agent can only narrow the privileges the host configured.
 */
export const resolveAgentWorkspaces = async (
  manifest: AgentManifest,
  provider: WorkspaceProvider | undefined,
  context: WorkspaceResolutionContext = {},
): Promise<ResolvedWorkspace[]> => {
  const resolved: ResolvedWorkspace[] = [];
  for (const binding of manifest.workspaces ?? []) {
    const alias = binding.alias ?? binding.ref;
    const store = provider
      ? await provider.resolveWorkspace(binding, context)
      : undefined;
    if (!store) {
      if (binding.required === false) continue;
      throw new Error(
        provider
          ? `Unknown workspace "${binding.ref}".`
          : `Workspace "${binding.ref}" requires a WorkspaceProvider.`,
      );
    }
    if (store.mode === "read" && binding.mode === "read_write") {
      throw new Error(
        `Workspace "${binding.ref}" is read-only and cannot be elevated by an agent.`,
      );
    }
    const mode = binding.mode ?? store.mode;
    resolved.push({
      binding,
      alias,
      mode,
      store: restrictWorkspace(store, mode),
    });
  }
  return resolved;
};

const stepsUseRunSandbox = (steps: readonly AgentStep[]): boolean =>
  steps.some(
    (step) =>
      (step.type === "code" &&
        (step.sandbox === "run" || (step.workspaces?.length ?? 0) > 0)) ||
      (step.type === "loop" && stepsUseRunSandbox(step.steps)),
  );

const sandboxBudgetFromCheckpoint = (
  checkpoint: RunCheckpoint | null,
): SandboxBudgetState | undefined => {
  const value = checkpoint?.metadata?.sandboxBudget;
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.commandsUsed) ||
    typeof value.sandboxSecondsUsed !== "number"
  ) {
    return undefined;
  }
  return {
    commandsUsed: Number(value.commandsUsed),
    sandboxSecondsUsed: Number(value.sandboxSecondsUsed),
  };
};

const jsonByteLength = (value: JsonValue): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const assertRecoverableCheckpoint = (input: {
  checkpoint: RunCheckpoint;
  runId: string;
  manifest: AgentManifest;
  runAttempt: number;
}): void => {
  const { runId, manifest, runAttempt } = input;
  const checkpoint = parseRunCheckpoint(input.checkpoint);
  if (checkpoint.runId !== runId)
    throw new Error(`Checkpoint does not belong to run ${runId}`);
  if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1) {
    throw new Error(
      `Checkpoint sequence for run ${runId} must be a positive safe integer`,
    );
  }
  const checkpointAttempt = checkpoint.attempt ?? 1;
  if (
    !Number.isSafeInteger(checkpointAttempt) ||
    checkpointAttempt < 1 ||
    checkpointAttempt > runAttempt
  ) {
    throw new Error(`Checkpoint attempt for run ${runId} is not recoverable`);
  }
  if (checkpoint.contractVersion !== "1.0") {
    throw new Error(
      `Unsupported checkpoint contract version ${checkpoint.contractVersion}`,
    );
  }
  if (
    checkpoint.cursor == null ||
    !Number.isSafeInteger(checkpoint.cursor.stepIndex) ||
    checkpoint.cursor.stepIndex < 0 ||
    checkpoint.cursor.stepIndex > manifest.steps.length
  ) {
    throw new Error(
      `Checkpoint cursor for run ${runId} is outside the manifest`,
    );
  }
  if (checkpoint.cursor.stepIndex < manifest.steps.length) {
    const activeTopLevelStep = manifest.steps[checkpoint.cursor.stepIndex]?.id;
    const activePath = checkpoint.cursor.stepPath ?? checkpoint.cursor.stepId;
    if (
      activeTopLevelStep &&
      activePath &&
      activePath !== activeTopLevelStep &&
      !activePath.startsWith(`${activeTopLevelStep}/`)
    ) {
      throw new Error(
        `Checkpoint active step does not match the manifest for run ${runId}`,
      );
    }
  }
  if (
    checkpoint.state == null ||
    typeof checkpoint.state !== "object" ||
    Array.isArray(checkpoint.state) ||
    !Array.isArray(checkpoint.stepResults) ||
    !Array.isArray(checkpoint.transcript) ||
    !Array.isArray(checkpoint.artifacts)
  ) {
    throw new Error(`Checkpoint payload for run ${runId} is malformed`);
  }
  for (const [name, active, complete] of [
    ["transcript", checkpoint.activeStepTranscript, checkpoint.transcript],
    ["artifacts", checkpoint.activeStepArtifacts, checkpoint.artifacts],
  ] as const) {
    if (active == null) continue;
    if (!Array.isArray(active) || active.length > complete.length) {
      throw new Error(
        `Checkpoint active-step ${name} for run ${runId} is malformed`,
      );
    }
    const committedTail = complete.slice(complete.length - active.length);
    if (JSON.stringify(committedTail) !== JSON.stringify(active)) {
      throw new Error(
        `Checkpoint active-step ${name} for run ${runId} is inconsistent`,
      );
    }
  }
};

const withoutActiveTail = <T>(complete: T[], active: T[] | undefined): T[] =>
  active && active.length > 0 ? complete.slice(0, -active.length) : complete;

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value != null && typeof value === "object" && !Array.isArray(value);

const runtimeExtension = (
  value: JsonValue | undefined,
): JsonObject | undefined =>
  isJsonObject(value) && isJsonObject(value.agentRuntime)
    ? value.agentRuntime
    : undefined;

const usesStepOutputStateProjection = (manifest: AgentManifest): boolean =>
  runtimeExtension(manifest.extensions)?.stateProjection ===
  "step-output-state-v1";

const parseStructuredOutput = (value: JsonValue): JsonValue => {
  if (typeof value !== "string") return structuredClone(value);
  let stripped = value.trim();
  const fence = stripped.match(/^```([^\n\r]*)\r?\n([\s\S]*?)\r?\n```$/);
  if (fence) {
    const language = fence[1]?.trim().toLowerCase();
    if (
      language === "json" ||
      language === "yaml" ||
      language === "yml" ||
      language === ""
    ) {
      stripped = fence[2]?.trim() ?? "";
      if (language === "yaml" || language === "yml") {
        try {
          const parsed = parseYaml(stripped) as unknown;
          if (parsed != null && typeof parsed === "object")
            return parsed as JsonValue;
        } catch {
          return value;
        }
      }
    }
  }
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return value;
  try {
    return JSON.parse(stripped) as JsonValue;
  } catch {
    return value;
  }
};

const withProjectedStepState = (
  manifest: AgentManifest,
  step: AgentStep,
  stepIndex: number,
  result: StepExecutionResult,
): StepExecutionResult => {
  if (!usesStepOutputStateProjection(manifest) || result.output === undefined)
    return result;
  const projected = parseStructuredOutput(result.output);
  const stateKey =
    typeof runtimeExtension(step.extensions)?.stateKey === "string"
      ? String(runtimeExtension(step.extensions)?.stateKey)
      : `step-${stepIndex + 1}`;
  return {
    ...result,
    statePatch: {
      ...(result.statePatch ?? {}),
      set: {
        ...(result.statePatch?.set ?? {}),
        [stateKey]: projected,
        "step-previous": projected,
        ...(step.outputVariable ? { [step.outputVariable]: projected } : {}),
      },
    },
  };
};

const stringifyOutput = (value: JsonValue | undefined): string =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

export const selectRunOutput = (
  manifest: AgentManifest,
  stepResults: StepResult[],
): JsonValue | undefined => {
  const selectedIds = manifest.steps
    .filter((step) => step.includeInFinalOutput === true)
    .map((step) => step.id);
  if (selectedIds.length === 0) return stepResults.at(-1)?.output;
  const outputs = selectedIds.flatMap((stepId) => {
    const output = stepResults.find(
      (result) => result.stepId === stepId,
    )?.output;
    return output === undefined ? [] : [output];
  });
  if (outputs.length === 0) return stepResults.at(-1)?.output;
  if (usesStepOutputStateProjection(manifest)) {
    const selectedOutput = outputs
      .map(stringifyOutput)
      .filter((output) => output !== "");
    if (selectedOutput.length > 0) return selectedOutput.join("\n\n");
    for (const result of [...stepResults].reverse()) {
      const step = manifest.steps[result.stepIndex];
      if (step?.type === "webhook" || step?.type === "approval") continue;
      const fallback = stringifyOutput(result.output);
      if (fallback !== "") return fallback;
    }
    return "";
  }
  return outputs.length === 1 ? outputs[0] : outputs;
};

export const aggregateModelUsage = (
  transcript: TranscriptItem[],
): ModelUsage | undefined => {
  const usages = transcript.flatMap((item) => (item.usage ? [item.usage] : []));
  if (usages.length === 0) return undefined;
  const sum = (key: keyof ModelUsage): number | undefined => {
    const values = usages
      .map((usage) => usage[key])
      .filter((value): value is number => typeof value === "number");
    return values.length > 0
      ? values.reduce((total, value) => total + value, 0)
      : undefined;
  };
  const result: ModelUsage = {};
  const inputTokens = sum("inputTokens");
  const outputTokens = sum("outputTokens");
  const reasoningTokens = sum("reasoningTokens");
  const cachedInputTokens = sum("cachedInputTokens");
  const cacheWriteTokens = sum("cacheWriteTokens");
  const totalTokens = sum("totalTokens");
  const estimatedCost = sum("estimatedCost");
  if (inputTokens != null) result.inputTokens = inputTokens;
  if (outputTokens != null) result.outputTokens = outputTokens;
  if (reasoningTokens != null) result.reasoningTokens = reasoningTokens;
  if (cachedInputTokens != null) result.cachedInputTokens = cachedInputTokens;
  if (cacheWriteTokens != null) result.cacheWriteTokens = cacheWriteTokens;
  if (totalTokens != null) result.totalTokens = totalTokens;
  if (estimatedCost != null) result.estimatedCost = estimatedCost;
  return result;
};

const reportedTotalTokens = (usage: ModelUsage): number | undefined => {
  if (usage.totalTokens != null) return usage.totalTokens;
  if (usage.inputTokens == null && usage.outputTokens == null) return undefined;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
};

const consumedTokensFromTranscript = (transcript: TranscriptItem[]): number =>
  transcript.reduce((total, item) => {
    const reported = item.usage ? reportedTotalTokens(item.usage) : undefined;
    return total + (reported ?? 0);
  }, 0);

class RunTokenBudget implements TokenBudgetContext {
  readonly maxTotalTokens: number;
  #consumedTokens: number;

  constructor(state: RunBudgetState) {
    this.maxTotalTokens = state.maxTotalTokens;
    this.#consumedTokens = state.consumedTokens;
  }

  get consumedTokens(): number {
    return this.#consumedTokens;
  }

  consume(usage: ModelUsage): RunBudgetState {
    const tokens = reportedTotalTokens(usage);
    if (tokens == null) {
      throw new Error(
        "A budgeted model call must report totalTokens or inputTokens/outputTokens",
      );
    }
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error(
        "Budgeted model token usage must be a non-negative safe integer",
      );
    }
    this.#consumedTokens += tokens;
    if (!Number.isSafeInteger(this.#consumedTokens)) {
      throw new Error(
        "Cumulative model token usage exceeds the safe integer range",
      );
    }
    return this.snapshot();
  }

  snapshot(): RunBudgetState {
    return {
      maxTotalTokens: this.maxTotalTokens,
      consumedTokens: this.#consumedTokens,
    };
  }
}

/**
 * Persistence-neutral Agent Runtime with ordered commits. Sequential runs
 * checkpoint each step; parallel runs checkpoint dependency-safe prompt waves.
 */
export class AgentRuntime {
  readonly #dependencies: AgentRuntimeDependencies;
  readonly #executors: Map<string, StepExecutor>;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #manifestHasher: ManifestHasher;
  readonly #eventSequences = new Map<string, number>();
  readonly #eventTails = new Map<string, Promise<void>>();
  readonly #checkpointSequences = new Map<string, number>();
  readonly #runAttempts = new Map<string, number>();
  readonly #runTokenBudgets = new Map<string, RunTokenBudget>();
  readonly #activeRunIds = new Set<string>();
  readonly #runSandboxOpenings = new Map<string, Promise<RunSandboxSession>>();
  readonly #runSandboxSessions = new Map<string, RunSandboxSession>();

  constructor(dependencies: AgentRuntimeDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? systemClock;
    this.#ids = dependencies.idGenerator ?? cryptoIdGenerator;
    this.#manifestHasher = dependencies.manifestHasher ?? defaultManifestHasher;
    this.#executors = new Map();

    for (const executor of dependencies.stepExecutors) {
      if (this.#executors.has(executor.type)) {
        throw new Error(
          `Duplicate step executor registered for ${executor.type}`,
        );
      }
      this.#executors.set(executor.type, executor);
    }
  }

  async run(request: RunRequest): Promise<AgentExecutionResult> {
    let normalizedRequest = request;
    if (request.agentRunManifest) {
      if (
        request.resume ||
        request.manifest ||
        request.manifestReference ||
        request.variables ||
        request.runId ||
        request.execution ||
        request.budget
      ) {
        throw new Error(
          "agentRunManifest cannot be combined with resume, manifest, manifestReference, variables, runId, execution, or budget",
        );
      }
      const agentRunManifest = parseAgentRunManifest(request.agentRunManifest);
      const { agentRunManifest: _agentRunManifest, ...hostOptions } = request;
      normalizedRequest = {
        ...hostOptions,
        manifestReference: agentRunManifest.agent.ref,
        ...(agentRunManifest.runId ? { runId: agentRunManifest.runId } : {}),
        ...(agentRunManifest.variables
          ? { variables: agentRunManifest.variables }
          : {}),
        ...(agentRunManifest.execution
          ? { execution: agentRunManifest.execution }
          : {}),
        ...(agentRunManifest.budget ? { budget: agentRunManifest.budget } : {}),
      };
    }
    if (normalizedRequest.resume && !normalizedRequest.runId) {
      throw new Error("A runId is required to resume a run");
    }
    if (normalizedRequest.resume && normalizedRequest.variables != null) {
      throw new Error(
        "Run variable overrides cannot be supplied when resuming a run",
      );
    }
    const runId = normalizedRequest.runId ?? this.#ids.generateId("run");
    if (this.#activeRunIds.has(runId)) {
      throw new Error(
        `Run ${runId} is already active in this Agent Runtime process`,
      );
    }
    this.#activeRunIds.add(runId);
    try {
      return await this.#run({ ...normalizedRequest, runId });
    } finally {
      this.#activeRunIds.delete(runId);
      this.#eventSequences.delete(runId);
      this.#eventTails.delete(runId);
      this.#checkpointSequences.delete(runId);
      this.#runAttempts.delete(runId);
      this.#runTokenBudgets.delete(runId);
      this.#runSandboxOpenings.delete(runId);
      this.#runSandboxSessions.delete(runId);
    }
  }

  async #run(
    request: RunRequest & { runId: string },
  ): Promise<AgentExecutionResult> {
    const runId = request.runId;
    const existingRecord = request.resume
      ? await this.#dependencies.runStore.loadRun(runId)
      : null;
    if (request.resume && !existingRecord) {
      throw new Error(`Run ${runId} does not exist`);
    }
    if (
      existingRecord?.status === "completed" ||
      existingRecord?.status === "cancelled"
    ) {
      throw new Error(`Run ${runId} is already ${existingRecord.status}`);
    }

    const rawManifest = request.manifest
      ? request.manifest
      : request.manifestReference
        ? await this.#resolveManifest(request)
        : (existingRecord?.manifest ?? (await this.#resolveManifest(request)));
    const parsedManifest = agentManifestSchema.safeParse(rawManifest);
    if (!parsedManifest.success) {
      const reasons = parsedManifest.error.issues
        .map((issue) => issue.message)
        .join("; ");
      throw new Error(`Agent manifest is invalid: ${reasons}`);
    }
    const manifest = parsedManifest.data;
    const manifestStepCount = countManifestSteps(manifest.steps);
    if (
      manifest.limits?.maxSteps != null &&
      manifestStepCount > manifest.limits.maxSteps
    ) {
      throw new Error(
        `Manifest declares ${manifestStepCount} steps, exceeding its ${manifest.limits.maxSteps}-step limit`,
      );
    }
    const requestedBudget = request.budget
      ? agentRunBudgetSchema.parse(request.budget)
      : undefined;
    const latestCheckpoint = request.resume
      ? await this.#dependencies.runStore.loadLatestCheckpoint(runId)
      : null;
    if (request.resume && !latestCheckpoint) {
      throw new Error(`Run ${runId} has no checkpoint to resume`);
    }
    const workspaces = await resolveAgentWorkspaces(
      manifest,
      this.#dependencies.workspaces,
      { runId, ...(request.signal ? { signal: request.signal } : {}) },
    );
    const usesRunSandbox =
      workspaces.length > 0 || stepsUseRunSandbox(manifest.steps);
    if (usesRunSandbox) {
      if (!this.#dependencies.runSandbox) {
        throw new Error(
          workspaces.length > 0
            ? "Workspace bindings require a RunSandboxProvider"
            : "Code steps that use the run sandbox require a RunSandboxProvider",
        );
      }
      await this.#dependencies.runSandbox.validate({
        runId,
        attempt: request.resume ? (existingRecord?.attempt ?? 1) + 1 : 1,
        workspaces,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    }
    await this.#preflight(manifest);
    if (latestCheckpoint && existingRecord) {
      assertRecoverableCheckpoint({
        checkpoint: latestCheckpoint,
        runId,
        manifest,
        runAttempt: existingRecord.attempt ?? 1,
      });
    }
    if (
      latestCheckpoint &&
      latestCheckpoint.manifestHash !==
        (await this.#manifestHasher.hash(manifest))
    ) {
      throw new Error(`Manifest does not match checkpoint for run ${runId}`);
    }

    const effectiveBudget = requestedBudget ?? latestCheckpoint?.budget;
    if (effectiveBudget) {
      const consumedTokens =
        latestCheckpoint?.budget?.consumedTokens ??
        consumedTokensFromTranscript(latestCheckpoint?.transcript ?? []);
      this.#runTokenBudgets.set(
        runId,
        new RunTokenBudget({
          maxTotalTokens: effectiveBudget.maxTotalTokens,
          consumedTokens,
        }),
      );
    }

    const startedAt =
      existingRecord?.createdAt ?? this.#clock.now().toISOString();
    const startStepIndex = latestCheckpoint?.cursor.stepIndex ?? 0;
    let variables: VariableState = latestCheckpoint
      ? structuredClone(latestCheckpoint.state)
      : resolveAgentVariables(manifest, request.variables);
    const stepResults: StepResult[] = structuredClone(
      latestCheckpoint?.stepResults ?? [],
    );
    const transcript: TranscriptItem[] = structuredClone(
      withoutActiveTail(
        latestCheckpoint?.transcript ?? [],
        latestCheckpoint?.activeStepTranscript,
      ),
    );
    const artifacts: ArtifactRef[] = structuredClone(
      withoutActiveTail(
        latestCheckpoint?.artifacts ?? [],
        latestCheckpoint?.activeStepArtifacts,
      ),
    );

    const record: RunRecord = {
      runId,
      manifest,
      status: "running",
      attempt: 1,
      state: structuredClone(variables),
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    let uncommittedSteps: AgentStep[] = [];
    if (!request.resume) {
      await this.#dependencies.runStore.createRun(record);
      this.#runAttempts.set(runId, 1);
    } else {
      const attempt = await this.#dependencies.runStore.resumeRun(
        runId,
        this.#clock.now().toISOString(),
        request.allowRunningTakeover
          ? { allowRunningTakeover: true }
          : undefined,
      );
      this.#runAttempts.set(runId, attempt);
      record.attempt = attempt;
      this.#checkpointSequences.set(runId, latestCheckpoint!.sequence);
    }
    try {
      await this.#emit(runId, request.resume ? "run.resumed" : "run.started", {
        manifestId: manifest.id ?? null,
        startStepIndex,
      });
      for (const workspace of workspaces) {
        await this.#emit(runId, "workspace.bound", {
          workspace: workspace.binding.ref,
          alias: workspace.alias,
          mode: workspace.mode,
          ...(workspace.binding.tools
            ? { tools: [...workspace.binding.tools] }
            : {}),
          attachable: workspace.store.attachable != null,
        });
      }
      const runSandbox = this.#dependencies.runSandbox
        ? () =>
            this.#openRunSandbox({
              runId,
              workspaces,
              latestCheckpoint,
              signal: request.signal,
            })
        : undefined;
      if (!request.resume) {
        await this.#checkpoint({
          runId,
          manifest,
          nextStepIndex: 0,
          variables,
          stepResults,
          transcript,
          artifacts,
        });
      }

      const executionWaves = buildExecutionWaves(
        manifest,
        startStepIndex,
        this.#runTokenBudgets.has(runId)
          ? { mode: "sequential" }
          : request.execution,
        this.#dependencies.maxParallelSteps ?? 8,
      );
      for (const wave of executionWaves) {
        this.#throwIfAborted(request.signal);
        const waveVariables = snapshotState(variables);
        const waveStepResults = structuredClone(stepResults);
        uncommittedSteps = wave.stepIndexes.flatMap((stepIndex) => {
          const step = manifest.steps[stepIndex];
          return step ? [step] : [];
        });
        const settled = await Promise.allSettled(
          wave.stepIndexes.map((stepIndex) =>
            this.#executeTopLevelStep({
              runId,
              manifest,
              stepIndex,
              variables: waveVariables,
              stepResults: waveStepResults,
              transcript,
              artifacts,
              workspaces,
              runSandbox,
              signal: request.signal,
              latestCheckpoint,
            }),
          ),
        );
        const failures = settled.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason as unknown] : [],
        );
        if (failures.length > 0) {
          const suspended = failures.find(
            (failure) =>
              isRunSuspendedError(failure) || isRunInterruptedError(failure),
          );
          if (suspended) {
            uncommittedSteps = [];
            throw suspended;
          }
          const abortReason: unknown = request.signal?.aborted
            ? request.signal.reason
            : undefined;
          if (
            isRunSuspendedError(abortReason) ||
            isRunInterruptedError(abortReason)
          ) {
            uncommittedSteps = [];
            throw abortReason;
          }
          for (const failure of failures) {
            const wrapped =
              failure instanceof TopLevelStepExecutionError
                ? failure
                : undefined;
            if (wrapped) {
              await this.#emit(
                runId,
                "step.failed",
                {
                  error: toRunError(wrapped.cause) as unknown as JsonValue,
                },
                wrapped.step.id,
              );
            }
          }
          uncommittedSteps = [];
          const first = failures[0];
          throw first instanceof TopLevelStepExecutionError
            ? first.cause
            : first;
        }

        const outcomes = settled
          .flatMap((outcome) =>
            outcome.status === "fulfilled" ? [outcome.value] : [],
          )
          .sort((left, right) => left.stepIndex - right.stepIndex);
        assertParallelWaveStatePatches(outcomes);
        for (const outcome of outcomes) {
          if (outcome.skipped || !outcome.result || !outcome.stepResult)
            continue;
          variables = applyStatePatch(variables, outcome.result.statePatch);
          transcript.push(...(outcome.result.transcript ?? []));
          artifacts.push(...(outcome.result.artifacts ?? []));
          stepResults.push(outcome.stepResult);
        }

        const endingOutcome = outcomes.find(
          (outcome) => outcome.result?.endRun === true,
        );
        const nextStepIndex = endingOutcome
          ? manifest.steps.length
          : (wave.stepIndexes.at(-1) ?? -1) + 1;
        await this.#checkpoint({
          runId,
          manifest,
          nextStepIndex,
          variables,
          stepResults,
          transcript,
          artifacts,
        });
        for (const outcome of outcomes) {
          if (outcome.handledError) {
            await this.#emit(
              runId,
              "step.failed",
              {
                stepIndex: outcome.stepIndex,
                handled: true,
                error: outcome.handledError as unknown as JsonValue,
              },
              outcome.step.id,
            );
            continue;
          }
          await this.#emit(
            runId,
            outcome.skipped ? "step.skipped" : "step.completed",
            outcome.skipped ? undefined : { stepIndex: outcome.stepIndex },
            outcome.step.id,
          );
        }
        uncommittedSteps = [];
        if (endingOutcome) {
          await this.#emit(
            runId,
            "diagnostic",
            {
              code: "RUN_ENDED_BY_STEP",
              stepIndex: endingOutcome.stepIndex,
            },
            endingOutcome.step.id,
          );
          break;
        }
      }

      this.#throwIfAborted(request.signal);
      await this.#closeRunSandbox(runId, "completed");
      const output = selectRunOutput(manifest, stepResults);
      this.#assertOutputWithinLimit(manifest, output, "final run output");
      const usage = aggregateModelUsage(transcript);
      const completedAt = this.#clock.now().toISOString();
      const completedRecord: CompletedRunRecord = {
        ...record,
        status: "completed",
        state: structuredClone(variables),
        updatedAt: completedAt,
        ...(output === undefined ? {} : { output }),
        transcript: structuredClone(transcript),
        artifacts: structuredClone(artifacts),
        ...(usage ? { usage } : {}),
      };
      await this.#dependencies.runStore.completeRun(completedRecord);
      try {
        await this.#emit(runId, "run.completed");
      } catch {
        // Durable completion is authoritative; an observer cannot roll it back.
      }
      this.#eventSequences.delete(runId);
      this.#eventTails.delete(runId);
      this.#checkpointSequences.delete(runId);
      this.#runAttempts.delete(runId);

      return {
        runId,
        state: variables,
        variables,
        stepResults,
        transcript,
        artifacts,
        startedAt,
        completedAt,
        ...(usage ? { usage } : {}),
        ...(output === undefined ? {} : { output }),
      };
    } catch (caught) {
      // A host pauses or interrupts a run by aborting its signal with a
      // RunSuspendedError or RunInterruptedError reason. Whatever the step
      // threw while unwinding, the abort reason decides the outcome.
      const abortReason: unknown = request.signal?.aborted
        ? request.signal.reason
        : undefined;
      const error =
        isRunSuspendedError(abortReason) || isRunInterruptedError(abortReason)
          ? abortReason
          : caught;
      if (isRunSuspendedError(error)) {
        await this.#closeRunSandboxQuietly(runId, "suspended");
        const suspendedAt = this.#clock.now().toISOString();
        await this.#dependencies.runStore.suspendRun(
          runId,
          suspendedAt,
          this.#runAttempts.get(runId) ?? 1,
        );
        try {
          await this.#emit(runId, "run.suspended", {
            reason: error.reason,
            kind: suspensionKind(error.reason),
            ...(error.details ? { details: error.details } : {}),
          });
        } finally {
          this.#eventSequences.delete(runId);
          this.#eventTails.delete(runId);
          this.#checkpointSequences.delete(runId);
          this.#runAttempts.delete(runId);
        }
        throw error;
      }
      const runError = toRunError(error);
      if (isRunInterruptedError(error)) {
        runError.retryable = true;
        await this.#closeRunSandboxQuietly(runId, "suspended");
        const interruptedAt = this.#clock.now().toISOString();
        const attempt = this.#runAttempts.get(runId) ?? 1;
        if (this.#dependencies.runStore.interruptRun) {
          await this.#dependencies.runStore.interruptRun(
            runId,
            runError,
            interruptedAt,
            attempt,
          );
        } else {
          await this.#dependencies.runStore.failRun(
            runId,
            runError,
            interruptedAt,
            attempt,
          );
        }
        try {
          await this.#emit(runId, "run.interrupted", {
            reason: interruptionReason(error),
            error: runError as unknown as JsonValue,
            ...(error.details ? { details: error.details } : {}),
          });
        } finally {
          this.#eventSequences.delete(runId);
          this.#eventTails.delete(runId);
          this.#checkpointSequences.delete(runId);
          this.#runAttempts.delete(runId);
        }
        throw error;
      }
      const cancelled =
        isAbortError(request.signal) || isRunCancelledError(error);
      await this.#closeRunSandboxQuietly(
        runId,
        cancelled ? "cancelled" : "failed",
      );
      const failedAt = this.#clock.now().toISOString();
      if (cancelled) {
        await this.#dependencies.runStore.cancelRun(
          runId,
          failedAt,
          this.#runAttempts.get(runId) ?? 1,
        );
      } else {
        await this.#dependencies.runStore.failRun(
          runId,
          runError,
          failedAt,
          this.#runAttempts.get(runId) ?? 1,
        );
      }
      try {
        for (const step of uncommittedSteps) {
          await this.#emit(
            runId,
            "step.failed",
            { error: runError as unknown as JsonValue },
            step.id,
          );
        }
        await this.#emit(runId, cancelled ? "run.cancelled" : "run.failed", {
          error: runError as unknown as JsonValue,
        });
      } finally {
        this.#eventSequences.delete(runId);
        this.#eventTails.delete(runId);
        this.#checkpointSequences.delete(runId);
        this.#runAttempts.delete(runId);
      }
      throw error;
    }
  }

  async #executeTopLevelStep(input: {
    runId: string;
    manifest: AgentManifest;
    stepIndex: number;
    variables: Readonly<VariableState>;
    stepResults: Readonly<StepResult[]>;
    transcript: TranscriptItem[];
    artifacts: ArtifactRef[];
    workspaces: readonly ResolvedWorkspace[];
    runSandbox: (() => Promise<RunSandboxSession>) | undefined;
    signal?: AbortSignal | undefined;
    latestCheckpoint: RunCheckpoint | null;
  }): Promise<TopLevelStepOutcome> {
    const step = input.manifest.steps[input.stepIndex];
    if (!step) {
      throw new Error(`Manifest step ${input.stepIndex} does not exist`);
    }

    try {
      if (!(await this.#shouldExecute(step, { ...input.variables }))) {
        return { step, stepIndex: input.stepIndex, skipped: true };
      }

      const executor = this.#executors.get(step.type);
      if (!executor) {
        throw new Error(`No step executor registered for ${step.type}`);
      }

      await this.#emit(
        input.runId,
        "step.started",
        { stepIndex: input.stepIndex },
        step.id,
      );
      const checkpointNested = (nested: NestedCheckpointInput) =>
        this.#checkpoint({
          runId: input.runId,
          manifest: input.manifest,
          nextStepIndex: input.stepIndex,
          cursor: {
            stepIndex: input.stepIndex,
            stepId: step.id,
            stepPath: step.id,
            ...(nested.cursor ?? {}),
          },
          variables: nested.state,
          stepResults: [...input.stepResults],
          transcript: [...input.transcript, ...(nested.transcript ?? [])],
          artifacts: [...input.artifacts, ...(nested.artifacts ?? [])],
          ...(nested.continuation ? { continuation: nested.continuation } : {}),
          activeStepTranscript: nested.transcript ?? [],
          activeStepArtifacts: nested.artifacts ?? [],
        });

      const result = await executor.execute({
        runId: input.runId,
        manifest: input.manifest,
        step,
        stepIndex: input.stepIndex,
        stepPath: step.id,
        variables: snapshotState({ ...input.variables }),
        stepResults: structuredClone(input.stepResults),
        signal: input.signal,
        model: this.#dependencies.model,
        tools: this.#dependencies.tools,
        artifacts: this.#dependencies.artifacts,
        approvals: this.#dependencies.approvals,
        sandbox: this.#dependencies.sandbox,
        subRuns: this.#dependencies.subRuns,
        workspaces: input.workspaces,
        runSandbox: input.runSandbox,
        tokenBudget: this.#runTokenBudgets.get(input.runId),
        summarizer: this.#dependencies.summarizer,
        policies: resolveStepPolicies(
          this.#dependencies.policies,
          input.manifest,
          step,
          this.#dependencies.enforcedPolicies,
        ),
        emit: (type, data) =>
          this.#emit(input.runId, type, data, step.id, step.id),
        ...(input.latestCheckpoint?.cursor.stepIndex === input.stepIndex
          ? {
              resume: {
                cursor: input.latestCheckpoint.cursor,
                ...(input.latestCheckpoint.continuation
                  ? { continuation: input.latestCheckpoint.continuation }
                  : {}),
                ...(input.latestCheckpoint.activeStepTranscript
                  ? {
                      transcript: structuredClone(
                        input.latestCheckpoint.activeStepTranscript,
                      ),
                    }
                  : {}),
                ...(input.latestCheckpoint.activeStepArtifacts
                  ? {
                      artifacts: structuredClone(
                        input.latestCheckpoint.activeStepArtifacts,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
        executeChild: (childStep, childVariables, childPath) =>
          this.#executeChild({
            runId: input.runId,
            manifest: input.manifest,
            parentStepIndex: input.stepIndex,
            step: childStep,
            stepPath: childPath,
            variables: childVariables,
            workspaces: input.workspaces,
            runSandbox: input.runSandbox,
            signal: input.signal,
            latestCheckpoint: input.latestCheckpoint,
            stepResults: input.stepResults,
            checkpoint: checkpointNested,
          }),
        checkpoint: checkpointNested,
        evaluateCondition: (expression, conditionVariables) =>
          this.#evaluateCondition(expression, conditionVariables),
      });

      this.#throwIfAborted(input.signal);
      this.#assertOutputWithinLimit(
        input.manifest,
        result.output,
        `step ${step.id}`,
      );
      const projectedResult = withProjectedStepState(
        input.manifest,
        step,
        input.stepIndex,
        result,
      );
      const stepUsage = aggregateModelUsage(result.transcript ?? []);
      const stepResult: StepResult = {
        stepId: step.id,
        stepIndex: input.stepIndex,
        status: "completed",
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.transcript ? { transcript: result.transcript } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(stepUsage ? { usage: stepUsage } : {}),
        completedAt: this.#clock.now().toISOString(),
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
      return {
        step,
        stepIndex: input.stepIndex,
        skipped: false,
        result: projectedResult,
        stepResult,
      };
    } catch (error) {
      if (isRunSuspendedError(error) || isRunInterruptedError(error))
        throw error;
      if (
        !isControlFlowError(error, input.signal) &&
        resolveStepPolicies(
          this.#dependencies.policies,
          input.manifest,
          step,
          this.#dependencies.enforcedPolicies,
        ).onError === "continue"
      ) {
        const handledError = toRunError(error);
        const result = handledErrorResult(step, handledError);
        return {
          step,
          stepIndex: input.stepIndex,
          skipped: false,
          result,
          handledError,
          stepResult: {
            stepId: step.id,
            stepIndex: input.stepIndex,
            status: "completed",
            output: result.output!,
            completedAt: this.#clock.now().toISOString(),
            metadata: result.metadata!,
          },
        };
      }
      throw new TopLevelStepExecutionError(step, error);
    }
  }

  /**
   * Find configuration gaps that would otherwise fail the run only when a
   * step is reached, after earlier steps have spent tokens: unregistered
   * executors, missing adapters, unparseable conditions, and unknown tools.
   */
  async #preflight(manifest: AgentManifest): Promise<void> {
    const problems: string[] = [];
    const expressions: Array<{ stepId: string; label: string; value: string }> =
      [];
    const toolNames = new Map<string, string[]>();
    const visit = (steps: readonly AgentStep[]): void => {
      for (const step of steps) {
        if (!this.#executors.has(step.type)) {
          problems.push(
            `Step ${step.id} is a ${step.type} step, but no ${step.type} step executor is registered.`,
          );
        }
        if (step.when?.trim())
          expressions.push({
            stepId: step.id,
            label: "when",
            value: step.when,
          });
        if (step.type === "prompt" && step.tools?.length)
          toolNames.set(step.id, step.tools);
        if (step.type === "loop") {
          if (step.loop.condition?.trim())
            expressions.push({
              stepId: step.id,
              label: "loop.condition",
              value: step.loop.condition,
            });
          if (step.loop.goal?.trim())
            expressions.push({
              stepId: step.id,
              label: "loop.goal",
              value: step.loop.goal,
            });
          visit(step.steps);
        }
      }
    };
    visit(manifest.steps);

    const preflightContext: StepPreflightContext = {
      manifest,
      model: this.#dependencies.model,
      tools: this.#dependencies.tools,
      artifacts: this.#dependencies.artifacts,
      approvals: this.#dependencies.approvals,
      sandbox: this.#dependencies.sandbox,
      subRuns: this.#dependencies.subRuns,
      runSandbox: this.#dependencies.runSandbox,
    };
    const checkExecutors = async (steps: readonly AgentStep[]) => {
      for (const step of steps) {
        const executor = this.#executors.get(step.type);
        if (executor?.preflight)
          problems.push(...(await executor.preflight(step, preflightContext)));
        if (step.type === "loop") await checkExecutors(step.steps);
      }
    };
    await checkExecutors(manifest.steps);

    const evaluator = this.#dependencies.conditionEvaluator;
    if (expressions.length > 0 && !evaluator) {
      problems.push(
        `Steps ${[...new Set(expressions.map((entry) => entry.stepId))].join(", ")} use conditions, but no ConditionEvaluator is configured.`,
      );
    } else if (evaluator?.validate) {
      for (const expression of expressions) {
        try {
          await evaluator.validate(expression.value);
        } catch (error) {
          problems.push(
            `Step ${expression.stepId} has an invalid ${expression.label} expression: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    if (toolNames.size > 0) {
      const tools = this.#dependencies.tools;
      if (tools) {
        const available = new Set(
          (await tools.listTools()).map((tool) => tool.name),
        );
        for (const [stepId, names] of toolNames) {
          const unknown = names.filter(
            (name) =>
              !available.has(name) &&
              tools.isToolExcluded?.(name) !== true &&
              tools.unavailableToolReason?.(name) === undefined,
          );
          if (unknown.length > 0) {
            problems.push(
              `Prompt step ${stepId} names unknown tools: ${unknown.join(", ")}.`,
            );
          }
        }
      }
    }

    if (problems.length > 0) {
      throw new AgentRuntimeError(
        `Agent manifest cannot run with this host configuration: ${problems.join(" ")}`,
        "MANIFEST_PREFLIGHT_FAILED",
      );
    }
  }

  async #resolveManifest(request: RunRequest): Promise<AgentManifest> {
    if (request.manifest) return request.manifest;
    if (!this.#dependencies.agentManifestSource) {
      throw new Error("An agent manifest or AgentManifestSource is required");
    }
    return this.#dependencies.agentManifestSource.loadManifest(
      request.manifestReference,
    );
  }

  #assertOutputWithinLimit(
    manifest: AgentManifest,
    output: JsonValue | undefined,
    label: string,
  ): void {
    const maxOutputBytes = manifest.limits?.maxOutputBytes;
    if (output === undefined || maxOutputBytes == null) return;
    const outputBytes = jsonByteLength(output);
    if (outputBytes > maxOutputBytes) {
      throw new Error(
        `${label} is ${outputBytes} bytes, exceeding the ${maxOutputBytes}-byte output limit`,
      );
    }
  }

  async #shouldExecute(
    step: AgentStep,
    variables: VariableState,
  ): Promise<boolean> {
    if (!step.when) return true;
    if (!this.#dependencies.conditionEvaluator) {
      throw new Error(
        `Step ${step.id} has a condition but no ConditionEvaluator is configured`,
      );
    }
    return this.#dependencies.conditionEvaluator.evaluate(step.when, variables);
  }

  async #evaluateCondition(
    expression: string,
    variables: Readonly<VariableState>,
  ): Promise<boolean> {
    if (expression.trim() === "") return true;
    if (!this.#dependencies.conditionEvaluator) {
      throw new Error(
        "A ConditionEvaluator is required for loop conditions and goals",
      );
    }
    return this.#dependencies.conditionEvaluator.evaluate(
      expression,
      variables,
    );
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Run cancelled");
  }

  async #executeChild(
    input: ChildExecutionInput,
  ): Promise<StepExecutionResult> {
    this.#throwIfAborted(input.signal);
    if (!(await this.#shouldExecute(input.step, { ...input.variables }))) {
      await this.#emit(
        input.runId,
        "step.skipped",
        undefined,
        input.step.id,
        input.stepPath,
      );
      return { metadata: { skipped: true } };
    }

    const executor = this.#executors.get(input.step.type);
    if (!executor) {
      throw new Error(`No step executor registered for ${input.step.type}`);
    }

    await this.#emit(
      input.runId,
      "step.started",
      { stepIndex: input.parentStepIndex },
      input.step.id,
      input.stepPath,
    );
    const cursorPath = input.latestCheckpoint?.cursor.stepPath;
    const isResumingPath =
      input.latestCheckpoint?.cursor.stepIndex === input.parentStepIndex &&
      (cursorPath === input.stepPath ||
        cursorPath?.startsWith(`${input.stepPath}/`) === true);

    let result: StepExecutionResult;
    try {
      result = await this.#executeChildStep(executor, input, isResumingPath);
    } catch (error) {
      if (
        isControlFlowError(error, input.signal) ||
        resolveStepPolicies(
          this.#dependencies.policies,
          input.manifest,
          input.step,
          this.#dependencies.enforcedPolicies,
        ).onError !== "continue"
      )
        throw error;
      const handledError = toRunError(error);
      await this.#emit(
        input.runId,
        "step.failed",
        {
          stepIndex: input.parentStepIndex,
          handled: true,
          error: handledError as unknown as JsonValue,
        },
        input.step.id,
        input.stepPath,
      );
      return handledErrorResult(input.step, handledError);
    }

    await this.#emit(
      input.runId,
      "step.completed",
      { stepIndex: input.parentStepIndex },
      input.step.id,
      input.stepPath,
    );
    return withProjectedStepState(
      input.manifest,
      input.step,
      input.parentStepIndex,
      result,
    );
  }

  #executeChildStep(
    executor: StepExecutor,
    input: ChildExecutionInput,
    isResumingPath: boolean,
  ): Promise<StepExecutionResult> {
    return executor.execute({
      runId: input.runId,
      manifest: input.manifest,
      step: input.step,
      stepIndex: input.parentStepIndex,
      stepPath: input.stepPath,
      variables: snapshotState({ ...input.variables }),
      stepResults: structuredClone(input.stepResults),
      signal: input.signal,
      model: this.#dependencies.model,
      tools: this.#dependencies.tools,
      artifacts: this.#dependencies.artifacts,
      approvals: this.#dependencies.approvals,
      sandbox: this.#dependencies.sandbox,
      subRuns: this.#dependencies.subRuns,
      workspaces: input.workspaces,
      runSandbox: input.runSandbox,
      tokenBudget: this.#runTokenBudgets.get(input.runId),
      summarizer: this.#dependencies.summarizer,
      emit: (type, data) =>
        this.#emit(input.runId, type, data, input.step.id, input.stepPath),
      ...(isResumingPath && input.latestCheckpoint
        ? {
            resume: {
              cursor: input.latestCheckpoint.cursor,
              ...(input.latestCheckpoint.continuation
                ? { continuation: input.latestCheckpoint.continuation }
                : {}),
              ...(input.latestCheckpoint.activeStepTranscript
                ? {
                    transcript: structuredClone(
                      input.latestCheckpoint.activeStepTranscript,
                    ),
                  }
                : {}),
              ...(input.latestCheckpoint.activeStepArtifacts
                ? {
                    artifacts: structuredClone(
                      input.latestCheckpoint.activeStepArtifacts,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      executeChild: (childStep, childVariables, childPath) =>
        this.#executeChild({
          ...input,
          step: childStep,
          stepPath: childPath,
          variables: childVariables,
        }),
      checkpoint: (nested) =>
        input.checkpoint({
          ...nested,
          cursor: {
            stepId: input.step.id,
            stepPath: input.stepPath,
            ...(nested.cursor ?? {}),
          },
        }),
      evaluateCondition: (expression, conditionVariables) =>
        this.#evaluateCondition(expression, conditionVariables),
      policies: resolveStepPolicies(
        this.#dependencies.policies,
        input.manifest,
        input.step,
        this.#dependencies.enforcedPolicies,
      ),
    });
  }

  async #checkpoint(input: {
    runId: string;
    manifest: AgentManifest;
    nextStepIndex: number;
    variables: VariableState;
    stepResults: StepResult[];
    transcript: TranscriptItem[];
    artifacts: ArtifactRef[];
    activeStepTranscript?: TranscriptItem[];
    activeStepArtifacts?: ArtifactRef[];
    cursor?: ExecutionCursor;
    continuation?: JsonObject;
  }): Promise<void> {
    const checkpointSequence =
      (this.#checkpointSequences.get(input.runId) ?? 0) + 1;
    const checkpoint: RunCheckpoint = {
      id: this.#ids.generateId("checkpoint"),
      runId: input.runId,
      sequence: checkpointSequence,
      attempt: this.#runAttempts.get(input.runId) ?? 1,
      manifestHash: await this.#manifestHasher.hash(input.manifest),
      contractVersion: "1.0",
      runtimeVersion: this.#dependencies.runtimeVersion ?? RUNTIME_VERSION,
      cursor: input.cursor ?? { stepIndex: input.nextStepIndex },
      state: structuredClone(input.variables),
      stepResults: structuredClone(input.stepResults),
      transcript: structuredClone(input.transcript),
      artifacts: structuredClone(input.artifacts),
      ...(input.activeStepTranscript
        ? { activeStepTranscript: structuredClone(input.activeStepTranscript) }
        : {}),
      ...(input.activeStepArtifacts
        ? { activeStepArtifacts: structuredClone(input.activeStepArtifacts) }
        : {}),
      ...(input.continuation
        ? { continuation: structuredClone(input.continuation) }
        : {}),
      ...(this.#runTokenBudgets.get(input.runId)
        ? { budget: this.#runTokenBudgets.get(input.runId)!.snapshot() }
        : {}),
      ...(this.#runSandboxSessions.has(input.runId)
        ? {
            metadata: {
              sandboxBudget: {
                ...this.#runSandboxSessions.get(input.runId)!.budget(),
              },
            },
          }
        : {}),
      createdAt: this.#clock.now().toISOString(),
    };
    await this.#dependencies.runStore.saveCheckpoint(checkpoint);
    this.#checkpointSequences.set(input.runId, checkpointSequence);
    await this.#emit(input.runId, "checkpoint.saved", {
      checkpointId: checkpoint.id,
      nextStepIndex: checkpoint.cursor.stepIndex,
    });
  }

  #openRunSandbox(input: {
    runId: string;
    workspaces: readonly ResolvedWorkspace[];
    latestCheckpoint: RunCheckpoint | null;
    signal?: AbortSignal | undefined;
  }): Promise<RunSandboxSession> {
    const existing = this.#runSandboxOpenings.get(input.runId);
    if (existing) return existing;
    const provider = this.#dependencies.runSandbox;
    if (!provider) {
      return Promise.reject(
        new Error("This run has no RunSandboxProvider configured"),
      );
    }
    const budget = sandboxBudgetFromCheckpoint(input.latestCheckpoint);
    const opening = provider
      .open({
        runId: input.runId,
        attempt: this.#runAttempts.get(input.runId) ?? 1,
        workspaces: input.workspaces,
        emit: (type, data, stepId) =>
          this.#emit(input.runId, type, data, stepId, stepId),
        ...(this.#dependencies.artifacts
          ? { artifacts: this.#dependencies.artifacts }
          : {}),
        ...(budget ? { budget } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      .then((session) => {
        this.#runSandboxSessions.set(input.runId, session);
        return session;
      });
    this.#runSandboxOpenings.set(input.runId, opening);
    opening.catch(() => this.#runSandboxOpenings.delete(input.runId));
    return opening;
  }

  async #closeRunSandbox(
    runId: string,
    reason: "completed" | "failed" | "cancelled" | "suspended",
  ): Promise<void> {
    const session = this.#runSandboxSessions.get(runId);
    this.#runSandboxSessions.delete(runId);
    this.#runSandboxOpenings.delete(runId);
    if (session) await session.close(reason);
  }

  async #closeRunSandboxQuietly(
    runId: string,
    reason: "failed" | "cancelled" | "suspended",
  ): Promise<void> {
    try {
      await this.#closeRunSandbox(runId, reason);
    } catch (error) {
      try {
        await this.#emit(runId, "diagnostic", {
          code: "SANDBOX_CLOSE_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The run outcome is already decided; sandbox cleanup is best effort.
      }
    }
  }

  async #emit(
    runId: string,
    type: string,
    data?: JsonObject,
    stepId?: string,
    stepPath?: string,
  ): Promise<RunEvent> {
    const previous = this.#eventTails.get(runId) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const event = {
        id: this.#ids.generateId("event"),
        runId,
        type,
        sequence: (this.#eventSequences.get(runId) ?? 0) + 1,
        attempt: this.#runAttempts.get(runId) ?? 1,
        timestamp: this.#clock.now().toISOString(),
        ...(stepId ? { stepId, stepPath: stepPath ?? stepId } : {}),
        ...(data ? { data } : {}),
      } as RunEvent;
      this.#eventSequences.set(runId, event.sequence);

      for (const sink of this.#dependencies.eventSinks ?? []) {
        try {
          await sink.emit(event);
        } catch (error) {
          this.#dependencies.onEventSinkError?.(error, event, sink);
          if (this.#dependencies.eventSinkFailurePolicy === "fail-run")
            throw error;
        }
      }
      return event;
    });
    this.#eventTails.set(
      runId,
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
    return pending;
  }
}
