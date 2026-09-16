# Agent Runner example

Agent Runner is a focused web host for Clear Ideas Agent Runtime.
It lets you add YAML or JSON agent manifests, generates a form from their
variables, streams each run to the browser, and saves manifests and run history
to local files.

Use this example when you want to understand how an application embeds Agent
Runtime. The more advanced `interactive-web` example covers remote execution,
MCP tools, dependency visualization, and OpenTelemetry.

## Run it

Open a terminal in this directory:

```sh
npm install
export OPENAI_API_KEY="..."
npm start
```

Open [http://127.0.0.1:4180](http://127.0.0.1:4180).

The Node host, storage layer, and tests are TypeScript. Node.js 24 runs these
erasable-type `.ts` files directly, so the example does not need a compile-to-
JavaScript step. The browser client remains plain JavaScript and has no frontend
build pipeline. Ace adds YAML and JSON highlighting to the manifest editor from
its prebuilt browser files.

The example intentionally fixes the model to `openai/gpt-5.6-luna`, so the only
model setting you need is `OPENAI_API_KEY`.

## Try the workflow

1. Select the bundled **Hello brief** agent.
2. Change one or more inputs and choose **Run agent**.
3. Watch the outline run, one conditional writing step run, and the other skip.
4. Edit the manifest YAML and choose **Save manifest**.
5. Choose **New** to paste another manifest.
6. Select an item under Recent runs to reopen its output. Failed or suspended
   runs can be resumed from their latest checkpoint.

Local data is written under `.data/`. Remove that directory when you want to
reset the example.

## How it works

The browser uses three API endpoints:

- `GET` and `POST /api/manifests` list, validate, and save manifests.
- `POST /api/runs` starts or resumes a run and streams newline-delimited JSON.
- `GET /api/runs` lists records already saved by `FileRunStore`.

For every run, the server:

1. loads the selected manifest;
2. validates the browser's variable overrides as an `AgentRunManifest`;
3. creates the model adapter named by the manifest;
4. registers `PromptStepExecutor` as the supported step behavior;
5. supplies `JexlConditionEvaluator` for manifest `when` expressions; and
6. calls `runtime.run()`, streaming its events and final result to the browser.

`AgentRuntime` saves a checkpoint before execution and after each committed
step. A resume request supplies the same run ID and `resume: true`; the runtime
loads the latest checkpoint from `FileRunStore`, restores variables and prior
step results, then continues at the checkpoint's next step. The host does not
manually reconstruct state or choose an arbitrary step.

The browser maps `step.*` events to the progress list and appends
`model.text.delta` events to the output area. The terminal result adds each
step's output and replaces the stream with the durable final output.

## Deliberate limits

This is a learning example, not a multi-user agent service.

- It uses one Node.js process and `FileRunStore`.
- Active executions live in memory; run records and checkpoints survive a
  restart.
- The host defines one model profile: `openai/gpt-5.6-luna`.
- Only the prompt executor is registered; loops, tools, webhooks, code
  execution, approvals, sub-runs, authentication, and remote workers are not.
- Imported manifests can describe unsupported capabilities, but those runs are
  rejected because the host never supplies the corresponding adapters.

These boundaries demonstrate an important host rule: accepting a manifest does
not grant it infrastructure capabilities.

## Files worth reading

- `agent-host.ts` — the complete typed Agent Runtime consumption path
- `server.ts` — HTTP routes and static-file wiring
- `storage.ts` — manifest validation and file persistence
- `public/app.js` — variable forms and NDJSON event handling
- `hello.agent.yaml` — the bundled conditional prompt agent
- `server.test.ts` — deterministic end-to-end tests with a fake model
- `WALKTHROUGH.md` — a ready-to-record tutorial script

## Test

The tests do not call a real model or require credentials:

```sh
npm test
```
