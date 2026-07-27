# `@clearideas/agent-runtime-telemetry-otel`

An OpenTelemetry `EventSink` for Agent Runtime.

```ts
import { OpenTelemetryEventSink } from "@clearideas/agent-runtime-telemetry-otel";

const telemetry = new OpenTelemetryEventSink();
// Pass `telemetry` to the `AgentRuntime` constructor in its `eventSinks` array.
```

The sink uses the global OpenTelemetry tracer by default and accepts an
explicit `Tracer` for applications that configure telemetry independently. It
creates nested run, step, model, and tool spans. If no SDK/provider is
registered, the OpenTelemetry API supplies a no-op tracer.

## Data policy

Telemetry is metadata-only by default. The mapper uses an allowlist and does
not record prompts, text/reasoning deltas, variable values, outputs, tool
arguments/results, arbitrary payload fields, error stacks, or error messages.
It records identifiers, event and step types, timing, token counts, and error
codes. Error messages require an explicit `captureErrorMessages: true` opt-in.

Call `shutdown()` during process teardown to end spans left open by an
interrupted run. Configure exporter flushing in the application's OpenTelemetry
SDK.
