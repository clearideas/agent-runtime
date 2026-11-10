/**
 * Admission control: a global and a per-principal limit on concurrent runs,
 * with a bounded first-in, first-out queue. Requests beyond the queue, or
 * that wait longer than the queue timeout, are refused with 429.
 */
import { ServerError } from "./errors.js";

interface Waiter {
  principal: string;
  limit: number | undefined;
  resolve(release: () => void): void;
  reject(error: Error): void;
  cleanup(): void;
}

export interface AdmissionOptions {
  maxConcurrentRuns: number;
  maxQueuedRequests: number;
  queueTimeoutMs: number;
}

export interface AdmissionSnapshot {
  active: number;
  queued: number;
}

export class AdmissionController {
  readonly #options: AdmissionOptions;
  readonly #activeByPrincipal = new Map<string, number>();
  readonly #queue: Waiter[] = [];
  #active = 0;

  constructor(options: AdmissionOptions) {
    this.#options = options;
  }

  get snapshot(): AdmissionSnapshot {
    return { active: this.#active, queued: this.#queue.length };
  }

  /**
   * Wait for a slot. Resolves with a release function that must be called
   * exactly once when the run ends.
   */
  acquire(
    principal: string,
    limit: number | undefined,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#canRun(principal, limit)) {
      return Promise.resolve(this.#take(principal));
    }
    if (this.#queue.length >= this.#options.maxQueuedRequests) {
      return Promise.reject(
        this.#busy("The server is at capacity; retry shortly."),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#remove(waiter);
        reject(this.#busy("Timed out waiting for capacity; retry shortly."));
      }, this.#options.queueTimeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        this.#remove(waiter);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Request aborted while queued."),
        );
      };
      const waiter: Waiter = {
        principal,
        limit,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #busy(message: string): ServerError {
    return new ServerError(429, "rate_limit_exceeded", message, {
      retryAfter: 1,
    });
  }

  #canRun(principal: string, limit: number | undefined): boolean {
    if (this.#active >= this.#options.maxConcurrentRuns) return false;
    return (
      limit === undefined ||
      (this.#activeByPrincipal.get(principal) ?? 0) < limit
    );
  }

  #take(principal: string): () => void {
    this.#active += 1;
    this.#activeByPrincipal.set(
      principal,
      (this.#activeByPrincipal.get(principal) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      const remaining = (this.#activeByPrincipal.get(principal) ?? 1) - 1;
      if (remaining <= 0) this.#activeByPrincipal.delete(principal);
      else this.#activeByPrincipal.set(principal, remaining);
      this.#drain();
    };
  }

  #remove(waiter: Waiter): void {
    waiter.cleanup();
    const index = this.#queue.indexOf(waiter);
    if (index >= 0) this.#queue.splice(index, 1);
  }

  /** Admit the oldest waiters that fit; a waiter blocked by its own limit does not block others. */
  #drain(): void {
    for (let index = 0; index < this.#queue.length;) {
      if (this.#active >= this.#options.maxConcurrentRuns) return;
      const waiter = this.#queue[index]!;
      if (!this.#canRun(waiter.principal, waiter.limit)) {
        index += 1;
        continue;
      }
      this.#queue.splice(index, 1);
      waiter.cleanup();
      waiter.resolve(this.#take(waiter.principal));
    }
  }
}
