---
title: Execution policies
description: Decide how a run handles oversized input, model errors, invalid output, tool-call limits, and failed steps so that it completes whenever completion is possible.
---

# Execution policies

A run should stop only when it cannot continue: a required connection is
down, a host policy denies something, or a person cancels it. Conditions that
have a safe mitigation are handled instead. Execution policies decide those
mitigations.

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
every step type.

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
| `onError`                   | `fail`     | a failed step fails the run                                       |

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

| Condition                                                 | Outcome                                                   |
| --------------------------------------------------------- | --------------------------------------------------------- |
| A required connection, workspace, or model is unavailable | the run fails; it can be resumed after the cause is fixed |
| A host or manifest policy denies an operation             | the run fails                                             |
| The token budget is used up                               | the run is suspended; resume with a higher budget         |
| An approval is pending, or a host pauses the run          | the run is suspended                                      |
| An execution engine times out or shuts down               | the run is interrupted; resume continues it               |
| A person cancels the run                                  | the run is cancelled                                      |
| A strategy of `fail`, or a limit with no mitigation       | the run fails                                             |

See [Persistence and recovery](./persistence-and-recovery.md#run-states) for the
run states.
