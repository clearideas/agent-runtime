"""``MemoryRunStore`` and ``FileRunStore`` (``store-local``)."""

from __future__ import annotations

import asyncio
import copy
import os
import re
from typing import Any

from ..._js import json as js_json
from ..._js import strings as js_strings
from ..._js.errors import Error
from ...core.ports import summarize_checkpoint
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

    def __init__(self, max_nested_restart_points: int = 10) -> None:
        self._runs: dict[str, JsonObject] = {}
        self._checkpoints: dict[str, JsonObject] = {}
        self._boundaries: dict[str, dict[int, JsonObject]] = {}
        self._max_nested = max_nested_restart_points

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

    async def list_checkpoints(self, run_id: str, options: JsonObject | None = None) -> list[JsonObject]:
        retained = dict(self._boundaries.get(run_id) or {})
        latest = self._checkpoints.get(run_id)
        if latest and (not (options or {}).get("boundaries") or latest.get("boundary")):
            retained[latest["sequence"]] = latest
        return [summarize_checkpoint(retained[sequence]) for sequence in sorted(retained)]

    async def load_checkpoint(self, run_id: str, sequence: int) -> JsonObject | None:
        latest = self._checkpoints.get(run_id)
        checkpoint = (
            latest if latest and latest["sequence"] == sequence else self._boundaries.get(run_id, {}).get(sequence)
        )
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
            **({"manifest": copy.deepcopy(options["manifest"])} if options and options.get("manifest") else {}),
        }
        return attempt

    async def save_checkpoint(self, checkpoint: JsonObject) -> None:
        run = self._require(checkpoint["runId"])
        if _check_checkpoint(run, checkpoint, self._checkpoints.get(checkpoint["runId"])):
            self._checkpoints[checkpoint["runId"]] = copy.deepcopy(checkpoint)
            if checkpoint.get("boundary"):
                boundaries = self._boundaries.setdefault(checkpoint["runId"], {})
                boundaries[checkpoint["sequence"]] = copy.deepcopy(checkpoint)
                nested = sorted(
                    (sequence for sequence, value in boundaries.items() if "/" in value["boundary"]["stepPath"]),
                    reverse=True,
                )
                for sequence in nested[self._max_nested :]:
                    del boundaries[sequence]

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
        self._boundaries.pop(run_id, None)
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

    def __init__(self, root_directory: str, max_nested_restart_points: int = 10) -> None:
        if not js_strings.trim(root_directory):
            raise Error("FileRunStore requires a root directory.")
        self._root = os.path.abspath(root_directory)
        self._locks: dict[str, asyncio.Lock] = {}
        self._max_nested = max_nested_restart_points

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

    def _boundary_files(self, run_id: str) -> list[tuple[int, bool, str]]:
        directory = os.path.join(self._run_directory(run_id), "checkpoints")
        try:
            names = os.listdir(directory)
        except FileNotFoundError:
            return []
        entries: list[tuple[int, bool, str]] = []
        for name in names:
            match = re.fullmatch(r"(\d{12})(\.nested)?\.json", name)
            if match:
                entries.append((int(match.group(1)), bool(match.group(2)), os.path.join(directory, name)))
        return entries

    async def list_checkpoints(self, run_id: str, options: JsonObject | None = None) -> list[JsonObject]:
        retained: dict[int, JsonObject] = {}
        for sequence, _, path in self._boundary_files(run_id):
            checkpoint = await self._read_json(path)
            if checkpoint is not None:
                retained[sequence] = checkpoint
        latest = await self.load_latest_checkpoint(run_id)
        if latest and (not (options or {}).get("boundaries") or latest.get("boundary")):
            retained[latest["sequence"]] = latest
        return [summarize_checkpoint(retained[sequence]) for sequence in sorted(retained)]

    async def load_checkpoint(self, run_id: str, sequence: int) -> JsonObject | None:
        latest = await self.load_latest_checkpoint(run_id)
        if latest and latest["sequence"] == sequence:
            return latest
        if not isinstance(sequence, int) or sequence < 1:
            return None
        for candidate, _, path in self._boundary_files(run_id):
            if candidate == sequence:
                return await self._read_json(path)
        return None

    async def resume_run(self, run_id: str, resumed_at: str, options: JsonObject | None = None) -> int:
        async with self._lock(run_id):
            existing = await self._require(run_id)
            if existing["status"] in ("completed", "cancelled"):
                raise Error(f"Run {run_id} is already {existing['status']}")
            if existing["status"] == "running" and (options or {}).get("allowRunningTakeover") is not True:
                raise Error(f"Run {run_id} is still owned by a running attempt")
            attempt = existing.get("attempt", 1) + 1
            await write_json_atomically(
                self._run_file(run_id),
                {
                    **existing,
                    "status": "running",
                    "attempt": attempt,
                    "updatedAt": resumed_at,
                    **({"manifest": options["manifest"]} if options and options.get("manifest") else {}),
                },
            )
            return attempt

    async def save_checkpoint(self, checkpoint: JsonObject) -> None:
        async with self._lock(checkpoint["runId"]):
            run = await self._require(checkpoint["runId"])
            current = await self.load_latest_checkpoint(checkpoint["runId"])
            if _check_checkpoint(run, checkpoint, current):
                if checkpoint.get("boundary"):
                    nested = "/" in checkpoint["boundary"]["stepPath"]
                    name = f"{checkpoint['sequence']:012d}{'.nested' if nested else ''}.json"
                    boundary_file = os.path.join(self._run_directory(checkpoint["runId"]), "checkpoints", name)
                    await write_json_atomically(boundary_file, checkpoint)
                    if nested:
                        stale = sorted(
                            (entry for entry in self._boundary_files(checkpoint["runId"]) if entry[1]), reverse=True
                        )
                        for _, _, path in stale[self._max_nested :]:
                            try:
                                os.unlink(path)
                            except FileNotFoundError:
                                pass
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
