import type {
  RunCheckpoint,
  RunError,
  RunEvent,
} from "@clearideas/agent-runtime-contracts";

import type {
  CompletedRunRecord,
  EventSink,
  IdGenerator,
  ResumeRunOptions,
  RunRecord,
  RunStore,
} from "../ports/index.js";

export class SequenceIdGenerator implements IdGenerator {
  #next = 0;

  generateId(prefix: "run" | "checkpoint" | "event"): string {
    this.#next += 1;
    return `${prefix}_${this.#next}`;
  }
}

export class CollectingEventSink implements EventSink {
  readonly events: RunEvent[] = [];

  emit(event: RunEvent): void {
    this.events.push(structuredClone(event));
  }
}

export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();
  readonly checkpoints = new Map<string, RunCheckpoint[]>();
  readonly completed = new Map<string, CompletedRunRecord>();
  readonly failures = new Map<string, { error: RunError; failedAt: string }>();

  async createRun(record: RunRecord): Promise<void> {
    if (this.runs.has(record.runId)) {
      throw new Error(`Run ${record.runId} already exists`);
    }
    this.runs.set(record.runId, structuredClone(record));
  }

  async loadRun(runId: string): Promise<RunRecord | null> {
    const record = this.runs.get(runId);
    return record ? structuredClone(record) : null;
  }

  async loadLatestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    const checkpoint = this.checkpoints.get(runId)?.at(-1);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async resumeRun(
    runId: string,
    resumedAt: string,
    options?: ResumeRunOptions,
  ): Promise<number> {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Run ${runId} does not exist`);
    if (record.status === "completed" || record.status === "cancelled") {
      throw new Error(`Run ${runId} is already ${record.status}`);
    }
    if (record.status === "running" && options?.allowRunningTakeover !== true) {
      throw new Error(`Run ${runId} is still owned by a running attempt`);
    }
    const attempt = (record.attempt ?? 1) + 1;
    this.runs.set(runId, {
      ...structuredClone(record),
      status: "running",
      attempt,
      updatedAt: resumedAt,
    });
    this.failures.delete(runId);
    return attempt;
  }

  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    const record = this.runs.get(checkpoint.runId);
    if (!record) throw new Error(`Run ${checkpoint.runId} does not exist`);
    if ((checkpoint.attempt ?? 1) !== (record.attempt ?? 1)) {
      throw new Error(`Run ${checkpoint.runId} is owned by another attempt`);
    }
    const checkpoints = this.checkpoints.get(checkpoint.runId) ?? [];
    checkpoints.push(structuredClone(checkpoint));
    this.checkpoints.set(checkpoint.runId, checkpoints);
  }

  async suspendRun(
    runId: string,
    suspendedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Run ${runId} does not exist`);
    if ((record.attempt ?? 1) !== expectedAttempt) {
      throw new Error(`Run ${runId} is owned by another attempt`);
    }
    if (record.status !== "created" && record.status !== "running") {
      if (record.status === "suspended") return;
      throw new Error(`Cannot suspend ${record.status} run ${runId}`);
    }
    this.runs.set(runId, {
      ...structuredClone(record),
      status: "suspended",
      updatedAt: suspendedAt,
    });
  }

  async completeRun(record: CompletedRunRecord): Promise<void> {
    const current = this.runs.get(record.runId);
    if (!current) throw new Error(`Run ${record.runId} does not exist`);
    if ((record.attempt ?? 1) !== (current.attempt ?? 1)) {
      throw new Error(`Run ${record.runId} is owned by another attempt`);
    }
    this.completed.set(record.runId, structuredClone(record));
    this.runs.set(record.runId, structuredClone(record));
  }

  async failRun(
    runId: string,
    error: RunError,
    failedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Run ${runId} does not exist`);
    if ((record.attempt ?? 1) !== expectedAttempt) {
      throw new Error(`Run ${runId} is owned by another attempt`);
    }
    this.failures.set(runId, { error: structuredClone(error), failedAt });
    this.runs.set(runId, {
      ...record,
      status: "failed",
      updatedAt: failedAt,
    });
  }

  async cancelRun(
    runId: string,
    cancelledAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Run ${runId} does not exist`);
    if ((record.attempt ?? 1) !== expectedAttempt) {
      throw new Error(`Run ${runId} is owned by another attempt`);
    }
    if (record.status === "completed") {
      throw new Error(`Run ${runId} is already completed`);
    }
    this.runs.set(runId, {
      ...structuredClone(record),
      status: "cancelled",
      updatedAt: cancelledAt,
    });
    this.failures.delete(runId);
  }
}
