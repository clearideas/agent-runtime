# @clearideas/agent-runtime-server

## 1.0.0

### Patch Changes

- @clearideas/agent-runtime-condition-jexl@1.0.0
  - @clearideas/agent-runtime-contracts@1.0.0
  - @clearideas/agent-runtime-core@1.0.0
  - @clearideas/agent-runtime-config@1.0.0
  - @clearideas/agent-runtime-sandbox@1.0.0
  - @clearideas/agent-runtime-step-loop@1.0.0
  - @clearideas/agent-runtime-step-prompt@1.0.0
  - @clearideas/agent-runtime-step-standard@1.0.0
  - @clearideas/agent-runtime-store-local@1.0.0
  - @clearideas/agent-runtime-store-sqlite@1.0.0

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

- Updated dependencies [4713bbb]
- Updated dependencies [4713bbb]
  - @clearideas/agent-runtime-core@0.10.0
  - @clearideas/agent-runtime-step-loop@0.10.0
  - @clearideas/agent-runtime-step-prompt@0.10.0
  - @clearideas/agent-runtime-step-standard@0.10.0
  - @clearideas/agent-runtime-sandbox@0.10.0
  - @clearideas/agent-runtime-config@0.10.0
  - @clearideas/agent-runtime-contracts@0.10.0
  - @clearideas/agent-runtime-store-local@0.10.0
  - @clearideas/agent-runtime-store-sqlite@0.10.0
  - @clearideas/agent-runtime-condition-jexl@0.10.0

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
  - @clearideas/agent-runtime-core@0.9.0
  - @clearideas/agent-runtime-store-local@0.9.0
  - @clearideas/agent-runtime-store-sqlite@0.9.0
  - @clearideas/agent-runtime-condition-jexl@0.9.0
  - @clearideas/agent-runtime-config@0.9.0
  - @clearideas/agent-runtime-sandbox@0.9.0
  - @clearideas/agent-runtime-step-loop@0.9.0
  - @clearideas/agent-runtime-step-prompt@0.9.0
  - @clearideas/agent-runtime-step-standard@0.9.0
  - @clearideas/agent-runtime-contracts@0.9.0
