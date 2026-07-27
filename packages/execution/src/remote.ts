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
  type ExecutionLifecycleStatus,
  type ExecutionRequest,
  type ExecutionResultOptions,
  type ExecutionStatus,
  isEventAfter,
  isTerminalExecutionStatus,
  type ResumeExecutionRequest,
} from "./contracts.js";
import {
  createWorkerInvocation,
  type WorkerInvocation,
} from "./worker-protocol.js";

export interface RemoteExecutionReservation {
  handle: ExecutionHandle;
  shouldLaunch: boolean;
}

export interface RemoteExecutionControlPlane {
  reserve(input: {
    engine: string;
    mode: "run" | "resume";
    request: ExecutionRequest | ResumeExecutionRequest;
  }): Promise<RemoteExecutionReservation>;
  launched(
    handle: ExecutionHandle,
    providerData: JsonObject,
  ): Promise<ExecutionHandle>;
  launchFailed(handle: ExecutionHandle, error: RunError): Promise<void>;
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

/** Write side used by worker transports that deliver events and terminal results. */
export interface RemoteExecutionReporter {
  acceptEvent(handle: ExecutionHandle, event: RunEvent): Promise<void>;
  complete(handle: ExecutionHandle, result: RunResult): Promise<void>;
  fail(handle: ExecutionHandle, error: RunError): Promise<void>;
}

export interface RemoteComputeLauncher {
  readonly name: string;
  launch(
    invocation: WorkerInvocation,
    context: { handle: ExecutionHandle },
  ): Promise<JsonObject>;
  /** Optional non-blocking worker-message pump started after launch is recorded. */
  observe?(handle: ExecutionHandle): Promise<void>;
  cancel(handle: ExecutionHandle): Promise<void>;
}

export class RemoteExecutionEngine implements ExecutionEngine {
  readonly name: string;
  readonly #launcher: RemoteComputeLauncher;
  readonly #controlPlane: RemoteExecutionControlPlane;

  constructor(
    launcher: RemoteComputeLauncher,
    controlPlane: RemoteExecutionControlPlane,
  ) {
    this.#launcher = launcher;
    this.#controlPlane = controlPlane;
    this.name = launcher.name;
  }

  submit(request: ExecutionRequest): Promise<ExecutionHandle> {
    return this.#start("run", request);
  }

  resume(request: ResumeExecutionRequest): Promise<ExecutionHandle> {
    return this.#start("resume", request);
  }

  status(handle: ExecutionHandle): Promise<ExecutionStatus> {
    return this.#controlPlane.status(handle);
  }

  events(
    handle: ExecutionHandle,
    options?: ExecutionEventOptions,
  ): AsyncIterable<RunEvent> {
    return this.#controlPlane.events(handle, options);
  }

  result(
    handle: ExecutionHandle,
    options?: ExecutionResultOptions,
  ): Promise<RunResult> {
    return this.#controlPlane.result(handle, options);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    // Resolve the provider-owned handle from trusted control-plane state before
    // using providerData supplied by a caller.
    const canonical = (await this.#controlPlane.status(handle)).handle;
    await this.#launcher.cancel(canonical);
    await this.#controlPlane.cancel(canonical);
    const status = await this.#controlPlane.status(canonical);
    if (
      status.status !== "cancelled" &&
      !isTerminalExecutionStatus(status.status)
    ) {
      throw new Error(
        `Remote execution ${canonical.id} did not enter a terminal state after cancel.`,
      );
    }
  }

  async #start(
    mode: "run" | "resume",
    request: ExecutionRequest | ResumeExecutionRequest,
  ): Promise<ExecutionHandle> {
    const reservation = await this.#controlPlane.reserve({
      engine: this.name,
      mode,
      request,
    });
    if (!reservation.shouldLaunch) return reservation.handle;
    try {
      const providerData = await this.#launcher.launch(
        createWorkerInvocation(request, mode),
        { handle: reservation.handle },
      );
      const handle = await this.#controlPlane.launched(
        reservation.handle,
        providerData,
      );
      if (this.#launcher.observe) {
        queueMicrotask(() => {
          void this.#launcher.observe!(handle).catch(async (error) => {
            await this.#controlPlane.launchFailed(handle, {
              code: "REMOTE_OBSERVER_FAILED",
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            });
          });
        });
      }
      return handle;
    } catch (error) {
      const normalized: RunError = {
        code: "REMOTE_LAUNCH_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
      await this.#controlPlane.launchFailed(reservation.handle, normalized);
      throw new ExecutionEngineError(normalized);
    }
  }
}

interface MemoryRemoteRecord {
  handle: ExecutionHandle;
  digest: string;
  status: ExecutionLifecycleStatus;
  attempt: number;
  updatedAt: string;
  events: RunEvent[];
  version: number;
  waiters: Set<() => void>;
  result?: RunResult;
  error?: RunError;
}

/**
 * Reference control plane for tests and single-process development. Hosted
 * engines should persist the same lifecycle behind an authenticated API.
 */
export class InMemoryRemoteExecutionControlPlane implements RemoteExecutionControlPlane {
  readonly #records = new Map<string, MemoryRemoteRecord>();
  readonly #idempotency = new Map<string, string>();

  async reserve(input: {
    engine: string;
    mode: "run" | "resume";
    request: ExecutionRequest | ResumeExecutionRequest;
  }): Promise<RemoteExecutionReservation> {
    const digest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const idempotencyKey = input.request.idempotencyKey;
    if (idempotencyKey) {
      const existingId = this.#idempotency.get(idempotencyKey);
      if (existingId) {
        const existing = this.#records.get(existingId)!;
        if (existing.digest !== digest)
          throw new Error("Conflicting remote idempotency key reuse.");
        return {
          handle: structuredClone(existing.handle),
          shouldLaunch: false,
        };
      }
    }
    const now = new Date().toISOString();
    const runId = input.request.runId ?? `run_${randomUUID()}`;
    const handle: ExecutionHandle = {
      id: `remote_${randomUUID()}`,
      engine: input.engine,
      runId,
      submittedAt: now,
    };
    this.#records.set(handle.id, {
      handle,
      digest,
      status: "queued",
      attempt:
        input.mode === "resume"
          ? (input.request as ResumeExecutionRequest).attempt
          : 1,
      updatedAt: now,
      events: [],
      version: 0,
      waiters: new Set(),
    });
    if (idempotencyKey) this.#idempotency.set(idempotencyKey, handle.id);
    return { handle: structuredClone(handle), shouldLaunch: true };
  }

  async launched(
    handle: ExecutionHandle,
    providerData: JsonObject,
  ): Promise<ExecutionHandle> {
    const record = this.#record(handle);
    record.handle = {
      ...record.handle,
      providerData: structuredClone(providerData),
    };
    record.status = "running";
    this.#touch(record);
    return structuredClone(record.handle);
  }

  async launchFailed(handle: ExecutionHandle, error: RunError): Promise<void> {
    const record = this.#record(handle);
    if (isTerminalExecutionStatus(record.status)) return;
    record.status = "failed";
    record.error = structuredClone(error);
    this.#touch(record);
  }

  async status(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const record = this.#record(handle);
    const last = record.events.at(-1);
    return structuredClone({
      handle: record.handle,
      status: record.status,
      attempt: record.attempt,
      updatedAt: record.updatedAt,
      ...(last ? { lastEventCursor: eventCursor(last) } : {}),
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
      if (options.signal?.aborted) throw options.signal.reason;
      const pending = record.events.filter((item) =>
        isEventAfter(item, cursor),
      );
      if (pending.length > 0) {
        for (const item of pending) {
          cursor = eventCursor(item);
          yield structuredClone(item);
        }
        continue;
      }
      if (isTerminalExecutionStatus(record.status)) return;
      const version = record.version;
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          record.waiters.delete(wake);
          reject(options.signal?.reason ?? new Error("Operation aborted."));
        };
        record.waiters.add(wake);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (record.version !== version) wake();
      });
    }
  }

  async result(
    handle: ExecutionHandle,
    options: ExecutionResultOptions = {},
  ): Promise<RunResult> {
    const record = this.#record(handle);
    while (!isTerminalExecutionStatus(record.status)) {
      for await (const _event of this.events(handle, {
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        // Drain until terminal.
      }
    }
    if (record.result) return structuredClone(record.result);
    throw new ExecutionEngineError(
      record.error ?? {
        code:
          record.status === "cancelled"
            ? "EXECUTION_CANCELLED"
            : "REMOTE_EXECUTION_FAILED",
        message: `Remote execution ended as ${record.status}.`,
        retryable: false,
      },
    );
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const record = this.#record(handle);
    if (isTerminalExecutionStatus(record.status)) return;
    record.status = "cancelled";
    record.error = {
      code: "EXECUTION_CANCELLED",
      message: "Remote execution cancelled by client.",
      retryable: false,
    };
    this.#touch(record);
  }

  async acceptEvent(handle: ExecutionHandle, event: RunEvent): Promise<void> {
    const record = this.#record(handle);
    if (isTerminalExecutionStatus(record.status))
      throw new Error("Cannot append to a terminal run.");
    if (event.runId !== record.handle.runId)
      throw new Error("Remote event runId mismatch.");
    if (eventCursor(event).attempt !== record.attempt) {
      throw new Error("Remote event attempt mismatch.");
    }
    const previous = record.events.at(-1);
    if (
      previous &&
      compareEventCursors(eventCursor(event), eventCursor(previous)) <= 0
    ) {
      throw new Error("Remote event cursor is stale.");
    }
    record.events.push(structuredClone(event));
    this.#touch(record);
  }

  async complete(handle: ExecutionHandle, result: RunResult): Promise<void> {
    const record = this.#record(handle);
    if (isTerminalExecutionStatus(record.status)) return;
    if (result.runId !== record.handle.runId)
      throw new Error("Remote result runId mismatch.");
    record.result = structuredClone(result);
    record.status = "completed";
    this.#touch(record);
  }

  async fail(handle: ExecutionHandle, error: RunError): Promise<void> {
    const record = this.#record(handle);
    if (isTerminalExecutionStatus(record.status)) return;
    record.error = structuredClone(error);
    record.status = "failed";
    this.#touch(record);
  }

  #record(handle: ExecutionHandle): MemoryRemoteRecord {
    const record = this.#records.get(handle.id);
    if (
      !record ||
      record.handle.runId !== handle.runId ||
      record.handle.engine !== handle.engine
    ) {
      throw new Error(`Unknown remote execution handle ${handle.id}.`);
    }
    return record;
  }

  #touch(record: MemoryRemoteRecord): void {
    record.updatedAt = new Date().toISOString();
    record.version += 1;
    for (const waiter of record.waiters) waiter();
    record.waiters.clear();
  }
}
