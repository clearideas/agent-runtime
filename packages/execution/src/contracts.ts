import type {
  AgentManifest,
  AgentRunBudget,
  AgentRunExecution,
  JsonObject,
  RunCheckpoint,
  RunError,
  RunEvent,
  AgentVariableOverride,
  RunResult,
} from "@clearideas/agent-runtime-contracts";

export const EXECUTION_PROTOCOL_VERSION = "1.0" as const;

export type ExecutionLifecycleStatus =
  "queued" | "running" | "suspended" | "completed" | "failed" | "cancelled";

export type TerminalExecutionStatus = Extract<
  ExecutionLifecycleStatus,
  "completed" | "failed" | "cancelled"
>;

export interface EventCursor {
  attempt: number;
  sequence: number;
}

export interface ExecutionHandle {
  id: string;
  engine: string;
  runId: string;
  submittedAt: string;
  /** Provider-owned, JSON-safe data required to reconstruct the handle. */
  providerData?: JsonObject;
}

export interface ExecutionRequest {
  /** Resolved agent definition dispatched after the host validates the agent run manifest. */
  manifest: AgentManifest;
  runId?: string;
  variables?: AgentVariableOverride[];
  /** Step scheduling selected by the agent run manifest. */
  execution?: AgentRunExecution;
  budget?: AgentRunBudget;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Inline declarative runtime configuration for self-contained remote invocations. */
  configuration?: JsonObject;
  configReference?: string;
  runtimeReference?: string;
  traceContext?: {
    traceparent?: string;
    tracestate?: string;
    baggage?: string;
  };
  metadata?: JsonObject;
}

export interface ResumeExecutionRequest extends Omit<
  ExecutionRequest,
  "variables"
> {
  runId: string;
  attempt: number;
  checkpoint?: RunCheckpoint;
  checkpointReference?: string;
  allowRunningTakeover?: boolean;
}

export interface ExecutionStatus {
  handle: ExecutionHandle;
  status: ExecutionLifecycleStatus;
  attempt: number;
  updatedAt: string;
  lastEventCursor?: EventCursor;
  error?: RunError;
  metadata?: JsonObject;
}

export interface ExecutionEventOptions {
  after?: EventCursor;
  signal?: AbortSignal;
}

export interface ExecutionResultOptions {
  signal?: AbortSignal;
}

export interface ExecutionEngine {
  readonly name: string;
  submit(request: ExecutionRequest): Promise<ExecutionHandle>;
  resume(request: ResumeExecutionRequest): Promise<ExecutionHandle>;
  status(handle: ExecutionHandle): Promise<ExecutionStatus>;
  events(
    handle: ExecutionHandle,
    options?: ExecutionEventOptions,
  ): AsyncIterable<RunEvent>;
  result(
    handle: ExecutionHandle,
    options?: ExecutionResultOptions,
  ): Promise<RunResult>;
  cancel(handle: ExecutionHandle): Promise<void>;
}

export interface ExecutionHandlerContext {
  handle: ExecutionHandle;
  mode: "run" | "resume";
  attempt: number;
  checkpoint?: RunCheckpoint;
  checkpointReference?: string;
  signal: AbortSignal;
  emit(event: RunEvent): Promise<void>;
}

export type ExecutionHandler = (
  request: ExecutionRequest | ResumeExecutionRequest,
  context: ExecutionHandlerContext,
) => Promise<RunResult>;

export class ExecutionEngineError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: JsonObject | undefined;

  constructor(error: RunError) {
    super(error.message);
    this.name = "ExecutionEngineError";
    this.code = error.code;
    this.retryable = error.retryable ?? false;
    this.details = error.details;
  }
}

export const eventCursor = (event: RunEvent): EventCursor => ({
  attempt: event.attempt ?? 1,
  sequence: event.sequence,
});

export const compareEventCursors = (
  left: EventCursor,
  right: EventCursor,
): number =>
  left.attempt === right.attempt
    ? left.sequence - right.sequence
    : left.attempt - right.attempt;

export const isEventAfter = (event: RunEvent, cursor?: EventCursor): boolean =>
  cursor == null || compareEventCursors(eventCursor(event), cursor) > 0;

export const isTerminalExecutionStatus = (
  status: ExecutionLifecycleStatus,
): status is TerminalExecutionStatus =>
  status === "completed" || status === "failed" || status === "cancelled";
