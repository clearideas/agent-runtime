"""OpenTelemetry run-event sink (``@clearideas/agent-runtime-telemetry-otel``).

Needs the ``otel`` extra (``opentelemetry-api``). Span names, attributes, and
event names match the TypeScript sink.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from ._js import json as js_json
from ._js import time as js_time

JsonObject = dict[str, Any]

_START = {"run.started", "run.resumed", "step.started", "model.started", "model.tool.requested", "model.tool.started"}
_END = {
    "run.completed",
    "run.failed",
    "run.cancelled",
    "run.suspended",
    "run.interrupted",
    "step.completed",
    "step.failed",
    "model.completed",
    "model.tool.completed",
}


@dataclass
class TelemetryMapping:
    scope: str
    action: str
    span_name: str
    attributes: dict[str, Any]
    status: str | None = None
    error_message: str | None = None


def _as_object(value: Any) -> JsonObject | None:
    return value if isinstance(value, dict) else None


def _first(sources: list[JsonObject | None], keys: list[str], kind: str) -> Any:
    for source in sources:
        if not source:
            continue
        for key in keys:
            value = source.get(key)
            if kind == "string" and isinstance(value, str) and value:
                return value
            if (
                kind == "number"
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
            ):
                return value
            if kind == "boolean" and isinstance(value, bool):
                return value
    return None


def _scope(event_type: str) -> str:
    if event_type.startswith("model.tool."):
        return "tool"
    if event_type.startswith("model."):
        return "model"
    if any(
        event_type.startswith(prefix) for prefix in ("step.", "loop.", "approval.", "webhook.", "code.", "sub-run.")
    ):
        return "step"
    return "run"


def _action(event_type: str) -> str:
    if event_type in _START:
        return "start"
    if event_type in _END:
        return "end"
    if event_type.endswith(".failed") and event_type.startswith(("run.", "step.", "model.")):
        return "end"
    return "event"


def map_run_event_to_telemetry(event: JsonObject, capture_error_messages: bool = False) -> TelemetryMapping:
    data = _as_object(event.get("data"))
    payload = _as_object(event.get("payload"))
    sources = [data, payload]
    usage = [_as_object((data or {}).get("usage")), _as_object((payload or {}).get("usage")), *sources]
    error = next(
        (_as_object(source.get("error")) for source in sources if source and _as_object(source.get("error"))), None
    )
    attributes: dict[str, Any] = {
        "agent_runtime.run.id": event["runId"],
        "agent_runtime.run.attempt": event.get("attempt") or 1,
        "agent_runtime.event.type": event["type"],
        "agent_runtime.event.sequence": event["sequence"],
    }

    def put(key: str, value: Any) -> None:
        if value is not None:
            attributes[key] = value

    put("agent_runtime.step.id", event.get("stepId"))
    put("agent_runtime.step.path", event.get("stepPath"))
    for key, names, kind, origin in (
        ("agent_runtime.manifest.id", ["manifestId"], "string", sources),
        ("agent_runtime.step.index", ["stepIndex"], "number", sources),
        ("agent_runtime.step.type", ["stepType"], "string", sources),
        ("agent_runtime.checkpoint.id", ["checkpointId"], "string", sources),
        ("agent_runtime.checkpoint.next_step_index", ["nextStepIndex"], "number", sources),
        ("gen_ai.system", ["provider", "system"], "string", sources),
        ("gen_ai.request.model", ["modelId", "model"], "string", sources),
        ("gen_ai.tool.call.id", ["toolCallId", "callId"], "string", sources),
        ("gen_ai.tool.name", ["toolName"], "string", sources),
        ("gen_ai.usage.input_tokens", ["inputTokens", "promptTokens"], "number", usage),
        ("gen_ai.usage.output_tokens", ["outputTokens", "completionTokens"], "number", usage),
        ("gen_ai.usage.total_tokens", ["totalTokens"], "number", usage),
        ("gen_ai.usage.reasoning_tokens", ["reasoningTokens"], "number", usage),
        ("gen_ai.usage.cached_input_tokens", ["cachedInputTokens"], "number", usage),
        ("agent_runtime.duration_ms", ["durationMs"], "number", sources),
        ("agent_runtime.latency_ms", ["latencyMs"], "number", sources),
        ("agent_runtime.artifact.id", ["artifactId"], "string", sources),
        ("agent_runtime.model.purpose", ["purpose"], "string", sources),
    ):
        put(key, _first(origin, names, kind))
    if event["type"] == "context.reduced":
        put("agent_runtime.context.scope", _first(sources, ["scope"], "string"))
        put("agent_runtime.context.strategy", _first(sources, ["strategy"], "string"))
        put("agent_runtime.context.reason", _first(sources, ["reason"], "string"))
        put("agent_runtime.context.bytes_before", _first(sources, ["bytesBefore"], "number"))
        put("agent_runtime.context.bytes_after", _first(sources, ["bytesAfter"], "number"))
    if event["type"] == "model.retry":
        put("agent_runtime.retry.reason", _first(sources, ["reason"], "string"))
        put("agent_runtime.retry.attempt", _first(sources, ["attempt"], "number"))
    if event["type"] in ("run.suspended", "run.interrupted"):
        put("agent_runtime.run.stop_reason", _first(sources, ["reason"], "string"))
        put("agent_runtime.run.suspension_kind", _first(sources, ["kind"], "string"))
    put("agent_runtime.artifact.media_type", _first(sources, ["mediaType"], "string"))
    put("agent_runtime.artifact.size_bytes", _first(sources, ["sizeBytes"], "number"))
    code = _first([error], ["code", "name"], "string")
    put("error.type", code if code is not None else _first(sources, ["errorCode"], "string"))
    retryable = _first([error], ["retryable"], "boolean")
    put("error.retryable", retryable if retryable is not None else _first(sources, ["retryable"], "boolean"))
    status = "error" if event["type"].endswith(".failed") else "ok" if event["type"].endswith(".completed") else None
    message = None
    if capture_error_messages:
        message = _first([error], ["message"], "string") or _first(sources, ["errorMessage"], "string")
    scope = _scope(event["type"])
    return TelemetryMapping(scope, _action(event["type"]), f"agent_runtime.{scope}", attributes, status, message)


def _span_key(event: JsonObject, scope: str) -> str:
    run = [event["runId"], event.get("attempt") or 1]
    step = event.get("stepPath") or event.get("stepId")
    if scope == "run":
        return js_json.stringify([*run, "run"])
    if scope == "step":
        return js_json.stringify([*run, "step", step or "unknown-step"])
    if scope == "model":
        return js_json.stringify([*run, "model", step or "run"])
    call = _first([_as_object(event.get("data")), _as_object(event.get("payload"))], ["toolCallId", "callId"], "string")
    return js_json.stringify([*run, "tool", step or "run", call or "active-tool"])


def _time_ns(event: JsonObject) -> int | None:
    try:
        milliseconds = js_time.parse_ms(event["timestamp"])
    except Exception:
        return None
    return None if not math.isfinite(milliseconds) else int(milliseconds) * 1_000_000


@dataclass
class OpenTelemetryEventSink:
    """An ``EventSink`` that turns run events into run, step, model, and tool spans."""

    tracer: Any = None
    instrumentation_name: str = "@clearideas/agent-runtime-telemetry-otel"
    instrumentation_version: str | None = None
    capture_error_messages: bool = False
    _spans: dict[str, dict[str, Any]] = field(default_factory=lambda: {"run": {}, "step": {}, "model": {}, "tool": {}})
    _child_run_keys: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.tracer is None:
            from opentelemetry import trace

            self.tracer = trace.get_tracer(self.instrumentation_name, self.instrumentation_version)

    def emit(self, event: JsonObject) -> None:
        from opentelemetry.trace import Status, StatusCode

        mapping = map_run_event_to_telemetry(event, self.capture_error_messages)
        spans = self._spans[mapping.scope]
        key = _span_key(event, mapping.scope)
        span = spans.get(key)
        if mapping.action == "start" and span is None:
            span = self._start(event, mapping)
            spans[key] = span
            if mapping.scope != "run":
                self._child_run_keys[key] = _span_key(event, "run")
        elif span is None:
            span = self._nearest_parent(event) or self._ensure_run(event)
        timestamp = _time_ns(event)
        span.add_event(event["type"], mapping.attributes, timestamp)
        if mapping.status == "error":
            span.set_status(Status(StatusCode.ERROR, mapping.error_message))
        if mapping.action == "end":
            if mapping.status == "ok":
                span.set_status(Status(StatusCode.OK))
            if mapping.scope == "run":
                self._end_run(event, timestamp)
            elif key in spans:
                span.end(timestamp)
                del spans[key]
                self._child_run_keys.pop(key, None)

    def shutdown(self) -> None:
        for scope in ("tool", "model", "step", "run"):
            for span in self._spans[scope].values():
                span.end()
            self._spans[scope].clear()
        self._child_run_keys.clear()

    def _start(self, event: JsonObject, mapping: TelemetryMapping) -> Any:
        from opentelemetry import trace

        runs = self._spans["run"]
        run_span = runs.get(_span_key(event, "run"))
        if mapping.scope == "tool":
            parent = self._active("model", event) or self._active("step", event) or run_span
        elif mapping.scope == "model":
            parent = self._active("step", event) or run_span
        elif mapping.scope == "step":
            parent = run_span
        else:
            parent = None
        context = trace.set_span_in_context(parent) if parent is not None else None
        return self.tracer.start_span(
            mapping.span_name, context=context, attributes=mapping.attributes, start_time=_time_ns(event)
        )

    def _active(self, scope: str, event: JsonObject) -> Any:
        if scope == "step" and not event.get("stepId") and not event.get("stepPath"):
            return None
        return self._spans[scope].get(_span_key(event, scope))

    def _nearest_parent(self, event: JsonObject) -> Any:
        return (
            self._active("model", event)
            or self._active("step", event)
            or self._spans["run"].get(_span_key(event, "run"))
        )

    def _ensure_run(self, event: JsonObject) -> Any:
        key = _span_key(event, "run")
        if key in self._spans["run"]:
            return self._spans["run"][key]
        mapping = map_run_event_to_telemetry(event, self.capture_error_messages)
        mapping = TelemetryMapping(
            "run", "start", "agent_runtime.run", mapping.attributes, mapping.status, mapping.error_message
        )
        span = self._start(event, mapping)
        self._spans["run"][key] = span
        return span

    def _end_run(self, event: JsonObject, timestamp: int | None) -> None:
        run_key = _span_key(event, "run")
        for scope in ("tool", "model", "step"):
            spans = self._spans[scope]
            for key in [key for key in spans if self._child_run_keys.get(key) == run_key]:
                spans.pop(key).end(timestamp)
                self._child_run_keys.pop(key, None)
        run_span = self._spans["run"].pop(run_key, None)
        if run_span is not None:
            run_span.end(timestamp)
