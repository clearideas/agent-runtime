# Design: Workspaces and the run sandbox

Status: implemented. This document is the agreed design for host-defined
workspaces, the run sandbox that operates on them, the tools a model may use
against them, and the reporting the host receives. A decision log and a list
of implementation deviations at the end record the choices made during review
and the small adjustments made while building.

## 1. Summary

A **workspace** is a host-owned collection of files — a code base, a document
store, a scratch area — that exists independently of any run. The host
configuration declares which workspaces exist, where they live, the widest
access mode they permit, which files are visible, and what software may be
executed against them. An agent manifest binds a workspace by name and may
only narrow what the host allowed.

When a run binds at least one workspace, the runtime opens a **run sandbox**:
one isolated container per run attempt, separate from the process executing
the agent, that lives until the run completes, fails, is cancelled, or
suspends. Visible files are staged into it. Every operation a model performs on
a workspace — listing, reading, searching, writing, deleting, or running
host-allowlisted software — is exactly one command executed inside that
sandbox, admitted by a host command policy, pre-authorizable by a host hook,
reported as events with its exact arguments and changed files, and recorded in
the durable transcript.

The process executing the agent never interprets workspace content. It moves
bytes opaquely, checks file names against a character rule, and parses
bounded, schema-validated JSON tool results — the same trust posture it
already takes toward results from remote MCP servers.

## 2. Goals and non-goals

Goals:

- Let agents work on durable, host-owned file collections declared in
  configuration and bound in manifests, with the same host-defines /
  manifest-narrows authorization model used for MCP connections.
- Keep all handling of workspace content — including read-only access — out of
  the agent's process and inside an isolated sandbox.
- Give models enough latitude to be useful (read, search, edit, run tests,
  convert documents) under a host-controlled command policy.
- Give the host complete visibility: every command is pre-authorizable,
  event-reported, budgeted, and recorded.
- Preserve provider neutrality: Docker and Modal sandboxes, and local,
  in-memory, or application-provided workspace stores, through existing ports.
- Keep checkpoints reference-only; the sandbox is disposable and rebuilt on
  resume.

Non-goals:

- Running the agent itself inside a sandbox. The agent process remains trusted
  host code.
- Running the MCP server that serves workspace tools inside the sandbox. Policy
  code stays in the trusted process; the sandbox executes only allowlisted
  software. Because the server is a real MCP server, relocating it later is a
  transport change, not a redesign.
- Transactional rollback of workspace writes on run failure. Writes are
  host-visible side effects applied through the workspace store; hosts that
  need rollback use a scratch workspace or version control.
- Network access from the run sandbox. The sandbox has no network.

## 3. Terminology

| Term                      | Meaning                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Workspace                 | A host-defined, durable collection of files addressed by relative POSIX paths.                                                   |
| Workspace store           | The `WorkspaceStore` port implementation holding a workspace's authoritative bytes (local directory, memory, application store). |
| Binding                   | A manifest entry that references a workspace by name and optionally narrows its mode and tools.                                  |
| Alias                     | The binding's tool prefix and mount directory name. Defaults to the workspace name.                                              |
| Run sandbox               | The single container opened for a run attempt that stages bound workspaces and executes every workspace command.                 |
| Mount                     | The staged copy of one workspace inside the run sandbox at `/workspace/mounts/<alias>`.                                          |
| Sandbox working directory | The container's `/workspace` directory used by all sandbox operations. Distinct from the workspace concept.                      |
| Helper                    | The runtime-shipped program staged into the run sandbox that implements the built-in file operations.                            |
| Command policy            | Host configuration that decides which argv the sandbox may execute and how the model may influence it.                           |
| Command                   | One argv executed in the run sandbox on behalf of one tool call or one code step.                                                |
| Sync-back                 | Copying changed files from a read-write mount back into its workspace store after a command.                                     |

## 4. Invariants

These must hold in every configuration and are the acceptance criteria for the
security review of the implementation.

| #   | Invariant                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | A manifest names workspaces only by reference. Manifests never contain host paths, images, commands, or credentials.                                                                                                                                |
| I2  | Effective privilege is the intersection of host configuration and manifest binding. A manifest may narrow mode and tools; it can never widen them.                                                                                                  |
| I3  | No workspace content is interpreted in the agent's process: no decoding, parsing, searching, globbing over content, or execution. The process handles file names (character rule), opaque byte buffers, hashes, and bounded JSON tool results only. |
| I4  | Every model-initiated operation on a workspace is exactly one command in the run sandbox, admitted by the command policy, pre-authorizable by the host, reported by events, budgeted, and recorded in the transcript.                               |
| I5  | Durable mutation of a workspace happens only through `WorkspaceStore.write()`/`delete()` during sync-back of a read-write mount, which re-applies the path rule, visibility, and size limits. Read-only mounts are never synced back.               |
| I6  | The run sandbox has no network, a read-only root filesystem, a non-root user, resource limits, and a bounded lifetime. Its contents are never checkpointed.                                                                                         |
| I7  | Checkpoints contain references (paths, hashes, artifact refs, command records), never workspace bytes.                                                                                                                                              |
| I8  | Request-supplied configuration (inline worker configuration, run manifests) cannot define workspaces, sandbox images, helpers, or command policies. Only trusted host configuration or host callbacks can.                                          |
| I9  | Host hooks can bind every sandbox opening and every command to the current user, tenant, and run.                                                                                                                                                   |

## 5. Architecture

```
HOST PROCESS (trusted; interprets no workspace content)
┌─────────────────────────────────────────────────────────────────────────────┐
│  AgentRuntime (core)                                                        │
│   ├─ resolves bindings → ResolvedWorkspace[]        (before createRun)      │
│   ├─ opens RunSandboxSession lazily, closes it in finally                   │
│   └─ StepExecutionContext { workspaces, runSandbox }                        │
│            │                                                                │
│  PromptStepExecutor ──▶ ToolAdapter (CompositeToolAdapter)                  │
│                          ├─ ConfiguredMcpToolAdapter   (remote MCP, HTTPS)  │
│                          └─ WorkspaceToolAdapter       (MCP relay)          │
│                               one tool call ⇒ one RunSandboxSession.execute │
│                                         │                                   │
│  WorkspaceProvider → WorkspaceStore(s)  │   authorizeCommand() hook         │
│  (authoritative; host-owned)            │   events: sandbox.*               │
│          ▲ stage / sync-back            ▼                                   │
│       ProviderRunSandbox (sandbox package) ── CommandPolicy ── SandboxProvider
└─────────────────────────────────────────────────────────────────────────────┘
                                          │ putFiles / execute(argv) / readFile
                                          ▼
     ┌──────────────────────────────────────────────────────────────────────┐
     │ RUN SANDBOX (one per run attempt; no network; read-only root; limits) │
     │  /workspace/mounts/<alias>/   staged visible files of each binding   │
     │  /workspace/output/           files collected as run artifacts        │
     │  /workspace/bin/agent-fs      runtime-shipped helper                  │
     │  host image software          pdftotext, rg, pytest, git, …           │
     └──────────────────────────────────────────────────────────────────────┘
```

Responsibilities:

- **contracts**: manifest binding type, code-step fields, event types, command
  record type.
- **core**: ports (`WorkspaceStore`, `WorkspaceProvider`, `RunSandboxProvider`,
  `RunSandboxSession`), binding resolution, session lifecycle, context
  plumbing, path rule.
- **store-local**: `LocalDirectoryWorkspace`, `MemoryWorkspace` — opaque byte
  stores with name and size checks only.
- **sandbox**: `ProviderRunSandbox` (staging, sync-back, command policy
  engine, helper staging, reporting), Docker provider additions (tmpfs size,
  read-only attach), helper asset.
- **config**: configuration schema, `WorkspaceToolAdapter` (MCP relay),
  `CompositeToolAdapter`, composition of providers and sessions from
  configuration.
- **step-prompt**: passes `workspaces` and `runSandbox` through
  `ToolExecutionContext`.
- **step-standard**: code steps may execute in the run sandbox.
- **cli / agent-runtime**: wiring, declarative Docker provider, inline
  configuration rejection.

## 6. Contracts

### 6.1 Agent manifest

```yaml
workspaces:
  - ref: source-code # host workspace name (required)
    alias: code # ^[a-z][a-z0-9-]*$; defaults to ref
    mode: read # read | read_write; may only narrow the host mode
    tools: [list_files, read_file, search_files, pytest] # subset of host tools
    required: true # false: skip silently when the host lacks it
```

```ts
export interface AgentWorkspaceBinding {
  ref: string;
  alias?: string;
  tools?: string[];
  mode?: "read" | "read_write";
  required?: boolean;
}

export interface AgentManifest {
  // ...existing fields
  workspaces?: AgentWorkspaceBinding[];
}
```

Validation (in `agentManifestSchema`):

- Aliases are unique across `workspaces` **and** `connections`; tool names
  share one namespace.
- `tools` entries are non-empty strings; unknown names are dropped at
  composition (intersection semantics, as for connections).
- A `code` step's `workspaces` entries must name declared binding aliases,
  without repetition.

### 6.2 Code step

```ts
export interface CodeStep extends AgentStepBase {
  type: "code";
  language: string;
  code: string;
  timeoutMs?: number;
  environment?: Record<string, string>;
  /** Bound workspace aliases available to the step. Implies sandbox: run. */
  workspaces?: string[];
  /** run: execute in the run sandbox; step: ephemeral per-step sandbox. */
  sandbox?: "run" | "step";
}
```

Rules: `sandbox` defaults to `run` when `workspaces` is non-empty and `step`
otherwise. `sandbox: step` with `workspaces` is a validation error (a per-step
sandbox receives no mounts). `sandbox: run` without `workspaces` is permitted
(shared scratch space, no mounts).

### 6.3 Events

New `RunEventType` members:

| Type                        | When                                              |
| --------------------------- | ------------------------------------------------- |
| `workspace.bound`           | once per resolved binding at run start and resume |
| `sandbox.opened`            | run sandbox created and staged                    |
| `sandbox.command.started`   | before a command executes                         |
| `sandbox.command.completed` | after execution, sync-back, and reporting         |
| `sandbox.closed`            | run sandbox terminated                            |

Payloads are specified in §13.

### 6.4 Command record

Attached as `ToolResult.metadata.command` and `StepResult.metadata.command`,
and embedded in `sandbox.command.completed`:

```ts
export interface SandboxCommandRecord {
  id: string; // command id, unique within the run
  runId: string;
  attempt: number;
  stepId: string;
  toolCallId?: string;
  workspace?: string; // binding ref
  alias?: string;
  kind: "builtin" | "command" | "shell" | "code";
  name: string; // tool or command name, e.g. read_file, pytest, shell
  policyEntry?: string; // config key that admitted a command/shell
  argv: string[]; // exact argv executed
  cwd: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  filesChanged: Array<{
    alias: string;
    path: string;
    action: "created" | "modified" | "deleted";
    size?: number;
    sha256?: string;
  }>;
  artifacts?: string[]; // artifact ids produced by this command
  /** Sandbox files not synced back, with the reason (path, size, store). */
  ignoredPaths: Array<{ alias: string; path: string; reason: string }>;
  budget: {
    commandsUsed: number;
    commandsLimit: number;
    sandboxSecondsUsed: number;
    sandboxSecondsLimit: number;
  };
}
```

## 7. Host configuration

### 7.1 Schema

```yaml
version: "1.0"

workspaces:
  source-code:
    driver: local # local | host (provided by code)
    root: ./repo # string (relative to this file) or { env: NAME }
    mode: read # read | read_write (default read)
    include: ["src/**", "**/*.md"] # globs over relative paths; default: all
    exclude: ["**/node_modules/**"] # globs; excluded paths are never staged
    maxFiles: 5000 # staged-file ceiling (default 5000)
    maxFileBytes: 1048576 # per-file ceiling (default 1 MiB)
    maxTotalBytes: 104857600 # staged-bytes ceiling (default 100 MiB)
    attach: auto # auto | never; provider-native read-only attach

  notes:
    driver: local
    root: { env: AGENT_NOTES_ROOT }
    mode: read_write

sandbox:
  driver: docker # docker | bubblewrap | host (SandboxProvider supplied by code)
  image: ghcr.io/acme/dev-tools:1.4 # allowlisted run-sandbox image (docker)
  allowedImages: [ghcr.io/acme/dev-tools:1.4] # docker driver only
  binds: [/usr, /bin, /sbin, /lib, /lib64] # bubblewrap driver only; read-only host directories
  helper:
    command: ["python3", "/workspace/bin/agent-fs"] # default
    source: bundled # bundled | { path: ./agent-fs } (host-supplied)
  limits:
    memoryMb: 1024 # default 1024
    cpuCount: 2 # default 1
    processLimit: 256 # default 128
    workspaceTmpfsMb: 1024 # default 1024; must exceed staged bytes
    commandTimeoutMs: 60000 # default 60 s; per-command ceiling
    maxCommandTimeoutMs: 900000 # default 15 min; ceiling for per-entry overrides
    maxCommandsPerRun: 200 # default 200
    maxTotalSandboxSeconds: 900 # default 900
    maxStdoutBytes: 1048576 # default 1 MiB
    maxStderrBytes: 262144 # default 256 KiB
    maxArgs: 64 # default 64
    maxArgBytes: 4096 # default 4096 per argument
    maxTotalStagedBytes: 268435456 # default 256 MiB across all mounts
  commands:
    extract_text:
      description: Extract text from a PDF.
      argv: ["pdftotext", "-layout", "{file}", "-"] # fixed; model supplies file
      inputs: ["**/*.pdf"] # which mount files {file} may name
      workspaces: [source-code] # optional restriction; default: all
      timeoutMs: 30000
    pytest:
      description: Run the test suite.
      program: pytest # model supplies args
      args:
        maxCount: 16
        denyPatterns: ["^-p$", "^--plugins?$", "^--rootdir"]
      modes: [read, read_write] # default: both
    git:
      program: git
      args:
        allowPatterns: ["^(status|diff|log|blame|show)$"] # first arg
        maxCount: 32
  shell:
    enabled: false # default false; true exposes <alias>__shell
    program: ["/bin/sh", "-c"] # default
    timeoutMs: 60000
```

### 7.2 Rules

- `workspaces` and `sandbox` are independent sections, but a manifest that
  binds any workspace requires a `sandbox` section (or a host-supplied
  `RunSandboxProvider`). Composition fails otherwise.
- `driver: host` for a workspace means the host supplies the `WorkspaceStore`
  through `workspaceOptions.createWorkspace` or a full `WorkspaceProvider`.
  `driver: host` for the sandbox means the host supplies a `SandboxProvider`.
- Literal `root` values loaded from a file resolve against that file's
  directory. Environment references resolve at composition time against the
  process working directory or `workspaceOptions.baseDirectory`.
- A read-mode workspace cannot be bound read-write. A `commands` entry with
  `modes: [read_write]` is not exposed for read bindings.
- Command entry names must match `^[a-z][a-z0-9_]*$`, must not collide with
  built-in operation names (`list_files`, `read_file`, `search_files`,
  `write_file`, `delete_file`) or `shell`, and are exposed as `<alias>__<name>`
  for each bound workspace they apply to.
- `argv` and `program` are mutually exclusive. `argv` entries may contain the
  placeholders `{file}` (a mount-relative path validated against `inputs`),
  `{mount}` (the mount directory), and `{output}` (`/workspace/output`). No
  other interpolation exists; argv is passed to the provider as an array and
  never through a shell unless `kind` is `shell`.
- `shell.enabled: true` exposes `<alias>__shell` for every binding whose
  effective mode the host permits (`shell.modes`, default both). The command
  is executed as `[...shell.program, command]` with the mount as `cwd`.
- Inline worker configuration (`ExecutionRequest.configuration`) may define
  neither `workspaces` nor `sandbox` (I8).

### 7.3 Defaults summary

| Setting                                        | Default                                         |
| ---------------------------------------------- | ----------------------------------------------- |
| workspace `mode`                               | `read`                                          |
| `include`                                      | every visible path                              |
| `exclude`                                      | none                                            |
| `maxFiles` / `maxFileBytes` / `maxTotalBytes`  | 5000 / 1 MiB / 100 MiB                          |
| `attach`                                       | `auto`                                          |
| sandbox `image`                                | the `python` profile image (`python:3.12-slim`) |
| `helper.command`                               | `["python3", "/workspace/bin/agent-fs"]`        |
| `memoryMb` / `cpuCount` / `processLimit`       | 1024 / 1 / 128                                  |
| `workspaceTmpfsMb`                             | 1024                                            |
| `commandTimeoutMs` / `maxCommandTimeoutMs`     | 60 000 / 900 000                                |
| `maxCommandsPerRun` / `maxTotalSandboxSeconds` | 200 / 900                                       |
| `maxStdoutBytes` / `maxStderrBytes`            | 1 MiB / 256 KiB                                 |
| `maxArgs` / `maxArgBytes`                      | 64 / 4096                                       |
| `maxTotalStagedBytes`                          | 256 MiB                                         |
| `commands`                                     | none (only built-in operations)                 |
| `shell.enabled`                                | `false`                                         |
| `read_file` window                             | 400 lines, maximum 2000                         |
| `search_files` results / scanned bytes         | 200 / 50 MiB                                    |
| `list_files` limit                             | 1000, maximum 5000                              |

## 8. Core ports

### 8.1 Path rule

```ts
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const isSafeWorkspacePath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 1024 &&
  value.split("/").length <= 64 &&
  value.split("/").every((segment) => SEGMENT.test(segment));
```

Relative, POSIX, no empty segments, no leading dot in any segment. `.`, `..`,
absolute paths, hidden entries, and names with spaces or non-ASCII characters
are unaddressable. The rule is applied by the store, by staging, by the
helper, by sync-back, and by the relay before any argument reaches a command.

### 8.2 WorkspaceStore

```ts
export interface WorkspaceEntry {
  path: string;
  size: number;
  modifiedAt?: string;
  sha256?: string; // optional; stores that know it avoid re-hashing
}

export interface WorkspaceStore {
  readonly mode: "read" | "read_write";
  /** Enumerate visible regular files. Never follows symbolic links. */
  entries(options?: { signal?: AbortSignal }): Promise<WorkspaceEntry[]>;
  /** Opaque bytes. Rejects sizes above the configured ceiling. */
  read(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  write?(
    path: string,
    data: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceEntry>;
  delete?(path: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** Provider-native attach support (e.g. a host directory). */
  readonly attachable?: { kind: "local-directory"; root: string };
}
```

There is deliberately no `search`, no text handling, and no listing filter:
the store enumerates and moves bytes. Include/exclude and size limits are
applied inside `LocalDirectoryWorkspace` so that invisible files are never
enumerated or readable. `attachable` is present only when `include`/`exclude`
are empty and the store is a plain directory; see §12.4.

### 8.3 WorkspaceProvider and ResolvedWorkspace

```ts
export interface WorkspaceProvider {
  resolveWorkspace(
    binding: AgentWorkspaceBinding,
    context?: { runId?: string; signal?: AbortSignal },
  ): Promise<WorkspaceStore | undefined>;
}

export interface ResolvedWorkspace {
  binding: AgentWorkspaceBinding;
  alias: string;
  mode: "read" | "read_write"; // effective
  store: WorkspaceStore; // narrowed: write/delete absent when mode is read
}

export const resolveAgentWorkspaces = async (
  manifest: AgentManifest,
  provider: WorkspaceProvider | undefined,
  context?: { runId?: string; signal?: AbortSignal },
): Promise<ResolvedWorkspace[]>;
```

Resolution runs before `createRun` and on every resume. Unknown required
bindings, elevation attempts, and a missing provider fail the run before any
state is persisted.

### 8.4 RunSandboxProvider and RunSandboxSession

```ts
export interface RunSandboxOpenRequest {
  runId: string;
  attempt: number;
  workspaces: readonly ResolvedWorkspace[];
  emit(type: string, data?: JsonObject): Promise<RunEvent>;
  artifacts?: ArtifactStore;
  signal?: AbortSignal;
}

export interface RunSandboxProvider {
  /** Validate that a session could be opened (image, provider, limits). */
  validate(request: Omit<RunSandboxOpenRequest, "emit">): Promise<void>;
  open(request: RunSandboxOpenRequest): Promise<RunSandboxSession>;
}

export interface RunSandboxCommandRequest {
  stepId: string;
  toolCallId?: string;
  idempotencyKey?: string;
  alias?: string;
  kind: "builtin" | "command" | "shell" | "code";
  name: string;
  /** Tool arguments (builtin/command/shell) or code-step inputs (code). */
  arguments: JsonObject;
  signal?: AbortSignal;
}

export interface RunSandboxCommandResult {
  record: SandboxCommandRecord;
  /** Parsed JSON from the helper or a command's stdout, when JSON was requested. */
  output?: JsonValue;
  stdout: string; // bounded
  stderr: string; // bounded
  artifacts?: ArtifactRef[];
}

export interface RunSandboxSession {
  readonly id: string;
  /** Tool descriptions this session can serve, after policy and narrowing. */
  tools(alias: string): Promise<AgentTool[]>;
  execute(request: RunSandboxCommandRequest): Promise<RunSandboxCommandResult>;
  /** Final sync-back and termination. Idempotent. */
  close(
    reason: "completed" | "failed" | "cancelled" | "suspended",
  ): Promise<void>;
}
```

Core dependencies gain `workspaces?: WorkspaceProvider` and
`runSandbox?: RunSandboxProvider`. `StepExecutionContext` gains
`workspaces?: readonly ResolvedWorkspace[]` and
`runSandbox?: () => Promise<RunSandboxSession>` (lazy open, memoized per
run). `ToolExecutionContext` gains the same two members so tool adapters can
execute commands for the current run without holding run state.

### 8.5 SandboxProvider additions

```ts
export interface SandboxProvider {
  // ...existing members
  readonly capabilities?: { readOnlyAttachments?: boolean };
  /** Check that a specification could be created without creating it. */
  validate?(
    spec: SandboxSpec,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

export interface SandboxSpec {
  // ...existing members
  /** Honored only by providers whose capabilities declare readOnlyAttachments. */
  attachments?: Array<{ source: string; target: string }>;
  /** Provider-visible labels, e.g. the owning run id for host cleanup. */
  metadata?: Record<string, string | number | boolean>;
}
```

`SandboxSpec.limits` gains `workspaceTmpfsMb?: number`. Attachments are
requested at `create` time because bind mounts are creation options for every
provider. Docker and bubblewrap declare `readOnlyAttachments`; the Modal
provider does not and falls back to staging.

### 8.6 BubblewrapSandboxProvider

`BubblewrapSandboxProvider` (`@clearideas/agent-runtime-sandbox`) is a core
shipped provider that runs every command under `bwrap --unshare-all
--die-with-parent --new-session --clearenv` with:

- read-only binds of the configured `binds` (default `/usr`, `/bin`, `/sbin`,
  `/lib*`, `/etc/alternatives`, and the dynamic-loader configuration);
  symbolic links such as `/bin → usr/bin` are recreated as links;
- `--proc /proc`, `--dev /dev`, a private `/tmp`, and `/workspace` bound from
  a provider-owned host directory (mode `0700`) that persists across the
  commands of one sandbox and is removed on `terminate`;
- read-only attachments as `--ro-bind source target`;
- `prlimit --as --cpu --nproc --fsize` resource limits when util-linux
  `prlimit` is available (recorded in `providerData.limitsEnforced`);
  otherwise only timeouts and output ceilings apply;
- a minimal environment (`PATH`, `HOME=/tmp`, `LANG=C.UTF-8`) plus the
  command environment;
- host-side `putFiles`, `listFiles`, and `readFile` that refuse any symbolic
  link component, so software inside the sandbox cannot redirect host-side
  reads or writes.

`validate()` probes `bwrap` once per provider and fails composition with a
message naming the cause when the binary is missing or unprivileged user
namespaces are disabled. It requires Linux. The `sandbox.driver: bubblewrap`
configuration needs no `image`; the `image` reported in events is
`bubblewrap`.

## 9. Run sandbox lifecycle

1. **Validation (run start and resume, before `createRun`/`resumeRun`).**
   Resolve bindings. If any binding resolved, require `runSandbox` and call
   `validate()`: provider present, image permitted, helper available, staged
   size estimate within `maxTotalStagedBytes` (from `entries()` sizes without
   reading bytes). Emit `workspace.bound` per binding.
2. **Opening (lazy).** The session is opened by the first step that calls
   `context.runSandbox()` — a prompt step whose tool list includes a workspace
   tool, or a code step with `sandbox: run`. Opening: `provider.create(spec)`
   with network `none`, limits from configuration, attachments for attachable
   read-only mounts; stage the helper to `/workspace/bin/agent-fs` (mode
   `0o500`); stage each non-attached mount (§12.1); write
   `/workspace/workspaces.json` (§12.5); emit `sandbox.opened`.
3. **Commands.** Each `execute()` follows §11 and §13. The session serializes
   commands per run: at most one command executes at a time, matching the
   runtime's rule that tool-enabled prompt steps and code steps stay ordered.
4. **Suspension.** Core calls `close("suspended")` before persisting the
   suspended state: final sync-back for read-write mounts, terminate, emit
   `sandbox.closed`. The resumed attempt re-validates, re-resolves, and opens
   a fresh session; mounts are re-staged from the stores.
5. **Completion, failure, cancellation.** `close(reason)` in a `finally`. On
   cancellation the in-flight command is aborted through the provider signal,
   sync-back is still attempted with a bounded timeout, and termination
   always runs.
6. **Crash.** The container is orphaned until the provider's reaper removes it
   (Docker: labels `agent-runtime.run=<runId>` for host cleanup; Modal:
   sandbox timeout equals `maxTotalSandboxSeconds` plus staging allowance).
   Nothing is lost beyond changes since the last command's sync-back, and the
   transcript records exactly which commands completed.

Budgets: `maxCommandsPerRun` and `maxTotalSandboxSeconds` are cumulative
across attempts and are persisted in checkpoint metadata
(`checkpoint.metadata.sandboxBudget`), following the token-budget precedent.
Exhaustion returns a `sandbox_budget_exhausted` tool error; the run does not
suspend automatically because, unlike tokens, a host cannot safely raise the
limit without reviewing what was executed.

## 10. Tool surface

### 10.1 Naming and discovery

`WorkspaceToolAdapter` is an MCP relay: for each resolved binding it creates an
in-process `McpServer` over an in-memory transport whose handlers do nothing
but build a `RunSandboxCommandRequest` and call `session.execute()`. Tool
descriptions are discovered through the MCP client and renamed
`<alias>__<tool>`. The adapter holds no run state; it receives `workspaces` and
`runSandbox` through `ToolExecutionContext` and `listTools` is computed from
the manifest bindings and configuration without opening a sandbox.

The set exposed for a binding is: built-in operations permitted by the
effective mode, plus configured `commands` entries applicable to the
workspace and mode, plus `shell` when enabled — intersected with the binding's
`tools` list when present.

### 10.2 Built-in operations

All run through the helper (§11). Paths are mount-relative and validated by the
relay before the argv is built, and again by the helper.

| Tool           | Input                                                                        | Output                                                                                                                                                                           | Mode       |
| -------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `list_files`   | `path?`, `glob?`, `limit?` (≤ 5000)                                          | `{ files: [{ path, size, mediaType, modifiedAt }], truncated }`                                                                                                                  | read       |
| `read_file`    | `path`, `startLine?`, `lineCount?` (≤ 2000)                                  | text: `{ path, size, mediaType, encoding: "utf-8", content, startLine, lineCount, totalLines, truncated }`; binary: `{ path, size, mediaType, encoding: "binary", artifactId? }` | read       |
| `search_files` | `query` (literal, 1–512 chars), `glob?`, `caseSensitive?`, `limit?` (≤ 1000) | `{ matches: [{ path, line, text }], truncated }`                                                                                                                                 | read       |
| `write_file`   | `path`, `content`, `encoding?` (`utf-8` default, `base64`)                   | `{ path, size, mediaType, modifiedAt }`                                                                                                                                          | read_write |
| `delete_file`  | `path`                                                                       | `{ path, deleted: true }`                                                                                                                                                        | read_write |

Binary `read_file`: the helper copies the file to
`/workspace/output/<commandId>/<basename>`; after the command, the session
collects `/workspace/output/<commandId>` through `provider.readFile` (opaque
bytes), stores it with `ArtifactStore.put`, attaches the `ArtifactRef` to the
`ToolResult`, and deletes the staged copy. Without an `ArtifactStore`, the
result carries metadata only and `note: "binary content requires an artifact store"`.
The existing prompt-step media resolution renders the artifact to
multimodal models unchanged. Base64 content is never placed in a tool result.

Text detection is performed by the helper (media type from extension, then a
NUL-free UTF-8 decode of the first 8 KiB). Files above `maxFileBytes` are
rejected by the helper with `limit_exceeded`.

### 10.3 Configured commands

`argv` entries: the model's input schema has one `file` property when the
template contains `{file}` and none otherwise. `program` entries: the input
schema has `args: string[]`. Both accept no other input. Output: `{ exitCode,
stdout, stderr, truncated, artifacts? }` where stdout/stderr are bounded and
any files written under `/workspace/output/<commandId>` become artifacts.
Non-zero exit is returned as output, not as a tool error, so the model can
react (e.g. failing tests); policy denials and limit violations are tool
errors.

### 10.4 Shell

`<alias>__shell` with input `{ command: string }` (≤ `maxArgBytes`), executed
as `[...shell.program, command]` in the mount directory. Same output shape as
configured commands. Documented as "the model authors code at run time";
disabled by default.

### 10.5 Tool errors

| Code                       | Meaning                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `tool_not_allowed`         | name not exposed for this binding                           |
| `tool_not_authorized`      | `authorizeTool` or `authorizeCommand` rejected the call     |
| `workspace_path_invalid`   | path fails the rule or names an invisible/unavailable file  |
| `workspace_limit_exceeded` | file, listing, search, argument, or output ceiling exceeded |
| `sandbox_budget_exhausted` | `maxCommandsPerRun` or `maxTotalSandboxSeconds` reached     |
| `sandbox_command_timeout`  | per-command timeout                                         |
| `sandbox_command_failed`   | provider or helper failure (non-zero exit from the helper)  |
| `sandbox_unavailable`      | session could not be opened                                 |

## 11. Command policy engine

Located in the sandbox package; invoked by `RunSandboxSession.execute` before
any provider call.

1. **Admission.** Map `(alias, kind, name)` to a policy entry: built-ins need
   the effective mode; `command` needs an entry whose `workspaces` and `modes`
   include the binding; `shell` needs `shell.enabled` and mode permission;
   `code` needs the step to have declared `sandbox: run`.
2. **Argument validation.** Built-ins: validate paths with the rule and
   numeric bounds. `argv` entries: `{file}` must match `inputs` globs and the
   rule; `{mount}`/`{output}` are substituted; no other placeholder is
   recognized and braces elsewhere are literal. `program` entries: `args`
   count ≤ `maxCount` (default `maxArgs`), each ≤ `maxArgBytes`, no NUL or
   control characters, `denyPatterns` rejected, `allowPatterns` (when present)
   required for the first argument. Shell: command length ≤ `maxArgBytes`.
3. **Argv construction.** Built-ins: `[...helper.command, <operation>, --mount,
/workspace/mounts/<alias>, ...flags]`. Commands:
   `[program, ...args]` or the substituted template. Shell:
   `[...shell.program, command]`. Total argument count ≤ `maxArgs`.
4. **Budget check.** Reject when `commandsUsed >= maxCommandsPerRun` or
   `sandboxSecondsUsed >= maxTotalSandboxSeconds`.
5. **Authorization hook.** `authorizeCommand(request, context)` with the
   exact argv; throwing yields `tool_not_authorized`.
6. **Execution.** `provider.execute(handle, { command: argv[0], args: argv.slice(1),
cwd, environment, timeoutMs })` with
   `environment = { AGENT_WORKSPACES_FILE, AGENT_OUTPUT_DIRECTORY, AGENT_COMMAND_ID }`
   only. Stdout and stderr are accumulated up to their ceilings; the process is
   aborted when a ceiling or the timeout is reached.
7. **Sync-back and artifact collection** (§12.2, §10.2).
8. **Reporting** (§13).

Timeouts: `entry.timeoutMs ?? commandTimeoutMs`, capped at
`maxCommandTimeoutMs`. Code steps use the step's `timeoutMs` under the same
cap.

## 12. Staging and sync

### 12.1 Staging a mount

For each binding in manifest order:

1. `entries = await store.entries()`; the store has already applied
   include/exclude and the path rule. Enforce `maxFiles`, `maxFileBytes` per
   entry, `maxTotalBytes` per workspace, and `maxTotalStagedBytes` overall.
   Exceeding any limit fails opening with `sandbox_unavailable` and a message
   naming the limit.
2. Read each entry's bytes through `store.read()` (opaque) and stage in
   batches of ≤ 4 MiB through `provider.putFiles` at
   `/workspace/mounts/<alias>/<path>`, mode `0o400` for read bindings and
   `0o600` for read-write bindings. Parent directories are created by the
   provider.
3. Record `{ path, size, sha256 }` for every staged file as the mount's
   baseline.

Hashing is over opaque bytes and is the only computation the host process
performs on content.

### 12.2 Sync-back (read-write mounts only)

After every command (and at `close`):

1. `provider.listFiles(handle, "/workspace/mounts/<alias>")` → current
   entries. Names are validated with the rule; non-conforming names (which
   software inside the sandbox could create) are never copied and are
   reported in the command record under `ignoredPaths` with reason `path` so
   the host sees them.
2. Compare against the baseline by size, then by `sha256` of bytes read
   through `provider.readFile` for candidates whose size differs or whose
   provider `modifiedAt` (when available) is newer. Files exceeding
   `maxFileBytes` are not synced and are reported under `ignoredPaths` with
   reason `size`.
3. For each changed or new file: `store.write(path, bytes)`; for each missing
   baseline file: `store.delete(path)`. The store re-applies the path rule,
   visibility, and size ceiling; a rejection is reported in `ignoredPaths`
   with reason `store`.
4. Update the baseline and populate `filesChanged`.

Read-only mounts are never listed for sync-back. Modifications the model makes
to a read-only mount's staged copy are confined to the sandbox and vanish with
it.

### 12.3 Host-side changes during a run

The store is authoritative but the session does not poll it. If the host
modifies a workspace while a run is active, the sandbox copy is stale until
the next attempt's staging, and sync-back from a read-write mount overwrites
host changes to the same paths. This is documented; hosts that need exclusion
take a lock around the run.

### 12.4 Provider-native attach

When `attach: auto`, a binding is **read-only**, its store is `attachable`,
and the provider implements `attachReadOnly`, the mount is a read-only bind of
the store's directory rather than a staged copy. No bytes pass through the
host process, and the `maxFiles`/`maxTotalBytes` limits do not apply (the
provider enforces read-only). Attach is never used for read-write bindings
(writes must pass through the store) or for stores with include/exclude
rules (a bind would expose excluded files). `attach: never` disables it.

### 12.5 `/workspace/workspaces.json`

```json
{
  "version": 1,
  "mounts": {
    "code": {
      "path": "/workspace/mounts/code",
      "mode": "read",
      "fileCount": 412
    },
    "notes": {
      "path": "/workspace/mounts/notes",
      "mode": "read_write",
      "fileCount": 3
    }
  },
  "output": "/workspace/output"
}
```

Exposed to commands and code steps through `AGENT_WORKSPACES_FILE`.

## 13. Authorization and reporting

### 13.1 Hooks (composition options)

```ts
interface WorkspaceHostOptions {
  authorizeWorkspace?(input: {
    binding: AgentWorkspaceBinding;
    workspace: ResolvedWorkspace;
    runId: string;
  }): void | Promise<void>;
  authorizeSandbox?(input: {
    runId: string;
    attempt: number;
    image: string;
    mounts: Array<{ alias: string; mode: string; fileCount: number }>;
  }): void | Promise<void>;
  authorizeCommand?(
    input: {
      record: Pick<
        SandboxCommandRecord,
        "kind" | "name" | "policyEntry" | "argv" | "cwd" | "alias" | "workspace"
      >;
      toolCall?: ToolCall;
    },
    context: { runId: string; stepId: string; attempt: number },
  ): void | Promise<void>;
}
```

### 13.2 Events

`workspace.bound` → `{ workspace, alias, mode, tools: string[], attach: boolean }`

`sandbox.opened` → `{ sandboxId, image, provider, mounts: [{ alias, mode, fileCount, bytes, attached }], helper: { version, command } }`

`sandbox.command.started` → `{ commandId, toolCallId?, kind, name, policyEntry?, alias?, argv, cwd, timeoutMs }`

`sandbox.command.completed` → the full `SandboxCommandRecord`

`sandbox.closed` → `{ sandboxId, reason, commandsUsed, sandboxSecondsUsed, finalSync: { filesChanged: number, ignored: number } }`

Events carry argv and paths verbatim to host sinks. The CLI's local JSONL
sink keeps its existing redaction of secret-like keys; stdout and stderr
content is never placed in events (byte counts only). Tool results retain
bounded stdout/stderr in the transcript, which follows the run store's data
policy, as tool outputs do today.

### 13.3 Transcript

Every workspace tool call's `ToolResult.metadata.command` is the
`SandboxCommandRecord`. Code steps executed in the run sandbox attach the
record to `StepResult.metadata.command`. The durable transcript therefore
contains the complete, ordered list of commands with arguments, exit codes,
durations, and changed files.

## 14. Code steps in the run sandbox

A code step with `sandbox: run` (explicit or implied by `workspaces`) executes
as a command of kind `code`:

1. The runtime profile for `language` supplies the interpreter command (as
   today). The step's `code` is staged at
   `/workspace/steps/<stepId>/main.<ext>` and variables at
   `/workspace/steps/<stepId>/variables.json`.
2. `cwd` is `/workspace/steps/<stepId>`; `AGENT_VARIABLES_FILE`,
   `AGENT_OUTPUT_DIRECTORY` (`/workspace/output/<commandId>`), and
   `AGENT_WORKSPACES_FILE` are set. Declared `environment` keys pass the
   existing `allowedEnvironment` allowlist.
3. Mounts listed in `workspaces` are visible at their mount paths; other
   mounts are still present in the container (one sandbox per run) but the
   step receives no path to them in `workspaces.json` — the file lists only
   the step's declared aliases for code commands. This is a convenience, not
   a boundary; the boundary is the run's set of bindings.
4. Output files are collected as artifacts and sync-back runs for read-write
   mounts, as for any command.
5. The step's `code.execution.started/completed` events are emitted as today,
   with `sandbox: "run"` and `commandId` added.

Code steps with `sandbox: step` are unchanged and continue to use
`ProviderSandboxAdapter`.

## 15. Helper program (`agent-fs`)

A single-file, dependency-free Python 3.9+ script bundled in the sandbox
package (`assets/agent-fs.py`), staged at `/workspace/bin/agent-fs`. Hosts
whose images lack Python supply a replacement through `sandbox.helper`
implementing the same protocol (a static binary is the expected choice).

Interface: `agent-fs <operation> --mount <dir> [flags] --json`. Operations and
flags mirror §10.2. Output is a single JSON document on stdout; diagnostics go
to stderr. Exit codes: `0` success, `2` usage, `3` path invalid or not found,
`4` limit exceeded, `5` read-only mount. The helper:

- re-validates every path with the rule and refuses symbolic links and
  non-regular files;
- resolves paths with `os.path.realpath` and requires the result to remain
  beneath the mount;
- performs literal substring search line by line with bounded scanned bytes
  and results; never uses regular expressions from input;
- writes atomically (temp file + `os.replace`) and creates parents;
- reports `protocolVersion: 1` in every document; the relay rejects mismatches.

The relay parses stdout with a 1 MiB ceiling and validates it against the
operation's output schema before returning it to the model.

## 16. Composition

```ts
const composed = composeRuntime(manifest, config, context, {
  workspaceOptions: {
    provider?: WorkspaceProvider,         // replaces config.workspaces
    createWorkspace?: (name, definition, context) => WorkspaceStore,
    sandboxProvider?: SandboxProvider,    // required for sandbox.driver: host
    runSandbox?: RunSandboxProvider,      // replaces config.sandbox entirely
    artifacts?: ArtifactStore,            // binary reads and command outputs
    baseDirectory?: string,
    ...WorkspaceHostOptions,
  },
});
// composed: { model?, tools?, workspaces?, runSandbox? }
new AgentRuntime({ ...composed, runStore, stepExecutors, ... });
```

- `tools` is a `CompositeToolAdapter` when both remote connections and
  workspace bindings exist; name collisions fail at discovery.
- `createAgentRuntime({ manifest, workspaces?, runSandbox? })` forwards
  host-supplied providers into composition so composed tools use them.
- The CLI composes from configuration: `sandbox.driver: docker` instantiates
  `DockerSandboxProvider` with `allowedImages`; `--artifacts` supplies the
  artifact store used for binary reads. Runtime modules may export
  `workspaces` (a `WorkspaceProvider`), `sandboxProvider`, or `runSandbox`.
- `config validate` reports `workspaceCount` and whether a sandbox section is
  present; `validate --config` checks bindings, modes, tool names, image
  allowlisting, and command entry validity.
- Workers: `executeWorkerInvocation` composes identically from the trusted
  configuration; `assertSafeInlineWorkerConfiguration` rejects `workspaces`
  and `sandbox` in inline configuration.

## 17. Remote execution

Workspaces and the sandbox are provisioned where the run executes. A remote
worker resolves them from its configuration file or `configReference`. The
host launcher is responsible for placing workspace data on the worker (clone,
volume, or an application `WorkspaceProvider` backed by object storage) and
for a `SandboxProvider` reachable from the worker (Docker on the worker, or
Modal sandboxes). Event streams and the transcript carry command records
across the execution boundary unchanged.

## 18. Security analysis

| Threat                                             | Mitigation                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Manifest references a host path or image           | I1: references only; unknown names fail before `createRun`                                                                     |
| Manifest elevates mode or adds tools               | I2: intersection; elevation rejected at composition and at resolution                                                          |
| Malicious file content (crafted PDF, archive bomb) | I3: content is opened only inside the sandbox by allowlisted software under memory, CPU, process, and time limits              |
| Path traversal / symlink escape                    | path rule + realpath check in store, staging, helper, and sync-back; symlinks never followed; hidden entries unaddressable     |
| Model runs arbitrary software                      | only policy-admitted argv; `program` allowlists; `shell` opt-in; argv never passed through a shell otherwise                   |
| Argument injection                                 | argv arrays, count and byte ceilings, control-character rejection, deny/allow patterns                                         |
| Sandbox writes outside a workspace                 | only `/workspace/mounts/<rw-alias>` is synced; only through `store.write` with the rule and visibility; read-only never synced |
| Exfiltration                                       | no network; outputs only via bounded tool results and artifacts through the host's `ArtifactStore`                             |
| Resource exhaustion                                | per-command timeout, per-run command and second budgets, stdout/stderr ceilings, staged size ceilings, tmpfs size              |
| Request-controlled configuration                   | I8: inline worker configuration cannot define workspaces or sandbox                                                            |
| Orphaned containers after a crash                  | provider labels and timeouts for reaping; nothing durable depends on the container                                             |
| Hidden activity                                    | I4: every command pre-authorizable, event-reported with argv and changed files, recorded in the transcript                     |

## 19. Package placement and dependencies

| Package             | Additions                                                                                    | New dependencies     |
| ------------------- | -------------------------------------------------------------------------------------------- | -------------------- |
| contracts           | binding, code-step fields, event types, `SandboxCommandRecord`                               | —                    |
| core                | ports, path rule, resolution, session lifecycle, context members                             | —                    |
| store-local         | `LocalDirectoryWorkspace`, `MemoryWorkspace`                                                 | —                    |
| sandbox             | `ProviderRunSandbox`, command policy engine, staging/sync, helper asset, Docker attach/tmpfs | —                    |
| config              | schema, `WorkspaceToolAdapter` (MCP relay), `CompositeToolAdapter`, composition              | sandbox, store-local |
| step-prompt         | context pass-through                                                                         | —                    |
| step-standard       | `sandbox: run` code steps                                                                    | —                    |
| cli / agent-runtime | wiring, declarative Docker provider, inline rejection                                        | sandbox (cli)        |

The dependency graph stays acyclic: `config → sandbox → core → contracts`.

## 20. Testing strategy

| Layer                 | Exercises                                                                                                                                                                                                               | Provider                                              | Runs without Docker                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Contracts and core    | binding validation, alias namespace, code-step rules, resolution and narrowing, lazy open, close on every terminal path, budget persistence across resume                                                               | fake `RunSandboxProvider`                             | yes                                                                    |
| Stores                | traversal, symbolic links, hidden entries, include/exclude on reads, size limits, atomic writes, deterministic enumeration                                                                                              | none                                                  | yes                                                                    |
| Policy engine         | table tests for admission, placeholders, input globs, argument patterns and ceilings, shell gating, code-step argv                                                                                                      | none                                                  | yes                                                                    |
| Helper protocol       | the bundled `agent-fs.py` executed by the host `python3` against temporary directories: every operation, path rule, symbolic links, windows, search bounds, snapshot hashes                                             | none                                                  | yes (needs python3)                                                    |
| Run sandbox session   | staging, sync-back (created/modified/deleted/ignored), artifact collection, timeouts, output ceilings, budgets, authorization, events and records, code steps                                                           | `HostProcessTestProvider` (`./testing`, no isolation) | yes (needs python3)                                                    |
| Real isolation        | namespaces, no network, read-only attachments unwritable, symbolic-link escape refusal, timeouts, `prlimit` memory limit, state cleanup, complete run sandbox with helper                                               | `BubblewrapSandboxProvider`                           | yes on Linux with unprivileged user namespaces; skips itself otherwise |
| Docker                | `validate` rejections and `create` argument construction (attachments, tmpfs size, labels) through a stub `docker` binary                                                                                               | stub                                                  | yes                                                                    |
| Composition and relay | schema defaults and rejections, manifest validation, MCP relay discovery and execution, composite routing, host-supplied providers                                                                                      | `HostProcessTestProvider`                             | yes                                                                    |
| CLI end to end        | a configured run with a scripted model: tool results, transcript records, JSONL events, `config validate`, inline-configuration rejection; and the same run under `sandbox.driver: bubblewrap` from configuration alone | host-process and bubblewrap                           | yes / Linux                                                            |

| Use-case scenarios | the four use cases from the design review (Repo Mechanic, Policy Desk, Quarterly Pack, Marketplace) executed end to end through `AgentRuntime` and `composeRuntime` from configuration with scripted models: tenant isolation, failing-then-fixed test suites, per-department authorization by path, multimodal artifact delivery, suspension and resume in a fresh runtime with a fresh sandbox, and an adversarial run asserting the outcome of every attack row | `BubblewrapSandboxProvider` | yes on Linux; skips itself otherwise |

Real Docker and Modal runs are exercised by hosts through the same
`SandboxProvider` contract; the run sandbox code path is identical.

## 21. Implementation order

All items ship in the first release; the order minimizes rework.

1. contracts and core ports; resolution; session lifecycle with a fake
   provider.
2. store-local stores.
3. sandbox: helper, policy engine, staging/sync, `ProviderRunSandbox`, Docker
   additions.
4. config: schema, relay adapter, composite adapter, composition.
5. step-prompt and step-standard integration.
6. CLI, `createAgentRuntime`, worker guard.
7. Documentation (`docs/workspaces.md`, reference, production, sandboxes
   pages), examples, changeset.

## 22. Decision log

| Decision                                                               | Outcome                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Separate mutable, path-addressed concept vs. extending `ArtifactStore` | separate concept: workspace                                                                                             |
| Name                                                                   | "workspace"; the container directory is called the sandbox working directory                                            |
| Host defines / manifest narrows, mirroring connections                 | adopted                                                                                                                 |
| Where file operations execute                                          | always in the run sandbox, including read-only access; never in the agent process                                       |
| Persistent run-scoped sandbox vs. per-operation sandboxes              | one run sandbox per attempt; copy-in, sync-back                                                                         |
| Provider-native attach                                                 | supported for read-only, unfiltered, attachable stores; otherwise staged                                                |
| Tool surface                                                           | built-in operations via a runtime-shipped helper, host-configured commands (fixed argv or program + args), opt-in shell |
| Tiers                                                                  | replaced by the command policy; hosts choose; shell disabled by default                                                 |
| Host visibility                                                        | `authorizeCommand` hook, `sandbox.*` events with argv and changed files, command records in the transcript              |
| MCP vs. plain adapter                                                  | real in-process MCP server acting as a relay; transport-independent                                                     |
| MCP server placement                                                   | host process; not inside the sandbox                                                                                    |
| Binary files                                                           | never base64; artifact reference for multimodal models; processing through commands                                     |
| Code steps                                                             | optional `sandbox: run`, implied by `workspaces`                                                                        |
| Write durability                                                       | immediate through sync-back after each command; no rollback on failure                                                  |
| Sync granularity                                                       | after every command and at close                                                                                        |
