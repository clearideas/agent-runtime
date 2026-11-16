"""Following executions (``packages/execution/src/client.ts``)."""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any

from .._js.abort import AbortSignal, sleep
from .._js.errors import Error
from .contracts import event_cursor, is_terminal_execution_status

JsonObject = dict[str, Any]


class ExecutionClient:
    def __init__(self, engine: Any) -> None:
        self._engine = engine

    async def submit(self, request: JsonObject) -> JsonObject:
        return await self._engine.submit(request)

    async def resume(self, request: JsonObject) -> JsonObject:
        return await self._engine.resume(request)

    async def follow(
        self,
        handle: JsonObject,
        *,
        after: JsonObject | None = None,
        signal: AbortSignal | None = None,
        on_event: Callable[[JsonObject], Any] | None = None,
        reconnect_delay_ms: int = 250,
        maximum_reconnects: int = 3,
    ) -> JsonObject:
        """Stream events (reconnecting after errors) and return ``{handle, status, result?, lastEventCursor?}``."""
        cursor = after
        reconnects = 0
        while True:
            try:
                async for event in self._engine.events(handle, after=cursor, signal=signal):
                    cursor = event_cursor(event)
                    if on_event is not None:
                        value = on_event(event)
                        if inspect.isawaitable(value):
                            await value
                break
            except Exception:
                if (signal is not None and signal.aborted) or reconnects >= maximum_reconnects:
                    raise
                reconnects += 1
                await sleep(reconnect_delay_ms, signal)
        status = await self._engine.status(handle)
        followed: JsonObject = {"handle": handle, "status": status}
        if status["status"] == "completed":
            followed["result"] = await self._engine.result(handle, signal=signal)
        if cursor is not None:
            followed["lastEventCursor"] = cursor
        return followed

    async def wait(self, handle: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        async for _ in self._engine.events(handle, signal=signal):
            pass
        status = await self._engine.status(handle)
        if not is_terminal_execution_status(status["status"]):
            raise Error(f"Execution event stream ended while status was {status['status']}.")
        return status

    async def cancel(self, handle: JsonObject) -> None:
        await self._engine.cancel(handle)
