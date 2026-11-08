# `@clearideas/agent-runtime-sandbox`

Defines `SandboxProvider` and `ProviderSandboxAdapter` for isolated code and
artifact operations. Providers implement isolation and process control.
`ProviderSandboxAdapter` manages the workspace, output limits, environment
allowlists, and artifact persistence.

`DockerSandboxProvider` launches containers with networking disabled, a
read-only root filesystem, process and memory limits, and an isolated
`/workspace` tmpfs. `BubblewrapSandboxProvider` provides equivalent isolation
on Linux without a container daemon (user, PID, IPC, UTS, cgroup, and network
namespaces, dropped capabilities, and `prlimit` limits) and is the reference
provider for local development and continuous integration. Remote and application-specific
services can implement the same `SandboxProvider` contract.

`ProviderRunSandbox` implements the run sandbox: one sandbox per run attempt
in which every workspace operation executes as one command admitted by the
host command policy (`commands`, `shell`, `limits`), reported through
`sandbox.*` events, and recorded in the transcript. It stages bound
workspaces, serves the built-in `list_files`, `read_file`, `search_files`,
`write_file`, and `delete_file` operations through the bundled `agent-fs`
helper (`assets/agent-fs.py`, replaceable by a host-supplied program with the
same protocol), syncs read-write mounts back to their stores after each
command, and runs code steps that declare `workspaces`.

`@clearideas/agent-runtime-sandbox/testing` exports `HostProcessTestProvider`,
a **test-only** provider with no isolation that runs commands as host
processes so the run sandbox can be exercised where neither bubblewrap nor
Docker is available. Never use it outside tests.
