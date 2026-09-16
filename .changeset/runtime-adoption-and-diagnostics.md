---
"@clearideas/agent-runtime": minor
"@clearideas/agent-runtime-core": minor
"@clearideas/agent-runtime-cli": patch
---

Add validated defineAgent and createAgentRuntime helpers for standard TypeScript
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
