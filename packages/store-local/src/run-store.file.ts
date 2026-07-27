import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

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

import { safePathComponent } from "./path-component.js";
import type { FailedRunRecord } from "./run-store.memory.js";

const RUN_FILE = "run.json";
const CHECKPOINT_FILE = "checkpoint.json";

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

/**
 * Writes complete JSON documents through a same-directory temporary file and
 * atomic rename, so readers observe either the old document or the new one.
 */
const writeJsonAtomically = async (
  filePath: string,
  value: unknown,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

/**
 * Durable zero-service persistence for one Agent Runtime process. Atomic file
 * replacement protects readers from partial JSON, but cross-process resume
 * arbitration requires SqliteRunStore or another CAS-capable adapter.
 */
export class FileRunStore implements RunStore {
  readonly #rootDirectory: string;
  readonly #runLocks = new Map<string, Promise<void>>();

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim())
      throw new Error("FileRunStore requires a root directory.");
    this.#rootDirectory = path.resolve(rootDirectory);
  }

  async createRun(record: RunRecord): Promise<void> {
    return this.#withRunLock(record.runId, async () => {
      const filePath = this.#runFile(record.runId);
      if (await pathExists(filePath))
        throw new Error(`Run already exists: ${record.runId}`);
      await writeJsonAtomically(filePath, record);
    });
  }

  async loadRun(runId: string): Promise<RunRecord | null> {
    return readJson<RunRecord>(this.#runFile(runId));
  }

  async loadLatestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    return readJson<RunCheckpoint>(this.#checkpointFile(runId));
  }

  async resumeRun(
    runId: string,
    resumedAt: string,
    options?: ResumeRunOptions,
  ): Promise<number> {
    return this.#withRunLock(runId, async () => {
      const existing = await this.#requireRun(runId);
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
      await writeJsonAtomically(this.#runFile(runId), {
        ...existing,
        status: "running",
        attempt,
        updatedAt: resumedAt,
      });
      return attempt;
    });
  }

  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    return this.#withRunLock(checkpoint.runId, async () => {
      const run = await this.#requireRun(checkpoint.runId);
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
      const current = await this.loadLatestCheckpoint(checkpoint.runId);
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
      await writeJsonAtomically(
        this.#checkpointFile(checkpoint.runId),
        checkpoint,
      );
    });
  }

  async suspendRun(
    runId: string,
    suspendedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    return this.#withRunLock(runId, async () => {
      const existing = await this.#requireRun(runId);
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
      await writeJsonAtomically(this.#runFile(runId), {
        ...existing,
        status: "suspended",
        updatedAt: suspendedAt,
      });
    });
  }

  async completeRun(record: CompletedRunRecord): Promise<void> {
    return this.#withRunLock(record.runId, async () => {
      const existing = await this.#requireRun(record.runId);
      if (existing.status === "completed") {
        if (JSON.stringify(existing) === JSON.stringify(record)) return;
        throw new Error(`Run ${record.runId} has conflicting completed data`);
      }
      if (
        existing.status !== "created" &&
        existing.status !== "running" &&
        existing.status !== "suspended"
      ) {
        throw new Error(
          `Cannot complete ${existing.status} run ${record.runId}`,
        );
      }
      if ((record.attempt ?? 1) !== (existing.attempt ?? 1)) {
        throw new Error(`Run ${record.runId} is owned by another attempt`);
      }
      await writeJsonAtomically(this.#runFile(record.runId), record);
    });
  }

  async failRun(
    runId: string,
    error: RunError,
    failedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    return this.#withRunLock(runId, async () => {
      const existing = await this.#requireRun(runId);
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
        error,
        failedAt,
      };
      await writeJsonAtomically(this.#runFile(runId), failedRecord);
    });
  }

  async cancelRun(
    runId: string,
    cancelledAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    return this.#withRunLock(runId, async () => {
      const existing = await this.#requireRun(runId);
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
      await writeJsonAtomically(this.#runFile(runId), {
        ...existing,
        status: "cancelled",
        updatedAt: cancelledAt,
      });
    });
  }

  async #withRunLock<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.#runLocks.set(runId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#runLocks.get(runId) === current) this.#runLocks.delete(runId);
    }
  }

  async #requireRun(runId: string): Promise<RunRecord> {
    const record = await this.loadRun(runId);
    if (!record) throw new Error(`Run not found: ${runId}`);
    return record;
  }

  #runDirectory(runId: string): string {
    return path.join(
      this.#rootDirectory,
      "runs",
      safePathComponent(runId, "Run id"),
    );
  }

  #runFile(runId: string): string {
    return path.join(this.#runDirectory(runId), RUN_FILE);
  }

  #checkpointFile(runId: string): string {
    return path.join(this.#runDirectory(runId), CHECKPOINT_FILE);
  }
}
