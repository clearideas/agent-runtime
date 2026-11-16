"""Execution-engine contracts (``packages/execution/src/contracts.ts``).

Requests, handles, statuses, and events are JSON dictionaries with the
TypeScript keys. ``ExecutionEngine`` methods: ``submit``, ``resume``,
``status``, ``events(handle, after=, signal=)`` (async iterator), ``result``,
``cancel``.
"""

from __future__ import annotations

from typing import Any, Protocol

from .._js.errors import Error

JsonObject = dict[str, Any]

EXECUTION_PROTOCOL_VERSION = "1.0"
TERMINAL_EXECUTION_STATUSES = ("completed", "failed", "cancelled")


class ExecutionEngine(Protocol):
    name: str

    async def submit(self, request: JsonObject) -> JsonObject: ...
    async def resume(self, request: JsonObject) -> JsonObject: ...
    async def status(self, handle: JsonObject) -> JsonObject: ...
    def events(self, handle: JsonObject, after: JsonObject | None = None, signal: Any = None) -> Any: ...
    async def result(self, handle: JsonObject, signal: Any = None) -> JsonObject: ...
    async def cancel(self, handle: JsonObject) -> None: ...


class ExecutionEngineError(Error):
    name = "ExecutionEngineError"

    def __init__(self, error: JsonObject) -> None:
        super().__init__(error["message"])
        self.code = error["code"]
        self.retryable = error.get("retryable") or False
        self.details = error.get("details")


def event_cursor(event: JsonObject) -> JsonObject:
    return {"attempt": event.get("attempt") or 1, "sequence": event["sequence"]}


def compare_event_cursors(left: JsonObject, right: JsonObject) -> int:
    if left["attempt"] == right["attempt"]:
        return left["sequence"] - right["sequence"]
    return left["attempt"] - right["attempt"]


def is_event_after(event: JsonObject, cursor: JsonObject | None = None) -> bool:
    return cursor is None or compare_event_cursors(event_cursor(event), cursor) > 0


def is_terminal_execution_status(status: str) -> bool:
    return status in TERMINAL_EXECUTION_STATUSES
