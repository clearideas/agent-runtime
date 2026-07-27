# `@clearideas/agent-runtime-sandbox`

Defines `SandboxProvider` and `ProviderSandboxAdapter` for isolated code and
artifact operations. Providers implement isolation and process control.
`ProviderSandboxAdapter` manages the workspace, output limits, environment
allowlists, and artifact persistence.

`DockerSandboxProvider` launches containers with networking disabled, a
read-only root filesystem, process and memory limits, and an isolated
`/workspace` tmpfs. Remote and application-specific services can implement the
same `SandboxProvider` contract.
