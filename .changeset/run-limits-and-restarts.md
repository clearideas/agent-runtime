---
"@clearideas/agent-runtime-contracts": minor
"@clearideas/agent-runtime-core": minor
"@clearideas/agent-runtime-step-prompt": minor
"@clearideas/agent-runtime-step-loop": minor
"@clearideas/agent-runtime-step-standard": minor
"@clearideas/agent-runtime-sandbox": minor
"@clearideas/agent-runtime-config": minor
"@clearideas/agent-runtime-store-local": minor
"@clearideas/agent-runtime-store-sqlite": minor
"@clearideas/agent-runtime-execution": minor
"@clearideas/agent-runtime-server": minor
"@clearideas/agent-runtime-cli": minor
---

Run limits, blocked runs, manifest changes on resume, step commit points, and
restarts from a step.

**Behavior changes** (see "Upgrading to 0.10" in the production guide)

- **Failures pause.** A step failure that `onError` does not handle now blocks
  the run (`suspended`, kind `awaiting-host`, reason `blocked`) instead of
  failing it, unless the error is fatal: manifest or message validation, a
  changed completed step, a rejected approval, a tool-integrity violation, or
  a `RunFatalError`. `run()` rejects with a `RunSuspendedError` whose `cause`
  is the original error. `policies.onFailure: fail` restores failing.
  `agent-runtime serve` reports errors as before.
- **Every run has limits.** `DEFAULT_RUN_LIMITS`: 25M tokens, 24 h active
  time, 4 h per step execution, 100 recoveries, 10 recoveries without
  progress, 500 model turns per prompt step, 10,000 loop iterations, 10,000
  artifacts / 10 GiB, 64 MiB per checkpoint. A step execution is a top-level
  step or one loop iteration's child; a recovery is a resume after a failure,
  interruption, takeover, or error block. Reaching a limit blocks the run
  until a higher limit is granted with `RunRequest.limits` (`--limits` in the
  CLI) or in the manifest. Hosts replace defaults with `limits` and cap them
  with `enforcedLimits`, in code, in CLI and `serve` runtime modules, or per
  `serve` model. `maxStepTokens` and `maxEstimatedCost` have no default.
- **Sandbox budgets pause.** Exhausting the run sandbox's command or seconds
  budget blocks the run instead of returning a `sandbox_budget_exhausted`
  tool error. Defaults are higher: 2,000 commands and 4 hours per run,
  5 min / 1 h command timeouts, 500 output files / 500 MiB per command. A
  manifest may set lower values with `limits.sandbox`.
- **Interrupted commands are not replayed.** A workspace shell or configured
  command that was running when an attempt stopped is reported to the model
  as `tool_call_interrupted` on resume instead of executed again
  (`ToolAdapter.replaySafe`). An interrupted code step in the run sandbox
  blocks the run once with `STEP_INTERRUPTED_IN_DOUBT`, then runs again.
- **Manifest changes on resume.** A resume now accepts a manifest whose
  limits, policies, descriptions, default model, or steps not yet reached
  changed; a changed in-progress step runs again from its start. A changed
  completed step is refused with code `MANIFEST_CHANGED` (the message still
  begins "Manifest does not match checkpoint"). Stores save the supplied
  manifest (`ResumeRunOptions.manifest`).
- **Checkpoint contract `1.1`** adds `ledger`, `fingerprints`, `boundary`,
  `workspaces`, and `inputs`. Contract `1.0` checkpoints are still read;
  earlier releases cannot read `1.1`.

**Additions**

- Why a run is blocked is committed to the latest checkpoint as
  `ledger.blocked` and reported in `run.suspended` details; the ledger also
  records usage, recoveries, and granted limits across attempts.
- Step commit points: `WorkspaceStore.commit` (optional) is called when a step
  completes with the changes since the previous commit point; the token it
  returns is recorded in the checkpoint and emitted as `workspace.committed`.
  `WorkspaceStore.version` (optional) records read-only input versions.
- Restart from a step: `RunRequest.seed` starts a new run from a
  step-completion checkpoint, with fresh usage and the checkpoint's workspace
  tokens passed to the provider as `restoreFrom`. `RunStore.listCheckpoints`
  and `loadCheckpoint` (optional) expose restart points; the memory, file,
  and SQLite stores implement them. The memory and file stores keep every
  top-level restart point and the 10 most recent inside steps
  (`maxNestedRestartPoints`); SQLite adds a column to existing databases.
  CLI: `agent-runtime restart <run-id> [--from <step>] [--list]`; `inspect`
  lists restart points.
- `assessManifestChange(checkpoint, manifest)` reports, without running
  anything, whether resuming or restarting with an edited manifest would be
  accepted, rerun the in-progress step, or be refused, and why.
- A prompt step writes about two checkpoints per tool call, down from five.
