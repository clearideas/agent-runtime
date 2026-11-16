"""``SqliteRunStore`` (``@clearideas/agent-runtime-store-sqlite``).

Same schema and JSON encoding as the TypeScript store, so one database file
can be shared by both runtimes.
"""

from __future__ import annotations

import os
import sqlite3
from collections.abc import Callable
from typing import Any, TypeVar

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.errors import Error

JsonObject = dict[str, Any]
T = TypeVar("T")

_SCHEMA = """
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
"""

_serialize = js_json.stringify


def _summarize_checkpoint(checkpoint: JsonObject) -> JsonObject:
    from ..core.ports import summarize_checkpoint

    return summarize_checkpoint(checkpoint)


class SqliteRunStore:
    """Durable single-file RunStore; every method runs synchronously inside the async port."""

    def __init__(self, filename: str) -> None:
        if not js_strings.trim(filename):
            raise Error("SqliteRunStore requires a filename.")
        if filename != ":memory:":
            resolved = os.path.abspath(filename)
            os.makedirs(os.path.dirname(resolved), exist_ok=True)
            self._db = sqlite3.connect(resolved, isolation_level=None, check_same_thread=False)
            os.chmod(resolved, 0o600)
        else:
            self._db = sqlite3.connect(filename, isolation_level=None, check_same_thread=False)
        self._db.executescript(_SCHEMA)
        if filename != ":memory:":
            self._db.execute("PRAGMA journal_mode = WAL;")

    def _transaction(self, operation: Callable[[], T]) -> T:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            result = operation()
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        self._db.execute("COMMIT")
        return result

    def _record(self, run_id: str) -> JsonObject | None:
        row = self._db.execute("SELECT record_json FROM agent_runtime_runs WHERE run_id = ?", (run_id,)).fetchone()
        return js_json.parse(row[0]) if row else None

    def _require(self, run_id: str) -> JsonObject:
        record = self._record(run_id)
        if record is None:
            raise Error(f"Run {run_id} does not exist")
        return record

    async def create_run(self, record: JsonObject) -> None:
        try:
            self._db.execute(
                "INSERT INTO agent_runtime_runs (run_id, record_json) VALUES (?, ?)",
                (record["runId"], _serialize(record)),
            )
        except sqlite3.IntegrityError as error:
            if "UNIQUE constraint failed" in str(error):
                raise Error(f"Run {record['runId']} already exists", cause=error) from error
            raise

    async def load_run(self, run_id: str) -> JsonObject | None:
        return self._record(run_id)

    async def load_latest_checkpoint(self, run_id: str) -> JsonObject | None:
        row = self._db.execute(
            "SELECT checkpoint_json FROM agent_runtime_checkpoints WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        return js_json.parse(row[0]) if row else None

    async def list_checkpoints(self, run_id: str, options: JsonObject | None = None) -> list[JsonObject]:
        rows = self._db.execute(
            "SELECT checkpoint_json FROM agent_runtime_checkpoints WHERE run_id = ? ORDER BY sequence",
            (run_id,),
        ).fetchall()
        checkpoints = [js_json.parse(row[0]) for row in rows]
        if (options or {}).get("boundaries"):
            checkpoints = [checkpoint for checkpoint in checkpoints if checkpoint.get("boundary")]
        return [_summarize_checkpoint(checkpoint) for checkpoint in checkpoints]

    async def load_checkpoint(self, run_id: str, sequence: int) -> JsonObject | None:
        if not isinstance(sequence, int) or sequence < 1:
            return None
        row = self._db.execute(
            "SELECT checkpoint_json FROM agent_runtime_checkpoints WHERE run_id = ? AND sequence = ?",
            (run_id, sequence),
        ).fetchone()
        return js_json.parse(row[0]) if row else None

    async def resume_run(self, run_id: str, resumed_at: str, options: JsonObject | None = None) -> int:
        def operation() -> int:
            current = self._require(run_id)
            if current["status"] in ("completed", "cancelled"):
                raise Error(f"Run {run_id} is already {current['status']}")
            if current["status"] == "running" and (options or {}).get("allowRunningTakeover") is not True:
                raise Error(f"Run {run_id} is still owned by a running attempt")
            attempt = current.get("attempt", 1) + 1
            resumed = {
                **current,
                "status": "running",
                "attempt": attempt,
                "updatedAt": resumed_at,
                **({"manifest": options["manifest"]} if options and options.get("manifest") else {}),
            }
            cursor = self._db.execute(
                "UPDATE agent_runtime_runs SET record_json = ?, failure_json = NULL WHERE run_id = ?",
                (_serialize(resumed), run_id),
            )
            if cursor.rowcount != 1:
                raise Error(f"Run {run_id} does not exist")
            return attempt

        return self._transaction(operation)

    async def save_checkpoint(self, checkpoint: JsonObject) -> None:
        def operation() -> None:
            run_id = checkpoint["runId"]
            existing = self._db.execute(
                "SELECT sequence, checkpoint_json FROM agent_runtime_checkpoints WHERE run_id = ? AND (sequence = ? OR checkpoint_id = ?) LIMIT 1",
                (run_id, checkpoint["sequence"], checkpoint["id"]),
            ).fetchone()
            encoded = _serialize(checkpoint)
            if existing:
                if existing[0] == checkpoint["sequence"] and existing[1] == encoded:
                    return
                raise Error(f"Checkpoint sequence or id conflicts for run {run_id}")
            run = self._require(run_id)
            if run["status"] not in ("created", "running", "suspended"):
                raise Error(f"Cannot checkpoint {run['status']} run {run_id}")
            if checkpoint.get("attempt", 1) != run.get("attempt", 1):
                raise Error(f"Run {run_id} is owned by another attempt")
            latest = self._db.execute(
                "SELECT COALESCE(MAX(sequence), 0) FROM agent_runtime_checkpoints WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            expected = int(latest) + 1
            if checkpoint["sequence"] != expected:
                raise Error(
                    f"Checkpoint sequence {checkpoint['sequence']} is invalid for run {run_id}; expected {expected}"
                )
            self._db.execute(
                "INSERT INTO agent_runtime_checkpoints (run_id, sequence, checkpoint_id, checkpoint_json) VALUES (?, ?, ?, ?)",
                (run_id, checkpoint["sequence"], checkpoint["id"], encoded),
            )

        self._transaction(operation)

    async def suspend_run(self, run_id: str, suspended_at: str, expected_attempt: int) -> None:
        def operation() -> None:
            current = self._require(run_id)
            if current["status"] == "suspended" and current.get("attempt", 1) == expected_attempt:
                return
            if current["status"] not in ("created", "running"):
                raise Error(f"Cannot suspend {current['status']} run {run_id}")
            if current.get("attempt", 1) != expected_attempt:
                raise Error(f"Run {run_id} is owned by another attempt")
            self._db.execute(
                "UPDATE agent_runtime_runs SET record_json = ? WHERE run_id = ?",
                (_serialize({**current, "status": "suspended", "updatedAt": suspended_at}), run_id),
            )

        self._transaction(operation)

    async def complete_run(self, record: JsonObject) -> None:
        def operation() -> None:
            current = self._require(record["runId"])
            if current["status"] == "completed":
                if _serialize(current) == _serialize(record):
                    return
                raise Error(f"Run {record['runId']} has conflicting completed data")
            if current["status"] not in ("created", "running", "suspended"):
                raise Error(f"Cannot complete {current['status']} run {record['runId']}")
            if record.get("attempt", 1) != current.get("attempt", 1):
                raise Error(f"Run {record['runId']} is owned by another attempt")
            self._db.execute(
                "UPDATE agent_runtime_runs SET record_json = ?, failure_json = NULL WHERE run_id = ?",
                (_serialize(record), record["runId"]),
            )

        self._transaction(operation)

    async def fail_run(self, run_id: str, error: JsonObject, failed_at: str, expected_attempt: int) -> None:
        def operation() -> None:
            current = self._require(run_id)
            if current["status"] not in ("created", "running", "suspended"):
                raise Error(f"Cannot fail {current['status']} run {run_id}")
            if current.get("attempt", 1) != expected_attempt:
                raise Error(f"Run {run_id} is owned by another attempt")
            failed = {**current, "status": "failed", "updatedAt": failed_at}
            self._db.execute(
                "UPDATE agent_runtime_runs SET record_json = ?, failure_json = ? WHERE run_id = ?",
                (_serialize(failed), _serialize({"error": error, "failedAt": failed_at}), run_id),
            )

        self._transaction(operation)

    async def interrupt_run(self, run_id: str, error: JsonObject, interrupted_at: str, expected_attempt: int) -> None:
        def operation() -> None:
            current = self._require(run_id)
            if current["status"] not in ("created", "running"):
                raise Error(f"Cannot interrupt {current['status']} run {run_id}")
            if current.get("attempt", 1) != expected_attempt:
                raise Error(f"Run {run_id} is owned by another attempt")
            interrupted = {**current, "status": "interrupted", "updatedAt": interrupted_at}
            self._db.execute(
                "UPDATE agent_runtime_runs SET record_json = ?, failure_json = ? WHERE run_id = ?",
                (_serialize(interrupted), _serialize({"error": error, "interruptedAt": interrupted_at}), run_id),
            )

        self._transaction(operation)

    async def cancel_run(self, run_id: str, cancelled_at: str, expected_attempt: int) -> None:
        def operation() -> None:
            current = self._require(run_id)
            if current["status"] == "cancelled":
                return
            if current["status"] not in ("created", "running", "suspended", "interrupted"):
                raise Error(f"Cannot cancel {current['status']} run {run_id}")
            if current.get("attempt", 1) != expected_attempt:
                raise Error(f"Run {run_id} is owned by another attempt")
            self._db.execute(
                "UPDATE agent_runtime_runs SET record_json = ?, failure_json = NULL WHERE run_id = ?",
                (_serialize({**current, "status": "cancelled", "updatedAt": cancelled_at}), run_id),
            )

        self._transaction(operation)

    async def delete_run(self, run_id: str) -> bool:
        def operation() -> bool:
            current = self._record(run_id)
            if current is None:
                return False
            if current["status"] == "running":
                raise Error(f"Cannot delete running run {run_id}")
            self._db.execute("DELETE FROM agent_runtime_runs WHERE run_id = ?", (run_id,))
            return True

        return self._transaction(operation)

    def failure(self, run_id: str) -> JsonObject | None:
        row = self._db.execute("SELECT failure_json FROM agent_runtime_runs WHERE run_id = ?", (run_id,)).fetchone()
        return js_json.parse(row[0]) if row and row[0] else None

    def close(self) -> None:
        self._db.close()
