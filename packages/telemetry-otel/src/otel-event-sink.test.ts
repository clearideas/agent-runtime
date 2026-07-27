import type { RunEvent } from "@clearideas/agent-runtime-contracts";
import {
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
  type SpanStatus,
  SpanStatusCode,
  type TimeInput,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import {
  mapRunEventToTelemetry,
  OpenTelemetryEventSink,
} from "./otel-event-sink.js";

class RecordedSpan {
  readonly events: Array<{ name: string; attributes?: Attributes }> = [];
  readonly attributes: Attributes;
  readonly parent?: Span;
  status?: SpanStatus;
  ended = false;

  constructor(
    readonly name: string,
    options: SpanOptions = {},
    parent?: Span,
  ) {
    this.attributes = { ...options.attributes };
    this.parent = parent;
  }

  addEvent(
    name: string,
    attributes?: Attributes,
    _startTime?: TimeInput,
  ): this {
    this.events.push({ name, ...(attributes ? { attributes } : {}) });
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }

  end(_endTime?: TimeInput): void {
    this.ended = true;
  }
}

class RecordedTracer {
  readonly spans: RecordedSpan[] = [];

  startSpan(
    name: string,
    options?: SpanOptions,
    parentContext?: Context,
  ): Span {
    const span = new RecordedSpan(
      name,
      options,
      parentContext ? trace.getSpan(parentContext) : undefined,
    );
    this.spans.push(span);
    return span as unknown as Span;
  }
}

let sequence = 0;
const event = (type: string, overrides: Partial<RunEvent> = {}): RunEvent => ({
  id: `event-${sequence + 1}`,
  runId: "run-1",
  sequence: (sequence += 1),
  timestamp: `2026-07-22T12:00:0${sequence}.000Z`,
  type,
  ...overrides,
});

describe("mapRunEventToTelemetry", () => {
  it("copies only allowlisted metadata and token counts", () => {
    sequence = 0;
    const mapping = mapRunEventToTelemetry(
      event("model.usage", {
        stepId: "summarize",
        data: {
          provider: "openai",
          modelId: "gpt-test",
          prompt: "private prompt",
          output: "private output",
          variables: { customer: "private variable" },
          toolArguments: { query: "private arguments" },
          toolResult: "private result",
          usage: {
            inputTokens: 17,
            outputTokens: 5,
            totalTokens: 22,
            reasoningTokens: 2,
            cachedInputTokens: 3,
          },
          durationMs: 240,
        },
      }),
    );

    expect(mapping.scope).toBe("model");
    expect(mapping.attributes).toMatchObject({
      "agent_runtime.run.id": "run-1",
      "agent_runtime.step.id": "summarize",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-test",
      "gen_ai.usage.input_tokens": 17,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.total_tokens": 22,
      "gen_ai.usage.reasoning_tokens": 2,
      "gen_ai.usage.cached_input_tokens": 3,
      "agent_runtime.duration_ms": 240,
    });
    const serialized = JSON.stringify(mapping);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("toolArguments");
    expect(serialized).not.toContain("toolResult");
  });

  it("redacts error messages by default and permits an explicit opt-in", () => {
    sequence = 0;
    const failed = event("run.failed", {
      data: {
        error: {
          code: "PROVIDER_FAILED",
          message: "Secret document text was rejected",
          stack: "private stack",
          retryable: true,
        },
      },
    });

    const safe = mapRunEventToTelemetry(failed);
    expect(safe.status).toBe("error");
    expect(safe.attributes["error.type"]).toBe("PROVIDER_FAILED");
    expect(safe.attributes["error.retryable"]).toBe(true);
    expect(safe.errorMessage).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain("Secret document");
    expect(JSON.stringify(safe)).not.toContain("private stack");

    const optedIn = mapRunEventToTelemetry(failed, {
      captureErrorMessages: true,
    });
    expect(optedIn.errorMessage).toBe("Secret document text was rejected");
  });
});

describe("OpenTelemetryEventSink", () => {
  it("creates nested run, step, model, and tool spans and closes them", () => {
    sequence = 0;
    const tracer = new RecordedTracer();
    const sink = new OpenTelemetryEventSink({
      tracer: tracer as unknown as Tracer,
    });

    sink.emit(event("run.started", { data: { manifestId: "manifest-1" } }));
    sink.emit(
      event("step.started", {
        stepId: "step-1",
        stepPath: "step-1",
        data: { stepIndex: 0 },
      }),
    );
    sink.emit(
      event("model.started", {
        stepId: "step-1",
        stepPath: "step-1",
        data: { provider: "openai", modelId: "gpt-test" },
      }),
    );
    sink.emit(
      event("model.tool.requested", {
        stepId: "step-1",
        stepPath: "step-1",
        data: {
          toolCallId: "call-1",
          toolName: "search",
          arguments: { query: "secret query" },
        },
      }),
    );
    sink.emit(
      event("model.tool.started", {
        stepId: "step-1",
        stepPath: "step-1",
        data: { toolCallId: "call-1", toolName: "search" },
      }),
    );
    sink.emit(
      event("model.tool.completed", {
        stepId: "step-1",
        stepPath: "step-1",
        data: {
          toolCallId: "call-1",
          toolName: "search",
          result: "secret result",
          durationMs: 8,
        },
      }),
    );
    sink.emit(
      event("model.usage", {
        stepId: "step-1",
        stepPath: "step-1",
        data: { usage: { inputTokens: 10, outputTokens: 4 } },
      }),
    );
    sink.emit(
      event("model.completed", {
        stepId: "step-1",
        stepPath: "step-1",
      }),
    );
    sink.emit(
      event("step.completed", {
        stepId: "step-1",
        stepPath: "step-1",
        data: { stepIndex: 0, output: "secret output" },
      }),
    );
    sink.emit(event("run.completed"));

    expect(tracer.spans.map((span) => span.name)).toEqual([
      "agent_runtime.run",
      "agent_runtime.step",
      "agent_runtime.model",
      "agent_runtime.tool",
    ]);
    const [runSpan, stepSpan, modelSpan, toolSpan] = tracer.spans;
    expect(stepSpan?.parent).toBe(runSpan);
    expect(modelSpan?.parent).toBe(stepSpan);
    expect(toolSpan?.parent).toBe(modelSpan);
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
    expect(runSpan?.status?.code).toBe(SpanStatusCode.OK);
    expect(stepSpan?.status?.code).toBe(SpanStatusCode.OK);
    expect(modelSpan?.status?.code).toBe(SpanStatusCode.OK);
    expect(toolSpan?.status?.code).toBe(SpanStatusCode.OK);

    const recorded = JSON.stringify(tracer.spans);
    expect(recorded).not.toContain("secret query");
    expect(recorded).not.toContain("secret result");
    expect(recorded).not.toContain("secret output");
  });

  it("marks failed spans without exposing error messages by default", () => {
    sequence = 0;
    const tracer = new RecordedTracer();
    const sink = new OpenTelemetryEventSink({
      tracer: tracer as unknown as Tracer,
    });

    sink.emit(event("run.started"));
    sink.emit(
      event("step.started", {
        stepId: "step-1",
        data: { stepIndex: 0 },
      }),
    );
    sink.emit(
      event("step.failed", {
        stepId: "step-1",
        data: {
          error: {
            code: "EXECUTION_FAILED",
            message: "private provider response",
          },
        },
      }),
    );
    sink.emit(
      event("run.failed", {
        data: {
          error: {
            code: "EXECUTION_FAILED",
            message: "private provider response",
          },
        },
      }),
    );

    expect(tracer.spans).toHaveLength(2);
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
    expect(
      tracer.spans.every((span) => span.status?.code === SpanStatusCode.ERROR),
    ).toBe(true);
    expect(JSON.stringify(tracer.spans)).not.toContain("private provider");
    expect(
      tracer.spans
        .flatMap((span) => span.events)
        .some((item) =>
          Object.values(item.attributes ?? {}).includes("EXECUTION_FAILED"),
        ),
    ).toBe(true);
  });

  it("ends incomplete spans during shutdown", () => {
    sequence = 0;
    const tracer = new RecordedTracer();
    const sink = new OpenTelemetryEventSink({
      tracer: tracer as unknown as Tracer,
    });
    sink.emit(event("run.started"));
    sink.emit(event("step.started", { stepId: "step-1" }));

    sink.shutdown();

    expect(tracer.spans.every((span) => span.ended)).toBe(true);
  });

  it("keeps spans isolated when identifiers contain delimiter characters", () => {
    sequence = 0;
    const tracer = new RecordedTracer();
    const sink = new OpenTelemetryEventSink({
      tracer: tracer as unknown as Tracer,
    });

    sink.emit(event("run.started", { runId: "a", attempt: 1 }));
    sink.emit(
      event("step.started", {
        runId: "a",
        attempt: 1,
        stepId: "2:s",
        stepPath: "2:s",
      }),
    );
    sink.emit(event("run.started", { runId: "a:1", attempt: 2 }));
    sink.emit(
      event("step.started", {
        runId: "a:1",
        attempt: 2,
        stepId: "s",
        stepPath: "s",
      }),
    );

    sink.emit(event("run.completed", { runId: "a", attempt: 1 }));
    expect(tracer.spans).toHaveLength(4);
    expect(tracer.spans.filter((span) => span.ended)).toHaveLength(2);

    sink.emit(event("run.completed", { runId: "a:1", attempt: 2 }));
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
  });
});
