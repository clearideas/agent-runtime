---
title: Workspaces and the run sandbox
description: Give agents host-authorized access to code bases and document stores through an isolated per-run sandbox.
---

# Workspaces and the run sandbox

A **workspace** is a host-owned collection of files that exists independently
of any run: a code base, a document library, a scratch area. The host
configuration declares which workspaces exist, where they live, the widest
access mode they permit, which files are visible, and what software may run
against them. An agent manifest binds a workspace by name and may only narrow
what the host allowed.

When a run binds a workspace, Agent Runtime opens a **run sandbox**: one
isolated environment per run attempt, separate from the process executing the
agent, that lives until the run completes, fails, is cancelled, or suspends.
Every operation a model performs on a workspace — listing, reading,
searching, writing, deleting, or running host-allowlisted software — is
exactly one command executed inside that sandbox, admitted by a host command
policy, pre-authorizable by a host hook, reported as events with its exact
arguments and changed files, and recorded in the durable transcript.

The process executing the agent never interprets workspace content. It moves
bytes opaquely, checks file names against a character rule, and parses
bounded JSON tool results — the same trust posture it already takes toward
results from remote MCP servers.

## Host configuration

<<< ../examples/manifests/workspaces.config.yaml

### `workspaces`

| Field                                       | Notes                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `driver`                                    | `local` (a host directory) or `host` (a store supplied by application code)                    |
| `root`                                      | directory path or environment reference; literal paths resolve against the config file         |
| `mode`                                      | `read` (default) or `read_write`                                                               |
| `include`, `exclude`                        | globs over relative paths (`**`, `*`, `?`); excluded paths are never staged or readable        |
| `maxFiles`, `maxFileBytes`, `maxTotalBytes` | staging and per-file ceilings (defaults 5000, 1 MiB, 100 MiB)                                  |
| `attach`                                    | `never` (default) stages visible files; explicit `auto` permits a raw read-only directory bind |

Workspace paths accept only segments made of letters, digits, `.`, `_`, and
`-` that do not start with a dot. Hidden entries (`.git`, `.env`), symbolic
links, and names with spaces are never addressable.

Staging is the default for both local and host workspaces. Explicit `attach: auto`
allows native attachment for read-only, unfiltered directories when supported
by the provider. Programs then see the **entire raw directory**, including
hidden files such as `.env` and names the file tools refuse; store file-count
and byte limits do not apply to their direct filesystem reads. Use this only
for directories whose entire contents are safe to expose. A read-only bind
prevents writes; it does not filter reads. In application code, the same
opt-in is `new LocalDirectoryWorkspace({ root, attach: "auto" })`. Custom host
stores that provide `attachable` explicitly grant this capability; configured
host workspaces suppress it unless `attach: auto` is selected.

### `sandbox`

| Field                | Notes                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `driver`             | `bubblewrap` (Linux, no daemon), `docker` (requires `image`), or `host` (a `SandboxProvider` from code) |
| `image`              | container image for Docker; `allowedImages` defaults to `[image]`                                       |
| `binds`              | host directories bound read-only by bubblewrap; defaults to the system directories                      |
| `helper`             | `command` and `source` of the in-sandbox helper; defaults to the bundled Python script                  |
| `limits`             | memory, CPU, processes, tmpfs size, per-command and per-run timeouts, command count, output ceilings    |
| `commands`           | host-allowlisted programs exposed as tools (see below)                                                  |
| `shell`              | `enabled: true` exposes `<alias>__shell`; disabled by default                                           |
| `allowedEnvironment` | environment names code steps may forward                                                                |

Defaults: 1 GiB memory, 1 CPU, 128 processes, 1 GiB `/workspace`, 60 s per
command (15 min ceiling), 200 commands and 900 sandbox-seconds per run, 1 MiB
stdout and 256 KiB stderr per command, 256 MiB staged across all mounts.

## Agent manifest

<<< ../examples/manifests/workspace-review.agent.yaml

| Field      | Notes                                                                     |
| ---------- | ------------------------------------------------------------------------- |
| `ref`      | host workspace name                                                       |
| `alias`    | tool prefix and mount name; defaults to `ref`                             |
| `mode`     | `read` or `read_write`; cannot exceed the configured mode                 |
| `tools`    | subset of the tools the host exposes                                      |
| `required` | `false` lets the run proceed when the host does not configure the binding |

Aliases share one namespace with connection aliases. Required bindings are
resolved and the sandbox is validated before any run state is created; an
unknown workspace, an attempt to elevate `read` to `read_write`, or a missing
`sandbox` section fails the run immediately.

## Tools

Each bound workspace is served by an MCP server created inside the Agent
Runtime process and connected over an in-memory transport. The server holds no
policy and touches no content: it relays every call to the run sandbox. Tool
names use the `<alias>__<tool>` convention shared with remote connections.

| Tool           | Mode       | Purpose                                                                                 |
| -------------- | ---------- | --------------------------------------------------------------------------------------- |
| `list_files`   | read       | list files beneath a directory with an optional glob and limit                          |
| `read_file`    | read       | read a text window; binary files return metadata and an artifact reference              |
| `search_files` | read       | literal text search returning paths, line numbers, and lines                            |
| `write_file`   | read_write | create or replace one file                                                              |
| `delete_file`  | read_write | delete one file                                                                         |
| `<command>`    | per entry  | a host-configured program: fixed `argv` with a `{file}` argument, or `program` + `args` |
| `shell`        | per policy | a shell command in the mount directory, when `shell.enabled` is true                    |

Built-in operations are implemented by a small helper program that Agent
Runtime stages into the sandbox; it never runs in the agent process. Configured
commands run the host's exact `argv` (placeholders `{file}`, `{mount}`,
`{output}`) or a named `program` with model-supplied arguments validated
against `args.maxCount`, `args.allowPatterns`, and `args.denyPatterns`. Argv is
always passed as an array; nothing goes through a shell unless `shell` is
enabled.

Non-zero exits from commands are returned as output so the model can react to
failing tests. Policy denials, invalid paths, limits, budgets, and timeouts are
returned as tool errors (`tool_not_allowed`, `workspace_path_invalid`,
`workspace_limit_exceeded`, `sandbox_budget_exhausted`,
`sandbox_command_timeout`, `sandbox_command_failed`, `sandbox_unavailable`).

Binary `read_file` results never contain base64. When an `ArtifactStore` is
configured, the bytes are stored as an artifact and the reference is attached
to the tool result, which multimodal model adapters render as a file part.

## Sync and durability

Opening a staged workspace fails if any visible file exceeds `maxFileBytes`,
or if file-count, total-byte, or sandbox staging ceilings are exceeded. Files
over the limits are not silently skipped. Exclude unnecessary files with
`include`/`exclude` or raise the relevant limit after reviewing the input.

Visible files are staged into `/workspace/mounts/<alias>` when the sandbox
opens. After every command, read-write mounts are compared with the staged
baseline and changed files are written back through the workspace store,
which re-applies the path rule, visibility, and size limits. Read-only mounts
are staged with read-only permissions and are never synced back; changes the
model makes to them vanish with the sandbox. Paths the store rejects are
reported in the command record under `ignoredPaths`.

Workspaces are not run state. The sandbox is never checkpointed; a suspended
or resumed run rebuilds it from the stores, and a failed run does not roll
back writes already synced. Use `read` bindings, a scratch workspace, or host
version control when a run may be retried.

## Code steps

A `code` step that lists bound aliases in `workspaces` (or sets `sandbox: run`)
executes inside the run sandbox instead of a per-step sandbox. It sees the
mounts at the paths listed in `/workspace/workspaces.json`
(`AGENT_WORKSPACES_FILE`), receives `AGENT_VARIABLES_FILE` and
`AGENT_OUTPUT_DIRECTORY`, and its output files become artifacts. The command
is admitted, budgeted, and recorded like any other.

## Visibility and control

Every command produces `sandbox.command.started` and
`sandbox.command.completed` events carrying the exact argv, working directory,
exit code, duration, output sizes, changed files, ignored paths, and budget
usage. The same record is attached as `metadata.command` on the tool result or
step result, so the durable transcript is a complete audit trail. Sandbox
lifecycle produces `workspace.bound`, `sandbox.opened`, and `sandbox.closed`.

Hosts can veto before execution:

```ts
composeRuntime(
  manifest,
  config,
  {},
  {
    workspaceOptions: {
      authorizeWorkspace({ binding }) {
        authorizeForTenant(binding.ref);
      },
      authorizeSandbox({ image, mounts }) {
        assertApproved(image, mounts);
      },
      authorizeCommand({ record }, { runId }) {
        if (record.argv.includes("--force")) throw new Error("not permitted");
      },
    },
  },
);
```

## Bubblewrap

`sandbox.driver: bubblewrap` runs commands under
[bubblewrap](https://github.com/containers/bubblewrap) with separate user,
PID, IPC, UTS, cgroup, and network namespaces, read-only binds of the host
system directories, a private `/workspace` owned by the provider, and
`prlimit`-enforced memory, CPU, process, and file-size limits. It needs Linux
with unprivileged user namespaces and no container daemon, which makes it the
reference provider for local development and continuous integration. The
provider probes itself before a run and fails composition with a clear message
when bubblewrap or user namespaces are unavailable.

## Embedding

```ts
const composed = composeRuntime(
  manifest,
  config,
  {},
  {
    workspaceOptions: {
      provider, // optional: replaces config.workspaces
      runSandbox, // optional: replaces config.sandbox
      sandboxProvider, // required for sandbox.driver: host
      createWorkspace: (name) => stores[name], // backs driver: host workspaces
    },
  },
);
const runtime = new AgentRuntime({ ...composed, runStore, stepExecutors });
```

`composeRuntime` returns `workspaces` (a `WorkspaceProvider`) and `runSandbox`
(a `RunSandboxProvider`) alongside a `tools` adapter that merges workspace
tools with remote MCP tools. `createAgentRuntime({ manifest, workspaces,
runSandbox })` accepts host providers directly. Implement `WorkspaceStore` to
back a workspace with object storage or a database; it only enumerates and
moves opaque bytes.

## Remote execution

Workspaces and the sandbox are provisioned where the run executes. A worker
resolves them from its configuration file or `configReference`; inline request
configuration cannot define `workspaces` or `sandbox`, just as it cannot define
MCP connections.
