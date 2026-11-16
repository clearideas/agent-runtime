"""Helpers for the prompt-step test suites."""

from __future__ import annotations

import asyncio
import copy
import gc
from collections.abc import Awaitable, Callable
from typing import Any

from clearideas_agent_runtime.core.runtime import StepExecutionContext

AT = "2026-07-22T00:00:00.000Z"


class Adapter:
    """An adapter object from functions, like TypeScript object literals."""

    def __init__(self, **methods: Any) -> None:
        for name, method in methods.items():
            setattr(self, name, method)


def model(
    generate: Callable[[dict], Any] | None = None,
    stream: Callable[[dict], Any] | None = None,
    describe_model: Callable[[str], Any] | None = None,
) -> Adapter:
    async def default_generate(_: dict) -> dict:
        return {"transcript": []}

    methods: dict[str, Any] = {"generate": generate or default_generate}
    if stream is not None:
        methods["stream"] = stream
    if describe_model is not None:
        methods["describe_model"] = describe_model
    return Adapter(**methods)


def tools(
    execute: Callable[[dict, Any], Awaitable[dict]],
    names: list[str] | None = None,
    **extra: Any,
) -> Adapter:
    async def list_tools() -> list[dict]:
        return [{"name": name, "inputSchema": {"type": "object"}} for name in names or ["lookup"]]

    return Adapter(list_tools=list_tools, execute_tool=execute, **extra)


class Events:
    """Records emitted events; ``emit`` matches the runtime's signature."""

    def __init__(self, run_id: str = "run", on_emit: Callable[[str, Any], None] | None = None) -> None:
        self.run_id = run_id
        self.events: list[dict] = []
        self._on_emit = on_emit

    async def emit(self, type: str, data: dict | None = None) -> dict:
        if self._on_emit is not None:
            self._on_emit(type, data)
        event: dict = {
            "id": f"event-{len(self.events) + 1}",
            "runId": self.run_id,
            "sequence": len(self.events) + 1,
            "timestamp": AT,
            "type": type,
        }
        if data is not None:
            event["data"] = data
        self.events.append(event)
        return event

    def types(self) -> list[str]:
        return [event["type"] for event in self.events]

    def data(self, type: str) -> list[dict]:
        return [event.get("data") or {} for event in self.events if event["type"] == type]


def context(**fields: Any) -> StepExecutionContext:
    fields.setdefault("step_index", 0)
    fields.setdefault("variables", {})
    if "emit" not in fields:
        fields["emit"] = Events(fields.get("run_id", "run")).emit
    return StepExecutionContext(**fields)


def request_copy(request: dict) -> dict:
    """``structuredClone(request)`` without the live abort signal."""
    return copy.deepcopy({key: value for key, value in request.items() if key != "signal"})


def text_message(id_: str, text: str, role: str = "assistant", **extra: Any) -> dict:
    return {
        "id": id_,
        "type": "message",
        "role": role,
        "content": [{"type": "text", "text": text}],
        "createdAt": AT,
        **extra,
    }


async def unhandled_during(run: Callable[[], Awaitable[Any]]) -> list[Any]:
    """Collects 'exception was never retrieved' reports raised while ``run`` executes."""
    loop = asyncio.get_running_loop()
    seen: list[Any] = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, ctx: seen.append(ctx))
    try:
        await run()
        await asyncio.sleep(0.05)
        gc.collect()
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous)
    return seen


def never() -> asyncio.Future[Any]:
    return asyncio.get_running_loop().create_future()
