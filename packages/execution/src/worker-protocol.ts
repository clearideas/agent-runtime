import {
  agentRunExecutionSchema,
  parseAgentManifest,
  parseRunCheckpoint,
  parseAgentVariableOverrides,
  type JsonObject,
  type RunError,
  type RunEvent,
  type RunResult,
} from "@clearideas/agent-runtime-contracts";

import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionRequest,
  type ExecutionStatus,
  type ResumeExecutionRequest,
} from "./contracts.js";

export interface WorkerInvocation {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  action: "run" | "resume";
  request: ExecutionRequest | ResumeExecutionRequest;
}

export type WorkerMessage =
  | {
      protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
      type: "ready";
      data?: JsonObject;
    }
  | {
      protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
      type: "event";
      event: RunEvent;
    }
  | {
      protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
      type: "status";
      status: ExecutionStatus;
    }
  | {
      protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
      type: "result";
      result: RunResult;
    }
  | {
      protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
      type: "error";
      error: RunError;
    };

export const createWorkerInvocation = (
  request: ExecutionRequest | ResumeExecutionRequest,
  action: "run" | "resume" = "run",
): WorkerInvocation => ({
  protocolVersion: EXECUTION_PROTOCOL_VERSION,
  action,
  request: structuredClone(request),
});

export const serializeWorkerMessage = (message: WorkerMessage): string =>
  `${JSON.stringify(message)}\n`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const requireNonEmptyString = (value: unknown, label: string): void => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string.`);
};

const validateEvent = (value: unknown): void => {
  if (!isObject(value))
    throw new Error("Worker event message requires an event object.");
  requireNonEmptyString(value.id, "Worker event id");
  requireNonEmptyString(value.runId, "Worker event runId");
  requireNonEmptyString(value.timestamp, "Worker event timestamp");
  requireNonEmptyString(value.type, "Worker event type");
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) {
    throw new Error("Worker event sequence must be a positive safe integer.");
  }
  if (
    value.attempt != null &&
    (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1)
  ) {
    throw new Error("Worker event attempt must be a positive safe integer.");
  }
};

const validateResult = (value: unknown): void => {
  if (!isObject(value))
    throw new Error("Worker result message requires a result object.");
  requireNonEmptyString(value.runId, "Worker result runId");
  if (!isObject(value.state))
    throw new Error("Worker result state must be an object.");
  for (const field of ["stepResults", "transcript", "artifacts"] as const) {
    if (!Array.isArray(value[field]))
      throw new Error(`Worker result ${field} must be an array.`);
  }
  requireNonEmptyString(value.startedAt, "Worker result startedAt");
  requireNonEmptyString(value.completedAt, "Worker result completedAt");
};

export const parseWorkerInvocation = (
  input: string | unknown,
): WorkerInvocation => {
  const value =
    typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!isObject(value)) throw new Error("Worker invocation must be an object.");
  if (value.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported execution protocol ${String(value.protocolVersion)}.`,
    );
  }
  if (value.action !== "run" && value.action !== "resume") {
    throw new Error("Worker invocation action must be run or resume.");
  }
  if (!isObject(value.request) || !isObject(value.request.manifest)) {
    throw new Error("Worker invocation requires a manifest-bearing request.");
  }
  const request = value.request;
  const manifest = parseAgentManifest(request.manifest);
  if (request.runId != null)
    requireNonEmptyString(request.runId, "Worker request runId");
  if (request.variables != null) parseAgentVariableOverrides(request.variables);
  if (request.execution != null) {
    agentRunExecutionSchema.parse(request.execution);
  }
  if (request.configuration != null && !isObject(request.configuration)) {
    throw new Error("Worker request configuration must be an object.");
  }
  if (
    request.timeoutMs != null &&
    (!Number.isSafeInteger(request.timeoutMs) || Number(request.timeoutMs) <= 0)
  ) {
    throw new Error(
      "Worker request timeoutMs must be a positive safe integer.",
    );
  }
  if (value.action === "resume") {
    if (request.variables != null) {
      throw new Error("Resume request cannot include run variable overrides.");
    }
    requireNonEmptyString(request.runId, "Resume request runId");
    if (!Number.isSafeInteger(request.attempt) || Number(request.attempt) < 2) {
      throw new Error(
        "Resume request attempt must be an integer greater than one.",
      );
    }
    if (request.checkpoint == null && request.checkpointReference == null) {
      throw new Error(
        "Resume request requires checkpoint or checkpointReference.",
      );
    }
    if (request.checkpoint != null) parseRunCheckpoint(request.checkpoint);
    if (request.checkpointReference != null) {
      requireNonEmptyString(
        request.checkpointReference,
        "Resume checkpointReference",
      );
    }
  }
  const cloned = structuredClone(value) as unknown as WorkerInvocation;
  cloned.request.manifest = manifest;
  if (value.action === "run" && request.variables != null) {
    (cloned.request as ExecutionRequest).variables =
      parseAgentVariableOverrides(request.variables);
  }
  if (value.action === "resume" && request.checkpoint != null) {
    (cloned.request as ResumeExecutionRequest).checkpoint = parseRunCheckpoint(
      request.checkpoint,
    );
  }
  return cloned;
};

export const parseWorkerMessage = (input: string | unknown): WorkerMessage => {
  const value =
    typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!isObject(value)) throw new Error("Worker message must be an object.");
  if (value.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported execution protocol ${String(value.protocolVersion)}.`,
    );
  }
  if (
    !["ready", "event", "status", "result", "error"].includes(
      String(value.type),
    )
  ) {
    throw new Error(`Unsupported worker message type ${String(value.type)}.`);
  }
  if (value.type === "event") validateEvent(value.event);
  if (value.type === "result") validateResult(value.result);
  if (value.type === "error") {
    if (!isObject(value.error))
      throw new Error("Worker error message requires an error object.");
    requireNonEmptyString(value.error.code, "Worker error code");
    if (typeof value.error.message !== "string")
      throw new Error("Worker error message must be a string.");
  }
  return structuredClone(value) as unknown as WorkerMessage;
};
