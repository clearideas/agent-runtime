---
title: Persistence and recovery
description: Store run state, checkpoint nested execution, resume safely, and fence stale attempts.
---

# Persistence and recovery

## Store choices

| Store             | Best for                                         | Concurrency            |
| ----------------- | ------------------------------------------------ | ---------------------- |
| `MemoryRunStore`  | tests and ephemeral runs                         | one process            |
| `FileRunStore`    | local CLI use                                    | one process            |
| `SqliteRunStore`  | durable local services                           | transactional, fenced  |
| custom `RunStore` | hosted SQL, MongoDB, object-backed control plane | implementation-defined |

Database integrations implement `RunStore`.

## RunStore contract

A durable store implements create/load, latest checkpoint, resume reservation,
checkpoint save, suspension, completion, failure, and cancellation.

Store requirements:

- run IDs are unique;
- terminal states are immutable;
- checkpoint sequence increases monotonically;
- `resumeRun` atomically reserves a new attempt;
- writes carry the expected attempt and reject stale owners;
- a checkpoint and its state change are committed atomically where possible;
- when `resumeRun` receives `options.manifest`, it stores that manifest as
  the run's, so later resumes use it (see
  [manifest changes](#manifest-changes-on-resume)).

Optional members:

| Member                                   | Purpose                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `interruptRun`                           | record the `interrupted` status; without it, interruptions are stored as retryable failures             |
| `listCheckpoints(runId, { boundaries })` | summaries of retained checkpoints; `boundaries: true` lists only [restart points](#restart-from-a-step) |
| `loadCheckpoint(runId, sequence)`        | load one retained checkpoint                                                                            |
| `deleteRun(runId)`                       | retention: remove a run that is not `running`, with its checkpoints                                     |

Stores that list checkpoints keep at least the latest checkpoint and every
step-completion checkpoint; retention beyond that is theirs to decide. The
memory and file stores keep exactly those; SQLite keeps every checkpoint.

## Checkpoints

A checkpoint (contract `1.1`; `1.0` checkpoints still resume) contains:

- manifest hash, per-step `fingerprints`, and contract version;
- attempt and monotonic sequence;
- execution cursor, including nested loop position;
- variable state and completed step results;
- transcript and artifact references;
- active nested-step content and opaque continuation data;
- the effective token limit and cumulative consumed tokens, when budgeted;
- the run `ledger`: usage across attempts (tokens, active time, artifacts,
  sandbox commands and seconds), limits granted on resume, and, when the run
  is waiting for its host, a `blocked` record of why;
- `boundary`, on a checkpoint committed when a step completed: a
  [restart point](#restart-from-a-step);
- `workspaces` and `inputs`: the opaque tokens workspace stores returned at
  [step commit points](./workspaces.md#step-commit-points), and changes
  pending until the next one.

A prompt step writes about two checkpoints per tool call: one when the
model's response arrives and one when the tool's result is recorded.

## Resume

CLI:

```sh
agent-runtime resume run_123 \
  --max-total-tokens 150000 \
  --store-driver sqlite \
  --store ./.agent-runtime/runs.sqlite \
  --stream
```

Embedding:

```ts
await agentRuntime.run({
  runId: "run_123",
  resume: true,
  manifest,
  budget: { maxTotalTokens: 150000 },
});
```

Taking over a run still marked `running` requires
`allowRunningTakeover: true` and confirmation that the previous lease or
execution owner has expired.

For a token-budget suspension, the resume limit replaces the persisted limit;
it is not an additional allowance. Omitting the limit reuses the prior value.
If the effective limit is not greater than cumulative consumed tokens, the run
suspends again without issuing another model request or pending tool call.

### Granting higher limits

A run blocked by one of its [run limits](./execution-policies.md#run-limits)
resumes once a higher limit is granted, either in the manifest (see below) or
with `limits` on the resume request:

```ts
await agentRuntime.run({
  runId: "run_123",
  resume: true,
  limits: { maxTotalTokens: 50_000_000, sandbox: { maxCommands: 5_000 } },
});
```

```sh
agent-runtime resume run_123 --limits raised-limits.yaml
```

Granted limits are committed to the run's ledger before the attempt does
anything else, and apply to every later attempt. Host ceilings
(`enforcedLimits`, and the sandbox configuration for sandbox usage) still
apply.

### Manifest changes on resume

A resume may supply a changed manifest. Each checkpoint records a fingerprint
of every top-level step, and the runtime decides:

| What changed                                                                            | Outcome                                                                                |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `limits`, `policies`, `name`, `description`, the default `model`                        | accepted                                                                               |
| a step not yet reached                                                                  | accepted                                                                               |
| the step that was in progress                                                           | accepted; that step runs again from its start (`STEP_RESTARTED_AFTER_MANIFEST_CHANGE`) |
| the in-progress step, when it is a loop                                                 | refused: its saved state reflects iterations already run                               |
| a completed step, or `variables`, `connections`, `workspaces`, `messages`, `extensions` | refused with `MANIFEST_CHANGED`; the run is not touched                                |

A refused change can still run as a [restart from a step](#restart-from-a-step)
before the changed one. Checkpoints written before contract `1.1` have no
fingerprints and require the same manifest.

To show the consequences of an edit before anyone commits to it, call
`assessManifestChange(checkpoint, manifest)` with the checkpoint you would
resume or restart from. It runs nothing and returns the outcome (`unchanged`,
`accepted`, `restarts-step`, or `refused`), the changed steps, and a
one-sentence reason, decided by the same rules the resume applies.

```ts
import { assessManifestChange } from "@clearideas/agent-runtime";

const checkpoint = await runStore.loadLatestCheckpoint(runId);
const assessment = await assessManifestChange(checkpoint!, editedManifest);
if (assessment.outcome === "refused") showRestartOptions(assessment.reason);
```

### Crash loops

A resume after a failure, an interruption, a takeover, or a
[blocking error](#run-states) is a recovery. A run that keeps needing recovery
without making progress is stopped: after `limits.maxResumesWithoutProgress`
(default 10) consecutive recoveries with no new checkpoint in between, the run
is blocked with that limit instead of trying again, and after
`limits.maxRecoveries` (default 100) recoveries in all. The counts are
committed as soon as the attempt starts, so a crash cannot lose them. Resumes
that answer an approval, a child run, a budget, a granted limit, or a pause
are not recoveries.

## Run states

| Status        | Meaning                                                                 | Resumable                        |
| ------------- | ----------------------------------------------------------------------- | -------------------------------- |
| `running`     | an attempt owns the run                                                 | only with `allowRunningTakeover` |
| `suspended`   | waiting on purpose; `run.suspended` carries a `kind` (below)            | yes                              |
| `interrupted` | infrastructure stopped the attempt: a timeout, a shutdown, a lost lease | yes                              |
| `failed`      | the run could not proceed                                               | yes, after the cause is fixed    |
| `completed`   | finished                                                                | no                               |
| `cancelled`   | ended by a person                                                       | no                               |

A suspension's `kind` says what the run is waiting for:

| `kind`            | Suspension reason | Resumes when                                                    |
| ----------------- | ----------------- | --------------------------------------------------------------- |
| `awaiting-input`  | `approval`        | a person responds                                               |
| `awaiting-child`  | `sub-run`         | the child run finishes                                          |
| `awaiting-budget` | `token-budget`    | the host supplies a higher token budget                         |
| `awaiting-host`   | `blocked`         | the host grants a higher limit or fixes the error, then resumes |
| `paused`          | `paused`          | the host or user resumes it                                     |

A step failure that is not fatal blocks the run instead of failing it, unless
the run's `onFailure` policy is `fail` (see
[Execution policies](./execution-policies.md#when-a-failure-ends-the-attempt));
so does reaching a [run limit](./execution-policies.md#run-limits). `run.suspended` carries
`details.cause`, `limit` or `error`, with the limit and its usage or the
error's code and message. The run store records only the suspension, so the
runtime also commits the reason to the latest checkpoint as
`ledger.blocked`, where a host can read it later:

```json
{
  "cause": "limit",
  "code": "maxTotalTokens",
  "message": "The run reached its maxTotalTokens limit of 25000000 (used 25000113). Grant a higher limit to resume.",
  "used": 25000113,
  "value": 25000000,
  "at": "2026-07-22T10:00:00.000Z"
}
```

`agent-runtime inspect <run-id>` shows it with the rest of the checkpoint.
The promise returned by `run()` rejects with the `RunSuspendedError`; for an
error, its `cause` is the original error and its message is
`Run blocked: <original message>`.

Suspended and interrupted runs are not failures. A failed run can also be
resumed, but it stopped because something was wrong; fix the cause first, or
the same step fails again.

## Pausing and interrupting a run

A run's `signal` decides how an abort ends the attempt. The abort reason
selects the outcome:

```ts
import {
  createRunPauseRequest,
  RunInterruptedError,
} from "@clearideas/agent-runtime";

const controller = new AbortController();
const running = agentRuntime.run({
  manifest,
  runId,
  signal: controller.signal,
});

// A user pauses: the run is suspended with kind "paused".
controller.abort(createRunPauseRequest({ requestedBy: "user-123" }));

// The host is shutting down: the run is interrupted and can be resumed.
controller.abort(new RunInterruptedError("shutdown"));

// Any other reason cancels the run.
controller.abort(new Error("Cancelled by user"));
```

In every case the latest checkpoint is kept, and work in flight when the
signal fired is repeated on resume. An `InProcessExecutionEngine` timeout
interrupts the run instead of cancelling it. Stores implement the optional
`RunStore.interruptRun`; a store without it records a retryable
`RUN_INTERRUPTED` failure, which is also resumable.

## Suspension

Approval and sub-run adapters, and cumulative token budgets, can suspend a run.
The checkpoint remains available while compute is released. Prompt
continuations retain model responses, pending tool intent, and completed tool
results. Each logical tool call receives a stable idempotency key that is reused
after recovery. Side-effecting adapters must atomically honor that key in the
external system; checkpointing alone cannot provide exactly-once effects across
the external effect/response boundary.

### Resuming inside a step

Resuming continues inside the step that was running, not at its start. That
holds inside loops too: a loop's checkpoint embeds the state of the child that
was mid-step, so a prompt step paused during iteration 3 resumes in iteration
3 with its completed tool calls intact, and earlier iterations are not
repeated. Custom executors that run children through
`StepExecutionContext.executeChild` pass a `ChildExecutionFrame` to get the
same behavior (see [Reference](./reference.md#step-executors)).

Cumulative sandbox usage (`maxCommandsPerRun`, `maxTotalSandboxSeconds`) is
carried into every checkpoint, including those an attempt saves before it
reopens its sandbox, so it never resets across attempts.

### Interrupted tool calls

Before a tool call whose adapter says it is not safe to repeat
(`ToolAdapter.replaySafe(call) === false`) executes, the prompt step commits
that it started. If the attempt stops before the call's result is recorded,
the resumed step does not execute it again: the model receives a
`tool_call_interrupted` error telling it the call may have been fully, partly,
or not applied, and to check before retrying. Workspace shell and configured
commands are not safe to repeat; built-in workspace operations and tools
whose adapters do not say are executed again with the same idempotency key.

A `code` step that ran in the run sandbox is handled the same way: if its
attempt stopped while it ran, the run is blocked once with
`STEP_INTERRUPTED_IN_DOUBT`, so the host can inspect the workspace (or
restart from the previous step); the next resume runs it again. Under
`onFailure: fail`, it simply runs again.

## Restart from a step

A run can be restarted from any completed step, usually the last known good
one. Each checkpoint committed when a step completes is a restart point: it
has a `boundary` with the step path and execution key (for example
`each[2]/fetch` inside a loop), and stores keep it after later checkpoints
replace the latest.

A restart is a new run. Pass the restart point as `seed`:

```ts
const points = await runStore.listCheckpoints!("run_123", { boundaries: true });
const seed = await runStore.loadCheckpoint!(
  "run_123",
  points.at(-1)!.sequence, // the last known good step
);
await agentRuntime.run({ manifest, seed });
```

```sh
agent-runtime restart run_123 --list
agent-runtime restart run_123 --from review --run-id run_124
```

The new run:

- takes the seed's state, step results, transcript, and position, and runs
  from the step after the restart point (inside a loop, from the next
  iteration);
- starts its usage fresh: inherited tokens and artifacts are recorded in
  `ledger.inherited` and do not count against its limits;
- may use a changed manifest under the
  [same rules as a resume](#manifest-changes-on-resume), so a corrected later
  step takes effect;
- passes the seed's workspace tokens to `WorkspaceProvider.resolveWorkspace`
  as `context.restoreFrom` (see
  [workspaces](./workspaces.md#restarting-from-a-step));
- emits `run.started` with `seededFrom`, and records it in its first
  checkpoint's `metadata.seededFrom`. Provenance between runs is otherwise
  the host's.

External effects made after the restart point, such as webhook calls or MCP
tool calls, are not undone.

## Reconciliation

A hosted service should periodically:

1. find queued/running runs whose lease or heartbeat expired;
2. determine whether the execution engine is still active;
3. reserve a new attempt after the previous owner is confirmed inactive;
4. resume from the latest checkpoint;
5. reconcile terminal engine results into the durable store.

Confirm provider status or cancel the previous execution before assigning a new
owner.

Runs suspended with kind `awaiting-host` need a decision, not a retry loop:
read `ledger.blocked` from the latest checkpoint, then grant a higher limit,
fix the cause, or restart from an earlier step. Resuming an error-blocked run
is a recovery: without a fix, it counts toward `maxResumesWithoutProgress`.

## Data policy

Run state can contain prompts, model output, tool results, approval responses,
user-supplied variables, and conversation histories (the run record keeps the
supplied history, and checkpoints and completed runs keep the effective and
output histories). Encrypt it at rest where required, restrict access,
define retention, and avoid logging it accidentally. Artifact bytes may live in
a separate `ArtifactStore`; checkpoints should retain references and integrity
metadata.
