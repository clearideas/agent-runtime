---
"@clearideas/agent-runtime-core": patch
"@clearideas/agent-runtime-step-loop": patch
"@clearideas/agent-runtime-step-prompt": patch
"@clearideas/agent-runtime-step-standard": patch
"@clearideas/agent-runtime-sandbox": patch
"@clearideas/agent-runtime-config": patch
---

Durable resume and workspace copy-back fixes.

- **Loops resume where they paused.** A prompt or sub-run step that paused
  mid-step inside a loop (for example on a token budget) restarted the loop
  from its first iteration on resume, repeating tool calls and model calls and
  duplicating transcript items. A loop's checkpoint now embeds the state of
  its mid-step child through a new `ChildExecutionFrame` argument to
  `StepExecutionContext.executeChild`. Checkpoints written by earlier releases
  in that state still restart the loop, now with a
  `LOOP_RESUME_STATE_UNRECOGNIZED` diagnostic.
- **No deletions from an incomplete listing.** When a command left more files
  in a read-write mount than the workspace's `maxFiles`, copy-back treated
  unlisted files as deleted and removed them from the workspace store. An
  incomplete listing now never deletes.
- **Workspaces stay within their limits.** Copy-back refuses changes that
  would exceed the store's `maxFiles` or `maxTotalBytes`, so a run can no
  longer grow its workspace past the limits it must be staged under to resume.
- **The model is told what was not saved.** Command results carry
  `notPersisted` entries for changes the store did not receive (hidden or
  invalid paths, symbolic links, oversized files, store rejections, workspace
  limits). Code steps record them in `metadata.notPersisted`.
- **Sandbox budgets never reset.** Cumulative sandbox usage is written to every
  checkpoint, including those saved before an attempt reopens its sandbox.
- **Failed final syncs are durable.** When the final copy-back fails on
  suspension, interruption, or failure, the latest checkpoint is re-committed
  with `metadata.workspaceSync`; on resume the runtime emits a diagnostic and
  the resumed prompt step tells its model once.
- **Webhook keys per loop iteration.** The default `Idempotency-Key` is
  `<runId>:<execution key>`, which includes each enclosing loop's iteration.
  Top-level keys are unchanged. Steps receive the key as
  `StepExecutionContext.executionKey`.
