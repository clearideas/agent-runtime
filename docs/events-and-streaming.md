---
title: Events and streaming
description: Stream model output, observe lifecycle events, implement callbacks, and reconnect remote clients.
---

# Events and streaming

## Interactive CLI

```sh
agent-runtime run ./agent.yaml --stream --format pretty
```

Model text is written to stdout. Lifecycle progress is written to stderr.
Reasoning deltas require `--show-reasoning`.

For a client or shell pipeline:

```sh
agent-runtime run ./agent.yaml --format ndjson
```

Each line is a JSON event or terminal result. `--format json` emits a completion
summary without prompts, variables, transcripts, or model output.

## Event sinks as callbacks

Embedding hosts subscribe with one or more `EventSink` implementations:

```ts
import type { EventSink } from "@clearideas/agent-runtime-core";

const callbacks: EventSink = {
  async emit(event) {
    switch (event.type) {
      case "model.text.delta":
        process.stdout.write(String(event.data?.delta ?? ""));
        break;
      case "step.completed":
        await publishProgress(event.runId, event.stepId);
        break;
      case "run.failed":
        await incrementFailureMetric(event.runId);
        break;
    }
  },
};
```

Pass it in `new AgentRuntime({ eventSinks: [callbacks], ... })`.

By default, sink failures call `onEventSinkError` without failing the run. Set
`eventSinkFailurePolicy: "fail-run"` when event delivery is required for the
run. A sink failure cannot reverse a saved checkpoint or completed run.

## Ordering

Events carry:

```ts
{
  id: string
  runId: string
  attempt?: number
  sequence: number
  timestamp: string
  type: string
  stepId?: string
  stepPath?: string
  data?: JsonObject
  payload?: JsonObject
}
```

Order by `(runId, attempt ?? 1, sequence)`. Sequence numbers restart for each
resumed attempt. Remote streams use `{ attempt, sequence }` as a reconnect
cursor. Agent Runtime emits event values in `data`. Adapter-provided events may
also contain `payload`.

## Remote streaming

`ExecutionClient.follow()` reconnects a remote event stream without replaying
events already delivered:

```ts
const followed = await client.follow(handle, {
  onEvent: (event) => sendToBrowser(event),
  reconnectDelayMs: 500,
  maximumReconnects: 5,
  signal,
});
```

An execution engine's `events()` implementation must replay events strictly
after the supplied cursor and end only when execution is terminal.

## OpenTelemetry

Add `OpenTelemetryEventSink` alongside application callbacks:

```ts
import { OpenTelemetryEventSink } from "@clearideas/agent-runtime-telemetry-otel";

const telemetry = new OpenTelemetryEventSink();

const agentRuntime = new AgentRuntime({
  eventSinks: [callbacks, telemetry],
  // model and step adapters
});

await telemetry.end();
```

The sink records run, step, model, and tool metadata. It excludes prompt text,
variable values, model output, and tool payloads.

The [Showcase](./showcase.md) demonstrates streaming runtime events to a
browser in both local and remote execution. Its hosts use browser event sinks;
to add tracing, register OpenTelemetryEventSink alongside those sinks as shown
above. Configure OTEL_TRACES_EXPORTER=otlp and OTEL_EXPORTER_OTLP_ENDPOINT
for an OpenTelemetry collector.

## Event catalog

The supported event families are:

| Family      | Events                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Run         | `run.started`, `run.resumed`, `run.suspended`, `run.interrupted`, `run.completed`, `run.failed`, `run.cancelled`, `run.heartbeat` |
| Step        | `step.started`, `step.skipped`, `step.completed`, `step.failed`                                                                   |
| Model       | `model.started`, `model.text.delta`, `model.reasoning.delta`, `model.usage`, `model.completed`, `model.retry`                     |
| Tool        | `model.tool.requested`, `model.tool.started`, `model.tool.completed`                                                              |
| Context     | `context.reduced`                                                                                                                 |
| Loop        | `loop.iteration.started`, `loop.iteration.completed`, `loop.iteration.skipped`, `loop.goal.met`                                   |
| Standard    | approval, webhook, code execution, and sub-run lifecycle events                                                                   |
| Storage     | `checkpoint.saved`, `artifact.created`                                                                                            |
| Workspaces  | `workspace.bound`, `sandbox.opened`, `sandbox.command.started`, `sandbox.command.completed`, `sandbox.closed`                     |
| Diagnostics | `diagnostic`                                                                                                                      |

Notes on recent additions:

- `run.suspended` carries `reason` and `kind` (`awaiting-input`,
  `awaiting-child`, `awaiting-budget`, `paused`, or `other`);
  `run.interrupted` carries `reason`. See
  [run states](./persistence-and-recovery.md#run-states).
- `step.failed` with `handled: true` means an `onError: continue` policy
  recorded the failure and the run continues.
- `model.started`, `model.completed`, and `model.usage` carry
  `purpose: "summarize"` for summarizer calls. Usage reported by a host
  summarizer adapter arrives as `model.usage` with `source: "host"`.
- `model.retry` carries `reason` (`retryable-error`, `context-overflow`,
  `invalid-output`, `empty-output`, or `truncated-output`) and `attempt`. A
  streaming client should discard the step's partial text when it arrives.
- `context.reduced` carries `scope`, `strategy`, `reason`, and byte sizes. See
  [Context management](./context-management.md#events).
- `model.tool.completed` carries `rejected: true` for calls that were answered
  with an error instead of being run.
- Diagnostics codes include `TOOLS_UNAVAILABLE`, `TOOL_CALL_LIMIT_REACHED`,
  `USAGE_ESTIMATED`, `CONTEXT_SUMMARY_FAILED`, `COMPACTION_LIMIT_REACHED`, and
  `RUN_ENDED_BY_STEP`.

Consumers must ignore unknown event types so compatible additions do not break
clients.

## Privacy

Raw event sinks, including `JsonlEventSink`, receive complete events. The CLI's
local JSONL sink omits transient text and reasoning deltas and redacts common
credential fields. OpenTelemetry records metadata by default. Configure
retention, access control, and redaction for each custom sink.
