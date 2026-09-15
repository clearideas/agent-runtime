# Agent Runner video walkthrough

## Video brief

**Working title:** Consume Agent Runtime in a tiny TypeScript web app

**Target length:** 12–14 minutes

**Audience:** TypeScript or Node.js developers who understand an HTTP app
but are new to Clear Ideas Agent Runtime.

**Viewer outcome:** A viewer should understand the important integration code:
configure a model, choose a `RunStore`, register the supported `StepExecutor`s,
provide condition evaluation, call `AgentRuntime.run()`, observe events, and
resume a failed run from its durable step checkpoint.

Keep returning to one sentence:

> The manifest selects behavior; the host supplies the behavior and durability.

## Recording preparation

Open a terminal in the `examples/agent-runner` directory:

```sh
npm install
export OPENAI_API_KEY="..."
npm start
```

Open `http://127.0.0.1:4180` and this directory in your editor. Reset `.data/`
before recording if you want an empty run history. Never show the API key or
environment contents on screen. Record the browser at 1920×1080 and 100% zoom;
the page is arranged to keep the manifest and runtime visible side by side at
that size.

## The integration code this tutorial teaches

Show these two blocks early. They are the central Agent Runtime consumption
path, without the surrounding HTTP or manifest-file code.

Construct a runtime with the behavior and storage the host supports:

```ts
const configuredModel = createConfiguredModelAdapter(manifest, runtimeConfig);

const runtime = new AgentRuntime({
  runStore: new FileRunStore(".data/runtime"),
  stepExecutors: [new PromptStepExecutor()],
  conditionEvaluator: new JexlConditionEvaluator(),
  ...(configuredModel ? { model: configuredModel } : {}),
  eventSinks: [{ emit: (event) => sendToBrowser(event) }],
});
```

Start a run, or recover the same run from its latest checkpoint:

```ts
const result = await runtime.run({ manifest, runId, variables, signal });

const resumed = await runtime.run({ runId, resume: true, signal });
```

This example does not add an execution engine, client, queue, or plugin system.
Its code demonstrates the runtime directly.

## Suggested timeline

| Time        | Screen                | Topic                                  |
| ----------- | --------------------- | -------------------------------------- |
| 0:00–0:40   | Finished app          | Show the outcome                       |
| 0:40–2:20   | `hello.agent.yaml`    | Steps, variables, and conditions       |
| 2:20–3:30   | `agent-host.ts`       | Model configuration and `FileRunStore` |
| 3:30–6:10   | `agent-host.ts`       | Executors and condition evaluation     |
| 6:10–8:10   | `agent-host.ts`       | Start a run and save checkpoints       |
| 8:10–10:10  | `agent-host.ts`       | Resume at the durable step cursor      |
| 10:10–11:10 | `server.ts`, `app.js` | Stream events across the HTTP boundary |
| 11:10–12:40 | `server.test.ts`      | Prove the completed step is not rerun  |
| 12:40–14:00 | Browser and host code | Recap the integration                  |

## Script

### 1. Show the finished workflow — 0:00

**On screen:** Select Hello brief, leave Concise enabled, and run it.

**Narration:**

> This is Agent Runner, a focused TypeScript host for Clear Ideas
> Agent Runtime. It saves manifests, creates an input form, shows step events,
> and stores run history. We will use the UI to see the runtime work, but the
> subject of this video is the integration code in `agent-host.ts`.

Point out that Outline and Write concise complete while Write detailed skips.

> Those states are not UI conventions. They come from the runtime's executor,
> condition, event, and checkpoint contracts.

### 2. Read the manifest as an execution request — 0:40

**On screen:** `hello.agent.yaml`. Highlight `model.ref`, `variables`, each
`type: prompt`, and the two `when` expressions.

**Narration:**

> A manifest declares what should happen. It does not contain the code that
> makes a prompt step run. Each step has a type, and the host must register an
> executor for that type.

> The first prompt writes an outline into runtime state. The next two steps are
> conditional branches. If Concise is true, one writer runs and the other is
> skipped. If it is false, the opposite happens. Both branches read the outline
> produced by the first step.

> This gives us three runtime concepts in one manifest: step dispatch,
> shared variable state, and condition evaluation.

### 3. Configure persistence and the model — 2:20

**On screen:** The first half of `createAgentHost` in `agent-host.ts`.

**Narration:**

> The host defines `default` as OpenAI GPT-5.6 Luna. The manifest selects the
> profile; the host owns the provider, model name, and API key.

Highlight `FileRunStore`.

> The run store is more than completed-run history. Agent Runtime writes the
> lifecycle record and checkpoints through this interface. A checkpoint holds
> the execution cursor, variables, completed step results, transcript, and
> other continuation state needed for recovery.

> We create the store once and give the same instance to every runtime created
> by this host.

### 4. Register executable behavior — 3:30

**On screen:** `createRuntime` in `agent-host.ts`. Highlight
`stepExecutors`.

**Narration:**

> `stepExecutors` is one of the most important host decisions. Agent Runtime
> reads a step's `type` and dispatches it to the matching executor. This host
> registers only `PromptStepExecutor`, so prompt steps work and other step types
> are rejected.

> The prompt executor renders the prompt from current variables, calls the
> model adapter, emits streaming model events, and returns a state patch and
> transcript items to the runtime. The runtime—not the executor—commits that
> result and advances the durable cursor.

Highlight `conditionEvaluator`.

> Before dispatching a step with `when`, the runtime asks the condition
> evaluator to evaluate the expression against current variables. Here JEXL
> turns `concise == true` into a boolean. A false condition emits a skipped-step
> event and still advances the checkpoint, so recovery does not reconsider work
> that was already committed.

Highlight `eventSinks`.

> The event sink observes those decisions: started, skipped, completed, model
> deltas, and checkpoint saves. It does not drive execution.

### 5. Start and checkpoint a run — 6:10

**On screen:** `execute` in `agent-host.ts`, from `parseAgentRunManifest`
through `runtime.run()`.

**Narration:**

> The browser supplies a saved manifest ID and input values. The host validates
> those values with `parseAgentRunManifest`, creates a run ID, then constructs a
> runtime with the manifest's configured model.

> The first `runtime.run` call includes the resolved manifest and input values.
> Agent Runtime creates the run record and an initial checkpoint. In sequential
> execution it then repeats a clear cycle: evaluate the condition, invoke the
> matching executor if needed, commit its state change, and save a checkpoint
> whose cursor points to the next step.

> If the outline commits successfully and the following model call fails, the
> latest checkpoint already contains the outline and points at the concise
> writer. The failed call is not mistaken for committed work.

### 6. Resume at the durable step cursor — 8:10

**On screen:** `resume` in `agent-host.ts`.

**Narration:**

> Resume is intentionally short. The browser sends the existing run ID. The
> host loads its record so it can recreate the same model adapter, constructs
> the same runtime dependencies, and calls `run` with that run ID and
> `resume: true`.

> We do not pass new variables, reconstruct state, or tell the runtime to start
> at a hand-picked step. `FileRunStore` supplies the latest checkpoint. Agent
> Runtime verifies that its manifest matches, restores its state and prior
> results, reserves a new attempt, and continues from the checkpoint's next
> step index.

> That distinction matters: this is durable recovery at a known step boundary,
> not arbitrary rewinding. Completed and cancelled runs are terminal. This
> example offers Resume only for failed or suspended runs.

### 7. Keep transport outside the integration — 10:10

**On screen:** `handleRun` in `server.ts`, followed by `streamRun` and
`processMessage` in `public/app.js`.

**Narration:**

> The server uses one endpoint for both paths. A manifest ID starts a run; a run
> ID resumes one. In either case it writes callback messages as newline-delimited
> JSON and forwards browser disconnection through an abort signal.

> The browser maps step events to the progress list, appends model text deltas,
> and displays the terminal `RunResult`. Its `stepResults` contain the committed
> output of each executed step, so the UI shows those beneath the step statuses
> as well as showing the selected final output. The Resume button simply sends
> the selected failed or suspended run ID. Ace only highlights the manifest
> source; the browser sends that same YAML or JSON string to the host. None of
> this UI or HTTP code decides which step runs next.

### 8. Prove recovery with a deterministic failure — 11:10

**On screen:** The resume test in `server.test.ts`, then run:

```sh
npm test
```

**Narration:**

> The test model succeeds for the outline, fails once in the writing step, and
> then succeeds when the same run is resumed. The assertion checks for
> `run.resumed` and proves that Outline was called exactly once. That is the
> key recovery guarantee visible at the integration boundary: state committed
> before the failure is restored instead of recomputed.

### 9. Recap the host contract — 12:40

**On screen:** Return to `createRuntime`, `execute`, and `resume` in
`agent-host.ts`.

**Narration:**

> Each dependency in the reusable integration has a real job. The
> model adapter performs inference. Step executors implement the manifest's
> step types. The condition evaluator decides guarded steps against runtime
> state. The run store commits lifecycle and checkpoint data. Event sinks make
> execution observable.

> A new run supplies a manifest and variables. A recovered run supplies its ID
> and `resume: true`. Agent Runtime coordinates the executors, conditions,
> commits, events, and recovery cursor.

> A production host would use stronger multi-process storage and ownership
> fencing, but the integration shape stays the same: the manifest selects
> behavior; the host supplies the behavior and durability.

## Optional follow-up video

Use `examples/interactive-web` for a second video about remote execution, MCP
tools, dependency-safe parallel scheduling, reconnection, and OpenTelemetry.
