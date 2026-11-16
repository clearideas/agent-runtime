---
title: Execution policies
description: Configure how runs handle input limits, model errors, invalid output, tool-call limits, and failed steps.
---

# Execution policies

Execution policies configure whether a run retries, reduces context, attempts
output repair, suspends, or fails when it encounters a limit or error. Choose
the behavior appropriate to the task and the host's requirements.

## Layers

Policies are set in four places. Each layer overrides the previous one field
by field:

1. **Host defaults**: `new AgentRuntime({ policies })`, or `policies` in a CLI
   runtime module.
2. **Manifest**: the top-level `policies` block.
3. **Step**: a step's own `policies` block.
4. **Host-enforced**: `new AgentRuntime({ enforcedPolicies })`, or
   `enforcedPolicies` in a CLI runtime module. These apply last, so a manifest
   cannot override them. Use them for limits an agent must not raise, such as
   the summarizer's model or call budget.

```yaml
policies:
  context:
    strategy: summarize-or-prune
  modelRetry:
    maxAttempts: 4

steps:
  - id: research
    type: prompt
    prompt: Research the topic.
    policies:
      context:
        strategy: prune # this step never calls the summarizer
```

`context`, `toolCallLimit`, `modelRetry`, and `outputRepair` apply to prompt
steps; setting them on another step type fails validation. `onError` applies to
every step type. `onFailure` applies to the whole run: set it on the host or in
the manifest's `policies`; a step's `policies` cannot set it.

## Defaults

| Policy                      | Default    | Meaning                                                           |
| --------------------------- | ---------- | ----------------------------------------------------------------- |
| `context.strategy`          | `prune`    | reduce oversized input without a model call                       |
| `context.reduceTo`          | 0.25       | a reduction aims for 25% of the trigger: few, deep reductions     |
| `context.openingShare`      | 0.5 / 0.9  | opening-prompt budget with / without tools, × the trigger         |
| `context.toolResultShare`   | 0.4        | largest single tool result, × the trigger                         |
| `context.retain`            | 2 rounds   | newest tool rounds kept verbatim, when the goal allows            |
| `context.maxCompactions`    | 25         | summarizer compactions per step execution                         |
| `toolCallLimit`             | `finalize` | at the tool-call limit, ask for a final answer instead of failing |
| `modelRetry.maxAttempts`    | 3          | attempts per model request for retryable errors                   |
| `modelRetry.initialDelayMs` | 1000       | backoff doubles after each attempt                                |
| `modelRetry.maxDelayMs`     | 20000      | longest wait between attempts                                     |
| `outputRepair.maxAttempts`  | 1          | extra turns to repair invalid, empty, or truncated output         |
| `onError`                   | `fail`     | a failed step ends the attempt (see `onFailure`)                  |
| `onFailure`                 | `pause`    | a failure that is not fatal blocks the run until the host acts    |

Set `context.strategy: fail` and `toolCallLimit: fail` to restore the behavior
of earlier releases.

## Context

See [Context management](./context-management.md). With the default policy, an
oversized opening prompt, tool result, or tool loop is pruned to fit instead of
failing the step.

## Model errors

Rate limits, provider overload, server errors, timeouts
(`limits.providerTimeoutMs`), and dropped connections are retried with
exponential backoff. Each retry emits `model.retry` with the attempt number,
delay, and error name or HTTP status. Authentication errors, invalid requests,
and other errors that would fail again are not retried. A provider's
context-overflow error is handled by [context reduction](./context-management.md#when-reduction-happens),
not by retrying the same request.

```yaml
policies:
  modelRetry:
    maxAttempts: 5
    initialDelayMs: 2000
    maxDelayMs: 60000
```

A streaming attempt that fails after emitting text is retried from the start;
clients that display `model.text.delta` should reset the step's text when they
receive `model.retry`.

## Output repair

| Condition                                   | Repair                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Final output does not match `outputSchema`  | the model is told why and asked again                                                     |
| `completionPolicy.requireOutput` and empty  | the model is asked for its final answer                                                   |
| Truncated response (`finishReason: length`) | the request is repeated with twice the output budget, up to the model's `maxOutputTokens` |

Each repair emits `model.retry` and counts against `outputRepair.maxAttempts`.
The truncated response stays in the transcript but is hidden from the retry.

## Tool calls

Agent Runtime runs only the tools a step names. A call to any other tool, or a
call the model adapter marks invalid, receives an error result the model can
read and act on. Nothing is executed, and a call is never answered twice.

When a step reaches `limits.maxToolCallsPerIteration` with
`toolCallLimit: finalize`, further calls in that response receive a
`tool_call_limit_reached` error, and the next request asks for a final answer
with `toolChoice: none`. The tools stay defined so providers accept the
history. `toolCallLimit: fail` fails the step instead.

If a connection marked `required: false` is unreachable, a step that names its
tools runs without them. The model is told which tools are unavailable and
why, and a `TOOLS_UNAVAILABLE` diagnostic is emitted. A required connection
that is unreachable fails the run before it starts.

## Failed steps

`onError: continue` records a failed step as a result instead of failing the
run. The step's output, and its `outputVariable`, become:

```json
{ "error": { "code": "AGENT_EXECUTION_FAILED", "message": "..." } }
```

A `step.failed` event with `handled: true` is emitted, and the run continues.
Later steps can branch on the error or pass it to a model:

```yaml
steps:
  - id: enrich
    type: webhook
    url: https://enrichment.example.com/lookup
    retries: 2
    outputVariable: enrichment
    policies:
      onError: continue

  - id: draft
    type: prompt
    prompt: |-
      Draft the account summary. Enrichment data, or the error that prevented
      it: {{ enrichment }}
```

Inside a loop, a child with `onError: continue` records the error as that
iteration's result and the loop moves on. Suspensions, pauses, interruptions,
and cancellations are never converted into results.

### When a failure ends the attempt

A failure that `onError` does not handle ends the attempt. With the default
`onFailure: pause`, the run is not failed: it is suspended with kind
`awaiting-host` (reason `blocked`), keeping everything committed so far, and
resumes from its latest checkpoint once the host fixes the cause, such as a
provider outage, an expired credential, or a broken tool. This covers
exhausted model retries, output that is still invalid after repair, exhausted
webhook retries, timeouts, and every other error that is not fatal. `run()`
rejects with a `RunSuspendedError` whose `cause` is the original error.

Before 0.10, such a run failed. Set `onFailure: fail` on the host for every
run, or in a manifest's `policies`, to keep that behavior:

```ts
new AgentRuntime({ policies: { onFailure: "fail" }, ...dependencies });
```

```yaml
policies:
  onFailure: fail
```

Fatal errors fail the run whatever `onFailure` says:

- manifest and conversation-message validation errors;
- a completed step whose definition changed (`MANIFEST_CHANGED`);
- a rejected approval with `onReject: fail`;
- an MCP tool-integrity violation;
- any error with `fatal: true`, such as a `RunFatalError` a host throws from an
  adapter or hook to refuse an operation on policy grounds.

```ts
import { RunFatalError } from "@clearideas/agent-runtime";

authorizeDestination: async (url) => {
  if (!allowed(url))
    throw new RunFatalError(`Destination ${url.host} is not allowed`);
},
```

## Run limits

Run limits stop a runaway run. Every run has `DEFAULT_RUN_LIMITS`, set far
above what normal runs use; the host's defaults
(`new AgentRuntime({ limits })`), the manifest's `limits`, and limits granted
on a resume replace them, in that order:

```yaml
limits:
  maxTotalTokens: 2000000
  maxRunActiveMs: 3600000
  maxTurnsPerPrompt: 100
  maxEstimatedCost: 5
  sandbox:
    maxCommands: 300
```

A step execution is one run of a step that does work: a top-level step, or
one loop iteration's child. A loop is not one; it is bounded by the run's
limits and `maxLoopIterations`.

| Limit                       | Default       | Counts                                                                    |
| --------------------------- | ------------- | ------------------------------------------------------------------------- |
| `maxTotalTokens`            | 25,000,000    | model tokens reported across the run                                      |
| `maxStepTokens`             | none          | model tokens reported by one step execution                               |
| `maxEstimatedCost`          | none          | `estimatedCost` adapters report across the run, in the adapters' currency |
| `maxRunActiveMs`            | 24 hours      | execution time across all attempts                                        |
| `maxStepActiveMs`           | 4 hours       | execution time of one step execution, across attempts                     |
| `maxRecoveries`             | 100           | resumes after a failure, an interruption, a takeover, or an error block   |
| `maxResumesWithoutProgress` | 10            | consecutive recoveries that commit no new checkpoint (a crash loop)       |
| `maxTurnsPerPrompt`         | 500           | model requests of one prompt step execution                               |
| `maxLoopIterations`         | 10,000        | iterations of one loop step execution                                     |
| `maxArtifacts`              | 10,000        | artifacts the run records                                                 |
| `maxArtifactBytes`          | 10 GiB        | bytes of artifacts the run records                                        |
| `maxCheckpointBytes`        | 64 MiB        | serialized size of one checkpoint                                         |
| `sandbox.*`                 | host's values | run-sandbox usage; see [Workspaces](./workspaces.md#sandbox-usage-limits) |

Resumes that answer an approval, a child run, a token budget, a granted limit,
or a pause are not recoveries and never count against a limit.

Reaching a limit blocks the run (kind `awaiting-host`, `details.cause:
"limit"`) at a point it can resume from: time limits abort the attempt,
token, artifact, and size limits are checked at each checkpoint, and loop and
turn limits before the next iteration or model request. The run resumes once
a higher limit is granted: change the manifest's `limits` (a resume accepts
it), or pass `limits` on the resume request, which is kept for later attempts
too. See
[Granting higher limits](./persistence-and-recovery.md#granting-higher-limits).

Hosts can cap any limit with `new AgentRuntime({ enforcedLimits })`: a
ceiling that no manifest or resume request can exceed. CLI and
`agent-runtime serve` hosts set `limits` and `enforcedLimits` in their runtime
module; `serve` also accepts them per served model.

The explicit token budget (`budget.maxTotalTokens` on a run request, suspension
kind `awaiting-budget`) is separate: it requires every model call to report
usage and runs steps sequentially, while `limits.maxTotalTokens` counts the
usage models report and changes nothing else.

## Approvals

`onReject` decides what a rejected approval does:

| `onReject`       | Result                                                                           |
| ---------------- | -------------------------------------------------------------------------------- |
| `fail` (default) | the run fails                                                                    |
| `cancel`         | the run is cancelled                                                             |
| `complete`       | the run completes successfully without running later steps                       |
| `continue`       | `{ approved: false, respondedAt, response? }` is recorded and the next step runs |

```yaml
steps:
  - id: review
    type: approval
    prompt: Publish the report?
    outputVariable: review
    onReject: continue
  - id: publish
    type: prompt
    when: review.approved == true
    prompt: Publish the report.
  - id: revise
    type: prompt
    when: review.approved == false
    prompt: Revise the report using the reviewer's response {{ review.response }}.
```

`action` is informational: it is forwarded in events and on
`ApprovalRejectedError`.

## Checks before a run starts

Before a run is created, Agent Runtime checks that the host can execute every
step, including steps inside loops:

- each step type has a registered executor;
- each executor has the adapters it needs (a `ModelAdapter` for prompt steps,
  an `ApprovalAdapter` for approvals, a `SandboxAdapter` or run sandbox for
  code, a `SubRunAdapter` for sub-runs);
- `when`, loop `condition`, and loop `goal` expressions parse;
- every tool a prompt step names exists, was excluded by host policy, or
  belongs to an optional source that is unavailable.

All problems are reported together in one `MANIFEST_PREFLIGHT_FAILED` error, and
no run record is created. Custom executors contribute checks by implementing
`StepExecutor.preflight`.

## What still stops a run

| Condition                                                          | Outcome                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| A required connection, workspace, or model is unavailable at start | the run does not start; a resume is refused and the run is unchanged  |
| A step fails with an error that is not fatal                       | the run is blocked (`awaiting-host`); resume after fixing the cause   |
| A run limit is reached                                             | the run is blocked (`awaiting-host`); resume with a higher limit      |
| A fatal error, or any failure under `onFailure: fail`              | the run fails                                                         |
| The token budget is used up                                        | the run is suspended (`awaiting-budget`); resume with a higher budget |
| An approval is pending, or a host pauses the run                   | the run is suspended                                                  |
| An execution engine times out or shuts down                        | the run is interrupted; resume continues it                           |
| A person cancels the run                                           | the run is cancelled                                                  |

See [Persistence and recovery](./persistence-and-recovery.md#run-states) for the
run states.
