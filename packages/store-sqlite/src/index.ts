import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

interface JsonRow {
  json: string;
}

interface SequenceRow {
  sequence: number;
  json?: string;
}

const serialize = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;

/**
 * Durable single-file RunStore using Node's built-in SQLite binding. Every
 * method is synchronous internally but exposed through the async RunStore port.
 */
export class SqliteRunStore implements RunStore {
  readonly #database: DatabaseSync;

  constructor(filename: string) {
    if (!filename.trim())
      throw new Error("SqliteRunStore requires a filename.");
    if (filename !== ":memory:") {
      const resolved = path.resolve(filename);
      mkdirSync(path.dirname(resolved), { recursive: true });
      this.#database = new DatabaseSync(resolved);
      chmodSync(resolved, 0o600);
    } else {
      this.#database = new DatabaseSync(filename);
    }
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS agent_runtime_runs (
        run_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        failure_json TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_runtime_checkpoints (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        checkpoint_id TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        UNIQUE (run_id, checkpoint_id),
        FOREIGN KEY (run_id) REFERENCES agent_runtime_runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS agent_runtime_checkpoints_latest
        ON agent_runtime_checkpoints(run_id, sequence DESC);
    `);
    if (filename !== ":memory:")
      this.#database.exec("PRAGMA journal_mode = WAL;");
  }

  async createRun(record: RunRecord): Promise<void> {
    try {
      this.#database
        .prepare(
          "INSERT INTO agent_runtime_runs (run_id, record_json) VALUES (?, ?)",
        )
        .run(record.runId, serialize(record));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(`Run ${record.runId} already exists`, { cause: error });
      }
      throw error;
    }
  }

  async loadRun(runId: string): Promise<RunRecord | null> {
    const row = this.#database
      .prepare(
        "SELECT record_json AS json FROM agent_runtime_runs WHERE run_id = ?",
      )
      .get(runId) as JsonRow | undefined;
    return row ? parse<RunRecord>(row.json) : null;
  }

  async loadLatestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    const row = this.#database
      .prepare(
        `
        SELECT checkpoint_json AS json
        FROM agent_runtime_checkpoints
        WHERE run_id = ?
        ORDER BY sequence DESC
        LIMIT 1
      `,
      )
      .get(runId) as JsonRow | undefined;
    return row ? parse<RunCheckpoint>(row.json) : null;
  }

  async resumeRun(
    runId: string,
    resumedAt: string,
    options?: ResumeRunOptions,
  ): Promise<number> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(
          "SELECT record_json AS json FROM agent_runtime_runs WHERE run_id = ?",
        )
        .get(runId) as JsonRow | undefined;
      if (!row) throw new Error(`Run ${runId} does not exist`);
      const current = parse<RunRecord>(row.json);
      if (current.status === "completed" || current.status === "cancelled") {
        throw new Error(`Run ${runId} is already ${current.status}`);
      }
      if (
        current.status === "running" &&
        options?.allowRunningTakeover !== true
      ) {
        throw new Error(`Run ${runId} is still owned by a running attempt`);
      }
      const attempt = (current.attempt ?? 1) + 1;
      const resumed: RunRecord = {
        ...current,
        status: "running",
        attempt,
        updatedAt: resumedAt,
      };
      const result = this.#database
        .prepare(
          `
          UPDATE agent_runtime_runs
          SET record_json = ?, failure_json = NULL
          WHERE run_id = ?
        `,
        )
        .run(serialize(resumed), runId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Run ${runId} does not exist`);
      }
      this.#database.exec("COMMIT");
      return attempt;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async saveCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare(
          `
          SELECT sequence, checkpoint_json AS json
          FROM agent_runtime_checkpoints
          WHERE run_id = ? AND (sequence = ? OR checkpoint_id = ?)
          LIMIT 1
        `,
        )
        .get(checkpoint.runId, checkpoint.sequence, checkpoint.id) as
        SequenceRow | undefined;
      const encoded = serialize(checkpoint);
      if (existing) {
        if (
          existing.sequence === checkpoint.sequence &&
          existing.json === encoded
        ) {
          this.#database.exec("COMMIT");
          return;
        }
        throw new Error(
          `Checkpoint sequence or id conflicts for run ${checkpoint.runId}`,
        );
      }

      const runExists = this.#database
        .prepare(
          "SELECT record_json AS json FROM agent_runtime_runs WHERE run_id = ?",
        )
        .get(checkpoint.runId) as JsonRow | undefined;
      if (!runExists) throw new Error(`Run ${checkpoint.runId} does not exist`);
      const run = parse<RunRecord>(runExists.json);
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
      const latest = this.#database
        .prepare(
          `
          SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM agent_runtime_checkpoints
          WHERE run_id = ?
        `,
        )
        .get(checkpoint.runId) as unknown as SequenceRow;
      const expected = Number(latest.sequence) + 1;
      if (checkpoint.sequence !== expected) {
        throw new Error(
          `Checkpoint sequence ${checkpoint.sequence} is invalid for run ${checkpoint.runId}; expected ${expected}`,
        );
      }
      this.#database
        .prepare(
          `
          INSERT INTO agent_runtime_checkpoints
            (run_id, sequence, checkpoint_id, checkpoint_json)
          VALUES (?, ?, ?, ?)
        `,
        )
        .run(checkpoint.runId, checkpoint.sequence, checkpoint.id, encoded);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async suspendRun(
    runId: string,
    suspendedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(
          "SELECT record_json AS json FROM agent_runtime_runs WHERE run_id = ?",
        )
        .get(runId) as JsonRow | undefined;
      if (!row) throw new Error(`Run ${runId} does not exist`);
      const current = parse<RunRecord>(row.json);
      if (
        current.status === "suspended" &&
        (current.attempt ?? 1) === expectedAttempt
      ) {
        this.#database.exec("COMMIT");
        return;
      }
      if (current.status !== "created" && current.status !== "running") {
        throw new Error(`Cannot suspend ${current.status} run ${runId}`);
      }
      if ((current.attempt ?? 1) !== expectedAttempt) {
        throw new Error(`Run ${runId} is owned by another attempt`);
      }
      this.#database
        .prepare(
          "UPDATE agent_runtime_runs SET record_json = ? WHERE run_id = ?",
        )
        .run(
          serialize({
            ...current,
            status: "suspended",
            updatedAt: suspendedAt,
          }),
          runId,
        );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async completeRun(record: CompletedRunRecord): Promise<void> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(
          "SELECT record_json AS json FROM agent_runtime_runs WHERE run_id = ?",
        )
        .get(record.runId) as JsonRow | undefined;
      if (!row) throw new Error(`Run ${record.runId} does not exist`);
      const current = parse<RunRecord>(row.json);
      if (current.status === "completed") {
        if (serialize(current) === serialize(record)) {
          this.#database.exec("COMMIT");
          return;
        }
        throw new Error(`Run ${record.runId} has conflicting completed data`);
      }
      if (
        current.status !== "created" &&
        current.status !== "running" &&
        current.status !== "suspended"
      ) {
        throw new Error(
          `Cannot complete ${current.status} run ${record.runId}`,
        );
      }
      if ((record.attempt ?? 1) !== (current.attempt ?? 1)) {
        throw new Error(`Run ${record.runId} is owned by another attempt`);
      }
      this.#database
        .prepare(
          `
          UPDATE agent_runtime_runs
          SET record_json = ?, failure_json = NULL
          WHERE run_id = ?
        `,
        )
        .run(serialize(record), record.runId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async failRun(
    runId: string,
    error: RunError,
    failedAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(
          "SELECT record_json AS json FROM agent_runtime_runs WHERE run_id = ?",
        )
        .get(runId) as JsonRow | undefined;
      if (!row) throw new Error(`Run ${runId} does not exist`);
      const current = parse<RunRecord>(row.json);
      if (
        current.status !== "created" &&
        current.status !== "running" &&
        current.status !== "suspended"
      ) {
        throw new Error(`Cannot fail ${current.status} run ${runId}`);
      }
      if ((current.attempt ?? 1) !== expectedAttempt) {
        throw new Error(`Run ${runId} is owned by another attempt`);
      }
      const failedRecord: RunRecord = {
        ...current,
        status: "failed",
        updatedAt: failedAt,
      };
      this.#database
        .prepare(
          `
          UPDATE agent_runtime_runs
          SET record_json = ?, failure_json = ?
          WHERE run_id = ?
        `,
        )
        .run(serialize(failedRecord), serialize({ error, failedAt }), runId);
      this.#database.exec("COMMIT");
    } catch (caught) {
      this.#database.exec("ROLLBACK");
      throw caught;
    }
  }

  async cancelRun(
    runId: string,
    cancelledAt: string,
    expectedAttempt: number,
  ): Promise<void> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(
          "SELECT record_json AS json FROM agent_runtime_runs WHERE run_id = ?",
        )
        .get(runId) as JsonRow | undefined;
      if (!row) throw new Error(`Run ${runId} does not exist`);
      const current = parse<RunRecord>(row.json);
      if (current.status === "cancelled") {
        this.#database.exec("COMMIT");
        return;
      }
      if (
        current.status !== "created" &&
        current.status !== "running" &&
        current.status !== "suspended"
      ) {
        throw new Error(`Cannot cancel ${current.status} run ${runId}`);
      }
      if ((current.attempt ?? 1) !== expectedAttempt) {
        throw new Error(`Run ${runId} is owned by another attempt`);
      }
      const cancelledRecord: RunRecord = {
        ...current,
        status: "cancelled",
        updatedAt: cancelledAt,
      };
      this.#database
        .prepare(
          `
          UPDATE agent_runtime_runs
          SET record_json = ?, failure_json = NULL
          WHERE run_id = ?
        `,
        )
        .run(serialize(cancelledRecord), runId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}
