"""Port of ``packages/telemetry-otel/src/otel-event-sink.test.ts``."""

from __future__ import annotations

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from clearideas_agent_runtime.telemetry import OpenTelemetryEventSink, map_run_event_to_telemetry


def event(sequence: int, type_: str, **fields: object) -> dict:
    return {
        "id": f"e{sequence}",
        "runId": "run-1",
        "sequence": sequence,
        "timestamp": f"2026-01-01T00:00:0{sequence % 10}.000Z",
        "type": type_,
        **fields,
    }


def test_maps_events_to_scopes_attributes_and_redacted_errors() -> None:
    mapping = map_run_event_to_telemetry(
        event(
            3,
            "model.completed",
            stepId="s",
            data={
                "model": "openai/gpt",
                "provider": "openai",
                "usage": {"inputTokens": 4, "outputTokens": 2, "totalTokens": 6},
            },
        )
    )
    assert (mapping.scope, mapping.action, mapping.span_name, mapping.status) == (
        "model",
        "end",
        "agent_runtime.model",
        "ok",
    )
    assert mapping.attributes["gen_ai.usage.total_tokens"] == 6 and mapping.attributes["gen_ai.system"] == "openai"
    failed = map_run_event_to_telemetry(
        event(4, "step.failed", stepId="s", data={"error": {"code": "X", "message": "secret", "retryable": True}})
    )
    assert (
        failed.attributes["error.type"] == "X"
        and failed.attributes["error.retryable"] is True
        and failed.error_message is None
    )
    assert (
        map_run_event_to_telemetry(
            event(4, "step.failed", data={"error": {"code": "X", "message": "m"}}), capture_error_messages=True
        ).error_message
        == "m"
    )


def test_builds_nested_spans_and_ends_children_with_the_run() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    sink = OpenTelemetryEventSink(tracer=provider.get_tracer("test"))
    for item in [
        event(1, "run.started"),
        event(2, "step.started", stepId="s"),
        event(3, "model.started", stepId="s"),
        event(4, "model.tool.started", stepId="s", data={"toolCallId": "c1", "toolName": "lookup"}),
        event(5, "model.tool.completed", stepId="s", data={"toolCallId": "c1"}),
        event(6, "model.completed", stepId="s"),
        event(7, "step.started", stepId="t"),
        event(8, "run.failed", data={"error": {"code": "BOOM"}}),
    ]:
        sink.emit(item)
    spans = {
        span.name + ":" + str(span.attributes.get("agent_runtime.step.id")): span
        for span in exporter.get_finished_spans()
    }
    assert set(spans) == {
        "agent_runtime.run:None",
        "agent_runtime.step:s",
        "agent_runtime.model:s",
        "agent_runtime.tool:s",
        "agent_runtime.step:t",
    }
    run = spans["agent_runtime.run:None"]
    assert run.status.status_code == StatusCode.ERROR
    assert spans["agent_runtime.tool:s"].parent.span_id == spans["agent_runtime.model:s"].context.span_id
    assert spans["agent_runtime.step:t"].parent.span_id == run.context.span_id
