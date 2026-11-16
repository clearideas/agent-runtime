"""Shared record machinery for the in-process engine and in-memory control plane."""

from __future__ import annotations

import asyncio
import copy
from typing import Any

from .._js.abort import AbortSignal, abort_reason_error
from .contracts import event_cursor, is_event_after, is_terminal_execution_status

JsonObject = dict[str, Any]


class ExecutionRecord:
    def __init__(self, handle: JsonObject, digest: str, attempt: int, updated_at: str) -> None:
        self.handle = handle
        self.digest = digest
        self.status = "queued"
        self.attempt = attempt
        self.updated_at = updated_at
        self.events: list[JsonObject] = []
        self.version = 0
        self.changed = asyncio.Event()
        self.result: JsonObject | None = None
        self.error: JsonObject | None = None
        self.done = asyncio.Event()

    def touch(self) -> None:
        self.version += 1
        self.changed.set()
        self.changed = asyncio.Event()

    def status_view(self) -> JsonObject:
        status: JsonObject = {
            "handle": self.handle,
            "status": self.status,
            "attempt": self.attempt,
            "updatedAt": self.updated_at,
        }
        if self.events:
            status["lastEventCursor"] = event_cursor(self.events[-1])
        if self.error is not None:
            status["error"] = self.error
        return copy.deepcopy(status)

    async def stream(self, after: JsonObject | None, signal: AbortSignal | None) -> Any:
        cursor = after
        while True:
            if signal is not None and signal.aborted:
                raise abort_reason_error(signal)
            pending = [event for event in self.events if is_event_after(event, cursor)]
            if pending:
                for event in pending:
                    cursor = event_cursor(event)
                    yield copy.deepcopy(event)
                continue
            if is_terminal_execution_status(self.status):
                return
            changed = self.changed
            waiters = [asyncio.ensure_future(changed.wait())]
            if signal is not None:
                waiters.append(asyncio.ensure_future(signal.wait()))  # pyright: ignore[reportArgumentType]
            try:
                await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for waiter in waiters:
                    waiter.cancel()
