"""Deterministic test doubles (``packages/core/src/testing/index.ts``)."""

from __future__ import annotations

import copy
from typing import Any

from .._js.errors import Error

JsonObject = dict[str, Any]


class SequenceIdGenerator:
    def __init__(self) -> None:
        self._next = 0

    def generate_id(self, prefix: str) -> str:
        self._next += 1
        return f"{prefix}_{self._next}"


class CollectingEventSink:
    def __init__(self) -> None:
        self.events: list[JsonObject] = []

    def emit(self, event: JsonObject) -> None:
        self.events.append(copy.deepcopy(event))


class MemoryRunStore:
    """In-memory ``RunStore`` with attempt ownership checks."""

    def __init__(self) -> None:
        self.runs: dict[str, JsonObject] = {}
        self.checkpoints: dict[str, list[JsonObject]] = {}
        self.completed: dict[str, JsonObject] = {}
        self.failures: dict[str, JsonObject] = {}

    async def create_run(self, record: JsonObject) -> None:
        if record["runId"] in self.runs:
            raise Error(f"Run {record['runId']} already exists")
        self.runs[record["runId"]] = copy.deepcopy(record)

    async def load_run(self, run_id: str) -> JsonObject | None:
        record = self.runs.get(run_id)
        return copy.deepcopy(record) if record else None

    async def load_latest_checkpoint(self, run_id: str) -> JsonObject | None:
        checkpoints = self.checkpoints.get(run_id)
        return copy.deepcopy(checkpoints[-1]) if checkpoints else None

    async def resume_run(self, run_id: str, resumed_at: str, options: JsonObject | None = None) -> int:
        record = self.runs.get(run_id)
        if not record:
            raise Error(f"Run {run_id} does not exist")
        if record["status"] in ("completed", "cancelled"):
            raise Error(f"Run {run_id} is already {record['status']}")
        if record["status"] == "running" and not (options or {}).get("allowRunningTakeover"):
            raise Error(f"Run {run_id} is still owned by a running attempt")
        attempt = (record.get("attempt") or 1) + 1
        self.runs[run_id] = {**copy.deepcopy(record), "status": "running", "attempt": attempt, "updatedAt": resumed_at}
        self.failures.pop(run_id, None)
        return attempt

    async def save_checkpoint(self, checkpoint: JsonObject) -> None:
        record = self.runs.get(checkpoint["runId"])
        if not record:
            raise Error(f"Run {checkpoint['runId']} does not exist")
        if checkpoint.get("attempt", 1) != record.get("attempt", 1):
            raise Error(f"Run {checkpoint['runId']} is owned by another attempt")
        self.checkpoints.setdefault(checkpoint["runId"], []).append(copy.deepcopy(checkpoint))

    async def suspend_run(self, run_id: str, suspended_at: str, expected_attempt: int) -> None:
        record = self.runs.get(run_id)
        if not record:
            raise Error(f"Run {run_id} does not exist")
        if record.get("attempt", 1) != expected_attempt:
            raise Error(f"Run {run_id} is owned by another attempt")
        if record["status"] not in ("created", "running"):
            if record["status"] == "suspended":
                return
            raise Error(f"Cannot suspend {record['status']} run {run_id}")
        self.runs[run_id] = {**copy.deepcopy(record), "status": "suspended", "updatedAt": suspended_at}

    async def complete_run(self, record: JsonObject) -> None:
        current = self.runs.get(record["runId"])
        if not current:
            raise Error(f"Run {record['runId']} does not exist")
        if record.get("attempt", 1) != current.get("attempt", 1):
            raise Error(f"Run {record['runId']} is owned by another attempt")
        self.completed[record["runId"]] = copy.deepcopy(record)
        self.runs[record["runId"]] = copy.deepcopy(record)

    async def fail_run(self, run_id: str, error: JsonObject, failed_at: str, expected_attempt: int) -> None:
        record = self.runs.get(run_id)
        if not record:
            raise Error(f"Run {run_id} does not exist")
        if record.get("attempt", 1) != expected_attempt:
            raise Error(f"Run {run_id} is owned by another attempt")
        self.failures[run_id] = {"error": copy.deepcopy(error), "failedAt": failed_at}
        self.runs[run_id] = {**record, "status": "failed", "updatedAt": failed_at}

    async def cancel_run(self, run_id: str, cancelled_at: str, expected_attempt: int) -> None:
        record = self.runs.get(run_id)
        if not record:
            raise Error(f"Run {run_id} does not exist")
        if record.get("attempt", 1) != expected_attempt:
            raise Error(f"Run {run_id} is owned by another attempt")
        if record["status"] == "completed":
            raise Error(f"Run {run_id} is already completed")
        self.runs[run_id] = {**copy.deepcopy(record), "status": "cancelled", "updatedAt": cancelled_at}
        self.failures.pop(run_id, None)
