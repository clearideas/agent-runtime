# @clearideas/agent-runtime-config

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
