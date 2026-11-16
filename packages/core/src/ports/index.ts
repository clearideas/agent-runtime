import type {
  AgentManifest,
  AgentWorkspaceBinding,
  ContextSummarizer,
  ConversationMessage,
  MessagesSignature,
  SummaryKind,
  ArtifactRef,
  JsonObject,
  JsonValue,
  ModelUsage,
  PromptMessage,
  RunCheckpoint,
  RunError,
  RunEvent,
  ExecutionCursor,
  RunCheckpointBoundary,
  RunSandboxUsageLimits,
  AgentVariableOverride,
  WorkspaceChange,
  SandboxCommandRecord,
  ToolCall,
  ToolResult,
  TranscriptItem,
  VariableState,
  WorkspaceMode,
} from "@clearideas/agent-runtime-contracts";

/** Loads an agent manifest without coupling execution to files, HTTP, or a database. */
export interface AgentManifestSource {
  loadManifest(reference?: string): Promise<AgentManifest>;
}

/**
 * - suspended: waiting on purpose (a person, a child run, a budget, or a pause request); resumable.
 * - interrupted: infrastructure stopped the attempt (timeout, shutdown); resumable, not a failure.
 * - failed: the run could not proceed; a host may still resume it after fixing the cause.
 * - cancelled: ended by a person; terminal.
 */
export type RunStatus =
  | "created"
  | "running"
  | "suspended"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunRecord {
  runId: string;
  manifest: AgentManifest;
  status: RunStatus;
  /** Atomically incremented whenever a persisted run is resumed. */
  attempt?: number;
  state: VariableState;
  /** The conversation history as supplied (normalized, media ingested), kept for audit. */
  messages?: RunRecordMessages;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecordMessages {
  supplied: ConversationMessage[];
  /** Leading messages covered by a verified signature. */
  signedCount: number;
  scope?: string;
}

export interface CompletedRunRecord extends Omit<RunRecord, "messages"> {
  status: "completed";
  output?: JsonValue;
  transcript: TranscriptItem[];
  artifacts: ArtifactRef[];
  usage?: ModelUsage;
  /** The supplied history, plus the output history and its signature. */
  messages?: RunRecordMessages & {
    output: ConversationMessage[];
    signature?: MessagesSignature;
  };
}

/** What a store lists about a checkpoint without loading it. */
export interface RunCheckpointSummary {
  id: string;
  sequence: number;
  attempt?: number;
  createdAt: string;
  cursor: ExecutionCursor;
  /** Present on step-completion checkpoints: the points a run can restart from. */
  boundary?: RunCheckpointBoundary;
}

/** Summarize a checkpoint for `RunStore.listCheckpoints`. */
export const summarizeCheckpoint = (
  checkpoint: RunCheckpoint,
): RunCheckpointSummary => ({
  id: checkpoint.id,
  sequence: checkpoint.sequence,
  ...(checkpoint.attempt !== undefined ? { attempt: checkpoint.attempt } : {}),
  createdAt: checkpoint.createdAt,
  cursor: structuredClone(checkpoint.cursor),
  ...(checkpoint.boundary
    ? { boundary: structuredClone(checkpoint.boundary) }
    : {}),
});

export interface ResumeRunOptions {
  /** Explicit host assertion that the previous running owner is no longer active. */
  allowRunningTakeover?: boolean;
  /**
   * The manifest this attempt runs, when the host supplied one that may
   * differ from the stored one (for example with raised limits). Stores save
   * it as the run's manifest so later resumes use it.
   */
  manifest?: AgentManifest;
}

/**
 * Durable run state. Implementations should make saveCheckpoint atomic where
 * their storage technology permits it.
 */
export interface RunStore {
  createRun(record: RunRecord): Promise<void>;
  loadRun(runId: string): Promise<RunRecord | null>;
  loadLatestCheckpoint(runId: string): Promise<RunCheckpoint | null>;
  /** Atomically make an existing recoverable run active again. */
  resumeRun(
    runId: string,
    resumedAt: string,
    options?: ResumeRunOptions,
  ): Promise<number>;
  /** Commit a checkpoint only if its attempt still owns the run. */
  saveCheckpoint(checkpoint: RunCheckpoint): Promise<void>;
  /** Yield active compute while preserving the latest resumable checkpoint. */
  suspendRun(
    runId: string,
    suspendedAt: string,
    expectedAttempt: number,
  ): Promise<void>;
  completeRun(record: CompletedRunRecord): Promise<void>;
  failRun(
    runId: string,
    error: RunError,
    failedAt: string,
    expectedAttempt: number,
  ): Promise<void>;
  /**
   * Record that infrastructure stopped the attempt. The run stays resumable.
   * Stores without this method record a retryable RUN_INTERRUPTED failure.
   */
  interruptRun?(
    runId: string,
    error: RunError,
    interruptedAt: string,
    expectedAttempt: number,
  ): Promise<void>;
  cancelRun(
    runId: string,
    cancelledAt: string,
    expectedAttempt: number,
  ): Promise<void>;
  /**
   * Optional. The run's retained checkpoints, oldest first. With
   * `boundaries: true`, only step-completion checkpoints: the points a run
   * can restart from. Stores keep at least the latest checkpoint and every
   * step-completion checkpoint; retention beyond that is theirs to decide.
   */
  listCheckpoints?(
    runId: string,
    options?: { boundaries?: boolean },
  ): Promise<RunCheckpointSummary[]>;
  /** Optional. Load one retained checkpoint by sequence. */
  loadCheckpoint?(
    runId: string,
    sequence: number,
  ): Promise<RunCheckpoint | null>;
  /**
   * Permanently remove a run record and its checkpoints, for retention.
   * Refuses a run that is still `running`. Returns false when the run does
   * not exist. Optional: hosts that apply retention check for it.
   */
  deleteRun?(runId: string): Promise<boolean>;
}

export interface ArtifactInput {
  name: string;
  mediaType: string;
  data: Uint8Array | string;
  metadata?: JsonObject;
}

export interface ArtifactData {
  ref: ArtifactRef;
  data: Uint8Array;
}

export interface ArtifactStore {
  put(input: ArtifactInput): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<ArtifactData>;
}

const WORKSPACE_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;
export const MAXIMUM_WORKSPACE_PATH_LENGTH = 1024;
export const MAXIMUM_WORKSPACE_PATH_DEPTH = 64;

/**
 * Workspace paths are relative POSIX paths whose segments contain only
 * letters, digits, dots, underscores, and hyphens and start with a letter,
 * digit, or underscore.
 * Traversal, absolute paths, and hidden entries are unaddressable.
 */
export const isSafeWorkspacePath = (value: string): boolean => {
  if (value.length === 0 || value.length > MAXIMUM_WORKSPACE_PATH_LENGTH)
    return false;
  const segments = value.split("/");
  return (
    segments.length <= MAXIMUM_WORKSPACE_PATH_DEPTH &&
    segments.every((segment) => WORKSPACE_PATH_SEGMENT.test(segment))
  );
};

export const assertWorkspacePath = (
  value: string,
  label = "Workspace path",
): string => {
  if (!isSafeWorkspacePath(value)) {
    throw new Error(
      `${label} must be a relative POSIX path with safe segments: ${value}`,
    );
  }
  return value;
};

export interface WorkspaceEntry {
  path: string;
  size: number;
  modifiedAt?: string;
  sha256?: string;
}

export interface WorkspaceLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/**
 * A durable, host-owned collection of files such as a code base or document
 * store. Stores enumerate and move opaque bytes; they never interpret
 * content. Implementations confine every path beneath their root, never
 * follow symbolic links, expose only visible files, and refuse writes unless
 * their mode is read_write.
 */
/**
 * A step completed and every change it made to a read-write workspace has
 * been copied back: a consistent point at which a host may snapshot the
 * workspace. The runtime records the token the store returns in the
 * step-completion checkpoint and hands it back when a run restarts from it.
 */
export interface WorkspaceCommitPoint {
  runId: string;
  attempt: number;
  /** The workspace binding alias. */
  alias: string;
  /** The step that completed: a top-level step id or a nested step path. */
  stepPath: string;
  /** The completed execution, for example `each[2]/fetch`. */
  executionKey?: string;
  /** The checkpoint that will record the returned token. */
  checkpointSequence: number;
  /** Changes copied back since the previous commit point, across attempts. */
  changes: WorkspaceChange[];
  /** Changes that were not saved since the previous commit point. */
  notPersisted: NotPersistedChange[];
}

export interface WorkspaceStore {
  readonly mode: WorkspaceMode;
  readonly limits?: WorkspaceLimits;
  /** Present when a provider may bind the directory read-only instead of staging it. */
  readonly attachable?: { kind: "local-directory"; root: string };
  entries(options?: { signal?: AbortSignal }): Promise<WorkspaceEntry[]>;
  read(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  write?(
    path: string,
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceEntry>;
  delete?(path: string, options?: { signal?: AbortSignal }): Promise<void>;
  /**
   * Optional. Called at each step commit point that changed this workspace.
   * Return an opaque token that identifies the state (a snapshot, a commit,
   * a version); the runtime never interprets it.
   */
  commit?(
    point: WorkspaceCommitPoint,
    options?: { signal?: AbortSignal },
  ): Promise<{ token?: string } | undefined>;
  /**
   * Optional. An opaque token for the store's current state, recorded for
   * read-only bindings when a run starts.
   */
  version?(options?: { signal?: AbortSignal }): Promise<string | undefined>;
}

export interface WorkspaceResolutionContext {
  runId?: string;
  signal?: AbortSignal;
  /**
   * For a run seeded from another run's step checkpoint: per workspace
   * alias, the token the store returned at that step's commit point. The
   * host prepares the workspace in that state (or decides not to).
   */
  restoreFrom?: Record<string, string>;
}

/** Resolves manifest workspace bindings to host-authorized stores. */
export interface WorkspaceProvider {
  resolveWorkspace(
    binding: AgentWorkspaceBinding,
    context?: WorkspaceResolutionContext,
  ): Promise<WorkspaceStore | undefined>;
}

/** A manifest binding resolved against the host with its effective privileges. */
export interface ResolvedWorkspace {
  binding: AgentWorkspaceBinding;
  alias: string;
  mode: WorkspaceMode;
  store: WorkspaceStore;
}

/** Narrow a store to the effective mode; a read binding never exposes writes. */
export const restrictWorkspace = (
  store: WorkspaceStore,
  mode: WorkspaceMode,
): WorkspaceStore => {
  if (store.mode === "read" && mode === "read_write") {
    throw new Error("A read-only workspace cannot be elevated to read_write.");
  }
  if (mode === "read_write") return store;
  return {
    mode: "read",
    ...(store.limits ? { limits: store.limits } : {}),
    ...(store.attachable ? { attachable: store.attachable } : {}),
    entries: (options) => store.entries(options),
    read: (path, options) => store.read(path, options),
    ...(store.version ? { version: (options) => store.version!(options) } : {}),
  };
};

export interface SandboxBudgetState {
  commandsUsed: number;
  sandboxSecondsUsed: number;
}

export interface RunSandboxOpenRequest {
  runId: string;
  attempt: number;
  workspaces: readonly ResolvedWorkspace[];
  emit(type: string, data?: JsonObject, stepId?: string): Promise<RunEvent>;
  artifacts?: ArtifactStore;
  /** Cumulative usage restored from the latest checkpoint on resume. */
  budget?: SandboxBudgetState;
  /**
   * Usage limits the run requested (manifest and granted limits). Providers
   * cap each at their host configuration; a run can lower a limit, not raise it.
   */
  limits?: RunSandboxUsageLimits;
  signal?: AbortSignal;
}

export interface RunSandboxCommandRequest {
  stepId: string;
  toolCallId?: string;
  idempotencyKey?: string;
  /** Binding alias the command targets; required for builtin, command, and shell. */
  alias?: string;
  kind: "builtin" | "command" | "shell" | "code";
  name: string;
  /** Tool arguments, or code-step inputs for kind code. */
  arguments: JsonObject;
  signal?: AbortSignal;
}

/** Why a change in a read-write mount was not written to its workspace store. */
export type NotPersistedReason =
  | "invalid-path"
  | "symlink"
  | "too-large"
  | "store-rejected"
  | "workspace-limit";

/**
 * A change in a read-write mount that was not saved to the workspace store.
 * Reported with the command that produced it, so a model never believes a
 * change persisted when it did not. `path` is `*` when the mount holds more
 * files than the workspace allows and the excess cannot be named.
 */
export interface NotPersistedChange {
  alias: string;
  path: string;
  reason: NotPersistedReason;
  message: string;
}

export interface RunSandboxCommandResult {
  record: SandboxCommandRecord;
  /** Structured output for builtin operations and code steps. */
  output?: JsonValue;
  stdout: string;
  stderr: string;
  artifacts?: ArtifactRef[];
  /** Changes this command made that were not saved, each reported once. */
  notPersisted?: NotPersistedChange[];
}

/**
 * One isolated environment per run attempt in which every workspace
 * operation executes. Sessions serialize commands, report each one through
 * events, and never outlive the attempt.
 */
export interface RunSandboxSession {
  readonly id: string;
  execute(request: RunSandboxCommandRequest): Promise<RunSandboxCommandResult>;
  budget(): SandboxBudgetState;
  /**
   * Changes copied back to each read-write workspace since the last call,
   * keyed by alias. The runtime collects them for step commit points.
   */
  takeChanges?(): Record<
    string,
    { changes: WorkspaceChange[]; notPersisted: NotPersistedChange[] }
  >;
  /** Final sync-back and termination. Idempotent. */
  close(
    reason: "completed" | "failed" | "cancelled" | "suspended",
  ): Promise<void>;
}

export interface RunSandboxProvider {
  /** Describe the tools a binding exposes after host policy; no sandbox is opened. */
  tools(workspace: ResolvedWorkspace): Promise<AgentTool[]>;
  /** Fail fast before a run is created when a session could not be opened. */
  validate(
    request: Omit<RunSandboxOpenRequest, "emit" | "artifacts">,
  ): Promise<void>;
  open(request: RunSandboxOpenRequest): Promise<RunSandboxSession>;
}

/** Event sinks are observers; they do not own durable execution state. */
export interface EventSink {
  emit(event: RunEvent): Promise<void> | void;
}

export interface ApprovalRequest {
  runId: string;
  stepId: string;
  prompt: string;
  details?: JsonObject;
}

export interface ApprovalResult {
  approved: boolean;
  response?: JsonValue;
  respondedAt: string;
}

export interface ApprovalAdapter {
  requestApproval(
    request: ApprovalRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ApprovalResult>;
}

export interface SubRunRequest {
  parentRunId: string;
  stepId: string;
  manifest?: AgentManifest;
  manifestReference?: string;
  variables: AgentVariableOverride[];
  /** The step's history selection, when the sub-run step sets `history`. */
  messages?: ConversationMessage[];
  /** Present when the parent run has a signer; covers every forwarded message. */
  messagesSignature?: MessagesSignature;
  /** The parent run's signature scope; pass it to the child run. */
  messagesScope?: string;
  /** Opaque adapter-owned state restored from a suspended parent checkpoint. */
  continuation?: JsonObject;
}

export interface SubRunResult {
  runId: string;
  /** Omitted by legacy synchronous adapters and treated as completed. */
  status?: "completed" | "suspended";
  output?: JsonValue;
  state?: VariableState;
  transcript?: TranscriptItem[];
  artifacts?: ArtifactRef[];
  /** Opaque adapter-owned state persisted when status is suspended. */
  continuation?: JsonObject;
}

export interface SubRunAdapter {
  execute(
    request: SubRunRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SubRunResult>;
}

export interface AgentTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  metadata?: JsonObject;
}

export interface ToolExecutionContext {
  runId: string;
  stepId: string;
  variables: Readonly<VariableState>;
  /** Stable across recovery attempts for one logical tool call. */
  idempotencyKey?: string;
  /** Workspaces bound by the manifest and resolved for this run. */
  workspaces?: readonly ResolvedWorkspace[];
  /** Opens (once) and returns the run sandbox session for this run. */
  runSandbox?: () => Promise<RunSandboxSession>;
  signal?: AbortSignal;
}

export type ConnectionCredentialStatus =
  "ready" | "authorization_required" | "unavailable";

export interface ConnectionCredentialRequest {
  connectionRef: string;
  authType: string;
  credentialProfile?: string;
  runId?: string;
  stepId?: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

export type ConnectionCredentialResult =
  | {
      status: "ready";
      headers: Record<string, string>;
      expiresAt?: string;
    }
  | {
      status: "authorization_required";
      authorizationUrl?: string;
    }
  | {
      status: "unavailable";
      message?: string;
    };

export interface ConnectionCredentialProvider {
  getCredential(
    request: ConnectionCredentialRequest,
  ): Promise<ConnectionCredentialResult>;
  invalidateCredential?(
    request: ConnectionCredentialRequest & {
      reason: "expired" | "unauthorized";
    },
  ): Promise<void>;
}

export interface ToolAdapter {
  listTools(): Promise<AgentTool[]>;
  /**
   * True only for names explicitly removed by host policy during the last
   * discovery. Prompt steps may omit these; other missing names remain errors.
   */
  isToolExcluded?(name: string): boolean;
  /**
   * A reason when a name belongs to an optional source (such as a connection
   * marked not required) that was unreachable during the last discovery.
   * Prompt steps run without these tools and tell the model why.
   */
  unavailableToolReason?(name: string): string | undefined;
  executeTool(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
  /**
   * Whether a call interrupted mid-execution may be executed again on resume
   * (its effect sets state rather than adding to it, or the tool honors the
   * idempotency key). `false` makes the runtime report the interruption to
   * the model instead. Unknown (`undefined`) keeps the default: re-execute
   * with the same idempotency key.
   */
  replaySafe?(call: ToolCall): boolean | undefined;
}

/**
 * A host-authorized input that a sandbox adapter may stage for the process.
 * Agent Runtime carries references and provenance only; byte loading and access
 * checks remain the responsibility of the selected sandbox adapter.
 */
export interface SandboxInputReference {
  id: string;
  metadata?: JsonObject;
}

export interface SandboxRequest {
  runId: string;
  stepId: string;
  language: string;
  code: string;
  variables: Readonly<VariableState>;
  environment?: Record<string, string>;
  timeoutMs?: number;
  inputReferences?: SandboxInputReference[];
  metadata?: JsonObject;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output?: JsonValue;
  artifacts?: ArtifactRef[];
}

export interface SandboxAdapter {
  execute(
    request: SandboxRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxResult>;
}

export type ModelMessage = PromptMessage;

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: AgentTool[];
  /** none: tools stay defined (for history replay) but the model must answer in text. */
  toolChoice?: "auto" | "none" | "required";
  outputSchema?: JsonObject;
  maxOutputTokens?: number;
  providerOptions?: JsonObject;
  signal?: AbortSignal;
}

export interface ModelResult {
  output?: JsonValue;
  transcript: TranscriptItem[];
  toolCalls?: ToolCall[];
  finishReason?: string;
  providerMetadata?: JsonObject;
}

export type ModelEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "completed"; result: ModelResult };

/**
 * One request to condense material so a prompt step fits its context: an
 * oversized opening-prompt variable (`input`), older tool rounds
 * (`transcript`), or one large tool result (`tool-result`).
 */
export interface ContextSummarizeRequest {
  runId: string;
  /**
   * The step whose context is reduced. Empty for run-level conversation
   * history compaction (`kind: "messages"`), which belongs to no step; step
   * ids are never empty.
   */
  stepId: string;
  kind: SummaryKind;
  /** What is condensed: a variable path, "5 earlier tool rounds", a tool name. */
  label: string;
  /** The step's prompt with `{{ placeholders }}` instead of values. */
  task: string;
  /** The material, as text. Tool results are untrusted data. */
  text: string;
  /** The size the result should have, in JSON-escaped bytes. */
  targetBytes: number;
  /** The step's resolved summarizer settings (model, prompts, limits). */
  settings: ContextSummarizer;
  signal?: AbortSignal;
}

export interface ContextSummarizeResult {
  text: string;
  /** Model usage the host incurred; counted in step usage and the run budget. */
  usage?: ModelUsage;
}

/**
 * Lets a host observe, change, or replace context summarization. `next` runs
 * Agent Runtime's built-in summarizer (chunked model calls through the step's
 * ModelAdapter), so a host can wrap it, call it with a changed request, or
 * ignore it and summarize some other way. Throwing fails the summarization;
 * with `summarize-or-prune` the step then prunes instead.
 */
export interface ContextSummarizerAdapter {
  summarize(
    request: ContextSummarizeRequest,
    next: (request: ContextSummarizeRequest) => Promise<ContextSummarizeResult>,
  ): Promise<ContextSummarizeResult>;
}

/** What a host knows about a model; used to size context reduction. */
export interface ModelDescription {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Declared image input support. `false` lets the runtime refuse images up front. */
  imageInput?: boolean;
}

export interface ModelAdapter {
  generate(request: ModelRequest): Promise<ModelResult>;
  stream?(request: ModelRequest): AsyncIterable<ModelEvent>;
  /** Optional model limits, keyed by the same model string as requests. */
  describeModel?(
    model: string,
  ): ModelDescription | undefined | Promise<ModelDescription | undefined>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  generateId(prefix: "run" | "checkpoint" | "event"): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const cryptoIdGenerator: IdGenerator = {
  generateId: (prefix) => `${prefix}_${globalThis.crypto.randomUUID()}`,
};
