"""An execution engine that runs a handler in this process (``packages/execution/src/in-process.ts``)."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .._js import json as js_json
from .._js import time as js_time
from .._js.abort import AbortController, AbortSignal, abort_reason_error
from .._js.errors import Error, error_message, error_name
from ._records import ExecutionRecord
from .contracts import ExecutionEngineError, compare_event_cursors, event_cursor, is_terminal_execution_status

JsonObject = dict[str, Any]


@dataclass
class ExecutionHandlerContext:
    handle: JsonObject
    mode: str
    attempt: int
    signal: AbortSignal
    emit: Callable[[JsonObject], Awaitable[None]]
    checkpoint: JsonObject | None = None
    checkpoint_reference: str | None = None


ExecutionHandler = Callable[[JsonObject, ExecutionHandlerContext], Awaitable[JsonObject]]


def normalize_error(error: BaseException) -> JsonObject:
    if isinstance(error, ExecutionEngineError):
        normalized: JsonObject = {"code": error.code, "message": error.message, "retryable": error.retryable}
        if error.details:
            normalized["details"] = error.details
        return normalized
    name = error_name(error)
    normalized = {
        "code": "EXECUTION_CANCELLED" if name == "AbortError" else "EXECUTION_FAILED",
        "message": error_message(error),
        "retryable": False,
    }
    if name != "Error":
        normalized["details"] = {"name": name}
    return normalized


def request_digest(request: JsonObject) -> str:
    return hashlib.sha256(
        js_json.stringify({key: value for key, value in request.items() if key != "signal"}).encode("utf-8")
    ).hexdigest()


class InProcessExecutionEngine:
    def __init__(
        self,
        handler: ExecutionHandler,
        *,
        name: str | None = None,
        now: Callable[[], datetime] | None = None,
        generate_id: Callable[[], str] | None = None,
    ) -> None:
        self.name = name or "in-process"
        self._handler = handler
        self._now = now or js_time.now
        self._generate_id = generate_id or (lambda: f"execution_{uuid.uuid4()}")
        self._records: dict[str, ExecutionRecord] = {}
        self._controllers: dict[str, AbortController] = {}
        self._idempotency: dict[str, str] = {}
        self._tasks: set[asyncio.Task[Any]] = set()

    async def submit(self, request: JsonObject) -> JsonObject:
        return self._start(request, "run", 1)

    async def resume(self, request: JsonObject) -> JsonObject:
        attempt = request.get("attempt")
        if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 2:
            raise Error("Resume attempt must be an integer greater than one.")
        if not request.get("checkpoint") and not request.get("checkpointReference"):
            raise Error("Resume requires a checkpoint or checkpointReference.")
        return self._start(request, "resume", attempt)

    async def status(self, handle: JsonObject) -> JsonObject:
        return self._record(handle).status_view()

    async def events(
        self, handle: JsonObject, after: JsonObject | None = None, signal: AbortSignal | None = None
    ) -> Any:
        async for event in self._record(handle).stream(after, signal):  # pyright: ignore[reportGeneralTypeIssues]
            yield event

    async def result(self, handle: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        record = self._record(handle)
        if record.result is not None:
            return copy.deepcopy(record.result)
        if record.error is not None:
            raise ExecutionEngineError(record.error)
        waiters = [asyncio.ensure_future(record.done.wait())]
        if signal is not None:
            if signal.aborted:
                raise abort_reason_error(signal)
            waiters.append(asyncio.ensure_future(signal.wait()))  # pyright: ignore[reportArgumentType]
        try:
            await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for waiter in waiters:
                waiter.cancel()
        if record.result is not None:
            return copy.deepcopy(record.result)
        if record.error is not None:
            raise ExecutionEngineError(record.error)
        raise abort_reason_error(signal)  # type: ignore[arg-type]

    async def cancel(self, handle: JsonObject) -> None:
        record = self._record(handle)
        if is_terminal_execution_status(record.status):
            return
        self._controllers[record.handle["id"]].abort(Error("Execution cancelled by client."))
        self._finish(
            record,
            "cancelled",
            error={"code": "EXECUTION_CANCELLED", "message": "Execution cancelled by client.", "retryable": False},
        )

    def _start(self, request: JsonObject, mode: str, attempt: int) -> JsonObject:
        digest = request_digest(request)
        key = request.get("idempotencyKey")
        if key and key in self._idempotency:
            existing = self._records[self._idempotency[key]]
            if existing.digest != digest:
                raise Error(f"Idempotency key {key} was reused with another request.")
            return copy.deepcopy(existing.handle)
        submitted_at = js_time.to_iso(self._now())
        handle = {
            "id": self._generate_id(),
            "engine": self.name,
            "runId": request.get("runId") or f"run_{uuid.uuid4()}",
            "submittedAt": submitted_at,
        }
        record = ExecutionRecord(handle, digest, attempt, submitted_at)
        self._records[handle["id"]] = record
        self._controllers[handle["id"]] = AbortController()
        if key:
            self._idempotency[key] = handle["id"]
        task = asyncio.get_running_loop().create_task(self._execute(record, copy.deepcopy(request), mode))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return copy.deepcopy(handle)

    async def _execute(self, record: ExecutionRecord, request: JsonObject, mode: str) -> None:
        if record.status == "cancelled":
            return
        controller = self._controllers[record.handle["id"]]
        record.status = "running"
        record.updated_at = js_time.to_iso(self._now())
        record.touch()
        timer = None
        timeout_ms = request.get("timeoutMs")
        if timeout_ms is not None:

            def expire() -> None:
                error = ExecutionEngineError(
                    {
                        "code": "EXECUTION_TIMEOUT",
                        "message": f"Execution timed out after {timeout_ms}ms.",
                        "retryable": True,
                        "details": {"timeoutMs": timeout_ms},
                    }
                )
                error.interruption = "execution-timeout"  # type: ignore[attr-defined]
                controller.abort(error)

            timer = asyncio.get_running_loop().call_later(timeout_ms / 1000, expire)

        async def emit(event: JsonObject) -> None:
            if is_terminal_execution_status(record.status):
                return
            if event["runId"] != record.handle["runId"]:
                raise Error(f"Event runId {event['runId']} does not match {record.handle['runId']}.")
            if event_cursor(event)["attempt"] != record.attempt:
                raise Error(
                    f"Event attempt {event_cursor(event)['attempt']} does not match execution attempt {record.attempt}."
                )
            if record.events and compare_event_cursors(event_cursor(event), event_cursor(record.events[-1])) <= 0:
                raise Error("Execution events must have strictly increasing cursors.")
            record.events.append(copy.deepcopy(event))
            record.updated_at = js_time.to_iso(self._now())
            record.touch()

        try:
            result = await self._handler(
                request,
                ExecutionHandlerContext(
                    handle=copy.deepcopy(record.handle),
                    mode=mode,
                    attempt=record.attempt,
                    signal=controller.signal,
                    emit=emit,
                    checkpoint=copy.deepcopy(request["checkpoint"]) if request.get("checkpoint") else None,
                    checkpoint_reference=request.get("checkpointReference") or None,
                ),
            )
            if is_terminal_execution_status(record.status):
                return
            if result["runId"] != record.handle["runId"]:
                raise Error(f"Result runId {result['runId']} does not match {record.handle['runId']}.")
            self._finish(record, "completed", result=result)
        except Exception as error:
            if not is_terminal_execution_status(record.status):
                self._finish(record, "failed", error=normalize_error(error))
        finally:
            if timer is not None:
                timer.cancel()

    def _finish(
        self, record: ExecutionRecord, status: str, *, result: JsonObject | None = None, error: JsonObject | None = None
    ) -> None:
        if is_terminal_execution_status(record.status):
            return
        record.status = status
        record.updated_at = js_time.to_iso(self._now())
        if result is not None:
            record.result = copy.deepcopy(result)
        else:
            record.error = copy.deepcopy(
                error or {"code": "EXECUTION_FAILED", "message": f"Execution ended as {status}.", "retryable": False}
            )
        record.done.set()
        record.touch()

    def _record(self, handle: JsonObject) -> ExecutionRecord:
        if handle.get("engine") != self.name:
            raise Error(f"Execution handle belongs to engine {handle.get('engine')}, not {self.name}.")
        record = self._records.get(handle.get("id"))  # type: ignore[arg-type]
        if record is None or record.handle["runId"] != handle.get("runId"):
            raise Error(f"Unknown execution handle {handle.get('id')}.")
        return record
