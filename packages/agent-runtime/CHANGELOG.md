# @clearideas/agent-runtime

## 0.6.0

### Minor Changes

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
  - @clearideas/agent-runtime-model-ai-sdk@0.6.0
  - @clearideas/agent-runtime-step-loop@0.6.0

## 0.5.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [4196b3a]
  - @clearideas/agent-runtime-core@0.5.0
  - @clearideas/agent-runtime-condition-jexl@0.5.0
  - @clearideas/agent-runtime-model-ai-sdk@0.5.0
  - @clearideas/agent-runtime-config@0.5.0
  - @clearideas/agent-runtime-step-loop@0.5.0
  - @clearideas/agent-runtime-step-prompt@0.5.0
  - @clearideas/agent-runtime-step-standard@0.5.0
  - @clearideas/agent-runtime-store-local@0.5.0
  - @clearideas/agent-runtime-contracts@0.5.0
  - @clearideas/agent-runtime-execution@0.5.0
