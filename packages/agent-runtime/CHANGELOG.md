# @clearideas/agent-runtime

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
