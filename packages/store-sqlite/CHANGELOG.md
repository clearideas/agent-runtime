# @clearideas/agent-runtime-store-sqlite

## 0.7.1

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-core@0.7.1
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

## 0.6.3

### Patch Changes

- @clearideas/agent-runtime-contracts@0.6.3
  - @clearideas/agent-runtime-core@0.6.3

## 0.6.2

### Patch Changes

- @clearideas/agent-runtime-contracts@0.6.2
  - @clearideas/agent-runtime-core@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [743cc1e]
- Updated dependencies [f944e14]
  - @clearideas/agent-runtime-core@0.6.1
  - @clearideas/agent-runtime-contracts@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [ec1209b]
- Updated dependencies [7a9b18c]
  - @clearideas/agent-runtime-contracts@0.6.0
  - @clearideas/agent-runtime-core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [4196b3a]
  - @clearideas/agent-runtime-core@0.5.0
  - @clearideas/agent-runtime-contracts@0.5.0
