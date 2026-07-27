import type {
  AgentManifest,
  ArtifactRef,
  JsonObject,
  JsonValue,
  ModelUsage,
  RunCheckpoint,
  RunError,
  RunEvent,
  AgentVariableOverride,
  ToolCall,
  ToolResult,
  TranscriptItem,
  VariableState,
} from "@clearideas/agent-runtime-contracts";

/** Loads an agent manifest without coupling execution to files, HTTP, or a database. */
export interface AgentManifestSource {
  loadManifest(reference?: string): Promise<AgentManifest>;
}

export type RunStatus =
  "created" | "running" | "suspended" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  runId: string;
  manifest: AgentManifest;
  status: RunStatus;
  /** Atomically incremented whenever a persisted run is resumed. */
  attempt?: number;
  state: VariableState;
  createdAt: string;
  updatedAt: string;
}

export interface CompletedRunRecord extends RunRecord {
  status: "completed";
  output?: JsonValue;
  transcript: TranscriptItem[];
  artifacts: ArtifactRef[];
  usage?: ModelUsage;
}

export interface ResumeRunOptions {
  /** Explicit host assertion that the previous running owner is no longer active. */
  allowRunningTakeover?: boolean;
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
  cancelRun(
    runId: string,
    cancelledAt: string,
    expectedAttempt: number,
  ): Promise<void>;
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
  executeTool(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
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

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: TranscriptItem["content"];
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: AgentTool[];
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

export interface ModelAdapter {
  generate(request: ModelRequest): Promise<ModelResult>;
  stream?(request: ModelRequest): AsyncIterable<ModelEvent>;
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
