"""
Small helpers shared by the demo hosts (``lib/host-kit.ts``). Nothing here is
specific to Agent Runtime integration; it keeps each host.py focused on the
parts that are.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
from collections.abc import AsyncIterator
from typing import Any, TypedDict

from clearideas_agent_runtime import parse_agent_runtime_config

from . import js
from .demo import Emit
from .observed_tools import ObservedToolAdapter, ObservedToolCall, truncate_for_display

JsonObject = dict[str, Any]


def _plain(value: Any) -> Any:
    """Drop members JSON.stringify would drop (``js.UNDEFINED``)."""
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items() if item is not js.UNDEFINED}
    if isinstance(value, (list, tuple)):
        return [None if item is js.UNDEFINED else _plain(item) for item in value]
    return value


def to_json(value: Any) -> Any:
    """``JSON.parse(JSON.stringify(value ?? null))``."""
    return js.parse(stringify(value))


def stringify(value: Any, indent: int | None = None) -> str:
    """``JSON.stringify`` with JavaScript's number formatting and key order."""
    return js.stringify(_plain(None if value is js.UNDEFINED else value), indent)


def with_model_overrides(config: JsonObject) -> JsonObject:
    """Live mode may select another provider or model without editing YAML."""
    profile = (config.get("models") or {}).get("default")
    if not profile:
        return config
    return parse_agent_runtime_config(
        {
            **config,
            "models": {
                **config["models"],
                "default": {
                    **profile,
                    "provider": os.environ.get("SHOWCASE_PROVIDER", profile["provider"]),
                    "model": os.environ.get("SHOWCASE_MODEL", profile["model"]),
                },
            },
        }
    )


class Visibility(TypedDict, total=False):
    include: list[str]
    exclude: list[str]


def visibility_of(definition: JsonObject | None) -> Visibility:
    """The include/exclude globs of a local workspace definition."""
    if not definition or definition.get("driver") != "local":
        return {}
    visibility: Visibility = {}
    if definition.get("include"):
        visibility["include"] = definition["include"]
    if definition.get("exclude"):
        visibility["exclude"] = definition["exclude"]
    return visibility


def summarize_result(result: JsonObject) -> Any:
    """The parts of a RunResult the browser shows."""
    return to_json(
        {
            "runId": result["runId"],
            "output": result.get("output"),
            "state": result.get("state"),
            "stepResults": [
                {"stepId": step["stepId"], "status": step["status"], "output": step.get("output")}
                for step in result.get("stepResults") or []
            ],
            "usage": result.get("usage"),
            "startedAt": result.get("startedAt"),
            "completedAt": result.get("completedAt"),
        }
    )


def mirror_tools(tools: Any, emit: Emit) -> ObservedToolAdapter:
    """Mirror tool inputs and outputs to the browser (events carry names only)."""

    def observe(observed: ObservedToolCall) -> None:
        call, result = observed.call, observed.result
        message: JsonObject = {
            "kind": "tool-io",
            "stepId": observed.step_id,
            "toolCallId": call["id"],
            "name": call["name"],
            "input": truncate_for_display(call.get("input")),
        }
        if result.get("error"):
            message["error"] = {"code": result["error"]["code"], "message": result["error"]["message"]}
        else:
            message["output"] = truncate_for_display(result.get("output"))
        if result.get("artifacts"):
            message["artifacts"] = to_json(result["artifacts"])
        emit(message)

    return ObservedToolAdapter(tools, observe)


class _ForwardingModel:
    """A model wrapper that keeps the optional ``stream`` and ``describe_model``
    methods of the model it wraps, and only those it has."""

    def __init__(self, model: Any) -> None:
        self._model = model
        # Agent Runtime treats a model whose ``stream`` is None as non-streaming.
        if getattr(model, "stream", None) is None:
            self.stream = None
        describe = getattr(model, "describe_model", None)
        if describe is not None:
            self.describe_model = describe


def forward_describe_model(model: Any) -> dict[str, Any]:
    """``describe_model`` (model limits, used to size context reduction) of a wrapped model, if any."""
    describe = getattr(model, "describe_model", None)
    return {"describe_model": describe} if describe is not None else {}


class _RefusedCallMirror(_ForwardingModel):
    def __init__(self, model: Any, remember: Any) -> None:
        super().__init__(model)
        self._remember = remember

    async def generate(self, request: JsonObject) -> JsonObject:
        result = await self._model.generate(request)
        self._remember(result.get("toolCalls"))
        return result

    async def stream(self, request: JsonObject) -> AsyncIterator[JsonObject]:  # type: ignore[override]
        async for event in self._model.stream(request):
            if event["type"] == "tool-call":
                self._remember([event["call"]])
            if event["type"] == "completed":
                self._remember(event["result"].get("toolCalls"))
            yield event


class _RefusedCallSink:
    def __init__(self, requested: dict[str, JsonObject], emit: Emit) -> None:
        self._requested = requested
        self._emit = emit

    def emit(self, event: JsonObject) -> None:
        data = event.get("data") or {}
        if event["type"] != "model.tool.completed" or data.get("rejected") is not True:
            return
        call = self._requested.get(str(data.get("toolCallId")))
        if call is None:
            return
        self._emit(
            {
                "kind": "tool-io",
                "stepId": event.get("stepId") or "",
                "toolCallId": call["id"],
                "name": call["name"],
                "input": truncate_for_display(call.get("input")),
                "error": {
                    "code": str(data.get("errorCode") or "tool_not_allowed"),
                    "message": "Agent Runtime refused the call: the step does not allow this tool.",
                },
            }
        )


def mirror_refused_calls(model: Any, emit: Emit) -> tuple[Any, _RefusedCallSink]:
    """
    Agent Runtime answers a tool call the step does not allow (or one the
    model adapter marked invalid) with an error and never runs it, so the
    ToolAdapter mirror above never sees it. This mirrors those refused calls
    too: it remembers each call the model requests and, when
    `model.tool.completed` reports `rejected: true`, streams the call's input
    with the refusal. Returns the wrapped model and an event sink.
    """
    requested: dict[str, JsonObject] = {}

    def remember(calls: list[JsonObject] | None) -> None:
        for call in calls or []:
            requested[call["id"]] = call

    return _RefusedCallMirror(model, remember), _RefusedCallSink(requested, emit)


def run_sync(awaitable: Any) -> Any:
    """
    Await ``awaitable`` from synchronous code, such as a module that loads
    its agent and configuration once when it is imported (the TypeScript hosts
    use top-level ``await`` for this).
    """

    async def wait() -> Any:
        return await awaitable

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(wait())
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        return pool.submit(asyncio.run, wait()).result()
