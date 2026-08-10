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
and user-supplied variables. Encrypt it at rest where required, restrict access,
define retention, and avoid logging it accidentally. Artifact bytes may live in
a separate `ArtifactStore`; checkpoints should retain references and integrity
metadata.
