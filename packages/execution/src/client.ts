import type { RunEvent, RunResult } from "@clearideas/agent-runtime-contracts";

import {
  type EventCursor,
  type ExecutionEngine,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionStatus,
  eventCursor,
  isTerminalExecutionStatus,
  type ResumeExecutionRequest,
} from "./contracts.js";

export interface FollowExecutionOptions {
  after?: EventCursor;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  reconnectDelayMs?: number;
  maximumReconnects?: number;
}

export interface FollowedExecution {
  handle: ExecutionHandle;
  status: ExecutionStatus;
  result?: RunResult;
  lastEventCursor?: EventCursor;
}

const wait = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (milliseconds <= 0) return;
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Operation aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export class ExecutionClient {
  readonly #engine: ExecutionEngine;

  constructor(engine: ExecutionEngine) {
    this.#engine = engine;
  }

  submit(request: ExecutionRequest): Promise<ExecutionHandle> {
    return this.#engine.submit(request);
  }

  resume(request: ResumeExecutionRequest): Promise<ExecutionHandle> {
    return this.#engine.resume(request);
  }

  async follow(
    handle: ExecutionHandle,
    options: FollowExecutionOptions = {},
  ): Promise<FollowedExecution> {
    let cursor = options.after;
    let reconnects = 0;
    const maximumReconnects = options.maximumReconnects ?? 3;
    while (true) {
      try {
        for await (const event of this.#engine.events(handle, {
          ...(cursor ? { after: cursor } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })) {
          cursor = eventCursor(event);
          await options.onEvent?.(event);
        }
        break;
      } catch (error) {
        if (options.signal?.aborted || reconnects >= maximumReconnects)
          throw error;
        reconnects += 1;
        await wait(options.reconnectDelayMs ?? 250, options.signal);
      }
    }
    const status = await this.#engine.status(handle);
    if (status.status === "completed") {
      return {
        handle,
        status,
        result: await this.#engine.result(handle, {
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        ...(cursor ? { lastEventCursor: cursor } : {}),
      };
    }
    return { handle, status, ...(cursor ? { lastEventCursor: cursor } : {}) };
  }

  async wait(
    handle: ExecutionHandle,
    signal?: AbortSignal,
  ): Promise<ExecutionStatus> {
    for await (const _event of this.#engine.events(handle, {
      ...(signal ? { signal } : {}),
    })) {
      // Draining the event stream waits until the execution reaches a terminal state.
    }
    const status = await this.#engine.status(handle);
    if (!isTerminalExecutionStatus(status.status)) {
      throw new Error(
        `Execution event stream ended while status was ${status.status}.`,
      );
    }
    return status;
  }

  cancel(handle: ExecutionHandle): Promise<void> {
    return this.#engine.cancel(handle);
  }
}
