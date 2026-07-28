# Interactive web example

The example runs the same agent locally or through the remote worker protocol
and streams ordered events to a browser. It uses a Node HTTP server and
browser-native HTML, CSS, and JavaScript. Model responses are rendered with
Marked, sanitized with DOMPurify, and highlighted with Highlight.js.

## Run the example

From the repository root:

```sh
npm run build
export OPENAI_API_KEY="..."
npm --prefix examples/interactive-web start
```

`OPENAI_API_KEY` is required because the example makes real model calls. Set it
in the same terminal that starts the server.

Open [http://127.0.0.1:4178](http://127.0.0.1:4178). The example uses the
OpenAI `gpt-5.6-luna` model and the public Context7 MCP endpoint; no Context7
key is required. The MCP result is returned to the model, written to
`contextNotes`, and consumed by the later draft and finalize steps.

The main page is the minimal interactive example. Open
[http://127.0.0.1:4178/visualizer](http://127.0.0.1:4178/visualizer) for the
same example with the event-driven execution visualization.

Choose Local or Remote before starting a run:

- Local uses `InProcessExecutionEngine`.
- Remote uses `RemoteExecutionEngine`, authenticated HTTP launch and callback
  endpoints, the versioned worker protocol, and a separate worker store.

Both modes use `ExecutionClient.follow()` and produce the same browser event
stream and final result.

On the visualizer page, the execution map is generated from the agent manifest
and updates from that event stream. It shows dependency fan-out and fan-in,
concurrent model responses, streamed character counts, MCP tool calls,
variable dependencies, and final completion. Run-variable pills connect to a
step while that step reads them, then yield to the model-response path when
streaming begins. The page-level Run agent control becomes Cancel run while an
execution is active.

Choose Sequential or Parallel step scheduling independently of the execution
engine. Parallel mode runs the draft and evidence-extraction steps together
after the Context7 step completes. Finalization waits for both outputs.

Context7 does not require authentication. To use a Context7 key for higher rate
limits, set `CONTEXT7_API_KEY`.

See [Models and providers](../../docs/models-and-providers.md) to use a
different hosted provider or a local model.

## Agent definition

- `interactive-brief.agent.yaml` is the reusable `AgentManifest`.
- The browser inputs become a validated `AgentRunManifest`.
- Agent variables have types, defaults, nested object values, and required run
  overrides.
- System prompts and prompt templates consume both top-level variables and
  nested properties.
- Step outputs write top-level variables such as `contextNotes` and
  `finalBrief`.
- A JEXL condition can skip the risk-review step.
- The agent run manifest selects sequential or dependency-safe parallel step
  scheduling.

## MCP connection and tool

- A read-only Context7 MCP connection is declared by the agent and configured
  separately by the host.
- `context7__query-docs` retrieves public documentation that is used by later
  agent steps.
- The system prompt treats external MCP output as untrusted reference data.

## Streaming and persistence

- `FileRunStore` persists local state under `.data/local/` and remote worker
  state under `.data/remote/`.
- Model text deltas and lifecycle, tool, checkpoint, and completion events
  stream as NDJSON over the run request.
- Closing or cancelling the browser request cancels the active execution.

The server returns the agent manifest, agent run manifest, ordered events,
usage, and final result.

## OpenTelemetry

`OpenTelemetryEventSink` receives the same run, step, model, and tool events as
the browser stream. It records metadata such as run IDs, event types, timing,
token usage, model names, tool names, and error codes. Prompt text, variable
values, model output, and tool payloads are excluded.

No exporter is enabled by default. Print completed spans to the server console:

```sh
AGENT_EXAMPLE_OTEL_CONSOLE=1 \
  npm --prefix examples/interactive-web start
```

Export OTLP traces to a collector:

```sh
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_SERVICE_NAME=agent-runtime-interactive-example \
  npm --prefix examples/interactive-web start
```

The server shuts down the telemetry sink and SDK when it receives `SIGINT` or
`SIGTERM`.

## Request and stream shape

The browser starts a run with:

```http
POST /api/runs
Content-Type: application/json
```

The response uses `application/x-ndjson`. Each line is one message:

```json
{"kind":"accepted","runId":"run-...","agentRunManifest":{}}
{"kind":"event","event":{"sequence":1,"type":"run.started"}}
{"kind":"event","event":{"sequence":8,"type":"model.text.delta","data":{"delta":"Hello"}}}
{"kind":"result","result":{"runId":"run-...","output":"..."}}
```

## Test

The tests use deterministic model and MCP adapters. They verify local and
remote execution, streamed events, persistence events, final output, and the
telemetry sink without calling external services:

```sh
npm run build
npm --prefix examples/interactive-web test
```
