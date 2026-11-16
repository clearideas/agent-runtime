"""``MemoryRunStore`` and ``FileRunStore`` (``store-local``)."""

from __future__ import annotations

import asyncio
import copy
import os
from typing import Any

from ..._js import json as js_json
from ..._js import strings as js_strings
from ..._js.errors import Error
from .files import read_text_with_retry, safe_path_component, write_json_atomically

JsonObject = dict[str, Any]
RUN_FILE = "run.json"
CHECKPOINT_FILE = "checkpoint.json"
_ACTIVE = ("created", "running", "suspended")


def _check_checkpoint(run: JsonObject, checkpoint: JsonObject, current: JsonObject | None) -> bool:
    """Validates a checkpoint commit; returns False when it is an identical replay."""
    run_id = checkpoint["runId"]
    if run["status"] not in _ACTIVE:
        raise Error(f"Cannot checkpoint {run['status']} run {run_id}")
    if checkpoint.get("attempt", 1) != run.get("attempt", 1):
        raise Error(f"Run {run_id} is owned by another attempt")
    if current is not None:
        if current["sequence"] == checkpoint["sequence"]:
            if js_json.stringify(current) == js_json.stringify(checkpoint):
                return False
            raise Error(f"Checkpoint sequence or id conflicts for run {run_id}")
        if checkpoint["sequence"] != current["sequence"] + 1:
            raise Error(
                f"Checkpoint {checkpoint['sequence']} for run {run_id} does not follow committed sequence {current['sequence']}"
            )
    elif checkpoint["sequence"] != 1:
        raise Error(f"First checkpoint for run {run_id} must have sequence 1")
    return True


class MemoryRunStore:
    """In-process persistence for tests, embedded use, and short-lived local runs."""

    def __init__(self) -> None:
        self._runs: dict[str, JsonObject] = {}
        self._checkpoints: dict[str, JsonObject] = {}

    async def create_run(self, record: JsonObject) -> None:
        if record["runId"] in self._runs:
            raise Error(f"Run already exists: {record['runId']}")
        self._runs[record["runId"]] = copy.deepcopy(record)

    async def load_run(self, run_id: str) -> JsonObject | None:
        record = self._runs.get(run_id)
        return copy.deepcopy(record) if record is not None else None

    async def load_latest_checkpoint(self, run_id: str) -> JsonObject | None:
        checkpoint = self._checkpoints.get(run_id)
        return copy.deepcopy(checkpoint) if checkpoint is not None else None

    async def resume_run(self, run_id: str, resumed_at: str, options: JsonObject | None = None) -> int:
        existing = self._require(run_id)
        if existing["status"] in ("completed", "cancelled"):
            raise Error(f"Run {run_id} is already {existing['status']}")
        if existing["status"] == "running" and (options or {}).get("allowRunningTakeover") is not True:
            raise Error(f"Run {run_id} is still owned by a running attempt")
        attempt = existing.get("attempt", 1) + 1
        self._runs[run_id] = {
            **copy.deepcopy(existing),
            "status": "running",
            "attempt": attempt,
            "updatedAt": resumed_at,
        }
        return attempt

    async def save_checkpoint(self, checkpoint: JsonObject) -> None:
        run = self._require(checkpoint["runId"])
        if _check_checkpoint(run, checkpoint, self._checkpoints.get(checkpoint["runId"])):
            self._checkpoints[checkpoint["runId"]] = copy.deepcopy(checkpoint)

    async def suspend_run(self, run_id: str, suspended_at: str, expected_attempt: int) -> None:
        existing = self._require(run_id)
        if existing["status"] == "suspended" and existing.get("attempt", 1) == expected_attempt:
            return
        if existing["status"] not in ("created", "running"):
            raise Error(f"Cannot suspend {existing['status']} run {run_id}")
        if existing.get("attempt", 1) != expected_attempt:
            raise Error(f"Run {run_id} is owned by another attempt")
        self._runs[run_id] = {**copy.deepcopy(existing), "status": "suspended", "updatedAt": suspended_at}

    async def complete_run(self, record: JsonObject) -> None:
        existing = self._require(record["runId"])
        if existing["status"] == "completed":
            if js_json.stringify(existing) == js_json.stringify(record):
                return
            raise Error(f"Run {record['runId']} has conflicting completed data")
        if existing["status"] not in _ACTIVE:
            raise Error(f"Cannot complete {existing['status']} run {record['runId']}")
        if record.get("attempt", 1) != existing.get("attempt", 1):
            raise Error(f"Run {record['runId']} is owned by another attempt")
        self._runs[record["runId"]] = copy.deepcopy(record)

    async def fail_run(self, run_id: str, error: JsonObject, failed_at: str, expected_attempt: int) -> None:
        existing = self._require(run_id)
        if existing["status"] not in _ACTIVE:
            raise Error(f"Cannot fail {existing['status']} run {run_id}")
        if existing.get("attempt", 1) != expected_attempt:
            raise Error(f"Run {run_id} is owned by another attempt")
        self._runs[run_id] = {
            **existing,
            "status": "failed",
            "updatedAt": failed_at,
            "error": copy.deepcopy(error),
            "failedAt": failed_at,
        }

    async def interrupt_run(self, run_id: str, error: JsonObject, interrupted_at: str, expected_attempt: int) -> None:
        existing = self._require(run_id)
        if existing["status"] not in ("created", "running"):
            raise Error(f"Cannot interrupt {existing['status']} run {run_id}")
        if existing.get("attempt", 1) != expected_attempt:
            raise Error(f"Run {run_id} is owned by another attempt")
        self._runs[run_id] = {
            **existing,
            "status": "interrupted",
            "updatedAt": interrupted_at,
            "error": copy.deepcopy(error),
            "interruptedAt": interrupted_at,
        }

    async def cancel_run(self, run_id: str, cancelled_at: str, expected_attempt: int) -> None:
        existing = self._require(run_id)
        if existing["status"] == "cancelled":
            return
        if existing["status"] not in ("created", "running", "suspended", "interrupted"):
            raise Error(f"Cannot cancel {existing['status']} run {run_id}")
        if existing.get("attempt", 1) != expected_attempt:
            raise Error(f"Run {run_id} is owned by another attempt")
        self._runs[run_id] = {**existing, "status": "cancelled", "updatedAt": cancelled_at}

    async def delete_run(self, run_id: str) -> bool:
        existing = self._runs.get(run_id)
        if existing is None:
            return False
        if existing["status"] == "running":
            raise Error(f"Cannot delete running run {run_id}")
        del self._runs[run_id]
        self._checkpoints.pop(run_id, None)
        return True

    def _require(self, run_id: str) -> JsonObject:
        record = self._runs.get(run_id)
        if record is None:
            raise Error(f"Run not found: {run_id}")
        return record


class FileRunStore:
    """Durable zero-service persistence for one Agent Runtime process.

    Files are byte-identical to the TypeScript ``FileRunStore``, so a store
    directory can be shared by both runtimes (one process at a time).
    """

    def __init__(self, root_directory: str) -> None:
        if not js_strings.trim(root_directory):
            raise Error("FileRunStore requires a root directory.")
        self._root = os.path.abspath(root_directory)
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, run_id: str) -> asyncio.Lock:
        lock = self._locks.get(run_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[run_id] = lock
        return lock

    async def _read_json(self, path: str) -> JsonObject | None:
        try:
            return js_json.parse(await read_text_with_retry(path))
        except FileNotFoundError:
            return None

    async def create_run(self, record: JsonObject) -> None:
        async with self._lock(record["runId"]):
            path = self._run_file(record["runId"])
            if os.path.exists(path):
                raise Error(f"Run already exists: {record['runId']}")
            await write_json_atomically(path, record)

    async def load_run(self, run_id: str) -> JsonObject | None:
        return await self._read_json(self._run_file(run_id))

    async def load_latest_checkpoint(self, run_id: str) -> JsonObject | None:
        return await self._read_json(self._checkpoint_file(run_id))

    async def resume_run(self, run_id: str, resumed_at: str, options: JsonObject | None = None) -> int:
        async with self._lock(run_id):
            existing = await self._require(run_id)
            if existing["status"] in ("completed", "cancelled"):
                raise Error(f"Run {run_id} is already {existing['status']}")
            if existing["status"] == "running" and (options or {}).get("allowRunningTakeover") is not True:
                raise Error(f"Run {run_id} is still owned by a running attempt")
            attempt = existing.get("attempt", 1) + 1
            await write_json_atomically(
                self._run_file(run_id), {**existing, "status": "running", "attempt": attempt, "updatedAt": resumed_at}
            )
            return attempt

    async def save_checkpoint(self, checkpoint: JsonObject) -> None:
        async with self._lock(checkpoint["runId"]):
            run = await self._require(checkpoint["runId"])
            current = await self.load_latest_checkpoint(checkpoint["runId"])
            if _check_checkpoint(run, checkpoint, current):
                await write_json_atomically(self._checkpoint_file(checkpoint["runId"]), checkpoint)

    async def suspend_run(self, run_id: str, suspended_at: str, expected_attempt: int) -> None:
        async with self._lock(run_id):
            existing = await self._require(run_id)
            if existing["status"] == "suspended" and existing.get("attempt", 1) == expected_attempt:
                return
            if existing["status"] not in ("created", "running"):
                raise Error(f"Cannot suspend {existing['status']} run {run_id}")
            if existing.get("attempt", 1) != expected_attempt:
                raise Error(f"Run {run_id} is owned by another attempt")
            await write_json_atomically(
                self._run_file(run_id), {**existing, "status": "suspended", "updatedAt": suspended_at}
            )

    async def complete_run(self, record: JsonObject) -> None:
        async with self._lock(record["runId"]):
            existing = await self._require(record["runId"])
            if existing["status"] == "completed":
                if js_json.stringify(existing) == js_json.stringify(record):
                    return
                raise Error(f"Run {record['runId']} has conflicting completed data")
            if existing["status"] not in _ACTIVE:
                raise Error(f"Cannot complete {existing['status']} run {record['runId']}")
            if record.get("attempt", 1) != existing.get("attempt", 1):
                raise Error(f"Run {record['runId']} is owned by another attempt")
            await write_json_atomically(self._run_file(record["runId"]), record)

    async def fail_run(self, run_id: str, error: JsonObject, failed_at: str, expected_attempt: int) -> None:
        async with self._lock(run_id):
            existing = await self._require(run_id)
            if existing["status"] not in _ACTIVE:
                raise Error(f"Cannot fail {existing['status']} run {run_id}")
            if existing.get("attempt", 1) != expected_attempt:
                raise Error(f"Run {run_id} is owned by another attempt")
            await write_json_atomically(
                self._run_file(run_id),
                {**existing, "status": "failed", "updatedAt": failed_at, "error": error, "failedAt": failed_at},
            )

    async def interrupt_run(self, run_id: str, error: JsonObject, interrupted_at: str, expected_attempt: int) -> None:
        async with self._lock(run_id):
            existing = await self._require(run_id)
            if existing["status"] not in ("created", "running"):
                raise Error(f"Cannot interrupt {existing['status']} run {run_id}")
            if existing.get("attempt", 1) != expected_attempt:
                raise Error(f"Run {run_id} is owned by another attempt")
            await write_json_atomically(
                self._run_file(run_id),
                {
                    **existing,
                    "status": "interrupted",
                    "updatedAt": interrupted_at,
                    "error": error,
                    "interruptedAt": interrupted_at,
                },
            )

    async def cancel_run(self, run_id: str, cancelled_at: str, expected_attempt: int) -> None:
        async with self._lock(run_id):
            existing = await self._require(run_id)
            if existing["status"] == "cancelled":
                return
            if existing["status"] not in ("created", "running", "suspended", "interrupted"):
                raise Error(f"Cannot cancel {existing['status']} run {run_id}")
            if existing.get("attempt", 1) != expected_attempt:
                raise Error(f"Run {run_id} is owned by another attempt")
            await write_json_atomically(
                self._run_file(run_id), {**existing, "status": "cancelled", "updatedAt": cancelled_at}
            )

    async def _require(self, run_id: str) -> JsonObject:
        record = await self.load_run(run_id)
        if record is None:
            raise Error(f"Run not found: {run_id}")
        return record

    def _run_directory(self, run_id: str) -> str:
        return os.path.join(self._root, "runs", safe_path_component(run_id, "Run id"))

    def _run_file(self, run_id: str) -> str:
        return os.path.join(self._run_directory(run_id), RUN_FILE)

    def _checkpoint_file(self, run_id: str) -> str:
        return os.path.join(self._run_directory(run_id), CHECKPOINT_FILE)
