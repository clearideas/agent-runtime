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
- a checkpoint and its state change are committed atomically where possible.

## Checkpoints

A checkpoint contains:

- manifest hash and contract version;
- attempt and monotonic sequence;
- execution cursor, including nested loop position;
- variable state and completed step results;
- transcript and artifact references;
- active nested-step content and opaque continuation data;
- the effective token limit and cumulative consumed tokens, when budgeted.

Resume rejects a manifest whose hash differs from the checkpoint. Publish
manifest changes as a new definition.

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

| `kind`            | Suspension reason | Resumes when                            |
| ----------------- | ----------------- | --------------------------------------- |
| `awaiting-input`  | `approval`        | a person responds                       |
| `awaiting-child`  | `sub-run`         | the child run finishes                  |
| `awaiting-budget` | `token-budget`    | the host supplies a higher token budget |
| `paused`          | `paused`          | the host or user resumes it             |

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

## Reconciliation

A hosted service should periodically:

1. find queued/running runs whose lease or heartbeat expired;
2. determine whether the execution engine is still active;
3. reserve a new attempt after the previous owner is confirmed inactive;
4. resume from the latest checkpoint;
5. reconcile terminal engine results into the durable store.

Confirm provider status or cancel the previous execution before assigning a new
owner.

## Data policy

Run state can contain prompts, model output, tool results, approval responses,
user-supplied variables, and conversation histories (the run record keeps the
supplied history, and checkpoints and completed runs keep the effective and
output histories). Encrypt it at rest where required, restrict access,
define retention, and avoid logging it accidentally. Artifact bytes may live in
a separate `ArtifactStore`; checkpoints should retain references and integrity
metadata.
