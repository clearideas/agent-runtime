"""Scenario driver for the cross-language suite (Python side of ``interop/driver.mjs``)."""

from __future__ import annotations

import copy
import math
import re
from typing import Any

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime._js import time as js_time
from clearideas_agent_runtime._js.errors import Error, error_message, error_name
from clearideas_agent_runtime._js.ops import UNDEFINED
from clearideas_agent_runtime.conditions import JexlConditionEvaluator
from clearideas_agent_runtime.core import AgentRuntime, RunSuspendedError, compile_prompt_template
from clearideas_agent_runtime.core.messages import MessagesOptions
from clearideas_agent_runtime.core.testing import CollectingEventSink, MemoryRunStore, SequenceIdGenerator
from clearideas_agent_runtime.steps.prompt import (
    DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    PromptMessageHistoryCompactor,
    PromptStepExecutor,
)
from clearideas_agent_runtime.stores.local import FileRunStore
from clearideas_agent_runtime.stores.sqlite import SqliteRunStore


def open_store(options: dict[str, Any] | None) -> Any:
    if not options:
        return MemoryRunStore()
    if options["kind"] == "file":
        return FileRunStore(options["path"])
    if options["kind"] == "sqlite":
        return SqliteRunStore(options["path"])
    raise Error(f"Unknown store kind: {options['kind']}")


class TickingClock:
    """Advances by ``step_ms`` on every read, starting at ``start``."""

    def __init__(self, start: str | None = None, step_ms: int | None = None) -> None:
        self._ms = js_time.parse_ms(start or "2026-01-01T00:00:00.000Z")
        self._step = 1 if step_ms is None else step_ms

    def now(self):
        value = js_time.from_ms(self._ms)
        self._ms += self._step
        return value


class EchoExecutor:
    """The scripted executor: behaviour selected by ``step.extensions.test``."""

    def __init__(self, step_type: str, suspended: set[str]) -> None:
        self.type = step_type
        self._suspended = suspended

    async def execute(self, context: Any) -> dict[str, Any]:
        step = context.step
        test = (step.get("extensions") or {}).get("test") or {}
        text = compile_prompt_template(
            step["prompt"] if step.get("prompt") is not None else step["id"], context.variables
        )
        if test.get("fail"):
            error = Error(test["fail"])
            if test.get("code"):
                error.code = test["code"]
            raise error
        if test.get("suspendOnce") and not context.resume and step["id"] not in self._suspended:
            self._suspended.add(step["id"])
            if context.checkpoint is not None:
                await context.checkpoint({"state": {**context.variables}, "continuation": {"phase": "waiting"}})
            raise RunSuspendedError("approval", {"stepId": step["id"]})
        if step["type"] == "loop" and context.execute_child is not None:
            state = {**context.variables}
            outputs = []
            for child in step["steps"]:
                result = await context.execute_child(child, state, f"{context.step_path}/{child['id']}")
                state = {**state, **((result.get("statePatch") or {}).get("set") or {})}
                outputs.append(result.get("output"))
            return {"output": outputs, "statePatch": {"set": state}}
        output = test["output"] if "output" in test else f"{step['id']}: {text}"
        result: dict[str, Any] = {"output": output}
        if step.get("outputVariable"):
            result["statePatch"] = {"set": {step["outputVariable"]: output}}
        if test.get("usage"):
            result["transcript"] = [
                {
                    "id": f"usage-{step['id']}",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": output if isinstance(output, str) else str(output)}],
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "usage": test["usage"],
                }
            ]
        if test.get("endRun"):
            result["endRun"] = True
        return result


class ScriptedHost:
    """Deterministic host adapters for real step executors (see ``driver.mjs``)."""

    def __init__(self, scenario: dict[str, Any]) -> None:
        self.spec = scenario.get("model") or {}
        self.script = list(self.spec.get("script") or [])
        self.model_requests: list[Any] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.declared = scenario.get("tools") or []
        self._calls = 0
        self._replies = 0
        self._transcripts = 0
        self._keys = 0
        host = self

        class Model:
            async def generate(self, request: dict[str, Any]) -> dict[str, Any]:
                return host.respond(request)

        self.model = Model()
        if self.spec.get("stream"):

            async def stream(request: dict[str, Any]):
                result = host.respond(request)
                if isinstance(result.get("output"), str) and result["output"]:
                    yield {"type": "text-delta", "delta": result["output"]}
                yield {"type": "completed", "result": result}

            self.model.stream = stream  # type: ignore[attr-defined]
        if self.spec.get("describe") is not None:

            async def describe_model(_model: str) -> dict[str, Any]:
                return self.spec["describe"]

            self.model.describe_model = describe_model  # type: ignore[attr-defined]

        class Tools:
            async def list_tools(self) -> list[dict[str, Any]]:
                return [{"name": tool["name"], "inputSchema": {"type": "object"}} for tool in host.declared]

            async def execute_tool(self, call: dict[str, Any], context: Any) -> dict[str, Any]:
                host.tool_calls.append(
                    {"id": call["id"], "name": call["name"], "idempotencyKey": context.idempotency_key}
                )
                tool = next((entry for entry in host.declared if entry["name"] == call["name"]), {})
                if tool.get("error"):
                    return {"callId": call["id"], "name": call["name"], "error": tool["error"]}
                output = tool.get("output")
                if output is None:
                    path = call["input"].get("path")
                    label = "file" if path is None else js_json.stringify(path) if not isinstance(path, str) else path
                    output = f"{label}: {'data ' * math.floor((tool.get('size') or 50) / 5)}"
                return {"callId": call["id"], "name": call["name"], "output": output}

        self.tools = Tools()

    def _transcript_id(self) -> str:
        self._transcripts += 1
        return f"item-{self._transcripts}"

    def _key(self) -> str:
        self._keys += 1
        return f"key-{self._keys}"

    @property
    def options(self) -> dict[str, Any]:
        async def sleep(_delay: float, _signal: Any = None) -> None:
            return None

        return {
            "now": lambda: js_time.from_ms(js_time.parse_ms("2026-01-01T00:00:00.000Z")),
            "generate_transcript_id": self._transcript_id,
            "sleep": sleep,
        }

    def _is_summary(self, request: dict[str, Any]) -> bool:
        return any(
            message["role"] == "system"
            and any(
                part["type"] == "text" and part["text"] == DEFAULT_SUMMARIZER_SYSTEM_PROMPT
                for part in message["content"]
            )
            for message in request["messages"]
        )

    def respond(self, request: dict[str, Any]) -> dict[str, Any]:
        self.model_requests.append(
            js_json.to_json_value({key: value for key, value in request.items() if key != "signal"})
        )
        if self._is_summary(request):
            summary = self.spec.get("summary") or {"text": "Summary of earlier material."}
            words = re.search(r"about (\d+) words", js_json.stringify(request["messages"]))
            text = (
                " ".join(["note"] * max(1, int(words.group(1)) if words else 1))
                if summary.get("words")
                else summary.get("text")
            )
            entry = {**summary, "text": text}
        else:
            entry = self.script.pop(0) if self.script else {"text": self.spec.get("final") or "final answer"}
        if entry.get("error"):
            error = Error(entry["error"]["message"])
            for key in ("name", "code", "statusCode"):
                if key in entry["error"]:
                    setattr(error, key, entry["error"][key])
            raise error
        calls = []
        for call in entry.get("calls") or []:
            self._calls += 1
            calls.append({"id": f"call-{self._calls}", "name": call["name"], "input": call.get("input") or {}})
        result: dict[str, Any] = {}
        if "output" in entry:
            result["output"] = entry["output"]
        elif entry.get("text") is not None:
            result["output"] = entry["text"]
        result["toolCalls"] = calls
        result["finishReason"] = entry.get("finishReason") or ("tool-calls" if calls else "stop")
        self._replies += 1
        item: dict[str, Any] = {
            "id": f"reply-{self._replies}",
            "type": "message",
            "role": "assistant",
            "content": ([{"type": "text", "text": entry["text"]}] if entry.get("text") else [])
            + [{"type": "tool-call", "call": call} for call in calls],
            "createdAt": "2026-01-01T00:00:00.000Z",
        }
        if entry.get("usage"):
            item["usage"] = entry["usage"]
        result["transcript"] = [item]
        return result


def provider_model(spec: dict[str, Any], options: dict[str, Any]) -> Any:
    """``scenario.provider``: ``PydanticAIModelAdapter`` for ``driver``, pointed at the suite's mock server."""
    from clearideas_agent_runtime.models.providers import create_model_factory
    from clearideas_agent_runtime.models.pydantic_ai import PydanticAIModelAdapter

    factory = create_model_factory(
        spec["driver"],
        spec.get("name") or "local",
        api_key="test-key",
        base_url=spec["baseURL"],
        headers={"x-case": spec["caseId"]},
    )
    return PydanticAIModelAdapter(
        resolve_model=lambda key: factory(key.split("/", 1)[1]),
        now=options["now"],
        generate_transcript_id=options["generate_transcript_id"],
    )


def error_report(error: BaseException) -> dict[str, Any]:
    report: dict[str, Any] = {"name": error_name(error), "message": error_message(error)}
    if isinstance(getattr(error, "code", None), str):
        report["code"] = error.code  # type: ignore[attr-defined]
    if isinstance(getattr(error, "reason", None), str):
        report["reason"] = error.reason  # type: ignore[attr-defined]
    return report


async def run_scenario(scenario: dict[str, Any]) -> dict[str, Any]:
    store = open_store(scenario.get("store"))
    events = CollectingEventSink()
    ids = SequenceIdGenerator()
    for _ in range(scenario.get("idOffset") or 0):
        ids.generate_id("run")
    clock_options = scenario.get("clock") or {}
    clock = TickingClock(clock_options.get("start"), clock_options.get("stepMs"))
    runs = []
    host = ScriptedHost(scenario)
    real = set(scenario.get("real") or [])
    for run in scenario["runs"]:
        suspended: set[str] = set()
        executors: list[Any] = [
            EchoExecutor(step_type, suspended)
            for step_type in scenario.get("executors") or ["prompt", "loop"]
            if step_type not in real
        ]
        if "prompt" in real:
            executors.append(PromptStepExecutor(**host.options, generate_tool_idempotency_key=host._key))
        runtime = AgentRuntime(
            run_store=store,
            event_sinks=[events],
            id_generator=ids,
            clock=clock,
            condition_evaluator=JexlConditionEvaluator(),
            step_executors=executors,
            model=(provider_model(scenario["provider"], host.options) if scenario.get("provider") else host.model)
            if real
            else None,
            tools=host.tools if real else None,
            policies=scenario.get("policies"),
            messages=MessagesOptions(compactor=PromptMessageHistoryCompactor(**host.options))
            if scenario.get("compactor")
            else None,
        )
        request = {} if run.get("resume") else {"manifest": copy.deepcopy(scenario["manifest"])}
        request.update(copy.deepcopy(run.get("request") or {}))
        try:
            runs.append({"ok": True, "result": await runtime.run(request)})
        except Exception as error:
            runs.append({"ok": False, "error": error_report(error)})
    if scenario.get("store"):
        stored = {}
        for run_id in scenario.get("storedRunIds") or []:
            stored[run_id] = {
                "record": await store.load_run(run_id),
                "checkpoint": await store.load_latest_checkpoint(run_id),
            }
        if hasattr(store, "close"):
            store.close()
        return {
            "runs": runs,
            "events": events.events,
            "stored": stored,
            "modelRequests": host.model_requests,
            "toolCalls": host.tool_calls,
        }
    return {
        "runs": runs,
        "modelRequests": host.model_requests,
        "toolCalls": host.tool_calls,
        "events": events.events,
        "checkpoints": store.checkpoints,
        "records": store.runs,
        "failures": store.failures,
    }


__all__ = ["UNDEFINED", "run_scenario"]
