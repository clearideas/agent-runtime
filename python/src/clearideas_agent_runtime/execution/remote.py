"""Remote execution: a launcher plus a control plane (``packages/execution/src/remote.ts``)."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import uuid
from typing import Any

from .._js import json as js_json
from .._js import time as js_time
from .._js.abort import AbortSignal
from .._js.errors import Error, error_message
from ._records import ExecutionRecord
from .contracts import ExecutionEngineError, compare_event_cursors, event_cursor, is_terminal_execution_status
from .worker_protocol import create_worker_invocation

JsonObject = dict[str, Any]


class RemoteExecutionEngine:
    """Reserves in the control plane, launches with the compute launcher, and reads state back."""

    def __init__(self, launcher: Any, control_plane: Any) -> None:
        self._launcher = launcher
        self._control_plane = control_plane
        self.name = launcher.name
        self._observers: set[asyncio.Task[Any]] = set()

    async def submit(self, request: JsonObject) -> JsonObject:
        return await self._start("run", request)

    async def resume(self, request: JsonObject) -> JsonObject:
        return await self._start("resume", request)

    async def status(self, handle: JsonObject) -> JsonObject:
        return await self._control_plane.status(handle)

    def events(self, handle: JsonObject, after: JsonObject | None = None, signal: AbortSignal | None = None) -> Any:
        return self._control_plane.events(handle, after=after, signal=signal)

    async def result(self, handle: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        return await self._control_plane.result(handle, signal=signal)

    async def cancel(self, handle: JsonObject) -> None:
        canonical = (await self._control_plane.status(handle))["handle"]
        await self._launcher.cancel(canonical)
        await self._control_plane.cancel(canonical)
        status = await self._control_plane.status(canonical)
        if status["status"] != "cancelled" and not is_terminal_execution_status(status["status"]):
            raise Error(f"Remote execution {canonical['id']} did not enter a terminal state after cancel.")

    async def _start(self, mode: str, request: JsonObject) -> JsonObject:
        reservation = await self._control_plane.reserve({"engine": self.name, "mode": mode, "request": request})
        if not reservation["shouldLaunch"]:
            return reservation["handle"]
        try:
            provider_data = await self._launcher.launch(
                create_worker_invocation(request, mode), {"handle": reservation["handle"]}
            )
            handle = await self._control_plane.launched(reservation["handle"], provider_data)
            observe = getattr(self._launcher, "observe", None)
            if observe is not None:

                async def watch() -> None:
                    try:
                        await observe(handle)
                    except Exception as error:
                        await self._control_plane.launch_failed(
                            handle,
                            {"code": "REMOTE_OBSERVER_FAILED", "message": error_message(error), "retryable": True},
                        )

                task = asyncio.get_running_loop().create_task(watch())
                self._observers.add(task)
                task.add_done_callback(self._observers.discard)
            return handle
        except Exception as error:
            normalized = {"code": "REMOTE_LAUNCH_FAILED", "message": error_message(error), "retryable": True}
            await self._control_plane.launch_failed(reservation["handle"], normalized)
            raise ExecutionEngineError(normalized) from error


class InMemoryRemoteExecutionControlPlane:
    """A control plane (and worker reporter) held in memory, for tests and single-process hosts."""

    def __init__(self) -> None:
        self._records: dict[str, ExecutionRecord] = {}
        self._idempotency: dict[str, str] = {}

    async def reserve(self, input: JsonObject) -> JsonObject:
        digest = hashlib.sha256(js_json.stringify(input).encode("utf-8")).hexdigest()
        key = input["request"].get("idempotencyKey")
        if key and key in self._idempotency:
            existing = self._records[self._idempotency[key]]
            if existing.digest != digest:
                raise Error("Conflicting remote idempotency key reuse.")
            return {"handle": copy.deepcopy(existing.handle), "shouldLaunch": False}
        now = js_time.to_iso(js_time.now())
        handle = {
            "id": f"remote_{uuid.uuid4()}",
            "engine": input["engine"],
            "runId": input["request"].get("runId") or f"run_{uuid.uuid4()}",
            "submittedAt": now,
        }
        attempt = input["request"]["attempt"] if input["mode"] == "resume" else 1
        self._records[handle["id"]] = ExecutionRecord(handle, digest, attempt, now)
        if key:
            self._idempotency[key] = handle["id"]
        return {"handle": copy.deepcopy(handle), "shouldLaunch": True}

    async def launched(self, handle: JsonObject, provider_data: JsonObject) -> JsonObject:
        record = self._record(handle)
        record.handle = {**record.handle, "providerData": copy.deepcopy(provider_data)}
        record.status = "running"
        self._touch(record)
        return copy.deepcopy(record.handle)

    async def launch_failed(self, handle: JsonObject, error: JsonObject) -> None:
        record = self._record(handle)
        if is_terminal_execution_status(record.status):
            return
        record.status = "failed"
        record.error = copy.deepcopy(error)
        self._touch(record)

    async def status(self, handle: JsonObject) -> JsonObject:
        return self._record(handle).status_view()

    async def events(
        self, handle: JsonObject, after: JsonObject | None = None, signal: AbortSignal | None = None
    ) -> Any:
        async for event in self._record(handle).stream(after, signal):  # pyright: ignore[reportGeneralTypeIssues]
            yield event

    async def result(self, handle: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        record = self._record(handle)
        while not is_terminal_execution_status(record.status):
            async for _ in self.events(handle, signal=signal):  # pyright: ignore[reportGeneralTypeIssues]
                pass
        if record.result is not None:
            return copy.deepcopy(record.result)
        raise ExecutionEngineError(
            record.error
            or {
                "code": "EXECUTION_CANCELLED" if record.status == "cancelled" else "REMOTE_EXECUTION_FAILED",
                "message": f"Remote execution ended as {record.status}.",
                "retryable": False,
            }
        )

    async def cancel(self, handle: JsonObject) -> None:
        record = self._record(handle)
        if is_terminal_execution_status(record.status):
            return
        record.status = "cancelled"
        record.error = {
            "code": "EXECUTION_CANCELLED",
            "message": "Remote execution cancelled by client.",
            "retryable": False,
        }
        self._touch(record)

    async def accept_event(self, handle: JsonObject, event: JsonObject) -> None:
        record = self._record(handle)
        if is_terminal_execution_status(record.status):
            raise Error("Cannot append to a terminal run.")
        if event["runId"] != record.handle["runId"]:
            raise Error("Remote event runId mismatch.")
        if event_cursor(event)["attempt"] != record.attempt:
            raise Error("Remote event attempt mismatch.")
        if record.events and compare_event_cursors(event_cursor(event), event_cursor(record.events[-1])) <= 0:
            raise Error("Remote event cursor is stale.")
        record.events.append(copy.deepcopy(event))
        self._touch(record)

    async def complete(self, handle: JsonObject, result: JsonObject) -> None:
        record = self._record(handle)
        if is_terminal_execution_status(record.status):
            return
        if result["runId"] != record.handle["runId"]:
            raise Error("Remote result runId mismatch.")
        record.result = copy.deepcopy(result)
        record.status = "completed"
        self._touch(record)

    async def fail(self, handle: JsonObject, error: JsonObject) -> None:
        record = self._record(handle)
        if is_terminal_execution_status(record.status):
            return
        record.error = copy.deepcopy(error)
        record.status = "failed"
        self._touch(record)

    def _record(self, handle: JsonObject) -> ExecutionRecord:
        record = self._records.get(handle.get("id"))  # type: ignore[arg-type]
        if (
            record is None
            or record.handle["runId"] != handle.get("runId")
            or record.handle["engine"] != handle.get("engine")
        ):
            raise Error(f"Unknown remote execution handle {handle.get('id')}.")
        return record

    def _touch(self, record: ExecutionRecord) -> None:
        record.updated_at = js_time.to_iso(js_time.now())
        if is_terminal_execution_status(record.status):
            record.done.set()
        record.touch()
