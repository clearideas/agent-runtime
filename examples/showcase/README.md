# Agent Runtime Showcase

Self-hosted, animated demos of Clear Ideas Agent Runtime 0.6. Each demo runs a
real agent manifest through the real runtime on your machine — real run
sandboxes, real workspace files, real checkpoints — and visualizes the event
stream as it happens. Every page also shows the manifest, host configuration,
and integration code that produced it.

| Demo                   | What it shows                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Repo Mechanic**      | A workspace, the run sandbox, an allowlisted test command, an `authorizeCommand` hook, a code step, and sync-back                |
| **Durable Runs**       | An approval step and a token budget pause the run; it resumes in a new attempt with a new sandbox, even after a restart          |
| **Guardrails**         | An untrusted agent and a hostile model, stopped by configuration, tool digests, path and argument rules, a hook, and the sandbox |
| **Document Library**   | A read-only workspace with visibility globs, an image passed to the model as an artifact, and an MCP ticket tool                 |
| **Orchestration**      | A parallel wave, a condition, a collection loop, and a goal loop, in this process or in a separate worker process                |
| **Long Investigation** | A step that reads more than three times its input limit; Agent Runtime prunes or summarizes its context so it finishes           |

The example targets the published **0.6.2** runtime and uses a separate lockfile;
its dependencies are installed independently of the repository workspaces.

## Run it

Requirements: Node.js 24 or newer, plus either Docker with Linux containers
or `python3` on the host. Docker supplies Python inside its image; a separate
host Python installation is needed only for bubblewrap or the fallback.

```sh
cd examples/showcase
npm ci
npm start
```

Open [http://127.0.0.1:4178](http://127.0.0.1:4178). From the repository root,
`npm run example:showcase` starts it too.

No API key is needed. The default **Scripted** mode replaces only the
model's decisions; the runtime, sandbox, workspace stores, policies, and
checkpoints are all real, and the script chooses each next step from the real
tool results (failing test names, search matches, host denials). Choose
**Live** in a demo to use a real model instead:

```sh
export OPENAI_API_KEY="..."
npm start
```

## Windows with Docker

Docker gives the showcase a real, isolated sandbox on Windows, and enables
live models. Use PowerShell for these steps.

1. **Install** [Node.js 24 or newer](https://nodejs.org) and
   [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/).
   Keep Docker's default **Linux containers** (the WSL 2 backend is
   recommended).
2. **Start Docker Desktop** and wait until it shows that the engine is
   running.
3. **Install the showcase:**

   ```powershell
   git clone https://github.com/clearideas/agent-runtime.git
   cd agent-runtime\examples\showcase
   npm ci
   ```

4. **Check the setup:**

   ```powershell
   npm run doctor
   ```

   The first time, this pulls the `python:3.12-slim` image (about 50 MB). It
   then runs three demos inside Docker. A working setup prints:

   ```text
   ✓ docker is available and isolated
   ✓ Repo Mechanic: 8 commands ran in docker; the fix synced back and the tests pass
   ✓ Durable Runs: paused for approval, then resumed with a fresh sandbox and published
   ✓ Guardrails: the sandbox blocked a script's network access
   ```

5. **Optional: a live model.** Set the key in the same PowerShell window you
   start the showcase from, then confirm it with three small real calls
   (a tool call, a reply using its result, and a structured answer):

   ```powershell
   $env:OPENAI_API_KEY = "sk-..."
   npm run doctor -- --live
   ```

   The default model is `openai/gpt-6-luna`. To use another model or provider:

   ```powershell
   $env:SHOWCASE_MODEL = "<model name>"        # another OpenAI model
   # or another provider:
   $env:SHOWCASE_PROVIDER = "anthropic"        # anthropic, google, xai, groq, cohere
   $env:SHOWCASE_MODEL = "<model name>"
   $env:ANTHROPIC_API_KEY = "..."
   ```

6. **Start it:**

   ```powershell
   npm start
   ```

   Open [http://127.0.0.1:4178](http://127.0.0.1:4178). The top bar shows
   **Sandbox: docker**. With a key set, each demo shows a **Model** choice;
   pick **Live**. Guardrails always uses its scripted, hostile model, and the
   Orchestration **Remote worker** option needs nothing extra: it starts a
   second Node.js process on your machine.

`$env:` variables last only for that PowerShell window. In `cmd.exe`, use
`set OPENAI_API_KEY=sk-...` instead.

| You see                                  | Do this                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Docker is not reachable`                | Start Docker Desktop, wait for the engine, then restart the showcase                                                                            |
| `Docker is running windows containers`   | Right-click the Docker icon, choose **Switch to Linux containers**                                                                              |
| **Not isolated** in the top bar          | Docker was not running when the showcase started; start Docker, then restart the showcase                                                       |
| Live is greyed out                       | Set the provider key in the window that runs `npm start`, then restart                                                                          |
| The live check fails with an auth error  | Check the API key                                                                                                                               |
| The live check fails with a model error  | Set `SHOWCASE_MODEL` to a model your account can use                                                                                            |
| The first run is slow                    | The image is being pulled; run `npm run doctor` once beforehand                                                                                 |
| `EPERM: operation not permitted, rename` | Run data is in a OneDrive or antivirus-scanned folder; set `SHOWCASE_DATA` to a local folder such as `$env:LOCALAPPDATA\agent-runtime-showcase` |
| A tool call fails (red in the terminal)  | The reason is shown under it and printed in the `npm start` window; include it in reports                                                       |

## Sandboxes

Workspace demos need a run sandbox. The server picks the best one available
and shows it in the top bar:

| Sandbox        | Where                                                | Isolation                                                          |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| **bubblewrap** | Linux with unprivileged user namespaces and `bwrap`  | Namespaces, no network, read-only system binds, resource limits    |
| **Docker**     | Any OS with a running Docker daemon                  | Container with no network, read-only root, resource limits         |
| **unisolated** | Fallback on `127.0.0.1` with the scripted model only | **None.** Commands run as host processes in a temporary directory. |

The demo manifests and configuration files declare `driver: bubblewrap`, as a
Linux host would ship them; `lib/environment.ts` swaps in Docker or the
fallback when bubblewrap is unavailable. The fallback exists so the demos
start on any laptop. The UI marks it **NOT ISOLATED** and disables Live mode
while it is in use. Production hosts choose their sandbox in configuration and
never fall back.

- **Ubuntu 24.04 and later** restrict unprivileged user namespaces through
  AppArmor, so `bwrap` fails by default. Use Docker, or allow namespaces on a
  development machine only:
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
- **Docker** uses `python:3.12-slim` by default (the image needs `python3`).
  The showcase pulls it on first start; set `SHOWCASE_DOCKER_IMAGE` to use
  another image.

## Repo Mechanic

An agent receives a bug report about invoice discounts. It lists the
repository, runs the test suite (two tests fail), searches for
`discount_rate`, reads the file, writes a fix, reruns the tests (all pass),
and a `code` step re-verifies inside the same sandbox before a final step
writes a pull-request description. The first step both calls tools and
returns a structured diagnosis (`outputSchema`); the Fix step's `when`
condition reads that diagnosis.

What to watch:

1. **Agent → host policy → sandbox.** Each tool call travels from the active
   step through the host policy shield (`authorizeCommand`) into the sandbox.
2. **One tool call is one command.** The sandbox terminal shows each command
   with a one-line result: the tests fail, the file is written, the tests pass.
3. **Sync-back.** The changed file travels back to the host's files. Files the
   host hides, such as `.env.example`, never enter the sandbox.

Turn off **Allow writes** and the host policy blocks the write; the agent
reports a patch it could not apply. **More options** holds the bug report,
model mode, speed, and whether to start from the buggy version (turn it off
and the agent finds nothing to fix, so the Fix step is skipped).

**Under the hood** has the source files, the audit trail (one
`SandboxCommandRecord` per command, as stored in the durable transcript), and
the raw event stream.

### Files

```text
demos/repo-mechanic/
  agent.yaml            the portable agent: binds "invoice-service", narrows tools
  runtime.config.yaml   host config: workspace root, visibility, sandbox policy
  host.ts               the integration: composeRuntime + policy hooks + AgentRuntime
  script.ts             scripted-mode model decisions
  fixture/              the buggy repository, copied into .data/ per run
```

Start with `host.ts`. Its numbered sections are the whole integration:

```ts
const composed = composeRuntime(
  manifest,
  config,
  { environment: { ...process.env, SHOWCASE_REPO_ROOT: root } },
  {
    workspaceOptions: {
      authorizeCommand({ record }) {
        if (!allowWrites && record.name === "write_file")
          throw new Error("Writes are disabled by the host policy.");
      },
    },
  },
);
const runtime = new AgentRuntime({
  ...composed,
  runStore: new FileRunStore(".data/runs"),
  stepExecutors: [new PromptStepExecutor(), new CodeStepExecutor()],
  conditionEvaluator: new JexlConditionEvaluator(),
  eventSinks: [{ emit: (event) => sendToBrowser(event) }],
});
await runtime.run({ manifest, runId, signal });
```

## Durable Runs

An agent drafts a quarterly report from a read-only `sales-data` workspace into
a read-write `reports` workspace, then reaches an approval step whose prompt
is templated with the run's variables ("Publish the Q3 revenue report?"). The host's
`ApprovalAdapter` throws `RunSuspendedError`, so the run is saved by
`FileRunStore` and its sandbox closes. **Approve** resumes it in a new attempt
with a new runtime and a new sandbox; the draft comes back from the host's
files. Turn on **Token budget** and the run also pauses mid-draft when it has
used 1,000 tokens; raising the limit continues without repeating any tool
call. A paused run survives a server restart.

With a live model, the draft and publish steps each list the `reports`
workspace before writing or reading a file by name: a workspace's tool paths
are relative to that workspace itself, but a model can still decide to nest a
file it writes under a folder named after the workspace, and the next attempt
needs to find it wherever it landed. Listing first is the pattern to copy for
any file a live model names itself.

## Guardrails

An agent from a marketplace, driven by a scripted hostile model, tries to get
out. Before the run, the host refuses the manifest's requests for write
access, a shell, a different AI provider (the model policy allows only the
host's profile), and a webhook to an AI endpoint (the host runs no webhook
steps); it also removes a vendor MCP tool whose description changed after
approval (pinned digests), and the step that names it runs without it. During the run, path and argument rules, a host
quota hook, files that were never staged, the network-free sandbox, and the
command budget stop the rest. One script tries to call an OpenAI-style
endpoint with the host's API key: sandboxed commands receive no host
environment, so there is no key, and no network to send it on.

The board reads from the host's side: green shields are blocked attacks,
grey dots are allowed actions, and red is an escape. A canary listener (which
also plays the attacker's AI endpoint) checks the network claim; without a
sandbox it is reached, and the demo says so.

## Document Library

A policy assistant answers from a read-only library. `include` and `exclude`
globs publish only the current policies, so a draft and an archived version
stay on the host. A diagram is read as a binary file and reaches the model as
an image artifact. When no published policy answers, the agent files a
ticket through an MCP server; workspace tools and MCP tools arrive through one
composed `ToolAdapter`.

## Orchestration

A launch-plan agent: three research steps that read only the brief run
together in parallel mode, a `when` condition skips mitigation for an
unregulated market, a collection loop writes one pitch per channel, and a goal
loop rewrites the headline until a critique approves it. **Runs in** switches
between `InProcessExecutionEngine` and a `RemoteExecutionEngine` whose worker
is a separate process reached over HTTP with signed callbacks. The browser
code is the same for both.

## Long Investigation

An on-call agent reads sixteen service logs and a 29 KB runbook to find why
checkout failed. Together they are more than three times the step's
`limits.maxInputBytes` (40 KB). Pick a context strategy:

- **Summarize** (`summarize-or-prune`): a summarizer condenses the runbook
  before the first request, then folds older tool rounds into one running
  summary while the newest two rounds stay verbatim.
- **Prune**: the runbook is clipped, older tool outputs become stubs, and the
  oldest rounds are removed with a note. No extra model calls.
- **Off** (`fail`): nothing is reduced, and the step fails at the limit.

The context-window chart draws every request the step sends, split by message
kind, against the limit. The host measures requests with a thin
`ModelAdapter` wrapper and streams sizes and kinds only, never content. The
host chooses the strategy as a host default policy; the manifest's own
`policies.context` merges over it: the 25% reduction goal, the opening
prompt's share, the summarizer's size limits and chunk size, and a variable
that is never shortened. The host also supplies a summarizer adapter that
wraps the built-in summarizer and reports each summarization (what it
condensed, the size it was asked for, the size it produced) to the reductions
log.

## How the showcase is built

```text
server.ts                        HTTP wiring: static files, JSON endpoints, NDJSON run streams
demos/<name>/                    one folder per demo (agent.yaml, runtime.config.yaml, host.ts, script.ts)
lib/catalog.ts                   the list of demos
lib/environment.ts               sandbox detection and the Scripted/Live mode policy
lib/scripted-model.ts            a paced, deterministic ModelAdapter
lib/host-kit.ts                  small helpers the demo hosts share
lib/observed-tools.ts            mirrors tool inputs and outputs to the browser
lib/mcp-server.ts                a minimal local MCP server for the demos
lib/workspace-files.ts           seeds demo workspaces and lists them from the host's side
lib/unisolated-provider.ts       the Not isolated demo fallback
public/assets/lib/run-state.js   event stream → view state (DOM-free, unit tested)
public/assets/lib/stage.js       the shared stage: agent → policy → sandbox → host files
public/assets/lib/demo-page.js   page wiring shared by every demo
public/assets/lib/context-state.js  model-input + context.reduced → context chart state (DOM-free)
public/assets/<demo>.js          what each page adds (attack board, graph, decision panel, context chart)
```

`model.tool.*` events carry tool names, never payloads. To show inputs and
outputs, the host wraps its `ToolAdapter` (`lib/observed-tools.ts`) and
streams them alongside the events. Apply your own redaction policy before doing
this in production.

The header loads Inter locally from `public/assets/fonts/`, using the same
font asset as the Docs theme. Its license is included in that directory.

The browser uses no framework or build step. Markdown is rendered with Marked
and DOMPurify, code with Highlight.js, all served locally under a strict
Content-Security-Policy.

## Configuration

| Variable                | Default            | Purpose                                                   |
| ----------------------- | ------------------ | --------------------------------------------------------- |
| `SHOWCASE_HOST`         | `127.0.0.1`        | Listen address. The unisolated fallback requires loopback |
| `SHOWCASE_PORT`         | `4178`             | Listen port                                               |
| `SHOWCASE_SANDBOX`      | `auto`             | `bubblewrap`, `docker`, or `unisolated` to force one      |
| `SHOWCASE_DOCKER_IMAGE` | `python:3.12-slim` | Image for the Docker sandbox; must include `python3`      |
| `SHOWCASE_PROVIDER`     | `openai`           | Live-mode provider for the `default` model profile        |
| `SHOWCASE_MODEL`        | `gpt-6-luna`       | Live-mode model                                           |
| `SHOWCASE_DATA`         | `.data/`           | Run store, artifacts, and demo workspaces                 |

Delete `.data/` to reset everything.

## Test

```sh
npm run doctor   # checks this machine and runs three demos in the sandbox
npm test         # the full test suite
```

The tests type-check the host code, unit-test the browser's event-to-state
logic, and run every demo end to end through the HTTP API with the scripted
model and whichever sandbox the machine provides. Force a sandbox with
`SHOWCASE_SANDBOX=unisolated npm test`.

## Notes

- **Developing against unreleased runtime changes.** `package.json` pins the
  published `@clearideas/agent-runtime` packages, and Long Investigation
  needs the context management added after 0.6.3. With an older runtime the
  demo is marked **Needs a newer runtime** and the other demos run as usual.
  To use the repository's own packages instead:

  ```sh
  # at the repository root
  npm ci
  npm run build
  # in examples/showcase
  npm ci
  npm run use-local-runtime
  ```

  The script removes the published `@clearideas` packages from this
  example's `node_modules`, so Node resolves them from the repository's
  workspace. Rebuild at the root after changing runtime code; run `npm ci`
  here to return to the published packages. At release, pin both
  `@clearideas` dependencies (and the lockfile) to the published version that
  contains context management.

- The unisolated fallback runs the interpreter that `python3` resolves to
  when the server starts, so pyenv or asdf shims and the macOS developer-tools
  stub work even though sandbox commands receive almost no environment. If a
  sandbox command still fails, the helper's error output is printed in the
  terminal running `npm start`.
