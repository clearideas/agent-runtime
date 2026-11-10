# @clearideas/agent-runtime-cli

## 0.9.0

### Minor Changes

- Add an OpenAI-compatible server: `agent-runtime serve` exposes agent
  manifests as models on `/v1/models` and `/v1/chat/completions`, so chat front
  ends and OpenAI SDKs can run whole agents.

  - **Serve.** `agent-runtime serve <manifest>` serves one manifest.
    `agent-runtime serve` reads `agent-runtime.server.yaml`, or the file named
    by `--server-config`, to serve several, with API keys scoped to models,
    per-key limits, admission control, request timeouts, graceful shutdown,
    health endpoints, and run retention. Storage a configuration file leaves
    out is durable, under `.agent-runtime/serve` beside it. `--check`
    validates and preflights everything and exits.
  - **Conversations.** Manifests that declare `messages` receive the chat as
    conversation turns. A conversation ledger maps what a client sends back to
    the history the runtime issued, so conversations continue from the
    runtime's own signed, compacted history: compaction is not repeated every
    turn, resent media is stored once, and `requireSignature` manifests work
    with ordinary clients. Edited or foreign histories are not recognized.
    Manifests without `messages` receive operator-mapped variables.
  - **Streaming.** Only the run's final output is ever streamed as content. A
    reply streams as it is written when its step is provably the reply;
    otherwise it is sent when the run completes. Optional progress uses the
    `reasoning_content` convention, with names only.
  - **Boundary.** Requests never supply manifests, configuration, tools, or
    provider options. Serve uses the worker's trust rules: webhook steps need a
    host-supplied authorizing executor. Client system messages and client
    tools are dropped (with `clientTools: reject`, tools are refused instead),
    media URLs are refused unless allowlisted, and run failures are redacted to
    their code.
  - **Embedding.** `@clearideas/agent-runtime-server` exports `AgentServer`,
    `listen` (node:http), and `createFetchHandler` (Request → Response).

  Supporting changes:

  - Host composition (runtime-module loading, adapter validation,
    configuration composition, and step-executor selection) moved from the CLI
    into `@clearideas/agent-runtime-server`, with an explicit trust mode, and
    is shared by `run`, `worker`, and `serve`. The CLI's exported types and
    behavior are unchanged.
  - Fix: `messages` options a runtime module exports as plain values, such as
    a host-enforced `requireSignature` or `authorizeArtifact`, were ignored by
    the CLI; they now apply. Modules that use `createRuntime()` were not
    affected.
  - `AgentRuntime.preflight(manifest)` runs the pre-run checks without creating
    a run.
  - `RunStore.deleteRun(runId)` is an optional method for retention; the memory
    and SQLite stores implement it.
  - CLI options accept `--name=value` as well as `--name value`.

  Release validation also covers custom output selectors in streamed replies,
  provider retries before and after partial output, stalled uploads on both HTTP
  transports, queued/preparing requests during shutdown, late runtime-resource
  cleanup, and bounded deletion of expired SQLite conversation/index rows.
  Partial live answers that need a retry end with `stream_interrupted` rather
  than concatenating failed and successful attempts. Custom output selectors
  always use committed streaming. Request deadlines cover uploads and setup as
  well as execution.

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-server@0.9.0
  - @clearideas/agent-runtime-core@0.9.0
  - @clearideas/agent-runtime-store-local@0.9.0
  - @clearideas/agent-runtime-store-sqlite@0.9.0
  - @clearideas/agent-runtime-config@0.9.0
  - @clearideas/agent-runtime-contracts@0.9.0
  - @clearideas/agent-runtime-execution@0.9.0

## 0.8.0

### Minor Changes

- Add conversation messages: continue a chat one run per turn.

  - **Declare.** An agent manifest's top-level `messages` block accepts a
    conversation history from its runs, with `required`, the compaction
    triggers `maxMessages` and `maxBytes`, `requireSignature`, and a history-only
    `context` policy. A manifest without it cannot receive a history, and
    behaves exactly as before.
  - **Supply.** Agent run manifests, `RunRequest`, worker invocations, and the
    CLI (`--messages`) carry `messages` and `messagesSignature`. Histories hold
    `user` and `assistant` messages with text, JSON, image, and file parts;
    system messages, tool history, reasoning, and provider options are rejected.
    `content` may be a string.
  - **Read.** A step's `history` setting (`all`, or `{ last, summary, insert,
media }`) inserts its selection into a prompt step's model input as literal
    turns, never templated, and narrows the step's read-only `messages`
    variable (`all`, `count`, `turn`, `last`, `lastUser`, `summary`,
    `summarized`, `text`), which works
    in templates, conditions, loop sources, sub-run mappings, code steps, and
    tool contexts. A prompt step may be a `systemPrompt` plus `history`. A
    sub-run step with `history` forwards its selection, signed, to the child.
  - **Turns.** A turn is the user's message, or messages, and the reply that
    completes it; turn N ends with the N-th assistant message. Numbers are
    stable when a rejected turn is retried and survive compaction. The
    `messages` variable and `conversationTurns(history)` expose the current
    turn and each message's turn and position; text renderings label messages
    `user (turn N): ...`.
  - **Reply.** Output selection is unchanged. `RunResult.messages` returns the
    history plus the final output as assistant text; completed run records keep
    it.
  - **Compact.** A history over its triggers is compacted once per run, before
    the first step, with the existing context policy and summarizer (new
    summary kind `messages`, `summarizer.prompts.messages`). Compaction keeps
    whole turns and never splits one. The summary is returned in
    `RunResult.messages`, so later turns start from it; its marker records the
    turns and messages it covers, and `messages.markers` lets the manifest word
    the summary heading and pruning note.
    `PromptMessageHistoryCompactor` implements the new `MessageHistoryCompactor`
    port; `createAgentRuntime` and the CLI wire it.
  - **Sign.** `createHmacMessageSigner` signs every returned history with
    HMAC-SHA-256 over RFC 8785 canonical JSON and a host `messagesScope`, and
    verifies signatures on the next turn. Configure keys in the host
    configuration's `messages.signing` section or supply a
    `MessageHistorySigner`.
  - **Media.** Inline media is stored as an artifact before the run is created;
    artifact references need `sha256` and, unless signed or ingested by the
    runtime, host approval through `authorizeArtifact`. `ModelDescription` adds
    `imageInput`; steps that would send images to a model declared without image
    input fail before the run is created. Inserted turns send images and PDFs
    to the model; other files become a text placeholder naming the file.

  Compatibility: a host `ContextSummarizerAdapter` receives history compaction
  requests with `kind: "messages"` and an empty `stepId`. Checkpoints of runs
  that use conversation messages carry a new `messages` field; resume such runs
  on this version or later.

  Lower the supported Node.js minimum to 22.20.0 across all packages and examples.
  Validate the exact minimum in CI, including SQLite persistence and native TypeScript example hosts.

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-contracts@0.8.0
  - @clearideas/agent-runtime-core@0.8.0
  - @clearideas/agent-runtime-execution@0.8.0
  - @clearideas/agent-runtime-step-loop@0.8.0
  - @clearideas/agent-runtime-step-prompt@0.8.0
  - @clearideas/agent-runtime-step-standard@0.8.0
  - @clearideas/agent-runtime-condition-jexl@0.8.0
  - @clearideas/agent-runtime-config@0.8.0
  - @clearideas/agent-runtime-sandbox@0.8.0
  - @clearideas/agent-runtime-store-local@0.8.0
  - @clearideas/agent-runtime-store-sqlite@0.8.0

## 0.7.1

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-core@0.7.1
  - @clearideas/agent-runtime-condition-jexl@0.7.1
  - @clearideas/agent-runtime-config@0.7.1
  - @clearideas/agent-runtime-sandbox@0.7.1
  - @clearideas/agent-runtime-step-loop@0.7.1
  - @clearideas/agent-runtime-step-prompt@0.7.1
  - @clearideas/agent-runtime-step-standard@0.7.1
  - @clearideas/agent-runtime-store-local@0.7.1
  - @clearideas/agent-runtime-store-sqlite@0.7.1
  - @clearideas/agent-runtime-contracts@0.7.1
  - @clearideas/agent-runtime-execution@0.7.1

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
  - @clearideas/agent-runtime-condition-jexl@0.7.0
  - @clearideas/agent-runtime-config@0.7.0
  - @clearideas/agent-runtime-contracts@0.7.0
  - @clearideas/agent-runtime-core@0.7.0
  - @clearideas/agent-runtime-execution@0.7.0
  - @clearideas/agent-runtime-sandbox@0.7.0
  - @clearideas/agent-runtime-step-loop@0.7.0
  - @clearideas/agent-runtime-step-prompt@0.7.0
  - @clearideas/agent-runtime-step-standard@0.7.0
  - @clearideas/agent-runtime-store-local@0.7.0
  - @clearideas/agent-runtime-store-sqlite@0.7.0

## 0.6.3

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-config@0.6.3
  - @clearideas/agent-runtime-condition-jexl@0.6.3
  - @clearideas/agent-runtime-contracts@0.6.3
  - @clearideas/agent-runtime-core@0.6.3
  - @clearideas/agent-runtime-execution@0.6.3
  - @clearideas/agent-runtime-sandbox@0.6.3
  - @clearideas/agent-runtime-step-loop@0.6.3
  - @clearideas/agent-runtime-step-prompt@0.6.3
  - @clearideas/agent-runtime-step-standard@0.6.3
  - @clearideas/agent-runtime-store-local@0.6.3
  - @clearideas/agent-runtime-store-sqlite@0.6.3

## 0.6.2

### Patch Changes

- Normalize model-supplied workspace tool paths, accepting Windows separators, root-relative and dotted spellings, repeated/trailing separators, and root listing aliases. Preserve canonical safety checks, input globs, and underscore-prefixed filenames; align the tool schema and improve path diagnostics.

- Updated dependencies [9b5fca1]
  - @clearideas/agent-runtime-step-prompt@0.6.2
  - @clearideas/agent-runtime-step-standard@0.6.2
  - @clearideas/agent-runtime-config@0.6.2
  - @clearideas/agent-runtime-condition-jexl@0.6.2
  - @clearideas/agent-runtime-contracts@0.6.2
  - @clearideas/agent-runtime-core@0.6.2
  - @clearideas/agent-runtime-execution@0.6.2
  - @clearideas/agent-runtime-sandbox@0.6.2
  - @clearideas/agent-runtime-step-loop@0.6.2
  - @clearideas/agent-runtime-store-local@0.6.2
  - @clearideas/agent-runtime-store-sqlite@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [743cc1e]
- Updated dependencies [f944e14]
  - @clearideas/agent-runtime-core@0.6.1
  - @clearideas/agent-runtime-sandbox@0.6.1
  - @clearideas/agent-runtime-contracts@0.6.1
  - @clearideas/agent-runtime-step-prompt@0.6.1
  - @clearideas/agent-runtime-store-local@0.6.1
  - @clearideas/agent-runtime-step-standard@0.6.1
  - @clearideas/agent-runtime-config@0.6.1
  - @clearideas/agent-runtime-condition-jexl@0.6.1
  - @clearideas/agent-runtime-step-loop@0.6.1
  - @clearideas/agent-runtime-store-sqlite@0.6.1
  - @clearideas/agent-runtime-execution@0.6.1

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

- Updated dependencies [c9a2886]
- Updated dependencies [ec1209b]
- Updated dependencies [7a9b18c]
  - @clearideas/agent-runtime-config@0.6.0
  - @clearideas/agent-runtime-contracts@0.6.0
  - @clearideas/agent-runtime-core@0.6.0
  - @clearideas/agent-runtime-store-local@0.6.0
  - @clearideas/agent-runtime-sandbox@0.6.0
  - @clearideas/agent-runtime-step-prompt@0.6.0
  - @clearideas/agent-runtime-step-standard@0.6.0
  - @clearideas/agent-runtime-condition-jexl@0.6.0
  - @clearideas/agent-runtime-execution@0.6.0
  - @clearideas/agent-runtime-step-loop@0.6.0
  - @clearideas/agent-runtime-store-sqlite@0.6.0

## 0.5.0

### Patch Changes

- 4196b3a: Add validated defineAgent and createAgentRuntime helpers for standard TypeScript
  composition, with adapter overrides and explicit persistence ownership.

  Preserve classified adapter error codes, retryability, and recovery hints. Use
  the actual package version in checkpoints. Existing contract-1.0 checkpoints
  remain readable when the manifest fingerprint matches.

  Warn when CLI event logging fails, show suspension and webhook retry progress,
  and close CLI-owned SQLite stores. Runtime modules may export an awaited
  shutdown hook; cleanup failures do not replace the execution error.

  Add three executable example patterns and clean consumer-install checks for
  packed API, TypeScript declarations, and CLI. Restore generated changelogs and
  GitHub release notes.

- Updated dependencies [4196b3a]
  - @clearideas/agent-runtime-core@0.5.0
  - @clearideas/agent-runtime-condition-jexl@0.5.0
  - @clearideas/agent-runtime-config@0.5.0
  - @clearideas/agent-runtime-step-loop@0.5.0
  - @clearideas/agent-runtime-step-prompt@0.5.0
  - @clearideas/agent-runtime-step-standard@0.5.0
  - @clearideas/agent-runtime-store-local@0.5.0
  - @clearideas/agent-runtime-store-sqlite@0.5.0
  - @clearideas/agent-runtime-contracts@0.5.0
  - @clearideas/agent-runtime-execution@0.5.0
