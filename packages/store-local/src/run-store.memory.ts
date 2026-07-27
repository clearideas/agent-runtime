import type {
  RunCheckpoint,
  RunError,
} from "@clearideas/agent-runtime-contracts";
import type {
  CompletedRunRecord,
  ResumeRunOptions,
  RunRecord,
  RunStore,
} from "@clearideas/agent-runtime-core";

export type FailedRunRecord = RunRecord & {
  status: "failed";
  error: RunError;
  failedAt: string;
};

const clone = <T>(value: T): T => structuredClone(value);

/** In-process persistence for tests, embedded use, and short-lived local runs. */
export class MemoryRunStore implements RunStore {
  readonly #runs = new Map<string, RunRecord>();
  readonly #checkpoints = new Map<string, RunCheckpoint>();

  async createRun(record: RunRecord): Promise<void> {
    if (this.#runs.has(record.runId)) {
      throw new Error(`Run already exists: ${record.runId}`);
    }
    this.#runs.set(record.runId, clone(record));
  }

  async loadRun(runId: string): Promise<RunRecord | null> {
    const record = this.#runs.get(runId);
    return record ? clone(record) : null;
  }

  async loadLatestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    const checkpoint = this.#checkpoints.get(runId);
    return checkpoint ? clone(checkpoint) : null;
  }

  async resumeRun(
    runId: string,
    resumedAt: string,
    options?: ResumeRunOptions,
  ): Promise<number> {
    const existing = this.#requireRun(runId);
    if (existing.status === "completed" || existing.status === "cancelled") {
      throw new Error(`Run ${runId} is already ${existing.status}`);
    }
    if (
      existing.status === "running" &&
      options?.allowRunningTakeover !== true
    ) {
      throw new Error(`Run ${runId} is still owned by a running attempt`);
    }
    const attempt = (existing.attempt ?? 1) + 1;
    this.#runs.set(runId, {
      ...clone(existing),
      status: "running",
      attempt,
      updatedAt: resumedAt,
    });
    return attempt;
  }

  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    const run = this.#requireRun(checkpoint.runId);
    if (
      run.status !== "created" &&
      run.status !== "running" &&
      run.status !== "suspended"
    ) {
      throw new Error(
        `Cannot checkpoint ${run.status} run ${checkpoint.runId}`,
      );
    }
    if ((checkpoint.attempt ?? 1) !== (run.attempt ?? 1)) {
      throw new Error(`Run ${checkpoint.runId} is owned by another attempt`);
    }
    const current = this.#checkpoints.get(checkpoint.runId);
    if (current) {
      if (current.sequence === checkpoint.sequence) {
        if (JSON.stringify(current) === JSON.stringify(checkpoint)) return;
        throw new Error(
          `Checkpoint sequence or id conflicts for run ${checkpoint.runId}`,
        );
      }
      if (checkpoint.sequence !== current.sequence + 1) {
        throw new Error(
          `Checkpoint ${checkpoint.sequence} for run ${checkpoint.runId} does not follow committed sequence ${current.sequence}`,
        );
      }
    } else if (checkpoint.sequence !== 1) {
      throw new Error(
        `First checkpoint for run ${checkpoint.runId} must have sequence 1`,
      );
    }
    this.#checkpoints.set(checkpoint.runId, clone(checkpoint));
  }

  async suspendRun(
    runId: string,
    suspendedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    const existing = this.#requireRun(runId);
    if (
      existing.status === "suspended" &&
      (existing.attempt ?? 1) === expectedAttempt
    )
      return;
    if (existing.status !== "created" && existing.status !== "running") {
      throw new Error(`Cannot suspend ${existing.status} run ${runId}`);
    }
    if ((existing.attempt ?? 1) !== expectedAttempt) {
      throw new Error(`Run ${runId} is owned by another attempt`);
    }
    this.#runs.set(runId, {
      ...clone(existing),
      status: "suspended",
      updatedAt: suspendedAt,
    });
  }

  async completeRun(record: CompletedRunRecord): Promise<void> {
    const existing = this.#requireRun(record.runId);
    if (existing.status === "completed") {
      if (JSON.stringify(existing) === JSON.stringify(record)) return;
      throw new Error(`Run ${record.runId} has conflicting completed data`);
    }
    if (
      existing.status !== "created" &&
      existing.status !== "running" &&
      existing.status !== "suspended"
    ) {
      throw new Error(`Cannot complete ${existing.status} run ${record.runId}`);
    }
    if ((record.attempt ?? 1) !== (existing.attempt ?? 1)) {
      throw new Error(`Run ${record.runId} is owned by another attempt`);
    }
    this.#runs.set(record.runId, clone(record));
  }

  async failRun(
    runId: string,
    error: RunError,
    failedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    const existing = this.#requireRun(runId);
    if (
      existing.status !== "created" &&
      existing.status !== "running" &&
      existing.status !== "suspended"
    ) {
      throw new Error(`Cannot fail ${existing.status} run ${runId}`);
    }
    if ((existing.attempt ?? 1) !== expectedAttempt) {
      throw new Error(`Run ${runId} is owned by another attempt`);
    }
    const failedRecord: FailedRunRecord = {
      ...existing,
      status: "failed",
      updatedAt: failedAt,
      error: clone(error),
      failedAt,
    };
    this.#runs.set(runId, failedRecord);
  }

  async cancelRun(
    runId: string,
    cancelledAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    const existing = this.#requireRun(runId);
    if (existing.status === "cancelled") return;
    if (
      existing.status !== "created" &&
      existing.status !== "running" &&
      existing.status !== "suspended"
    ) {
      throw new Error(`Cannot cancel ${existing.status} run ${runId}`);
    }
    if ((existing.attempt ?? 1) !== expectedAttempt) {
      throw new Error(`Run ${runId} is owned by another attempt`);
    }
    this.#runs.set(runId, {
      ...existing,
      status: "cancelled",
      updatedAt: cancelledAt,
    });
  }

  #requireRun(runId: string): RunRecord {
    const record = this.#runs.get(runId);
    if (!record) throw new Error(`Run not found: ${runId}`);
    return record;
  }
}
