# @clearideas/agent-runtime-config

## 0.10.0

### Minor Changes

- 4713bbb: Run limits, blocked runs, manifest changes on resume, step commit points, and
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

### Patch Changes

- 4713bbb: Durable resume and workspace copy-back fixes.

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

- Updated dependencies [4713bbb]
- Updated dependencies [4713bbb]
  - @clearideas/agent-runtime-core@0.10.0
  - @clearideas/agent-runtime-sandbox@0.10.0
  - @clearideas/agent-runtime-contracts@0.10.0
  - @clearideas/agent-runtime-store-local@0.10.0
  - @clearideas/agent-runtime-model-ai-sdk@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-core@0.9.0
  - @clearideas/agent-runtime-store-local@0.9.0
  - @clearideas/agent-runtime-model-ai-sdk@0.9.0
  - @clearideas/agent-runtime-sandbox@0.9.0
  - @clearideas/agent-runtime-contracts@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-contracts@0.8.0
  - @clearideas/agent-runtime-core@0.8.0
  - @clearideas/agent-runtime-model-ai-sdk@0.8.0
  - @clearideas/agent-runtime-sandbox@0.8.0
  - @clearideas/agent-runtime-store-local@0.8.0

## 0.7.1

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-core@0.7.1
  - @clearideas/agent-runtime-model-ai-sdk@0.7.1
  - @clearideas/agent-runtime-sandbox@0.7.1
  - @clearideas/agent-runtime-store-local@0.7.1
  - @clearideas/agent-runtime-contracts@0.7.1

## 0.7.0

### Minor Changes

- Add execution policies and context management so runs complete whenever a safe
  mitigation exists.

  - **Context management.** Prompt steps reduce oversized input before a request
    would exceed `limits.maxInputBytes`, `limits.maxMessagesPerPrompt`, a
    configured trigger, the model's input window, or a provider's
    context-overflow error. Oversized interpolated variables in the opening
    prompt, single large tool results, and older tool rounds are pruned or
    summarized (`policies.context.strategy`: `prune`, `summarize`,
    `summarize-or-prune`, or `fail`). A reduction aims for
    `policies.context.reduceTo` × the trigger (default 0.25): it keeps fewer
    recent rounds when that reaches the goal and reduces everything older in one
    pass, so compactions are few and deep. `openingShare` and `toolResultShare`
    size the opening prompt and single tool results.
  - **Summarizer control.** Every summarizer setting is a policy:
    `summaryShare`, `minSummaryBytes`, `maxSummaryBytes`, `chunkBytes`,
    `maxCalls`, `maxPasses`, per-kind `prompts`, and `overflowRetries`. The
    built-in prompts and defaults are exported. A host `ContextSummarizerAdapter`
    sees every summarization request and can observe, change, or replace it, and
    `enforcedPolicies` set limits a manifest cannot override. Summarization splits material larger than
    the summarizer's window into chunks. Reductions are transcript markers, so
    resume rebuilds the same model input without repeating completed summarizer
    calls. Each summarizer response checkpoints usage and partial progress;
    completed tools are checkpointed before their outputs are reduced. Exhausted
    token budgets stop further model dispatch, including after compaction, and
    summarizer chunks fit the full rendered request within the hard input limit.
  - **Execution policies.** A `policies` block on the host
    (`AgentRuntimeDependencies.policies`), the manifest, and any step sets
    `context`, `toolCallLimit`, `modelRetry`, `outputRepair`, and `onError`.
    Retryable model errors are retried with backoff; invalid structured output,
    empty required output, and truncated responses get a repair turn; reaching
    the tool-call limit asks for a final answer without tools; `onError:
continue` records a failed step's error as its output.
  - **Approvals.** `onReject: fail | cancel | complete | continue`.
  - **Run states.** New `interrupted` status for runs stopped by infrastructure,
    and pausing through the run signal (`createRunPauseRequest()`,
    `RunInterruptedError`). `run.suspended` events carry a `kind`.
    `InProcessExecutionEngine` timeouts interrupt runs instead of cancelling them.
    `RunStore.interruptRun` is optional.
  - **Preflight.** Unregistered executors, missing adapters, unparseable
    conditions, and unknown tool names fail before a run is created, with every
    problem reported in one `MANIFEST_PREFLIGHT_FAILED` error.
    `StepExecutor.preflight` and `ConditionEvaluator.validate` are optional hooks.
  - **Tools.** A prompt step executes only the tools it names. Invalid tool calls
    (now marked by the AI SDK adapter) and out-of-scope calls receive one error
    result instead of being run or answered twice. Tools of an unreachable
    optional MCP connection are reported through
    `ToolAdapter.unavailableToolReason`, and the step runs without them.
  - **Models.** `ModelAdapter.describeModel` (implemented from model profile
    capabilities), `ModelRequest.toolChoice`, and summarizer models in host model
    policy. Budgeted runs estimate usage when a provider reports none.

  - **Windows file stores.** `FileRunStore`, `FileArtifactStore`, and local
    directory workspaces retry the transient `EPERM`, `EACCES`, and `EBUSY`
    errors Windows reports while another process (a sync client, antivirus, or
    indexer) briefly holds a file open.

  - **Bubblewrap sandboxes drop all capabilities.** A command started by a host
    running as root (a container, WSL as root, sudo) previously kept root's
    capabilities inside the sandbox, including the override that ignores file
    modes. `BubblewrapSandboxProvider` now passes `--cap-drop ALL`, matching the
    Docker provider.

  Behavior changes: by default an oversized input is pruned instead of failing
  the step, and reaching `maxToolCallsPerIteration` asks for a final answer
  instead of failing. Set `policies.context.strategy: fail` and
  `policies.toolCallLimit: fail` to keep the previous behavior. Manifests that
  name unknown tools or unparseable conditions now fail before the run starts
  rather than when the step is reached.

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-contracts@0.7.0
  - @clearideas/agent-runtime-core@0.7.0
  - @clearideas/agent-runtime-model-ai-sdk@0.7.0
  - @clearideas/agent-runtime-sandbox@0.7.0
  - @clearideas/agent-runtime-store-local@0.7.0

## 0.6.3

### Patch Changes

- Refresh compatible AI SDK and provider dependencies, retaining the xAI v4 API. Update the standalone Agent Runner to the current runtime and patched transitive dependencies. Monitor both standalone examples with Dependabot and audit their locked installations in CI.
- Updated dependencies
  - @clearideas/agent-runtime-model-ai-sdk@0.6.3
  - @clearideas/agent-runtime-contracts@0.6.3
  - @clearideas/agent-runtime-core@0.6.3
  - @clearideas/agent-runtime-sandbox@0.6.3
  - @clearideas/agent-runtime-store-local@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [9b5fca1]
  - @clearideas/agent-runtime-model-ai-sdk@0.6.2
  - @clearideas/agent-runtime-contracts@0.6.2
  - @clearideas/agent-runtime-core@0.6.2
  - @clearideas/agent-runtime-sandbox@0.6.2
  - @clearideas/agent-runtime-store-local@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [184aede]
- Updated dependencies [743cc1e]
- Updated dependencies [f944e14]
  - @clearideas/agent-runtime-model-ai-sdk@0.6.1
  - @clearideas/agent-runtime-core@0.6.1
  - @clearideas/agent-runtime-sandbox@0.6.1
  - @clearideas/agent-runtime-contracts@0.6.1
  - @clearideas/agent-runtime-store-local@0.6.1

## 0.6.0

### Minor Changes

- c9a2886: Add optional verification of MCP tool metadata before it reaches a model.

  MCP connections accept a `toolIntegrity` block that pins a `sha256` digest per
  tool; at discovery, a changed definition or an exposed tool without a digest
  raises `McpToolIntegrityError` (or is dropped with `onFailure: exclude`). New
  exports `computeMcpToolDigest`, `canonicalizeMcpToolMetadata`,
  `discoverMcpConnectionTools`, and the `verifyToolMetadata` tool option let hosts
  record and verify the definitions approved when a connection is created.
  The CLI adds `connections inspect <config> [--connection <name>] [--format
json|yaml]` to print discovered tools with digests and a paste-ready
  `toolIntegrity` block. Connections without `toolIntegrity` behave as before.
  Tool discovery now follows `tools/list` pagination.

- 7a9b18c: Add host-defined workspaces and the run sandbox. A manifest binds a workspace
  (a code base, document store, or scratch area declared in the `workspaces`
  configuration section) by reference and may only narrow its mode and tools.
  Every model operation on a workspace executes as one command inside an
  isolated per-run sandbox declared by the new `sandbox` configuration section:
  built-in `list_files`, `read_file`, `search_files`, `write_file`, and
  `delete_file` operations served by a bundled helper, host-allowlisted
  `commands`, and an opt-in `shell`. Commands are admitted by the host policy,
  vetoable through `authorizeCommand`, reported through `workspace.bound` and
  `sandbox.*` events, recorded as `SandboxCommandRecord` in the transcript, and
  budgeted per run. Read-write mounts sync back through `WorkspaceStore` after
  each command; the agent process never interprets workspace content. Code steps
  may execute in the run sandbox with `workspaces` or `sandbox: run`. The sandbox
  package gains `ProviderRunSandbox`, the command policy engine,
  `BubblewrapSandboxProvider` (Linux isolation without a container daemon),
  Docker read-only attachments, labels, and tmpfs sizing, and a test-only
  `HostProcessTestProvider` under `./testing`. Inline worker configuration
  cannot define workspaces or a sandbox.

### Patch Changes

- ec1209b: Require patched MCP SDK and Zod releases for configured MCP connections and
  manifest/configuration validation. Refresh vulnerable transitive dependencies
  without changing runtime APIs, manifest formats, or checkpoint contracts.
- Updated dependencies [ec1209b]
- Updated dependencies [7a9b18c]
  - @clearideas/agent-runtime-contracts@0.6.0
  - @clearideas/agent-runtime-core@0.6.0
  - @clearideas/agent-runtime-store-local@0.6.0
  - @clearideas/agent-runtime-sandbox@0.6.0
  - @clearideas/agent-runtime-model-ai-sdk@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [4196b3a]
  - @clearideas/agent-runtime-core@0.5.0
  - @clearideas/agent-runtime-model-ai-sdk@0.5.0
  - @clearideas/agent-runtime-contracts@0.5.0
