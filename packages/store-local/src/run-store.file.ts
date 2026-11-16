import { randomUUID } from "node:crypto";
import { access, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import type {
  RunCheckpoint,
  RunError,
} from "@clearideas/agent-runtime-contracts";
import type {
  CompletedRunRecord,
  ResumeRunOptions,
  RunCheckpointSummary,
  RunRecord,
  RunStore,
} from "@clearideas/agent-runtime-core";
import { summarizeCheckpoint } from "@clearideas/agent-runtime-core";

import { readTextWithRetry, renameWithRetry } from "./file-retry.js";
import { safePathComponent } from "./path-component.js";
import type {
  FailedRunRecord,
  InterruptedRunRecord,
  RunStoreRetentionOptions,
} from "./run-store.memory.js";

const RUN_FILE = "run.json";
const CHECKPOINT_FILE = "checkpoint.json";
/** Step-completion checkpoints (restart points), one file per sequence. */
const BOUNDARY_DIRECTORY = "checkpoints";

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
    return JSON.parse(await readTextWithRetry(filePath)) as T;
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
    await renameWithRetry(temporaryPath, filePath);
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

  readonly #maxNested: number;

  constructor(rootDirectory: string, options: RunStoreRetentionOptions = {}) {
    if (!rootDirectory.trim())
      throw new Error("FileRunStore requires a root directory.");
    this.#rootDirectory = path.resolve(rootDirectory);
    this.#maxNested = options.maxNestedRestartPoints ?? 10;
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

  async listCheckpoints(
    runId: string,
    options: { boundaries?: boolean } = {},
  ): Promise<RunCheckpointSummary[]> {
    const retained = new Map<number, RunCheckpoint>();
    for (const entry of await this.#boundarySequences(runId)) {
      const checkpoint = await readJson<RunCheckpoint>(
        this.#boundaryFile(runId, entry.sequence, entry.nested),
      );
      if (checkpoint) retained.set(checkpoint.sequence, checkpoint);
    }
    const latest = await this.loadLatestCheckpoint(runId);
    if (latest && (!options.boundaries || latest.boundary))
      retained.set(latest.sequence, latest);
    return [...retained.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map(summarizeCheckpoint);
  }

  async loadCheckpoint(
    runId: string,
    sequence: number,
  ): Promise<RunCheckpoint | null> {
    const latest = await this.loadLatestCheckpoint(runId);
    if (latest?.sequence === sequence) return latest;
    if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
    const entry = (await this.#boundarySequences(runId)).find(
      (candidate) => candidate.sequence === sequence,
    );
    return entry
      ? readJson<RunCheckpoint>(
          this.#boundaryFile(runId, entry.sequence, entry.nested),
        )
      : null;
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
        ...(options?.manifest ? { manifest: options.manifest } : {}),
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
      // A restart point is kept after later checkpoints replace the latest.
      if (checkpoint.boundary) {
        const nested = checkpoint.boundary.stepPath.includes("/");
        await writeJsonAtomically(
          this.#boundaryFile(checkpoint.runId, checkpoint.sequence, nested),
          checkpoint,
        );
        // Bounded retention: all top-level restart points, recent nested ones.
        if (nested) {
          const stale = (await this.#boundarySequences(checkpoint.runId))
            .filter((entry) => entry.nested)
            .sort((left, right) => right.sequence - left.sequence)
            .slice(this.#maxNested);
          for (const entry of stale)
            await unlink(
              this.#boundaryFile(checkpoint.runId, entry.sequence, true),
            ).catch(() => undefined);
        }
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

  async interruptRun(
    runId: string,
    error: RunError,
    interruptedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    return this.#withRunLock(runId, async () => {
      const existing = await this.#requireRun(runId);
      if (existing.status !== "created" && existing.status !== "running") {
        throw new Error(`Cannot interrupt ${existing.status} run ${runId}`);
      }
      if ((existing.attempt ?? 1) !== expectedAttempt) {
        throw new Error(`Run ${runId} is owned by another attempt`);
      }
      const interrupted: InterruptedRunRecord = {
        ...existing,
        status: "interrupted",
        updatedAt: interruptedAt,
        error,
        interruptedAt,
      };
      await writeJsonAtomically(this.#runFile(runId), interrupted);
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
        existing.status !== "suspended" &&
        existing.status !== "interrupted"
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

  #boundaryFile(runId: string, sequence: number, nested: boolean): string {
    return path.join(
      this.#runDirectory(runId),
      BOUNDARY_DIRECTORY,
      `${String(sequence).padStart(12, "0")}${nested ? ".nested" : ""}.json`,
    );
  }

  async #boundarySequences(
    runId: string,
  ): Promise<Array<{ sequence: number; nested: boolean }>> {
    try {
      return (
        await readdir(path.join(this.#runDirectory(runId), BOUNDARY_DIRECTORY))
      )
        .map((name) => /^(\d{12})(\.nested)?\.json$/u.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({
          sequence: Number(match[1]),
          nested: match[2] !== undefined,
        }))
        .sort((left, right) => left.sequence - right.sequence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
