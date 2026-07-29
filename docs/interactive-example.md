---
title: Interactive web example
description: Run an agent from a browser with live model, tool, step, and lifecycle events.
---

# Interactive web example

The interactive example is a complete browser application backed by Agent
Runtime. It executes a five-step agent with an OpenAI model and the public
Context7 MCP server, then streams progress and output to the page.

Use it to see the same agent run:

- locally with `InProcessExecutionEngine`
- through the authenticated HTTP worker protocol with `RemoteExecutionEngine`
- sequentially or with dependency-safe parallel step scheduling

## Run the example

The example requires Node.js 24 or newer.

```sh
git clone https://github.com/clearideas/agent-runtime.git
cd agent-runtime
npm ci
npm run build
```

::: warning OpenAI API key required
The example makes real model calls. Set `OPENAI_API_KEY` in the same terminal
that starts the server:

```sh
export OPENAI_API_KEY="..."
```

The example cannot start an OpenAI model run without this environment
variable.
:::

Start the server:

```sh
npm run example:web
```

Open [http://127.0.0.1:4178](http://127.0.0.1:4178).

Context7 does not require authentication. If you have a Context7 API key, set
`CONTEXT7_API_KEY` before starting the server.

## Run an agent

The form supplies the variables required by the agent manifest:

| Variable                | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `topic`                 | subject of the brief                              |
| `audience`              | intended reader                                   |
| `libraryId`             | Context7 library in `/organization/project` form  |
| `documentationQuestion` | question sent to the Context7 `query-docs` tool   |
| `includeRisks`          | enables or skips the risk-review step             |
| `style`                 | object containing the requested tone and word cap |

Choose an execution engine and scheduling mode, then select **Run agent**.

- **Local** executes in the example server process.
- **Remote** sends a versioned worker invocation through authenticated launch
  and callback endpoints.
- **Sequential** runs one eligible step at a time.
- **Parallel** runs independent prompt steps concurrently, up to the run's
  `maxConcurrency` value.

The page adds each step output as it becomes available. The final output
appears only after the run completes and all steps marked
`includeInFinalOutput` have been collected. While a run is active, the run
control becomes **Cancel run**.

## View manifest graph execution

Open
[http://127.0.0.1:4178/visualizer](http://127.0.0.1:4178/visualizer) to run the
same agent with an event-driven execution map.

The map is generated from the agent manifest and visualizes the
dependency-aware execution plan resolved by the runtime. It shows:

- run variables read by each step
- step dependencies, fan-out, and fan-in
- calls to the model and Context7 MCP tool
- model responses streaming into active steps
- step completion, final-output assembly, and elapsed time

The visualizer consumes the same event stream as the standard page; it does not
simulate execution or infer completion from rendered text.

## Agent flow

The bundled agent follows this dependency graph:

```text
gather-context (Context7 MCP)
        |
        +-------------------+
        |                   |
        v                   v
      draft          extract-evidence
        |
        v
   review-risks
        |                   |
        +---------+---------+
                  |
                  v
               finalize
```

`draft` and `extract-evidence` both consume `contextNotes`, so parallel
scheduling can run them together. `review-risks` waits for `briefDraft`, and
`finalize` waits for the draft, evidence, and optional risk review.

The browser inputs become an `AgentRunManifest` with top-level variable
overrides and the selected scheduling policy:

```ts
const agentRunManifest = {
  schemaVersion: "1.0",
  agent: { ref: "interactive-brief.agent.yaml" },
  runId,
  variables: [
    { key: "topic", value: topic },
    { key: "audience", value: audience },
    { key: "libraryId", value: libraryId },
    { key: "documentationQuestion", value: documentationQuestion },
    { key: "includeRisks", value: includeRisks },
    { key: "style", value: { tone, maxWords } },
  ],
  execution: {
    mode: "parallel",
    maxConcurrency: 4,
  },
};
```

Variable override keys match the top-level declarations in the agent manifest.
Dot notation is used only when prompts read nested object properties, such as
<code v-pre>{{ style.maxWords }}</code>.

## Streaming

`POST /api/runs` returns `application/x-ndjson`. Each line is an accepted
message, run event, completed result, or error:

```json
{"kind":"accepted","runId":"run-...","agentRunManifest":{}}
{"kind":"event","event":{"sequence":1,"type":"run.started"}}
{"kind":"event","event":{"sequence":8,"type":"model.text.delta","data":{"delta":"Hello"}}}
{"kind":"result","result":{"runId":"run-...","output":"..."}}
```

The browser processes messages in order. Model deltas update the corresponding
step output, while step and run events update status, usage, and timing. Closing
the request or selecting **Cancel run** cancels the active execution.

## Persistence and telemetry

Local run state is stored under `examples/interactive-web/.data/local/`.
Remote-worker state is stored separately under
`examples/interactive-web/.data/remote/`.

Print completed OpenTelemetry spans to the server console:

```sh
AGENT_EXAMPLE_OTEL_CONSOLE=1 npm run example:web
```

Send traces to an OTLP collector:

```sh
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_SERVICE_NAME=agent-runtime-interactive-example \
  npm run example:web
```

Telemetry includes run, step, model, and tool metadata. Prompt text, variable
values, model output, and tool payloads are excluded.

## Test the example

The tests use deterministic model and MCP adapters, so they do not call an
external service:

```sh
npm run build
npm --prefix examples/interactive-web test
```

They cover local and remote execution, ordered streaming, final output,
persistence events, cancellation, and telemetry.
