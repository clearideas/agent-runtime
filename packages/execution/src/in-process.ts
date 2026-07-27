import { createHash, randomUUID } from "node:crypto";

import type {
  JsonObject,
  RunError,
  RunEvent,
  RunResult,
} from "@clearideas/agent-runtime-contracts";

import {
  compareEventCursors,
  eventCursor,
  ExecutionEngineError,
  type ExecutionEngine,
  type ExecutionEventOptions,
  type ExecutionHandle,
  type ExecutionHandler,
  type ExecutionLifecycleStatus,
  type ExecutionRequest,
  type ExecutionResultOptions,
  type ExecutionStatus,
  isEventAfter,
  isTerminalExecutionStatus,
  type ResumeExecutionRequest,
} from "./contracts.js";

interface Waiter {
  resolve(): void;
  reject(error: Error): void;
}

interface DeferredResult {
  promise: Promise<RunResult>;
  resolve(result: RunResult): void;
  reject(error: Error): void;
}

interface ExecutionRecord {
  handle: ExecutionHandle;
  requestDigest: string;
  status: ExecutionLifecycleStatus;
  attempt: number;
  updatedAt: string;
  events: RunEvent[];
  version: number;
  waiters: Set<Waiter>;
  controller: AbortController;
  result: DeferredResult;
  error?: RunError;
  resultValue?: RunResult;
}

export interface InProcessExecutionEngineOptions {
  name?: string;
  now?: () => Date;
  generateId?: () => string;
}

const deferredResult = (): DeferredResult => {
  let resolve!: (result: RunResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RunResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A caller may only inspect status/events. Prevent an unhandled rejection
  // while preserving rejection for a later result() call.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};

const normalizeError = (error: unknown): RunError => {
  if (error instanceof ExecutionEngineError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const source = error instanceof Error ? error : new Error(String(error));
  return {
    code:
      source.name === "AbortError" ? "EXECUTION_CANCELLED" : "EXECUTION_FAILED",
    message: source.message,
    retryable: false,
    ...(source.name === "Error"
      ? {}
      : { details: { name: source.name } as JsonObject }),
  };
};

const requestDigest = (
  request: ExecutionRequest | ResumeExecutionRequest,
): string => createHash("sha256").update(JSON.stringify(request)).digest("hex");

const clone = <T>(value: T): T => structuredClone(value);

export class InProcessExecutionEngine implements ExecutionEngine {
  readonly name: string;
  readonly #handler: ExecutionHandler;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  readonly #records = new Map<string, ExecutionRecord>();
  readonly #idempotency = new Map<string, string>();

  constructor(
    handler: ExecutionHandler,
    options: InProcessExecutionEngineOptions = {},
  ) {
    this.#handler = handler;
    this.name = options.name ?? "in-process";
    this.#now = options.now ?? (() => new Date());
    this.#generateId =
      options.generateId ?? (() => `execution_${randomUUID()}`);
  }

  async submit(request: ExecutionRequest): Promise<ExecutionHandle> {
    return this.#start(request, "run", 1);
  }

  async resume(request: ResumeExecutionRequest): Promise<ExecutionHandle> {
    if (!Number.isSafeInteger(request.attempt) || request.attempt < 2) {
      throw new Error("Resume attempt must be an integer greater than one.");
    }
    if (!request.checkpoint && !request.checkpointReference) {
      throw new Error("Resume requires a checkpoint or checkpointReference.");
    }
    return this.#start(request, "resume", request.attempt);
  }

  async status(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const record = this.#record(handle);
    const lastEvent = record.events.at(-1);
    return clone({
      handle: record.handle,
      status: record.status,
      attempt: record.attempt,
      updatedAt: record.updatedAt,
      ...(lastEvent ? { lastEventCursor: eventCursor(lastEvent) } : {}),
      ...(record.error ? { error: record.error } : {}),
    });
  }

  async *events(
    handle: ExecutionHandle,
    options: ExecutionEventOptions = {},
  ): AsyncIterable<RunEvent> {
    const record = this.#record(handle);
    let cursor = options.after;
    while (true) {
      if (options.signal?.aborted) throw this.#abortError(options.signal);
      const pending = record.events.filter((event) =>
        isEventAfter(event, cursor),
      );
      if (pending.length > 0) {
        for (const event of pending) {
          cursor = eventCursor(event);
          yield clone(event);
        }
        continue;
      }
      if (isTerminalExecutionStatus(record.status)) return;
      await this.#waitForChange(record, record.version, options.signal);
    }
  }

  async result(
    handle: ExecutionHandle,
    options: ExecutionResultOptions = {},
  ): Promise<RunResult> {
    const record = this.#record(handle);
    if (record.resultValue) return clone(record.resultValue);
    if (record.error) throw new ExecutionEngineError(record.error);
    if (!options.signal) return clone(await record.result.promise);
    if (options.signal.aborted) throw this.#abortError(options.signal);
    return new Promise<RunResult>((resolve, reject) => {
      const onAbort = (): void => reject(this.#abortError(options.signal!));
      options.signal!.addEventListener("abort", onAbort, { once: true });
      record.result.promise.then(
        (value) => {
          options.signal!.removeEventListener("abort", onAbort);
          resolve(clone(value));
        },
        (error) => {
          options.signal!.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const record = this.#record(handle);
    if (isTerminalExecutionStatus(record.status)) return;
    record.controller.abort(new Error("Execution cancelled by client."));
    const error: RunError = {
      code: "EXECUTION_CANCELLED",
      message: "Execution cancelled by client.",
      retryable: false,
    };
    this.#finish(record, "cancelled", { error });
  }

  async #start(
    request: ExecutionRequest | ResumeExecutionRequest,
    mode: "run" | "resume",
    attempt: number,
  ): Promise<ExecutionHandle> {
    const digest = requestDigest(request);
    if (request.idempotencyKey) {
      const existingId = this.#idempotency.get(request.idempotencyKey);
      if (existingId) {
        const existing = this.#records.get(existingId)!;
        if (existing.requestDigest !== digest) {
          throw new Error(
            `Idempotency key ${request.idempotencyKey} was reused with another request.`,
          );
        }
        return clone(existing.handle);
      }
    }
    const submittedAt = this.#now().toISOString();
    const runId = request.runId ?? `run_${randomUUID()}`;
    const handle: ExecutionHandle = {
      id: this.#generateId(),
      engine: this.name,
      runId,
      submittedAt,
    };
    const record: ExecutionRecord = {
      handle,
      requestDigest: digest,
      status: "queued",
      attempt,
      updatedAt: submittedAt,
      events: [],
      version: 0,
      waiters: new Set(),
      controller: new AbortController(),
      result: deferredResult(),
    };
    this.#records.set(handle.id, record);
    if (request.idempotencyKey)
      this.#idempotency.set(request.idempotencyKey, handle.id);
    queueMicrotask(() => void this.#execute(record, clone(request), mode));
    return clone(handle);
  }

  async #execute(
    record: ExecutionRecord,
    request: ExecutionRequest | ResumeExecutionRequest,
    mode: "run" | "resume",
  ): Promise<void> {
    if (record.status === "cancelled") return;
    this.#transition(record, "running");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (request.timeoutMs != null) {
      timeout = setTimeout(
        () =>
          record.controller.abort(
            new ExecutionEngineError({
              code: "EXECUTION_TIMEOUT",
              message: `Execution timed out after ${request.timeoutMs}ms.`,
              retryable: true,
            }),
          ),
        request.timeoutMs,
      );
      (timeout as unknown as { unref?: () => void }).unref?.();
    }
    try {
      const result = await this.#handler(request, {
        handle: clone(record.handle),
        mode,
        attempt: record.attempt,
        ...("checkpoint" in request && request.checkpoint
          ? { checkpoint: clone(request.checkpoint) }
          : {}),
        ...("checkpointReference" in request && request.checkpointReference
          ? { checkpointReference: request.checkpointReference }
          : {}),
        signal: record.controller.signal,
        emit: async (event) => {
          if (isTerminalExecutionStatus(record.status)) return;
          if (event.runId !== record.handle.runId) {
            throw new Error(
              `Event runId ${event.runId} does not match ${record.handle.runId}.`,
            );
          }
          const previous = record.events.at(-1);
          if (eventCursor(event).attempt !== record.attempt) {
            throw new Error(
              `Event attempt ${eventCursor(event).attempt} does not match execution attempt ${record.attempt}.`,
            );
          }
          if (
            previous &&
            compareEventCursors(eventCursor(event), eventCursor(previous)) <= 0
          ) {
            throw new Error(
              "Execution events must have strictly increasing cursors.",
            );
          }
          record.events.push(clone(event));
          this.#touch(record);
        },
      });
      if (isTerminalExecutionStatus(record.status)) return;
      if (result.runId !== record.handle.runId) {
        throw new Error(
          `Result runId ${result.runId} does not match ${record.handle.runId}.`,
        );
      }
      this.#finish(record, "completed", { result });
    } catch (error) {
      if (isTerminalExecutionStatus(record.status)) return;
      const normalized = normalizeError(error);
      this.#finish(record, "failed", { error: normalized });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #finish(
    record: ExecutionRecord,
    status: "completed" | "failed" | "cancelled",
    outcome: { result?: RunResult; error?: RunError },
  ): void {
    if (isTerminalExecutionStatus(record.status)) return;
    record.status = status;
    record.updatedAt = this.#now().toISOString();
    if (outcome.result) {
      record.resultValue = clone(outcome.result);
      record.result.resolve(clone(outcome.result));
    } else {
      const error = outcome.error ?? {
        code: "EXECUTION_FAILED",
        message: `Execution ended as ${status}.`,
        retryable: false,
      };
      record.error = clone(error);
      record.result.reject(new ExecutionEngineError(error));
    }
    this.#touch(record, false);
  }

  #transition(record: ExecutionRecord, status: ExecutionLifecycleStatus): void {
    record.status = status;
    record.updatedAt = this.#now().toISOString();
    this.#touch(record, false);
  }

  #touch(record: ExecutionRecord, updateTimestamp = true): void {
    record.version += 1;
    if (updateTimestamp) record.updatedAt = this.#now().toISOString();
    for (const waiter of record.waiters) waiter.resolve();
    record.waiters.clear();
  }

  #record(handle: ExecutionHandle): ExecutionRecord {
    if (handle.engine !== this.name) {
      throw new Error(
        `Execution handle belongs to engine ${handle.engine}, not ${this.name}.`,
      );
    }
    const record = this.#records.get(handle.id);
    if (!record || record.handle.runId !== handle.runId) {
      throw new Error(`Unknown execution handle ${handle.id}.`);
    }
    return record;
  }

  #waitForChange(
    record: ExecutionRecord,
    observedVersion: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (record.version !== observedVersion) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(this.#abortError(signal));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        record.waiters.delete(waiter);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => finish(this.#abortError(signal!));
      const waiter: Waiter = {
        resolve: () => finish(),
        reject: (error) => finish(error),
      };
      record.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (record.version !== observedVersion) finish();
    });
  }

  #abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error("Operation aborted.");
  }
}
