import type {
  JsonObject,
  JsonValue,
  RunEvent,
} from "@clearideas/agent-runtime-contracts";
import type { EventSink } from "@clearideas/agent-runtime-core/ports";
import {
  type Attributes,
  type Context,
  context,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";

export type AgentRuntimeTelemetryScope = "run" | "step" | "model" | "tool";
export type AgentRuntimeTelemetryAction = "start" | "event" | "end";

/**
 * Error messages are disabled by default because upstream providers may echo
 * prompts, tool arguments, or document content in an exception message.
 */
export interface AgentRuntimeTelemetryRedactionOptions {
  captureErrorMessages?: boolean;
}

export interface AgentRuntimeTelemetryMapping {
  scope: AgentRuntimeTelemetryScope;
  action: AgentRuntimeTelemetryAction;
  spanName: string;
  attributes: Attributes;
  status?: "ok" | "error";
  errorMessage?: string;
}

export interface OpenTelemetryEventSinkOptions extends AgentRuntimeTelemetryRedactionOptions {
  tracer?: Tracer;
  instrumentationName?: string;
  instrumentationVersion?: string;
}

type JsonRecord = Record<string, JsonValue>;

const asObject = (value: JsonValue | undefined): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const firstString = (
  sources: Array<JsonRecord | undefined>,
  keys: string[],
): string | undefined => {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
};

const firstNumber = (
  sources: Array<JsonRecord | undefined>,
  keys: string[],
): number | undefined => {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return undefined;
};

const firstBoolean = (
  sources: Array<JsonRecord | undefined>,
  keys: string[],
): boolean | undefined => {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "boolean") return value;
    }
  }
  return undefined;
};

const setIfDefined = (
  attributes: Attributes,
  key: string,
  value: string | number | boolean | undefined,
): void => {
  if (value !== undefined) attributes[key] = value;
};

const scopeForEvent = (eventType: string): AgentRuntimeTelemetryScope => {
  if (eventType.startsWith("model.tool.")) return "tool";
  if (eventType.startsWith("model.")) return "model";
  if (
    ["step.", "loop.", "approval.", "webhook.", "code.", "sub-run."].some(
      (prefix) => eventType.startsWith(prefix),
    )
  )
    return "step";
  return "run";
};

const actionForEvent = (eventType: string): AgentRuntimeTelemetryAction => {
  if (
    eventType === "run.started" ||
    eventType === "run.resumed" ||
    eventType === "step.started" ||
    eventType === "model.started" ||
    eventType === "model.tool.requested" ||
    eventType === "model.tool.started"
  ) {
    return "start";
  }
  if (
    eventType === "run.completed" ||
    eventType === "run.failed" ||
    eventType === "run.cancelled" ||
    eventType === "run.suspended" ||
    eventType === "step.completed" ||
    eventType === "step.failed" ||
    eventType === "model.completed" ||
    eventType === "model.tool.completed"
  ) {
    return "end";
  }
  if (
    eventType.endsWith(".failed") &&
    (eventType.startsWith("run.") ||
      eventType.startsWith("step.") ||
      eventType.startsWith("model."))
  ) {
    return "end";
  }
  return "event";
};

const spanNameForScope = (scope: AgentRuntimeTelemetryScope): string =>
  `agent_runtime.${scope}`;

const errorDetails = (
  sources: Array<JsonRecord | undefined>,
): JsonRecord | undefined => {
  for (const source of sources) {
    const error = source ? asObject(source.error) : undefined;
    if (error) return error;
  }
  return undefined;
};

/**
 * Converts an Agent Runtime event to an allowlisted telemetry description. This
 * function deliberately never copies arbitrary event data or payload fields.
 */
export const mapRunEventToTelemetry = (
  event: RunEvent,
  options: AgentRuntimeTelemetryRedactionOptions = {},
): AgentRuntimeTelemetryMapping => {
  const data = event.data as JsonObject | undefined;
  const payload = event.payload as JsonObject | undefined;
  const dataObject = data as JsonRecord | undefined;
  const payloadObject = payload as JsonRecord | undefined;
  const sources = [dataObject, payloadObject];
  const usageSources = [
    asObject(dataObject?.usage),
    asObject(payloadObject?.usage),
    ...sources,
  ];
  const error = errorDetails(sources);
  const attributes: Attributes = {
    "agent_runtime.run.id": event.runId,
    "agent_runtime.run.attempt": event.attempt ?? 1,
    "agent_runtime.event.type": event.type,
    "agent_runtime.event.sequence": event.sequence,
  };

  setIfDefined(attributes, "agent_runtime.step.id", event.stepId);
  setIfDefined(attributes, "agent_runtime.step.path", event.stepPath);
  setIfDefined(
    attributes,
    "agent_runtime.manifest.id",
    firstString(sources, ["manifestId"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.step.index",
    firstNumber(sources, ["stepIndex"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.step.type",
    firstString(sources, ["stepType"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.checkpoint.id",
    firstString(sources, ["checkpointId"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.checkpoint.next_step_index",
    firstNumber(sources, ["nextStepIndex"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.system",
    firstString(sources, ["provider", "system"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.request.model",
    firstString(sources, ["modelId", "model"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.tool.call.id",
    firstString(sources, ["toolCallId", "callId"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.tool.name",
    firstString(sources, ["toolName"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.usage.input_tokens",
    firstNumber(usageSources, ["inputTokens", "promptTokens"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.usage.output_tokens",
    firstNumber(usageSources, ["outputTokens", "completionTokens"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.usage.total_tokens",
    firstNumber(usageSources, ["totalTokens"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.usage.reasoning_tokens",
    firstNumber(usageSources, ["reasoningTokens"]),
  );
  setIfDefined(
    attributes,
    "gen_ai.usage.cached_input_tokens",
    firstNumber(usageSources, ["cachedInputTokens"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.duration_ms",
    firstNumber(sources, ["durationMs"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.latency_ms",
    firstNumber(sources, ["latencyMs"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.artifact.id",
    firstString(sources, ["artifactId"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.artifact.media_type",
    firstString(sources, ["mediaType"]),
  );
  setIfDefined(
    attributes,
    "agent_runtime.artifact.size_bytes",
    firstNumber(sources, ["sizeBytes"]),
  );

  const errorCode =
    firstString([error], ["code", "name"]) ??
    firstString(sources, ["errorCode"]);
  const retryable =
    firstBoolean([error], ["retryable"]) ??
    firstBoolean(sources, ["retryable"]);
  setIfDefined(attributes, "error.type", errorCode);
  setIfDefined(attributes, "error.retryable", retryable);

  const status = event.type.endsWith(".failed")
    ? "error"
    : event.type.endsWith(".completed")
      ? "ok"
      : undefined;
  const message = options.captureErrorMessages
    ? (firstString([error], ["message"]) ??
      firstString(sources, ["errorMessage"]))
    : undefined;
  const scope = scopeForEvent(event.type);

  return {
    scope,
    action: actionForEvent(event.type),
    spanName: spanNameForScope(scope),
    attributes,
    ...(status ? { status } : {}),
    ...(message ? { errorMessage: message } : {}),
  };
};

const eventTime = (event: RunEvent): Date | undefined => {
  const value = new Date(event.timestamp);
  return Number.isNaN(value.getTime()) ? undefined : value;
};

const spanKey = (
  event: RunEvent,
  scope: AgentRuntimeTelemetryScope,
): string => {
  const runAttempt = [event.runId, event.attempt ?? 1] as const;
  if (scope === "run") return JSON.stringify([...runAttempt, "run"]);
  if (scope === "step") {
    return JSON.stringify([
      ...runAttempt,
      "step",
      event.stepPath ?? event.stepId ?? "unknown-step",
    ]);
  }
  if (scope === "model") {
    return JSON.stringify([
      ...runAttempt,
      "model",
      event.stepPath ?? event.stepId ?? "run",
    ]);
  }
  const sources = [
    event.data as JsonRecord | undefined,
    event.payload as JsonRecord | undefined,
  ];
  const callId =
    firstString(sources, ["toolCallId", "callId"]) ?? "active-tool";
  return JSON.stringify([
    ...runAttempt,
    "tool",
    event.stepPath ?? event.stepId ?? "run",
    callId,
  ]);
};

/**
 * EventSink that builds one run span with nested step, model, and tool spans.
 * The global no-op tracer is used when no SDK/provider or explicit tracer is
 * configured, so attaching this sink does not require an exporter.
 */
export class OpenTelemetryEventSink implements EventSink {
  readonly #tracer: Tracer;
  readonly #options: AgentRuntimeTelemetryRedactionOptions;
  readonly #runSpans = new Map<string, Span>();
  readonly #stepSpans = new Map<string, Span>();
  readonly #modelSpans = new Map<string, Span>();
  readonly #toolSpans = new Map<string, Span>();
  readonly #childRunKeys = new Map<string, string>();

  constructor(options: OpenTelemetryEventSinkOptions = {}) {
    const instrumentationName =
      options.instrumentationName ?? "@clearideas/agent-runtime-telemetry-otel";
    this.#tracer =
      options.tracer ??
      trace.getTracer(instrumentationName, options.instrumentationVersion);
    this.#options = {
      ...(options.captureErrorMessages === undefined
        ? {}
        : { captureErrorMessages: options.captureErrorMessages }),
    };
  }

  emit(event: RunEvent): void {
    const mapping = mapRunEventToTelemetry(event, this.#options);
    const spans = this.#spansFor(mapping.scope);
    const key = spanKey(event, mapping.scope);
    let span = spans.get(key);

    if (mapping.action === "start" && !span) {
      span = this.#startSpan(event, mapping);
      spans.set(key, span);
      if (mapping.scope !== "run") {
        this.#childRunKeys.set(key, spanKey(event, "run"));
      }
    } else if (!span) {
      span = this.#nearestParent(event) ?? this.#ensureRunSpan(event);
    }

    const timestamp = eventTime(event);
    span.addEvent(event.type, mapping.attributes, timestamp);

    if (mapping.status === "error") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(mapping.errorMessage ? { message: mapping.errorMessage } : {}),
      });
    }

    if (mapping.action === "end") {
      if (mapping.status === "ok") span.setStatus({ code: SpanStatusCode.OK });
      if (mapping.scope === "run") this.#endRun(event, timestamp);
      else if (spans.has(key)) {
        span.end(timestamp);
        spans.delete(key);
        this.#childRunKeys.delete(key);
      }
    }
  }

  /** End any spans still open, for example during process shutdown. */
  shutdown(): void {
    for (const spans of [
      this.#toolSpans,
      this.#modelSpans,
      this.#stepSpans,
      this.#runSpans,
    ]) {
      for (const span of spans.values()) span.end();
      spans.clear();
    }
    this.#childRunKeys.clear();
  }

  #spansFor(scope: AgentRuntimeTelemetryScope): Map<string, Span> {
    if (scope === "run") return this.#runSpans;
    if (scope === "step") return this.#stepSpans;
    if (scope === "model") return this.#modelSpans;
    return this.#toolSpans;
  }

  #startSpan(event: RunEvent, mapping: AgentRuntimeTelemetryMapping): Span {
    const parent = this.#parentContext(event, mapping.scope);
    const startTime = eventTime(event);
    const options = {
      attributes: mapping.attributes,
      ...(startTime ? { startTime } : {}),
    };
    return this.#tracer.startSpan(mapping.spanName, options, parent);
  }

  #parentContext(event: RunEvent, scope: AgentRuntimeTelemetryScope): Context {
    const runSpan = this.#runSpans.get(spanKey(event, "run"));
    const parent =
      scope === "tool"
        ? (this.#activeModel(event) ?? this.#activeStep(event) ?? runSpan)
        : scope === "model"
          ? (this.#activeStep(event) ?? runSpan)
          : scope === "step"
            ? runSpan
            : undefined;
    return parent ? trace.setSpan(context.active(), parent) : context.active();
  }

  #nearestParent(event: RunEvent): Span | undefined {
    return (
      this.#activeModel(event) ??
      this.#activeStep(event) ??
      this.#runSpans.get(spanKey(event, "run"))
    );
  }

  #activeStep(event: RunEvent): Span | undefined {
    if (!event.stepId && !event.stepPath) return undefined;
    return this.#stepSpans.get(spanKey(event, "step"));
  }

  #activeModel(event: RunEvent): Span | undefined {
    return this.#modelSpans.get(spanKey(event, "model"));
  }

  #ensureRunSpan(event: RunEvent): Span {
    const key = spanKey(event, "run");
    const existing = this.#runSpans.get(key);
    if (existing) return existing;
    const mapping = mapRunEventToTelemetry(event, this.#options);
    const runMapping: AgentRuntimeTelemetryMapping = {
      ...mapping,
      scope: "run",
      action: "start",
      spanName: "agent_runtime.run",
    };
    const span = this.#startSpan(event, runMapping);
    this.#runSpans.set(key, span);
    return span;
  }

  #endRun(event: RunEvent, timestamp?: Date): void {
    const runKey = spanKey(event, "run");
    for (const spans of [this.#toolSpans, this.#modelSpans, this.#stepSpans]) {
      for (const [key, span] of spans) {
        if (this.#childRunKeys.get(key) !== runKey) continue;
        span.end(timestamp);
        spans.delete(key);
        this.#childRunKeys.delete(key);
      }
    }
    const runSpan = this.#runSpans.get(runKey);
    if (runSpan) runSpan.end(timestamp);
    this.#runSpans.delete(runKey);
  }
}
