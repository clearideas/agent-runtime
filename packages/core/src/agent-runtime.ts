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
  RunBlocked,
  RunCheckpointBoundary,
  RunCheckpointFingerprints,
  RunCheckpointWorkspace,
  RunLedger,
  RunLimits,
  RunEvent,
  AgentStep,
  AgentVariableOverride,
  ConversationMessage,
  ConversationMessageInput,
  ExecutionPolicies,
  MessagesSignature,
  RunMessagesState,
  RunResult,
  StatePatch,
  StepResult,
  TranscriptItem,
  VariableState,
  WorkspaceChange,
} from "@clearideas/agent-runtime-contracts";
import {
  RUN_CHECKPOINT_CONTRACT_VERSION,
  RUN_CHECKPOINT_CONTRACT_VERSIONS,
  agentRunBudgetSchema,
  agentManifestSchema,
  runLimitsSchema,
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
  NotPersistedChange,
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
import {
  compactionLabel,
  declaresMessages,
  historyBytes,
  outputHistory,
  planHistoryCompaction,
  prepareSuppliedHistory,
  pruneMarkerMessage,
  renderHistoryText,
  selectHistory,
  summaryMarkerMessage,
  withMessagesView,
  withoutMessagesPatch,
  withoutMessagesView,
  type AgentRuntimeMessagesOptions,
  type HistorySelection,
} from "./messages.js";
import { mergeExecutionPolicies, resolveStepPolicies } from "./policies.js";
import {
  RunLedgerTracker,
  resolveRunLimits,
  seededLedger,
  transcriptTokens,
  sandboxUsageFromCheckpoint,
  type EffectiveRunLimits,
} from "./limits.js";
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
  /** The run's effective limits. */
  limits?: EffectiveRunLimits | undefined;
  /** Effective policies: host defaults, then manifest, then step, then host-enforced. */
  policies?: ExecutionPolicies | undefined;
  /** The host's context summarizer, when it supplies one. */
  summarizer?: ContextSummarizerAdapter | undefined;
  /**
   * What this step sees of the conversation history. Present when the
   * manifest declares messages.
   */
  history?: StepHistoryContext | undefined;
  emit(type: string, data?: JsonObject): Promise<RunEvent>;
  /**
   * Stable identity of this step execution within the run: the step path,
   * with the iteration of each enclosing loop (for example `each[2]/fetch`).
   * The same execution keeps its key when it resumes.
   */
  executionKey?: string;
  /** Present when this step is resuming from a nested checkpoint. */
  resume?: {
    cursor: ExecutionCursor;
    continuation?: JsonObject;
    transcript?: TranscriptItem[];
    artifacts?: ArtifactRef[];
    /**
     * Facts about the previous attempt the step should tell its model once,
     * such as workspace changes that could not be saved.
     */
    notices?: string[];
  };
  /**
   * Execute a registered child step without committing the parent step. A
   * parent that checkpoints its own progress (such as a loop) passes a frame,
   * so the child's mid-step checkpoints carry the parent's state too.
   */
  executeChild?(
    step: AgentStep,
    variables: Readonly<VariableState>,
    stepPath: string,
    frame?: ChildExecutionFrame,
  ): Promise<StepExecutionResult>;
  /** Commit resumable state while a nested step remains active. */
  checkpoint?(input: NestedCheckpointInput): Promise<void>;
  evaluateCondition?(
    expression: string,
    variables: Readonly<VariableState>,
  ): Promise<boolean>;
}

/** One step's view of the run's conversation history. */
export interface StepHistoryContext {
  /** The step's selection, marker first when included, media mode applied. */
  messages: ConversationMessage[];
  /** Turn and position of each message in `messages`; undefined for the marker. */
  places: Array<{ turn: number; position: number } | undefined>;
  /** The current run's turn. */
  turn: number;
  /** The step set `history`; only then are turns inserted or histories forwarded. */
  explicit: boolean;
  /** Prompt steps insert `messages` as model turns. */
  insert: boolean;
  media: "include" | "latest" | "omit";
  /** The run's signature scope. */
  scope?: string | undefined;
  /** Sign messages the step forwards (a sub-run); undefined without a signer. */
  sign(
    messages: readonly ConversationMessage[],
  ): Promise<MessagesSignature | undefined>;
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
  /**
   * Set by a parent when a nested step has just completed: the checkpoint is
   * a step commit point and a restart point.
   */
  boundary?: { stepPath: string; executionKey?: string };
}

/** A child step's share of its parent's restored state. */
export interface ChildResumeState {
  continuation?: JsonObject;
  /** Transcript the child produced before the checkpoint. */
  transcript?: TranscriptItem[];
  /** Artifacts the child produced before the checkpoint. */
  artifacts?: ArtifactRef[];
}

/**
 * What a parent step supplies when it executes a child. Without a frame, a
 * child's mid-step checkpoint would replace the parent's own resumable state.
 */
export interface ChildExecutionFrame {
  /**
   * Wrap a child's nested checkpoint in the parent's resumable state: the
   * parent's continuation (embedding the child's), cursor, accumulated
   * transcript, and artifacts.
   */
  checkpoint(nested: NestedCheckpointInput): NestedCheckpointInput;
  /**
   * Present when the child is resuming. With a frame, a child resumes only
   * from this, never from the run's raw latest checkpoint.
   */
  resume?: ChildResumeState;
  /** Distinguishes repeated executions of one child, such as a loop iteration. */
  key?: string;
}

/** The execution key of a child step, from its parent's key and frame. */
export const childExecutionKey = (
  parentKey: string,
  childId: string,
  frame?: Pick<ChildExecutionFrame, "key">,
): string =>
  frame?.key !== undefined
    ? `${parentKey}[${frame.key}]/${childId}`
    : `${parentKey}/${childId}`;

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
  /**
   * Host default run limits, replacing values of `DEFAULT_RUN_LIMITS`; the
   * manifest and limits granted on resume override them.
   */
  limits?: RunLimits;
  /**
   * Host ceilings on run limits, applied after the manifest and any limits
   * granted on resume: they can only lower a limit. A ceiling alone applies.
   */
  enforcedLimits?: RunLimits;
  /** Observes, changes, or replaces context summarization. */
  summarizer?: ContextSummarizerAdapter;
  /** Conversation messages: signing, media authorization, limits, and compaction. */
  messages?: AgentRuntimeMessagesOptions;
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
  /**
   * Raise (or lower) run limits for this attempt and every later one, for
   * example to resume a run blocked by a limit. Host ceilings still apply.
   */
  limits?: RunLimits;
  /** Conversation history for an agent that declares messages. */
  messages?: ConversationMessageInput[];
  /** The runtime's signature over a leading prefix of `messages`. */
  messagesSignature?: MessagesSignature;
  /**
   * Host-only signature binding, for example `tenant:42/user:7/conversation:abc`.
   * Allowed alongside agentRunManifest because it is host data, like `signal`.
   */
  messagesScope?: string;
  signal?: AbortSignal;
  /** Resume from the latest committed checkpoint for runId. */
  resume?: boolean;
  /**
   * Start a new run from a step-completion checkpoint of another run (one
   * with `boundary`), for example to restart from the last known good step.
   * The new run reuses the checkpoint's state, results, and transcript,
   * starts with fresh usage, and passes the checkpoint's workspace tokens to
   * the workspace provider as `restoreFrom`. Not combined with resume,
   * variables, or messages.
   */
  seed?: RunCheckpoint;
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
  /** The frame the parent executor supplied for this child. */
  frame?: ChildExecutionFrame | undefined;
  /** This child's execution key. */
  executionKey: string;
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

  constructor(
    reason: string,
    details?: JsonObject,
    options?: { message?: string; cause?: unknown },
  ) {
    super(
      options?.message ?? `Run suspended: ${reason}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "RunSuspendedError";
    this.reason = reason;
    this.details = details;
  }
}

/**
 * An error that must end the run as failed even when the run's `onFailure`
 * policy would pause it: a security or policy violation, or a problem no
 * resume can fix. Hosts throw it from adapters and hooks (for example, a
 * destination that is not authorized).
 */
export class RunFatalError extends Error {
  readonly code: string;
  readonly fatal = true;

  constructor(message: string, code = "RUN_FATAL") {
    super(message);
    this.name = "RunFatalError";
    this.code = code;
  }
}

const FATAL_ERROR_CODES = new Set([
  "MANIFEST_PREFLIGHT_FAILED",
  "MANIFEST_CHANGED",
  "RUN_FATAL",
]);
const FATAL_ERROR_NAMES = new Set([
  "ApprovalRejectedError",
  "McpToolIntegrityError",
  "MessagesValidationError",
]);

/**
 * Fatal errors fail the run whatever its `onFailure` policy: manifest and
 * message validation, a rejected approval, tool-integrity violations, and
 * any error marked `fatal: true` (see `RunFatalError`).
 */
export const isFatalRunError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const marked = error as Error & { fatal?: unknown; code?: unknown };
  return (
    marked.fatal === true ||
    FATAL_ERROR_NAMES.has(error.name) ||
    (typeof marked.code === "string" && FATAL_ERROR_CODES.has(marked.code)) ||
    (typeof marked.code === "string" && marked.code.startsWith("MESSAGES_"))
  );
};

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
  | "awaiting-input"
  | "awaiting-child"
  | "awaiting-budget"
  | "awaiting-host"
  | "paused"
  | "other";

/**
 * Suspension reason for a run that needs its host: a limit was reached, or
 * a step failed with an error that is not fatal. Details carry a `cause`.
 */
export const RUN_BLOCKED_REASON = "blocked";

/** Classify a suspension reason for hosts and user interfaces. */
export const suspensionKind = (reason: string): RunSuspensionKind => {
  switch (reason) {
    case "approval":
      return "awaiting-input";
    case "sub-run":
      return "awaiting-child";
    case "token-budget":
      return "awaiting-budget";
    case RUN_BLOCKED_REASON:
      return "awaiting-host";
    case RUN_PAUSED_REASON:
      return "paused";
    default:
      return "other";
  }
};

/**
 * The suspension for a step that failed with an error the host can fix (a
 * provider outage, a credential, an interrupted operation). The run resumes
 * at its latest checkpoint once the host acts.
 */
export const createErrorSuspension = (input: {
  error: RunError;
  stepId?: string | undefined;
  /** The original error, kept as the suspension's `cause`. */
  cause?: unknown;
}): RunSuspendedError =>
  new RunSuspendedError(
    RUN_BLOCKED_REASON,
    {
      cause: "error",
      error: {
        code: input.error.code,
        message: input.error.message,
        ...(input.error.retryable !== undefined
          ? { retryable: input.error.retryable }
          : {}),
        ...(input.error.details ? { details: input.error.details } : {}),
      },
      ...(input.stepId ? { stepId: input.stepId } : {}),
    },
    {
      message: `Run blocked: ${input.error.message}`,
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    },
  );

/**
 * The suspension thrown when a run reaches one of its limits. The run resumes
 * once a higher limit is granted (`RunRequest.limits` or the manifest).
 */
export const createLimitSuspension = (input: {
  limit: string;
  used: number;
  value: number;
  stepId?: string | undefined;
}): RunSuspendedError =>
  new RunSuspendedError(
    RUN_BLOCKED_REASON,
    {
      cause: "limit",
      limit: input.limit,
      used: input.used,
      value: input.value,
      ...(input.stepId ? { stepId: input.stepId } : {}),
    },
    {
      message: `Run blocked: it reached its ${input.limit} limit (${input.used} of ${input.value}).`,
    },
  );

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

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

/** A step without the fields a resume may change: policies and descriptions. */
const fingerprintedStep = (step: AgentStep): JsonValue => {
  const {
    policies: _policies,
    name: _name,
    description: _description,
    metadata: _metadata,
    ...rest
  } = step;
  return (
    step.type === "loop"
      ? { ...rest, steps: step.steps.map(fingerprintedStep) }
      : rest
  ) as JsonValue;
};

/**
 * Fingerprints that decide which manifest changes a resume accepts. `global`
 * covers manifest fields that completed steps depend on; `steps` has one
 * entry per top-level step, over everything but its policies and
 * descriptions. Limits, policies, the default model, and descriptive fields
 * are not fingerprinted, so they may change on any resume.
 */
export const fingerprintManifest = async (
  manifest: AgentManifest,
): Promise<RunCheckpointFingerprints> => ({
  global: await sha256Hex(
    stableStringify({
      variables: manifest.variables ?? null,
      connections: manifest.connections ?? null,
      workspaces: manifest.workspaces ?? null,
      messages: manifest.messages ?? null,
      extensions: manifest.extensions ?? null,
    }),
  ),
  steps: await Promise.all(
    manifest.steps.map((step) =>
      sha256Hex(stableStringify(fingerprintedStep(step))),
    ),
  ),
});

/**
 * What resuming (or restarting) from a checkpoint with a given manifest
 * would do, decided before anything runs:
 *
 * - `unchanged`: the manifest is the one the checkpoint was written with.
 * - `accepted`: only fields a resume may change differ (limits, policies,
 *   descriptions, the default model) or steps with no completed work.
 * - `restarts-step`: the step that was in progress changed; it runs again
 *   from its start, repeating its completed work.
 * - `refused`: a completed step, or a manifest-wide field completed steps
 *   depend on, changed; restart from an earlier step or start a new run.
 */
export interface ManifestChangeAssessment {
  outcome: "unchanged" | "accepted" | "restarts-step" | "refused";
  /** Top-level steps whose definitions differ, in manifest order. */
  changedSteps: string[];
  /** Variables, connections, workspaces, messages, or extensions differ. */
  globalChanged: boolean;
  /** The step that restarts, or the first completed step that changed. */
  step?: string;
  /** Why, in one sentence. */
  reason: string;
}

const classifyManifestChange = (input: {
  manifest: AgentManifest;
  checkpoint: RunCheckpoint;
  current: RunCheckpointFingerprints;
  hashMatches: boolean;
}): ManifestChangeAssessment => {
  const { checkpoint, current, manifest } = input;
  const saved = checkpoint.fingerprints;
  if (!saved) {
    return input.hashMatches
      ? {
          outcome: "unchanged",
          changedSteps: [],
          globalChanged: false,
          reason: "The manifest is the one the checkpoint was written with.",
        }
      : {
          outcome: "refused",
          changedSteps: [],
          globalChanged: false,
          reason:
            "The checkpoint predates step fingerprints, so only the same manifest can resume it.",
        };
  }
  const changedSteps = manifest.steps.flatMap((step, index) =>
    saved.steps[index] !== current.steps[index] ? [step.id] : [],
  );
  if (current.steps.length < saved.steps.length)
    changedSteps.push(
      ...saved.steps
        .slice(current.steps.length)
        .map((_, offset) => `#${current.steps.length + offset + 1}`),
    );
  const globalChanged = saved.global !== current.global;
  const base = { changedSteps, globalChanged };
  if (globalChanged) {
    return {
      outcome: "refused",
      ...base,
      reason:
        "It changes variables, connections, workspaces, messages, or extensions, which completed steps depend on.",
    };
  }
  const cursor = checkpoint.cursor.stepIndex;
  for (let index = 0; index < cursor; index += 1) {
    if (saved.steps[index] !== current.steps[index]) {
      const id = manifest.steps[index]?.id ?? `#${index + 1}`;
      return {
        outcome: "refused",
        ...base,
        step: id,
        reason: `Step ${id} already completed and its definition changed.`,
      };
    }
  }
  const midStep =
    checkpoint.continuation != null ||
    (checkpoint.activeStepTranscript?.length ?? 0) > 0 ||
    (checkpoint.activeStepArtifacts?.length ?? 0) > 0 ||
    checkpoint.cursor.stepPath != null;
  if (
    cursor < manifest.steps.length &&
    midStep &&
    saved.steps[cursor] !== current.steps[cursor]
  ) {
    const step = manifest.steps[cursor]!;
    if (checkpoint.continuation?.type === "loop") {
      return {
        outcome: "refused",
        ...base,
        step: step.id,
        reason: `Loop step ${step.id} changed while it was in progress, and its saved state reflects iterations already run.`,
      };
    }
    return {
      outcome: "restarts-step",
      ...base,
      step: step.id,
      reason: `Step ${step.id} was in progress and changed; it runs again from its start.`,
    };
  }
  if (changedSteps.length === 0 && input.hashMatches) {
    return {
      outcome: "unchanged",
      ...base,
      reason: "The manifest is the one the checkpoint was written with.",
    };
  }
  return {
    outcome: "accepted",
    ...base,
    reason:
      changedSteps.length > 0
        ? `Only steps with no completed work changed (${changedSteps.join(", ")}).`
        : "Only fields a resume may change differ, such as limits or policies.",
  };
};

/**
 * Assess, without running anything, what resuming or restarting from
 * `checkpoint` with `manifest` would do. A host uses it to show the
 * consequences of an edit before the user commits to it.
 */
export const assessManifestChange = async (
  checkpoint: RunCheckpoint,
  manifest: AgentManifest,
  options: { manifestHasher?: ManifestHasher } = {},
): Promise<ManifestChangeAssessment> => {
  const parsed = agentManifestSchema.parse(manifest);
  return classifyManifestChange({
    manifest: parsed,
    checkpoint: parseRunCheckpoint(checkpoint),
    current: await fingerprintManifest(parsed),
    hashMatches:
      checkpoint.manifestHash ===
      (await (options.manifestHasher ?? defaultManifestHasher).hash(parsed)),
  });
};

/**
 * Apply the assessment when a run resumes or restarts: refuse, or drop the
 * changed in-progress step's partial work so it runs again from its start.
 */
const reconcileManifestChange = (input: {
  runId: string;
  manifest: AgentManifest;
  checkpoint: RunCheckpoint;
  current: RunCheckpointFingerprints;
  hashMatches: boolean;
}): { checkpoint: RunCheckpoint; restartedStep?: string } => {
  const { checkpoint, runId } = input;
  const assessment = classifyManifestChange(input);
  if (assessment.outcome === "refused") {
    if (!checkpoint.fingerprints)
      throw new Error(`Manifest does not match checkpoint for run ${runId}`);
    const advice = assessment.globalChanged
      ? "Start a new run, or restore those fields."
      : "Restart the run from a step before it, or restore the step.";
    throw new AgentRuntimeError(
      `Manifest does not match checkpoint for run ${runId}: ${assessment.reason[0]!.toLowerCase()}${assessment.reason.slice(1, -1)}. ${advice}`,
      "MANIFEST_CHANGED",
    );
  }
  if (assessment.outcome !== "restarts-step") return { checkpoint };
  const {
    continuation: _continuation,
    activeStepTranscript,
    activeStepArtifacts,
    ...rest
  } = checkpoint;
  return {
    checkpoint: {
      ...rest,
      cursor: { stepIndex: checkpoint.cursor.stepIndex },
      transcript: withoutActiveTail(
        checkpoint.transcript,
        activeStepTranscript,
      ),
      artifacts: withoutActiveTail(checkpoint.artifacts, activeStepArtifacts),
    },
    restartedStep: assessment.step!,
  };
};

/** Validate a seed: a step-completion checkpoint of some run. */
const parseSeed = (input: RunCheckpoint): RunCheckpoint => {
  const seed = parseRunCheckpoint(input);
  if (!seed.boundary) {
    throw new AgentRuntimeError(
      "A run can only be seeded from a step-completion checkpoint (one with a boundary); list them with RunStore.listCheckpoints(runId, { boundaries: true }).",
      "SEED_INVALID",
    );
  }
  return seed;
};

/** The workspace tokens a seed hands to the workspace provider. */
const restoreTokens = (
  seed: RunCheckpoint,
): Record<string, string> | undefined => {
  const tokens = Object.fromEntries(
    Object.entries(seed.workspaces ?? {}).flatMap(([alias, entry]) =>
      entry.token ? [[alias, entry.token]] : [],
    ),
  );
  return Object.keys(tokens).length > 0 ? tokens : undefined;
};

/**
 * A seed re-sequenced as the first checkpoint of a new run: same position,
 * state, and content, with fresh usage and a record of where it came from.
 */
const seededCheckpoint = (input: {
  runId: string;
  source: RunCheckpoint;
  seed: RunCheckpoint;
  id: string;
  fingerprints: RunCheckpointFingerprints;
  runtimeVersion: string;
  createdAt: string;
}): RunCheckpoint => {
  const {
    ledger: _ledger,
    budget: _budget,
    metadata,
    workspaces,
    ...rest
  } = structuredClone(input.source);
  const {
    sandboxBudget: _sandboxBudget,
    workspaceSync: _workspaceSync,
    ...keptMetadata
  } = metadata ?? {};
  const tokens = Object.fromEntries(
    Object.entries(workspaces ?? {}).flatMap(([alias, entry]) =>
      entry.token
        ? [
            [
              alias,
              {
                token: entry.token,
                ...(entry.stepPath ? { stepPath: entry.stepPath } : {}),
              },
            ],
          ]
        : [],
    ),
  );
  return {
    ...rest,
    id: input.id,
    runId: input.runId,
    sequence: 1,
    attempt: 1,
    contractVersion: RUN_CHECKPOINT_CONTRACT_VERSION,
    runtimeVersion: input.runtimeVersion,
    ledger: { ...seededLedger(input.source), progress: 1 },
    fingerprints: input.fingerprints,
    ...(Object.keys(tokens).length > 0 ? { workspaces: tokens } : {}),
    createdAt: input.createdAt,
    metadata: {
      ...keptMetadata,
      seededFrom: {
        runId: input.seed.runId,
        checkpointId: input.seed.id,
        checkpointSequence: input.seed.sequence,
        stepPath: input.seed.boundary!.stepPath,
      },
    },
  };
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
  if (
    !(RUN_CHECKPOINT_CONTRACT_VERSIONS as readonly string[]).includes(
      checkpoint.contractVersion,
    )
  ) {
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

/**
 * Fold later changes into earlier ones, one entry per path, relative to the
 * state at the previous commit point.
 */
export const mergeWorkspaceChanges = (
  earlier: readonly WorkspaceChange[],
  later: readonly WorkspaceChange[],
): WorkspaceChange[] => {
  const merged = new Map(earlier.map((change) => [change.path, change]));
  for (const change of later) {
    const before = merged.get(change.path);
    if (before?.action === "created" && change.action === "deleted") {
      merged.delete(change.path);
    } else if (before?.action === "created") {
      merged.set(change.path, { ...change, action: "created" });
    } else if (before?.action === "deleted" && change.action === "created") {
      merged.set(change.path, { ...change, action: "modified" });
    } else {
      merged.set(change.path, { ...change });
    }
  }
  return [...merged.values()];
};

/** The durable record of why a blocked run waits for its host. */
const blockedRecord = (error: RunSuspendedError, at: string): RunBlocked => {
  const details = error.details ?? {};
  const number = (value: JsonValue | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (details.cause === "limit") {
    const limit = String(details.limit ?? "limit");
    const used = number(details.used);
    const value = number(details.value);
    return {
      cause: "limit",
      code: limit,
      message: `The run reached its ${limit} limit${
        value !== undefined ? ` of ${value}` : ""
      }${used !== undefined ? ` (used ${used})` : ""}. Grant a higher limit to resume.`,
      ...(used !== undefined ? { used } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(typeof details.stepId === "string" ? { stepId: details.stepId } : {}),
      at,
    };
  }
  const runError =
    details.error != null && typeof details.error === "object"
      ? (details.error as JsonObject)
      : {};
  return {
    cause: "error",
    code: String(runError.code ?? "AGENT_EXECUTION_FAILED"),
    message: String(runError.message ?? error.message),
    ...(typeof runError.retryable === "boolean"
      ? { retryable: runError.retryable }
      : {}),
    ...(runError.details != null &&
    typeof runError.details === "object" &&
    !Array.isArray(runError.details)
      ? { details: runError.details }
      : {}),
    ...(typeof details.stepId === "string" ? { stepId: details.stepId } : {}),
    at,
  };
};

/** What a resuming step should be told about its previous attempt. */
const resumeNotices = (checkpoint: RunCheckpoint | null): string[] => {
  const sync = checkpoint?.metadata?.workspaceSync;
  if (
    sync == null ||
    typeof sync !== "object" ||
    Array.isArray(sync) ||
    sync.failed !== true
  )
    return [];
  return [
    `Some workspace changes from the previous attempt could not be saved when its sandbox closed (${String(sync.error ?? "unknown error")}). Workspace files may not match what earlier tool results show; check them before relying on them.`,
  ];
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
  /**
   * Cumulative sandbox usage for each active run, restored from the latest
   * checkpoint. Carried into every checkpoint, including those saved before
   * an attempt reopens its sandbox, so usage never resets across attempts.
   */
  readonly #runSandboxBudgets = new Map<string, SandboxBudgetState>();
  /** The checkpoint each active run most recently committed or resumed from. */
  readonly #lastCheckpoints = new Map<string, RunCheckpoint>();
  /** Each active run's durable usage and its effective limits. */
  readonly #runLedgers = new Map<string, RunLedgerTracker>();
  readonly #runLimits = new Map<string, EffectiveRunLimits>();
  readonly #runLimitControllers = new Map<string, AbortController>();
  readonly #runTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  readonly #runFingerprints = new Map<string, RunCheckpointFingerprints>();
  /** Resolved workspace bindings, commit tokens, and pending changes per run. */
  readonly #runWorkspaces = new Map<string, readonly ResolvedWorkspace[]>();
  readonly #runWorkspaceState = new Map<
    string,
    Record<string, RunCheckpointWorkspace>
  >();
  readonly #runPendingNotPersisted = new Map<
    string,
    Map<string, NotPersistedChange[]>
  >();
  readonly #runInputs = new Map<string, Record<string, { token: string }>>();
  /** Each active run's effective conversation history. */
  readonly #runMessages = new Map<string, RunMessagesState>();

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
        request.budget ||
        request.messages ||
        request.messagesSignature ||
        request.seed
      ) {
        throw new Error(
          "agentRunManifest cannot be combined with resume, seed, manifest, manifestReference, variables, runId, execution, budget, messages, or messagesSignature",
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
        ...(agentRunManifest.messages
          ? { messages: agentRunManifest.messages }
          : {}),
        ...(agentRunManifest.messagesSignature
          ? { messagesSignature: agentRunManifest.messagesSignature }
          : {}),
      };
    }
    if (normalizedRequest.resume && !normalizedRequest.runId) {
      throw new Error("A runId is required to resume a run");
    }
    if (
      normalizedRequest.seed &&
      (normalizedRequest.resume ||
        normalizedRequest.variables != null ||
        normalizedRequest.messages != null ||
        normalizedRequest.messagesSignature != null)
    ) {
      throw new Error(
        "A seeded run takes its state and history from the seed; it cannot be combined with resume, variables, or messages",
      );
    }
    if (normalizedRequest.resume && normalizedRequest.variables != null) {
      throw new Error(
        "Run variable overrides cannot be supplied when resuming a run",
      );
    }
    if (
      normalizedRequest.resume &&
      (normalizedRequest.messages != null ||
        normalizedRequest.messagesSignature != null ||
        normalizedRequest.messagesScope != null)
    ) {
      throw new Error(
        "Conversation messages cannot be supplied when resuming a run",
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
      this.#runSandboxBudgets.delete(runId);
      this.#lastCheckpoints.delete(runId);
      this.#runLedgers.delete(runId);
      this.#runLimits.delete(runId);
      this.#runFingerprints.delete(runId);
      this.#runWorkspaces.delete(runId);
      this.#runWorkspaceState.delete(runId);
      this.#runPendingNotPersisted.delete(runId);
      this.#runInputs.delete(runId);
      this.#runLimitControllers.delete(runId);
      for (const timer of this.#runTimers.get(runId) ?? []) clearTimeout(timer);
      this.#runTimers.delete(runId);
      this.#runMessages.delete(runId);
    }
  }

  /**
   * Check, without creating a run, that a manifest can run with this host:
   * the manifest is valid, every step has a registered executor and the
   * adapters it needs, every condition parses, and every tool a prompt step
   * names is available. Throws the error `run()` would throw before its
   * first model call, so a host can refuse a manifest at startup.
   */
  async preflight(manifest: AgentManifest): Promise<void> {
    await this.#preflight(this.#parseManifest(manifest));
  }

  #parseManifest(rawManifest: unknown): AgentManifest {
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
    return manifest;
  }

  async #run(
    input: RunRequest & { runId: string },
  ): Promise<AgentExecutionResult> {
    // Time limits abort the attempt through this controller with a limit
    // suspension; the host's own signal still pauses, interrupts, or cancels.
    const limitController = new AbortController();
    this.#runLimitControllers.set(input.runId, limitController);
    const request: RunRequest & { runId: string; signal: AbortSignal } = {
      ...input,
      signal: input.signal
        ? AbortSignal.any([input.signal, limitController.signal])
        : limitController.signal,
    };
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
    const manifest = this.#parseManifest(rawManifest);
    const requestedBudget = request.budget
      ? agentRunBudgetSchema.parse(request.budget)
      : undefined;
    let latestCheckpoint = request.resume
      ? await this.#dependencies.runStore.loadLatestCheckpoint(runId)
      : null;
    if (request.resume && !latestCheckpoint) {
      throw new Error(`Run ${runId} has no checkpoint to resume`);
    }
    const seed = request.seed ? parseSeed(request.seed) : undefined;
    const workspaces = await resolveAgentWorkspaces(
      manifest,
      this.#dependencies.workspaces,
      {
        runId,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(seed && restoreTokens(seed)
          ? { restoreFrom: restoreTokens(seed)! }
          : {}),
      },
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
    const fingerprints = await fingerprintManifest(manifest);
    this.#runFingerprints.set(runId, fingerprints);
    let restartedStep: string | undefined;
    if (latestCheckpoint) {
      const reconciled = reconcileManifestChange({
        runId,
        manifest,
        checkpoint: latestCheckpoint,
        current: fingerprints,
        hashMatches:
          latestCheckpoint.manifestHash ===
          (await this.#manifestHasher.hash(manifest)),
      });
      latestCheckpoint = reconciled.checkpoint;
      restartedStep = reconciled.restartedStep;
    }
    if (seed) {
      const reconciled = reconcileManifestChange({
        runId,
        manifest,
        checkpoint: seed,
        current: fingerprints,
        hashMatches:
          seed.manifestHash === (await this.#manifestHasher.hash(manifest)),
      });
      restartedStep = reconciled.restartedStep;
      latestCheckpoint = seededCheckpoint({
        runId,
        source: reconciled.checkpoint,
        seed,
        id: this.#ids.generateId("checkpoint"),
        fingerprints,
        runtimeVersion: this.#dependencies.runtimeVersion ?? RUNTIME_VERSION,
        createdAt: this.#clock.now().toISOString(),
      });
      assertRecoverableCheckpoint({
        checkpoint: latestCheckpoint,
        runId,
        manifest,
        runAttempt: 1,
      });
    }
    if (latestCheckpoint && existingRecord) {
      assertRecoverableCheckpoint({
        checkpoint: latestCheckpoint,
        runId,
        manifest,
        runAttempt: existingRecord.attempt ?? 1,
      });
    }

    if (latestCheckpoint) this.#lastCheckpoints.set(runId, latestCheckpoint);
    const restoredSandboxUsage = sandboxUsageFromCheckpoint(latestCheckpoint);
    if (restoredSandboxUsage)
      this.#runSandboxBudgets.set(runId, {
        commandsUsed: restoredSandboxUsage.commands,
        sandboxSecondsUsed: restoredSandboxUsage.seconds,
      });
    this.#runWorkspaces.set(runId, workspaces);
    this.#runWorkspaceState.set(
      runId,
      structuredClone(latestCheckpoint?.workspaces ?? {}),
    );
    if (latestCheckpoint?.inputs) {
      this.#runInputs.set(runId, structuredClone(latestCheckpoint.inputs));
    } else if (!request.resume) {
      // The version of each read-only input the run starts from, when the
      // store can name one.
      const inputs: Record<string, { token: string }> = {};
      for (const workspace of workspaces) {
        if (workspace.mode !== "read" || !workspace.store.version) continue;
        const token = await workspace.store.version({ signal: request.signal });
        if (token) inputs[workspace.alias] = { token };
      }
      this.#runInputs.set(runId, inputs);
    }
    const ledger = new RunLedgerTracker({
      checkpoint: latestCheckpoint,
      now: () => this.#clock.now().getTime(),
    });
    ledger.grant(
      request.limits ? runLimitsSchema.parse(request.limits) : undefined,
    );
    this.#runLedgers.set(runId, ledger);
    this.#runLimits.set(
      runId,
      resolveRunLimits(manifest, {
        defaults: this.#dependencies.limits,
        granted: ledger.granted,
        ceilings: this.#dependencies.enforcedLimits,
      }),
    );

    const effectiveBudget = requestedBudget ?? latestCheckpoint?.budget;
    if (effectiveBudget) {
      // A seeded run starts its budget fresh; its inherited transcript was
      // paid for by the run it came from.
      const consumedTokens = seed
        ? 0
        : (latestCheckpoint?.budget?.consumedTokens ??
          consumedTokensFromTranscript(latestCheckpoint?.transcript ?? []));
      this.#runTokenBudgets.set(
        runId,
        new RunTokenBudget({
          maxTotalTokens: effectiveBudget.maxTotalTokens,
          consumedTokens,
        }),
      );
    }

    // The conversation history is validated, verified, and its media
    // ingested before any run state exists; resume restores it instead.
    const prepared =
      request.resume || seed
        ? undefined
        : await prepareSuppliedHistory({
            runId,
            manifest,
            messages: request.messages,
            signature: request.messagesSignature,
            scope: request.messagesScope,
            options: this.#dependencies.messages ?? {},
            artifacts: this.#dependencies.artifacts,
            strategy:
              this.#historyPolicies(manifest).context?.strategy ?? "prune",
            describeModel: this.#dependencies.model?.describeModel
              ? async (model) =>
                  (await this.#dependencies.model!.describeModel!(model)) ??
                  undefined
              : undefined,
          });
    if (prepared) {
      this.#runMessages.set(runId, {
        history: structuredClone(prepared.history),
        compaction: prepared.compaction,
        signedCount: prepared.signedCount,
        ...(request.messagesScope != null
          ? { scope: request.messagesScope }
          : {}),
      });
    } else if (declaresMessages(manifest)) {
      this.#runMessages.set(
        runId,
        structuredClone(
          latestCheckpoint?.messages ?? {
            history: [],
            compaction: "complete",
            signedCount: 0,
          },
        ),
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
      ...(prepared
        ? {
            messages: {
              supplied: structuredClone(prepared.history),
              signedCount: prepared.signedCount,
              ...(request.messagesScope != null
                ? { scope: request.messagesScope }
                : {}),
            },
          }
        : existingRecord?.messages
          ? { messages: structuredClone(existingRecord.messages) }
          : seed && latestCheckpoint?.messages
            ? {
                messages: {
                  supplied: structuredClone(latestCheckpoint.messages.history),
                  signedCount: latestCheckpoint.messages.signedCount,
                  ...(latestCheckpoint.messages.scope != null
                    ? { scope: latestCheckpoint.messages.scope }
                    : {}),
                },
              }
            : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    let uncommittedSteps: AgentStep[] = [];
    /** The top-level step whose failure ended the attempt, when known. */
    let failedStepId: string | undefined;
    /** Whether a failure blocks the run (onFailure: pause) instead of failing it. */
    const failurePauses = (error: unknown) =>
      !isAbortError(request.signal) &&
      !isRunCancelledError(error) &&
      !isFatalRunError(error) &&
      mergeExecutionPolicies(
        this.#dependencies.policies,
        manifest.policies,
        this.#dependencies.enforcedPolicies,
      ).onFailure !== "fail";
    if (!request.resume) {
      await this.#dependencies.runStore.createRun(record);
      this.#runAttempts.set(runId, 1);
      if (seed && latestCheckpoint) {
        // The seed, re-sequenced for this run, is its first checkpoint.
        await this.#dependencies.runStore.saveCheckpoint(latestCheckpoint);
        this.#checkpointSequences.set(runId, latestCheckpoint.sequence);
        this.#lastCheckpoints.set(runId, latestCheckpoint);
      }
    } else {
      // A manifest the host supplied may differ from the stored one (within
      // the fingerprint rules); the store keeps it for later resumes.
      const suppliedManifest =
        request.manifest != null || request.manifestReference != null;
      const attempt = await this.#dependencies.runStore.resumeRun(
        runId,
        this.#clock.now().toISOString(),
        request.allowRunningTakeover || suppliedManifest
          ? {
              ...(request.allowRunningTakeover
                ? { allowRunningTakeover: true }
                : {}),
              ...(suppliedManifest ? { manifest } : {}),
            }
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
        ...(seed
          ? {
              seededFrom: {
                runId: seed.runId,
                checkpointSequence: seed.sequence,
                stepPath: seed.boundary!.stepPath,
                ...(seed.boundary!.executionKey
                  ? { executionKey: seed.boundary!.executionKey }
                  : {}),
              },
            }
          : {}),
        ...(prepared
          ? {
              messages: {
                count: prepared.history.length,
                signedCount: prepared.signedCount,
                verified: prepared.verified,
                ingestedArtifacts: prepared.ingestedArtifacts,
                compaction:
                  prepared.compaction === "pending" ? "pending" : "none",
              },
            }
          : {}),
      });
      if (restartedStep) {
        await this.#emit(
          runId,
          "diagnostic",
          {
            code: "STEP_RESTARTED_AFTER_MANIFEST_CHANGE",
            message: `Step ${restartedStep} changed while it was in progress; it runs again from its start.`,
          },
          restartedStep,
        );
      }
      for (const notice of resumeNotices(latestCheckpoint)) {
        await this.#emit(runId, "diagnostic", {
          code: "WORKSPACE_SYNC_FAILED_PREVIOUSLY",
          message: notice,
        });
      }
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
      if (request.resume) {
        await this.#enforceResumeLimits({
          runId,
          attempt: record.attempt ?? 1,
          previousStatus: existingRecord!.status,
          checkpoint: latestCheckpoint!,
          granted: request.limits !== undefined,
          stepsRemain:
            latestCheckpoint!.cursor.stepIndex < manifest.steps.length,
        });
      }
      this.#startRunTimer(runId);
      const runSandbox = this.#dependencies.runSandbox
        ? () =>
            this.#openRunSandbox({
              runId,
              workspaces,
              latestCheckpoint,
              signal: request.signal,
            })
        : undefined;
      if (!request.resume && !seed) {
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
      if (this.#runMessages.get(runId)?.compaction === "pending") {
        await this.#compactHistory({
          runId,
          manifest,
          variables,
          stepResults,
          transcript,
          artifacts,
          signal: request.signal,
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
              checkpointEnabled: wave.stepIndexes.length === 1,
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
                  // The first failure decides whether the run is blocked.
                  ...(failurePauses(
                    failures[0] instanceof TopLevelStepExecutionError
                      ? failures[0].cause
                      : failures[0],
                  )
                    ? { paused: true }
                    : {}),
                },
                wrapped.step.id,
              );
            }
          }
          uncommittedSteps = [];
          const first = failures[0];
          if (first instanceof TopLevelStepExecutionError)
            failedStepId = first.step.id;
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
        this.#runLedgers.get(runId)?.endStep();
        const lastIndex = wave.stepIndexes.at(-1)!;
        const lastStep = manifest.steps[lastIndex]!;
        await this.#checkpoint({
          runId,
          manifest,
          nextStepIndex,
          variables,
          stepResults,
          transcript,
          artifacts,
          boundary: {
            stepPath: lastStep.id,
            stepIndex: lastIndex,
            executionKey: lastStep.id,
          },
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
      const messagesState = this.#runMessages.get(runId);
      const messages = messagesState
        ? outputHistory(messagesState.history, output)
        : undefined;
      const messagesSignature =
        messages && this.#dependencies.messages?.signer
          ? await this.#dependencies.messages.signer.sign({
              messages,
              scope: messagesState?.scope,
            })
          : undefined;
      const completedAt = this.#clock.now().toISOString();
      const { messages: suppliedMessages, ...recordWithoutMessages } = record;
      const completedRecord: CompletedRunRecord = {
        ...recordWithoutMessages,
        status: "completed",
        state: structuredClone(variables),
        updatedAt: completedAt,
        ...(output === undefined ? {} : { output }),
        transcript: structuredClone(transcript),
        artifacts: structuredClone(artifacts),
        ...(usage ? { usage } : {}),
        ...(messages
          ? {
              messages: {
                supplied: structuredClone(suppliedMessages?.supplied ?? []),
                signedCount: suppliedMessages?.signedCount ?? 0,
                ...(messagesState?.scope != null
                  ? { scope: messagesState.scope }
                  : {}),
                output: structuredClone(messages),
                ...(messagesSignature ? { signature: messagesSignature } : {}),
              },
            }
          : {}),
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
        ...(messages ? { messages } : {}),
        ...(messagesSignature ? { messagesSignature } : {}),
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
        if (error.reason === RUN_BLOCKED_REASON) {
          // Suspension carries no details in the run store: the checkpoint
          // is where a host reads why the run is waiting for it.
          const blocked = blockedRecord(error, suspendedAt);
          await this.#commitCheckpointCopy(runId, (copy) => {
            copy.ledger = {
              ...(copy.ledger ?? {
                tokens: 0,
                activeMs: 0,
                artifacts: { count: 0, bytes: 0 },
              }),
              blocked,
            };
          }).catch(() => undefined);
        }
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
      if (failurePauses(error)) {
        // Not fatal: the run waits for its host to fix the cause, keeping
        // everything committed so far.
        const suspension = createErrorSuspension({
          error: runError,
          stepId: failedStepId ?? uncommittedSteps[0]?.id,
          cause: error,
        });
        await this.#closeRunSandboxQuietly(runId, "suspended");
        const suspendedAt = this.#clock.now().toISOString();
        const blocked = blockedRecord(suspension, suspendedAt);
        await this.#commitCheckpointCopy(runId, (copy) => {
          copy.ledger = {
            ...(copy.ledger ?? {
              tokens: 0,
              activeMs: 0,
              artifacts: { count: 0, bytes: 0 },
            }),
            blocked,
          };
        }).catch(() => undefined);
        await this.#dependencies.runStore.suspendRun(
          runId,
          suspendedAt,
          this.#runAttempts.get(runId) ?? 1,
        );
        try {
          for (const step of uncommittedSteps) {
            await this.#emit(
              runId,
              "step.failed",
              { error: runError as unknown as JsonValue, paused: true },
              step.id,
            );
          }
          await this.#emit(runId, "run.suspended", {
            reason: suspension.reason,
            kind: suspensionKind(suspension.reason),
            details: suspension.details!,
          });
        } finally {
          this.#eventSequences.delete(runId);
          this.#eventTails.delete(runId);
          this.#checkpointSequences.delete(runId);
          this.#runAttempts.delete(runId);
        }
        throw suspension;
      }
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
    /** Parallel prompt waves commit together; no cursor may advance within a wave. */
    checkpointEnabled: boolean;
  }): Promise<TopLevelStepOutcome> {
    const step = input.manifest.steps[input.stepIndex];
    if (!step) {
      throw new Error(`Manifest step ${input.stepIndex} does not exist`);
    }

    let stopStepTimer = (): void => undefined;
    try {
      const selection = this.#historySelection(input.runId, step);
      const stepVariables = withMessagesView(
        input.manifest,
        input.variables,
        selection,
      );
      if (!(await this.#shouldExecute(step, { ...stepVariables }))) {
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
      // A step execution's time and tokens are limited; a loop is not one:
      // each of its children is. Only a step running alone is tracked in
      // the ledger across attempts.
      const isExecution = step.type !== "loop";
      if (isExecution) {
        if (input.checkpointEnabled)
          this.#runLedgers.get(input.runId)?.startStep(step.id);
        stopStepTimer = this.#startStepTimer(input.runId, step.id);
      }
      const checkpointNested = (nested: NestedCheckpointInput) => {
        if (isExecution)
          this.#runLedgers
            .get(input.runId)
            ?.setStepTokens(step.id, transcriptTokens(nested.transcript ?? []));
        return input.checkpointEnabled
          ? this.#checkpoint({
              runId: input.runId,
              manifest: input.manifest,
              nextStepIndex: input.stepIndex,
              cursor: {
                stepIndex: input.stepIndex,
                stepId: step.id,
                stepPath: step.id,
                ...(nested.cursor ?? {}),
              },
              variables: withoutMessagesView(input.manifest, nested.state),
              stepResults: [...input.stepResults],
              transcript: [...input.transcript, ...(nested.transcript ?? [])],
              artifacts: [...input.artifacts, ...(nested.artifacts ?? [])],
              ...(nested.continuation
                ? { continuation: nested.continuation }
                : {}),
              activeStepTranscript: nested.transcript ?? [],
              activeStepArtifacts: nested.artifacts ?? [],
              ...(nested.boundary
                ? {
                    boundary: {
                      ...nested.boundary,
                      stepIndex: input.stepIndex,
                    },
                  }
                : {}),
            })
          : Promise.resolve();
      };

      const executed = await executor.execute({
        runId: input.runId,
        manifest: input.manifest,
        step,
        stepIndex: input.stepIndex,
        stepPath: step.id,
        variables: snapshotState(stepVariables),
        history: this.#historyContext(input.runId, selection),
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
        limits: this.#runLimits.get(input.runId),
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
                ...(resumeNotices(input.latestCheckpoint).length > 0
                  ? { notices: resumeNotices(input.latestCheckpoint) }
                  : {}),
              },
            }
          : {}),
        executionKey: step.id,
        executeChild: (childStep, childVariables, childPath, frame) =>
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
            frame,
            executionKey: childExecutionKey(step.id, childStep.id, frame),
          }),
        ...(input.checkpointEnabled ? { checkpoint: checkpointNested } : {}),
        evaluateCondition: (expression, conditionVariables) =>
          this.#evaluateCondition(expression, conditionVariables),
      });
      const result = this.#withoutMessagesResult(input.manifest, executed);

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
    } finally {
      stopStepTimer();
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

    const declaration = manifest.messages;
    if (
      declaration &&
      (declaration.maxMessages != null || declaration.maxBytes != null) &&
      !this.#dependencies.messages?.compactor
    ) {
      const strategy = this.#historyPolicies(manifest).context?.strategy;
      if (strategy === "summarize" || strategy === "summarize-or-prune") {
        problems.push(
          `The conversation history may be summarized (context strategy ${strategy}), but no MessageHistoryCompactor is configured.`,
        );
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
    parentInput: ChildExecutionInput,
  ): Promise<StepExecutionResult> {
    this.#throwIfAborted(parentInput.signal);
    // A child sees its own history selection, never its parent's view.
    const input: ChildExecutionInput = {
      ...parentInput,
      variables: withMessagesView(
        parentInput.manifest,
        parentInput.variables,
        this.#historySelection(parentInput.runId, parentInput.step),
      ),
    };
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
    // A framed child resumes only from the state its parent hands back.
    const cursorPath = input.latestCheckpoint?.cursor.stepPath;
    const isResumingPath = input.frame
      ? input.frame.resume !== undefined
      : input.latestCheckpoint?.cursor.stepIndex === input.parentStepIndex &&
        (cursorPath === input.stepPath ||
          cursorPath?.startsWith(`${input.stepPath}/`) === true);

    // Each child that does work is a step execution with its own time and
    // token limits; a nested loop is bounded through its children.
    const isExecution = input.step.type !== "loop";
    const ledger = this.#runLedgers.get(input.runId);
    let stopStepTimer = (): void => undefined;
    let result: StepExecutionResult;
    try {
      if (isExecution) {
        ledger?.startStep(input.executionKey);
        stopStepTimer = this.#startStepTimer(input.runId, input.executionKey);
      }
      result = this.#withoutMessagesResult(
        input.manifest,
        await this.#executeChildStep(executor, input, isResumingPath),
      );
      if (isExecution) ledger?.endStep(input.executionKey);
      stopStepTimer();
    } catch (error) {
      stopStepTimer();
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
      if (isExecution) ledger?.endStep(input.executionKey);
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
    // The child's checkpoints carry its own cursor, then pass through the
    // frame its parent supplied, so the parent's state is never replaced.
    const checkpoint = (nested: NestedCheckpointInput): Promise<void> => {
      if (input.step.type !== "loop")
        this.#runLedgers
          .get(input.runId)
          ?.setStepTokens(
            input.executionKey,
            transcriptTokens(nested.transcript ?? []),
          );
      const own: NestedCheckpointInput = {
        ...nested,
        state: withoutMessagesView(input.manifest, nested.state),
        cursor: {
          stepId: input.step.id,
          stepPath: input.stepPath,
          ...(nested.cursor ?? {}),
        },
      };
      return input.checkpoint(input.frame ? input.frame.checkpoint(own) : own);
    };
    const resume = !isResumingPath
      ? undefined
      : input.frame
        ? input.frame.resume
        : input.latestCheckpoint
          ? {
              ...(input.latestCheckpoint.continuation
                ? { continuation: input.latestCheckpoint.continuation }
                : {}),
              ...(input.latestCheckpoint.activeStepTranscript
                ? { transcript: input.latestCheckpoint.activeStepTranscript }
                : {}),
              ...(input.latestCheckpoint.activeStepArtifacts
                ? { artifacts: input.latestCheckpoint.activeStepArtifacts }
                : {}),
            }
          : undefined;
    return executor.execute({
      runId: input.runId,
      manifest: input.manifest,
      step: input.step,
      stepIndex: input.parentStepIndex,
      stepPath: input.stepPath,
      executionKey: input.executionKey,
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
      limits: this.#runLimits.get(input.runId),
      summarizer: this.#dependencies.summarizer,
      history: this.#historyContext(
        input.runId,
        this.#historySelection(input.runId, input.step),
      ),
      emit: (type, data) =>
        this.#emit(input.runId, type, data, input.step.id, input.stepPath),
      ...(resume
        ? {
            resume: {
              cursor: input.latestCheckpoint?.cursor ?? {
                stepIndex: input.parentStepIndex,
              },
              ...(resume.continuation
                ? { continuation: structuredClone(resume.continuation) }
                : {}),
              ...(resume.transcript
                ? { transcript: structuredClone(resume.transcript) }
                : {}),
              ...(resume.artifacts
                ? { artifacts: structuredClone(resume.artifacts) }
                : {}),
              ...(resumeNotices(input.latestCheckpoint).length > 0
                ? { notices: resumeNotices(input.latestCheckpoint) }
                : {}),
            },
          }
        : {}),
      executeChild: (childStep, childVariables, childPath, frame) =>
        this.#executeChild({
          ...input,
          step: childStep,
          stepPath: childPath,
          variables: childVariables,
          checkpoint,
          frame,
          executionKey: childExecutionKey(
            input.executionKey,
            childStep.id,
            frame,
          ),
        }),
      checkpoint,
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

  /**
   * History compaction policies: host defaults, the manifest's policies,
   * `messages.context`, then host-enforced policies. Manifest-level only: a
   * step's own policies never affect the run's history.
   */
  #historyPolicies(manifest: AgentManifest): ExecutionPolicies {
    return mergeExecutionPolicies(
      this.#dependencies.policies,
      manifest.policies,
      manifest.messages?.context
        ? { context: manifest.messages.context }
        : undefined,
      this.#dependencies.enforcedPolicies,
    );
  }

  #historySelection(
    runId: string,
    step: AgentStep,
  ): HistorySelection | undefined {
    const state = this.#runMessages.get(runId);
    return state ? selectHistory(state.history, step.history) : undefined;
  }

  #historyContext(
    runId: string,
    selection: HistorySelection | undefined,
  ): StepHistoryContext | undefined {
    if (!selection) return undefined;
    const scope = this.#runMessages.get(runId)?.scope;
    const signer = this.#dependencies.messages?.signer;
    return {
      messages: structuredClone(selection.messages),
      places: structuredClone(selection.places),
      turn: selection.currentTurn,
      explicit: selection.explicit,
      insert: selection.insert,
      media: selection.media,
      ...(scope != null ? { scope } : {}),
      sign: async (messages) =>
        signer ? signer.sign({ messages, scope }) : undefined,
    };
  }

  /** The `messages` view is never written back into run state. */
  #withoutMessagesResult(
    manifest: AgentManifest,
    result: StepExecutionResult,
  ): StepExecutionResult {
    if (!declaresMessages(manifest) || !result.statePatch) return result;
    const statePatch = withoutMessagesPatch(manifest, result.statePatch);
    const { statePatch: _statePatch, ...rest } = result;
    return statePatch ? { ...rest, statePatch } : rest;
  }

  /**
   * Compact the run's history once, before the first step. The summary, or
   * the pruning note, becomes the leading marker of the effective history
   * and of the output history.
   */
  async #compactHistory(input: {
    runId: string;
    manifest: AgentManifest;
    variables: VariableState;
    stepResults: StepResult[];
    transcript: TranscriptItem[];
    artifacts: ArtifactRef[];
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const { runId, manifest } = input;
    const state = this.#runMessages.get(runId)!;
    const save = (extra: TranscriptItem[] = []) =>
      this.#checkpoint({
        runId,
        manifest,
        nextStepIndex: 0,
        variables: input.variables,
        stepResults: input.stepResults,
        transcript: [...input.transcript, ...extra],
        artifacts: input.artifacts,
      });
    const policies = this.#historyPolicies(manifest);
    const strategy = policies.context?.strategy ?? "prune";
    const plan = planHistoryCompaction(
      state.history,
      manifest,
      policies.context?.reduceTo ?? 0.25,
    );
    if (!plan) {
      state.compaction = "complete";
      delete state.journal;
      await save();
      return;
    }
    const messagesBefore = state.history.length;
    const bytesBefore = historyBytes(state.history);
    let marker: ConversationMessage | undefined;
    let used: "summarize" | "prune" = "prune";
    let summarizerCalls = 0;
    if (strategy === "summarize" || strategy === "summarize-or-prune") {
      const compactor = this.#dependencies.messages?.compactor;
      let recorded: TranscriptItem[] = [];
      try {
        if (!compactor)
          throw new Error("No MessageHistoryCompactor is configured.");
        const segmentText = renderHistoryText(plan.segment);
        const result = await compactor.summarize({
          runId,
          manifest,
          text: segmentText,
          label: compactionLabel(plan),
          task:
            manifest.description?.trim() ||
            manifest.name?.trim() ||
            "an ongoing conversation",
          segmentBytes: historyBytes(plan.segment),
          maxTargetBytes: plan.markerBytes,
          policies,
          model: this.#dependencies.model,
          summarizer: this.#dependencies.summarizer,
          tokenBudget: this.#runTokenBudgets.get(runId),
          journal: state.journal,
          checkpoint: async ({ journal, transcript }) => {
            state.journal = structuredClone(journal);
            recorded = structuredClone(transcript);
            await save(recorded);
          },
          emit: (type, data) => this.#emit(runId, type, data),
          signal: input.signal,
        });
        input.transcript.push(...result.transcript);
        marker = summaryMarkerMessage(
          plan,
          result.text,
          manifest.messages?.markers,
        );
        used = "summarize";
        summarizerCalls = result.summarizerCalls;
      } catch (error) {
        if (isControlFlowError(error, input.signal) || strategy === "summarize")
          throw error;
        input.transcript.push(...recorded);
        await this.#emit(runId, "diagnostic", {
          code: "CONTEXT_SUMMARY_FAILED",
          scope: "messages",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    marker ??= pruneMarkerMessage(
      plan,
      plan.segment[0],
      manifest.messages?.markers,
    );
    state.history = [marker, ...plan.retained];
    state.compaction = "complete";
    delete state.journal;
    await this.#emit(runId, "context.reduced", {
      scope: "messages",
      strategy: used,
      reason: plan.reason,
      messagesBefore,
      messagesAfter: state.history.length,
      bytesBefore,
      bytesAfter: historyBytes(state.history),
      summarizerCalls,
    });
    await save();
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
    /** A step just completed: commit workspaces and mark a restart point. */
    boundary?: RunCheckpointBoundary;
  }): Promise<void> {
    const checkpointSequence =
      (this.#checkpointSequences.get(input.runId) ?? 0) + 1;
    this.#collectWorkspaceChanges(input.runId);
    if (input.boundary)
      await this.#commitWorkspaces(
        input.runId,
        input.boundary,
        checkpointSequence,
      );
    const workspaceState = this.#runWorkspaceState.get(input.runId);
    const inputs = this.#runInputs.get(input.runId);
    const sandboxBudget = this.#sandboxBudget(input.runId);
    const tracker = this.#runLedgers.get(input.runId);
    tracker?.setSandbox(
      sandboxBudget
        ? {
            commands: sandboxBudget.commandsUsed,
            seconds: sandboxBudget.sandboxSecondsUsed,
          }
        : undefined,
    );
    const ledger = tracker?.observe({
      sequence: checkpointSequence,
      transcript: input.transcript,
      artifacts: input.artifacts,
    });
    const checkpoint: RunCheckpoint = {
      id: this.#ids.generateId("checkpoint"),
      runId: input.runId,
      sequence: checkpointSequence,
      attempt: this.#runAttempts.get(input.runId) ?? 1,
      manifestHash: await this.#manifestHasher.hash(input.manifest),
      contractVersion: RUN_CHECKPOINT_CONTRACT_VERSION,
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
      ...(this.#runMessages.has(input.runId)
        ? { messages: structuredClone(this.#runMessages.get(input.runId)!) }
        : {}),
      ...(this.#sandboxBudget(input.runId)
        ? {
            metadata: {
              sandboxBudget: { ...this.#sandboxBudget(input.runId)! },
            },
          }
        : {}),
      ...(ledger ? { ledger } : {}),
      ...(this.#runFingerprints.has(input.runId)
        ? { fingerprints: this.#runFingerprints.get(input.runId)! }
        : {}),
      ...(workspaceState && Object.keys(workspaceState).length > 0
        ? { workspaces: structuredClone(workspaceState) }
        : {}),
      ...(inputs && Object.keys(inputs).length > 0
        ? { inputs: structuredClone(inputs) }
        : {}),
      ...(input.boundary ? { boundary: { ...input.boundary } } : {}),
      createdAt: this.#clock.now().toISOString(),
    };
    const maxCheckpointBytes = this.#runLimits.get(
      input.runId,
    )?.maxCheckpointBytes;
    if (maxCheckpointBytes !== undefined) {
      const bytes = new TextEncoder().encode(
        JSON.stringify(checkpoint),
      ).byteLength;
      if (bytes > maxCheckpointBytes) {
        throw createLimitSuspension({
          limit: "maxCheckpointBytes",
          used: bytes,
          value: maxCheckpointBytes,
        });
      }
    }
    await this.#dependencies.runStore.saveCheckpoint(checkpoint);
    this.#checkpointSequences.set(input.runId, checkpointSequence);
    this.#lastCheckpoints.set(input.runId, checkpoint);
    await this.#emit(input.runId, "checkpoint.saved", {
      checkpointId: checkpoint.id,
      nextStepIndex: checkpoint.cursor.stepIndex,
    });
    this.#enforceUsageLimits(input.runId, checkpoint.cursor.stepId);
  }

  /** Current cumulative sandbox usage: the open session's, else the restored value. */
  #sandboxBudget(runId: string): SandboxBudgetState | undefined {
    const session = this.#runSandboxSessions.get(runId);
    if (session) {
      const budget = session.budget();
      this.#runSandboxBudgets.set(runId, budget);
      return budget;
    }
    return this.#runSandboxBudgets.get(runId);
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
    const budget = this.#runSandboxBudgets.get(input.runId);
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
        ...(this.#runLimits.get(input.runId)?.sandbox &&
        Object.keys(this.#runLimits.get(input.runId)!.sandbox).length > 0
          ? { limits: { ...this.#runLimits.get(input.runId)!.sandbox } }
          : {}),
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
    if (session) this.#runSandboxBudgets.set(runId, session.budget());
    this.#runSandboxSessions.delete(runId);
    this.#runSandboxOpenings.delete(runId);
    if (session) {
      try {
        await session.close(reason);
      } finally {
        // The final sync may have copied back changes for the next commit point.
        this.#collectWorkspaceChanges(runId, session);
      }
    }
  }

  async #closeRunSandboxQuietly(
    runId: string,
    reason: "failed" | "cancelled" | "suspended",
  ): Promise<void> {
    try {
      await this.#closeRunSandbox(runId, reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.#emit(runId, "diagnostic", {
          code: "SANDBOX_CLOSE_FAILED",
          message,
        });
      } catch {
        // The run outcome is already decided; sandbox cleanup is best effort.
      }
      // A resumable run must not lose the fact that its workspace may be
      // behind its transcript: record it durably on the latest checkpoint.
      if (reason !== "cancelled") {
        await this.#recordWorkspaceSyncFailure(runId, message).catch(
          () => undefined,
        );
      }
    }
  }

  /** Move changes the open sandbox copied back into each workspace's pending list. */
  #collectWorkspaceChanges(
    runId: string,
    session: RunSandboxSession | undefined = this.#runSandboxSessions.get(
      runId,
    ),
  ): void {
    const taken = session?.takeChanges?.();
    if (!taken) return;
    const state = this.#runWorkspaceState.get(runId) ?? {};
    const notSaved = this.#runPendingNotPersisted.get(runId) ?? new Map();
    for (const [alias, { changes, notPersisted }] of Object.entries(taken)) {
      if (changes.length > 0) {
        const entry = state[alias] ?? {};
        entry.pending = mergeWorkspaceChanges(entry.pending ?? [], changes);
        if (entry.pending.length === 0) delete entry.pending;
        state[alias] = entry;
      }
      if (notPersisted.length > 0)
        notSaved.set(alias, [...(notSaved.get(alias) ?? []), ...notPersisted]);
    }
    this.#runWorkspaceState.set(runId, state);
    this.#runPendingNotPersisted.set(runId, notSaved);
  }

  /**
   * A step commit point: offer each read-write workspace that changed since
   * the previous one to its store, and record the token the store returns.
   */
  async #commitWorkspaces(
    runId: string,
    boundary: RunCheckpointBoundary,
    checkpointSequence: number,
  ): Promise<void> {
    const state = this.#runWorkspaceState.get(runId) ?? {};
    const notSaved = this.#runPendingNotPersisted.get(runId) ?? new Map();
    for (const workspace of this.#runWorkspaces.get(runId) ?? []) {
      if (workspace.mode !== "read_write") continue;
      const entry = state[workspace.alias] ?? {};
      const changes = entry.pending ?? [];
      const notPersisted = notSaved.get(workspace.alias) ?? [];
      if (changes.length === 0 && notPersisted.length === 0) continue;
      const committed = await workspace.store.commit?.({
        runId,
        attempt: this.#runAttempts.get(runId) ?? 1,
        alias: workspace.alias,
        stepPath: boundary.stepPath,
        ...(boundary.executionKey
          ? { executionKey: boundary.executionKey }
          : {}),
        checkpointSequence,
        changes: structuredClone(changes),
        notPersisted: structuredClone(notPersisted),
      });
      delete entry.pending;
      if (committed?.token) {
        entry.token = committed.token;
        entry.stepPath = boundary.stepPath;
        entry.sequence = checkpointSequence;
      }
      state[workspace.alias] = entry;
      notSaved.delete(workspace.alias);
      await this.#emit(
        runId,
        "workspace.committed",
        {
          alias: workspace.alias,
          workspace: workspace.binding.ref,
          stepPath: boundary.stepPath,
          ...(boundary.executionKey
            ? { executionKey: boundary.executionKey }
            : {}),
          checkpointSequence,
          created: changes.filter((change) => change.action === "created")
            .length,
          modified: changes.filter((change) => change.action === "modified")
            .length,
          deleted: changes.filter((change) => change.action === "deleted")
            .length,
          notPersisted: notPersisted.length,
          ...(committed?.token ? { token: committed.token } : {}),
        },
        boundary.stepPath.split("/").at(-1),
        boundary.stepPath,
      );
    }
    this.#runWorkspaceState.set(runId, state);
  }

  /**
   * Commit a copy of the latest checkpoint, same cursor and content, with the
   * current ledger and whatever `patch` adds. Used to make facts about the
   * attempt durable (a failed final sync, a resume, a block) without moving
   * the run's position.
   */
  async #commitCheckpointCopy(
    runId: string,
    patch: (copy: RunCheckpoint) => void,
  ): Promise<RunCheckpoint | undefined> {
    const last = this.#lastCheckpoints.get(runId);
    if (!last) return undefined;
    const sequence =
      Math.max(this.#checkpointSequences.get(runId) ?? 0, last.sequence) + 1;
    const budget = this.#sandboxBudget(runId);
    this.#runLedgers.get(runId)?.setSandbox(
      budget
        ? {
            commands: budget.commandsUsed,
            seconds: budget.sandboxSecondsUsed,
          }
        : undefined,
    );
    const ledger = this.#runLedgers.get(runId)?.snapshot();
    // A copy is not a restart point of its own: the checkpoint it copies is.
    const {
      metadata: lastMetadata,
      boundary: _boundary,
      ...rest
    } = structuredClone(last);
    const {
      workspaceSync: _workspaceSync,
      sandboxBudget: _sandboxBudget,
      ...keptMetadata
    } = lastMetadata ?? {};
    const metadata: JsonObject = {
      ...keptMetadata,
      ...(budget ? { sandboxBudget: { ...budget } } : {}),
    };
    const copy: RunCheckpoint = {
      ...rest,
      // Unique within the run without relying on the id generator: the base
      // checkpoint's id is unique, and so is the sequence.
      id: `${last.id.replace(/:copy-\d+$/u, "")}:copy-${sequence}`,
      sequence,
      attempt: this.#runAttempts.get(runId) ?? 1,
      contractVersion: RUN_CHECKPOINT_CONTRACT_VERSION,
      createdAt: this.#clock.now().toISOString(),
      ...(ledger ? { ledger } : {}),
      ...(this.#runFingerprints.has(runId)
        ? { fingerprints: this.#runFingerprints.get(runId)! }
        : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
    patch(copy);
    await this.#dependencies.runStore.saveCheckpoint(copy);
    this.#checkpointSequences.set(runId, sequence);
    this.#lastCheckpoints.set(runId, copy);
    return copy;
  }

  /** Record a failed final workspace sync on the latest checkpoint. */
  async #recordWorkspaceSyncFailure(
    runId: string,
    error: string,
  ): Promise<void> {
    const at = this.#clock.now().toISOString();
    await this.#commitCheckpointCopy(runId, (copy) => {
      copy.metadata = {
        ...(copy.metadata ?? {}),
        workspaceSync: { failed: true, error, at },
      };
    });
  }

  /**
   * Checks made when an attempt resumes: the number of resumes, and the
   * crash-loop guard, which counts consecutive resumes of a run that failed,
   * was interrupted, or was blocked by an error without committing any new
   * checkpoint since. The count is committed before the attempt does
   * anything else, so a crash cannot lose it.
   */
  async #enforceResumeLimits(input: {
    runId: string;
    attempt: number;
    previousStatus: RunRecord["status"];
    checkpoint: RunCheckpoint;
    /** Limits were granted with this resume; they must be durable at once. */
    granted: boolean;
    stepsRemain: boolean;
  }): Promise<void> {
    const limits = this.#runLimits.get(input.runId)!;
    const ledger = this.#runLedgers.get(input.runId)!;
    // A recovery is a resume after a failure, an interruption, a takeover,
    // or an error block. Answering an approval, a child run, a budget, a
    // granted limit, or a pause is not.
    const afterTrouble =
      input.previousStatus !== "suspended" ||
      input.checkpoint.ledger?.blocked?.cause === "error";
    let count = 0;
    if (afterTrouble) {
      ledger.recordRecovery();
      // Progress is the latest real checkpoint; the copies the runtime
      // commits to record a resume or a block do not count.
      const progress = ledger.progress ?? input.checkpoint.sequence;
      const previous = ledger.stalledResumes;
      count =
        previous && previous.sequence === progress ? previous.count + 1 : 1;
      ledger.stalledResumes = { count, sequence: progress };
    }
    // One write makes both the crash-loop count and any granted limits
    // durable before the attempt can fail.
    if (afterTrouble || input.granted)
      await this.#commitCheckpointCopy(input.runId, () => undefined);
    if (
      limits.maxRecoveries !== undefined &&
      ledger.recoveries > limits.maxRecoveries
    ) {
      throw createLimitSuspension({
        limit: "maxRecoveries",
        used: ledger.recoveries,
        value: limits.maxRecoveries,
      });
    }
    if (
      limits.maxResumesWithoutProgress !== undefined &&
      count > limits.maxResumesWithoutProgress
    ) {
      throw createLimitSuspension({
        limit: "maxResumesWithoutProgress",
        used: count,
        value: limits.maxResumesWithoutProgress,
      });
    }
    // A run already over a usage limit does not spend more before the next
    // checkpoint would notice.
    if (input.stepsRemain) this.#enforceUsageLimits(input.runId);
  }

  /** Abort the attempt with a limit suspension after `delayMs`. */
  #limitTimer(
    runId: string,
    delayMs: number,
    suspension: () => RunSuspendedError,
  ): () => void {
    const controller = this.#runLimitControllers.get(runId);
    if (!controller) return () => undefined;
    const timer = setTimeout(
      () => controller.abort(suspension()),
      Math.max(0, Math.min(delayMs, 2_147_483_647)),
    );
    (timer as { unref?: () => void }).unref?.();
    const timers = this.#runTimers.get(runId) ?? new Set();
    timers.add(timer);
    this.#runTimers.set(runId, timers);
    return () => {
      clearTimeout(timer);
      timers.delete(timer);
    };
  }

  #startRunTimer(runId: string): void {
    const limit = this.#runLimits.get(runId)?.maxRunActiveMs;
    const ledger = this.#runLedgers.get(runId)!;
    if (limit === undefined) return;
    const remaining = limit - ledger.activeMs;
    const suspension = () =>
      createLimitSuspension({
        limit: "maxRunActiveMs",
        used: Math.round(ledger.activeMs),
        value: limit,
      });
    if (remaining <= 0) throw suspension();
    this.#limitTimer(runId, remaining, suspension);
  }

  /** Start a step's active-time limit; returns the function that stops it. */
  #startStepTimer(runId: string, key: string) {
    const limit = this.#runLimits.get(runId)?.maxStepActiveMs;
    const ledger = this.#runLedgers.get(runId);
    if (limit === undefined || !ledger) return () => undefined;
    const suspension = () =>
      createLimitSuspension({
        limit: "maxStepActiveMs",
        used: Math.round(ledger.stepActiveMs(key)) || limit,
        value: limit,
        // The execution key names the exact execution, such as `each[2]/work`.
        stepId: key,
      });
    const remaining = limit - ledger.stepActiveMs(key);
    if (remaining <= 0) throw suspension();
    return this.#limitTimer(runId, remaining, suspension);
  }

  /** Usage limits checked after each committed checkpoint. */
  #enforceUsageLimits(runId: string, stepId?: string): void {
    const limits = this.#runLimits.get(runId);
    const ledger = this.#runLedgers.get(runId);
    if (!limits || !ledger) return;
    const checks: Array<[string, number, number | undefined]> = [
      ["maxTotalTokens", ledger.tokens, limits.maxTotalTokens],
      ["maxStepTokens", ledger.stepTokens, limits.maxStepTokens],
      ["maxEstimatedCost", ledger.estimatedCost, limits.maxEstimatedCost],
      ["maxArtifacts", ledger.artifacts.count, limits.maxArtifacts],
      ["maxArtifactBytes", ledger.artifacts.bytes, limits.maxArtifactBytes],
    ];
    for (const [limit, used, value] of checks) {
      if (value !== undefined && used > value) {
        throw createLimitSuspension({
          limit,
          used,
          value,
          ...(limit === "maxStepTokens" && (ledger.stepKey ?? stepId)
            ? { stepId: ledger.stepKey ?? stepId }
            : {}),
        });
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
