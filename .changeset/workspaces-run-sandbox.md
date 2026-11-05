---
"@clearideas/agent-runtime-contracts": minor
"@clearideas/agent-runtime-core": minor
"@clearideas/agent-runtime-config": minor
"@clearideas/agent-runtime-store-local": minor
"@clearideas/agent-runtime-sandbox": minor
"@clearideas/agent-runtime-step-prompt": minor
"@clearideas/agent-runtime-step-standard": minor
"@clearideas/agent-runtime": minor
"@clearideas/agent-runtime-cli": minor
---

Add host-defined workspaces and the run sandbox. A manifest binds a workspace
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
