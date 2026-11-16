# Agent Runtime Showcase

Interactive examples of Clear Ideas Agent Runtime 0.10, available locally or
on a hosted server. Each demo executes an agent manifest and visualizes the
runtime's event stream. Every page also shows the manifest, host configuration,
and integration code used by the example.

| Demo                   | What it shows                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Repo Mechanic**      | A workspace, the run sandbox, an allowlisted test command, an `authorizeCommand` hook, a code step, and sync-back                 |
| **Durable Runs**       | Approval, a token limit, and a provider outage pause the run; resume it, restart from a step's snapshot, or edit the agent        |
| **Guardrails**         | Scripted unauthorized actions tested against configuration, tool digests, path and argument rules, a hook, and the sandbox        |
| **Document Library**   | A read-only workspace with visibility globs, an image passed to the model as an artifact, and an MCP ticket tool                  |
| **Orchestration**      | A parallel wave, a condition, a collection loop, and a goal loop, in this process or in a separate worker process                 |
| **Long Investigation** | An investigation that processes logs and a runbook larger than its input limit, using context pruning or summarization            |
| **Data Chat**          | A chat, one run per message: moderation, data read and charts rendered in the sandbox, and a signed history the browser keeps     |
| **Document Chat**      | A chat about a Word document: each revision is a real .docx written in the sandbox, kept in a workspace per conversation, by turn |

The example targets Agent Runtime **0.10** and uses a separate lockfile. Until
0.10.0 is published, it installs the runtime from this repository
(`file:../../packages/...`), so build the repository first: run `npm ci` and
`npm run build` at the repository root, then `npm ci` here.

## Run it

To connect a local page to an on-demand hosted showcase instead, run
`SHOWCASE_URL=https://your-showcase-host.example npm run launch` and open
`http://127.0.0.1:4179`. Only the launcher runs locally. The
[hosting recipe](../../infrastructure/showcase/README.md) covers portable Linux
hosting, the optional Modal deployment, and GitHub Actions.

Requirements: Node.js 22.20.0 or newer, plus either Docker with Linux containers
or `python3` on the host. Docker supplies Python inside its image; a separate
host Python installation is needed only for bubblewrap or the fallback.

```sh
cd examples/showcase
npm ci
npm start
```

Open [http://127.0.0.1:4178](http://127.0.0.1:4178). From the repository root,
`npm run example:showcase` starts it too.

No API key is needed in the default **Scripted** mode. A script supplies model
decisions based on tool results, such as failing test names, search matches,
and host denials. The runtime executes the tools, applies policies, updates
workspace files, and saves checkpoints. Choose **Live** in a demo to make
model-provider calls:

```sh
export OPENAI_API_KEY="..."
npm start
```

## Run it on the Python runtime

Every demo also runs on [Agent Runtime for Python](../../python/README.md):
`server.py` serves the same pages and API as `server.ts`, and each demo's
`host.py` and `script.py` sit beside its `host.ts` and `script.ts`, using the
same `agent.yaml`, `runtime.config.yaml`, and fixtures. The top bar shows
**Runtime: Python**, and "How it's built" shows the Python sources.

Requirements: [uv](https://docs.astral.sh/uv/) (it installs Python 3.11+ and
the runtime from `../../python`), plus this example's `npm ci` for the browser
libraries.

```sh
cd examples/showcase
npm ci
npm run start:python         # uv run --project ../../python python server.py
npm run doctor:python        # the doctor, on the Python runtime
```

It listens on the same port and reads the same `SHOWCASE_*` variables; its
default data directory is `.data-python/`. Both servers can run at once on
different ports. Keep their `SHOWCASE_DATA` directories separate: the Python
port uses checkpoint contract 1.0 while the TypeScript durability update uses
1.1, so cross-runtime resume is not yet supported. Durable Runs uses
`agent.python.yaml` on the Python server because the TypeScript manifest has
new 0.10 policy fields.

## Windows with Docker

Docker gives the showcase a real, isolated sandbox on Windows, and enables
live models. Use PowerShell for these steps.

1. **Install** [Node.js 22.20.0 or newer](https://nodejs.org) and
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
files. A paused run survives a server restart.

Turn on **Token limit** and the run is granted only 1,000 tokens
(`RunRequest.limits`): it is blocked mid-draft, and raising the limit
continues without repeating any tool call. Turn on **Provider outage** and
every model call fails while Publish runs; the step retries
(`policies.modelRetry`), then the run is blocked instead of failed
(`policies.onFailure: pause`), with the cause saved in its checkpoint.
**The provider is back: resume** runs Publish again without repeating the
draft or the approval.

When a step completes, the host's reports store snapshots the folder at the
step commit point (`WorkspaceStore.commit`) and the token is recorded in the
step's checkpoint. **Restart points** lists them; **Restart from here** starts
a new run from that checkpoint (`RunRequest.seed`), and the host's workspace
provider restores the snapshot (`restoreFrom`), so restarting after Draft
asks for approval again on the same draft.

**Agent edit** applies a change to the agent for the next run, resume, or
restart, and shows what it would do before anything runs
(`assessManifestChange`): a new limit or a changed Publish step is accepted
while Publish has not run; a changed Draft step reruns Draft if the run was
blocked in it, and is refused once Draft has completed; a changed variable is
refused for every resume and restart. A refused edit can still start a new
run.

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
quota hook, files that were never staged, and the network-free sandbox stop
the rest. When the model floods the sandbox, the command budget blocks the
run: it is saved for the host to grant more, and this host never does. One
script tries to call an OpenAI-style
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

## Data Chat

A normal chat with a sales analyst, built on conversation messages. Every
message you send is one run of the same manifest:

1. **Moderate** reads only the newest message, as data through the
   `messages` variable, and returns a verdict.
2. **Analyze** runs only when the message is allowed. It sees the last six
   messages as real conversation turns, so "that" and "it" resolve, and reads
   the CSV files inside the run sandbox.
3. **Chart** is a `code` step that runs only when a chart was asked for. It
   renders a PNG in the sandbox with nothing but the Python standard library;
   the file it writes becomes a run artifact, shown in the chat.
4. **Reply** sees the whole conversation and writes the final output.

The browser keeps the conversation. Each message sends the history the host
returned last time, its signature, and the new text; the run returns the
history with the reply appended, signed again. The host keeps no session.

What to watch:

1. **A blocked message.** The second suggestion asks for customer email
   addresses. Moderation blocks it, every later step is skipped, and the run's
   final output is the verdict. The page does not keep that turn, so the
   retry continues from the same signed history.
2. **Compaction.** The agent accepts six messages. When the chart request
   crosses that, Agent Runtime summarizes the earlier conversation once,
   before the first step. The summary comes back in the history, so later
   messages start from it and never summarize the same messages again.
3. **Tampering.** Under **Tamper with the history**, choose **Edit a past
   reply** or **Replay in another conversation**,
   then send anything: the host refuses the history before any run exists
   (`MESSAGES_SIGNATURE_INVALID`), so no model is called.
4. **Hidden data.** `customers.csv` holds contact details. The host's
   visibility rules keep it out of the sandbox, so the agent never sees it.

Data Chat uses the conversation history support included in the pinned
Agent Runtime 0.9.0 packages.

### Files

```text
demos/data-chat/
  agent.yaml            declares messages; moderate, analyze, chart, reply
  runtime.config.yaml   host config: the sales data, what is visible, the sandbox
  host.ts               one run per message, the host's signing key, the scope
  script.ts             scripted-mode model decisions
  fixture/              the sales data, copied into .data/ on first start
```

## Document Chat

A chat with an editor about a Word document, built on conversation messages
and a workspace per conversation. Attach a `.docx`, or pick a suggestion to
start with the sample proposal. Every message is one run:

1. **Read** is a `code` step. Inside the run sandbox, with the Python
   standard library only, it opens the newest `.docx` in the conversation's
   workspace and lists its paragraphs, numbered, with their styles.
2. **Revise** sees the whole conversation as real turns, then the listing,
   and returns edits by paragraph number: replace, insert after, or delete.
   It never touches the file.
3. **Save** is a second `code` step. It applies the edits to the document's
   XML, keeping every untouched paragraph, table, and format, and writes the
   result as this turn's revision. Its output names the new file and is the
   reply.

The host keeps one directory per conversation and binds it as the agent's
`conversation` workspace for each run. An upload is saved under the turn it
arrives in (`turns/001/input/proposal.docx`), using the turn number Agent
Runtime assigns, and the message names it; each revision lands in
`turns/NNN/output/`. The history carries only text. The host opens a
conversation's directory only for a history it signed for that
conversation.

What to watch:

1. **The document.** Open any version in the **Document** panel, with its
   changes from the version before, or download it and open it in Word.
2. **The workspace.** The panel beside the chat lists every file by turn;
   the stage's host files show the revision each run writes back.
3. **Compaction.** The agent accepts eight messages. At the fifth message,
   Agent Runtime summarizes turns 1–3 once; the manifest words the summary's
   heading. The summary keeps each revision's path and turn, so **What have
   we changed so far?** still lists all four files.

Scripted mode handles the suggestions and a few similar requests on any
document; choose **Live** to ask for anything. Document Chat needs the same
newer runtime as Data Chat.

### Files

```text
demos/document-chat/
  agent.yaml            declares messages and the conversation workspace; read, revise, save
  runtime.config.yaml   host config: the conversation workspace and the sandbox
  host.ts               one run per message, one directory per conversation, uploads by turn
  script.ts             scripted-mode model decisions
  fixture/proposal.docx the sample document
lib/docx.ts             reads a .docx for the page's preview
```

## How the showcase is built

```text
server.ts                        HTTP wiring: static files, JSON endpoints, NDJSON run streams
server.py                        the same server on the Python runtime (Starlette + uvicorn)
demos/<name>/                    one folder per demo (agent.yaml, runtime.config.yaml, host.ts,
                                 script.ts, and their Python editions host.py and script.py)
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
lib/*.py                         the Python editions of lib/*.ts (scripted_model.py, host_kit.py, …)
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

The same HTTP tests run against the Python server, together with the parity
tests that compare the two servers:

```sh
npm run test:python   # every test/*.test.ts against server.py, and test/parity.python.ts
```

With `SHOWCASE_RUNTIME=python`, `test/helpers.ts` starts `server.py` in the
repository's Python environment (`python/.venv`, created with uv when
missing) instead of `server.ts`. Live-mode tests reach the Python server's
real OpenAI adapter through a local stand-in endpoint
(`test/python-live-provider.ts`) answered by the same demo scripts.

The parity tests (`test/parity.python.ts`) run every demo on both servers
and require the same browser stream, host state, model requests, and stored
run records and checkpoints, after normalizing IDs, times, ports, and
measured durations. In Live mode, the provider must receive the same requests
from both runtimes' OpenAI adapters. They also resume runs and continue chats
across the two runtimes. This parity gate currently fails until the Python
port adopts the TypeScript 0.10 durability behavior. From the repository
root, `make test-showcase` runs this gate, and `make test` runs the Python host
library's unit tests (`test_py/`).

## Notes

- **Developing against unreleased runtime changes.** `package.json` uses the
  repository's own runtime packages. Rebuild them after changing runtime code:

  ```sh
  # at the repository root
  npm ci
  npm run build
  # in examples/showcase, install the local packages
  npm ci
  ```

  The `use-local-runtime` script is retained for older published-package
  installs; the package file references now make it unnecessary.

- The unisolated fallback runs the interpreter that `python3` resolves to
  when the server starts, so pyenv or asdf shims and the macOS developer-tools
  stub work even though sandbox commands receive almost no environment. If a
  sandbox command still fails, the helper's error output is printed in the
  terminal running `npm start`.

## Optional consent and analytics

Self-hosted showcases do not send analytics by default. To enable the shared
consent client, register this deployment's exact origin and site key in the API's
`BROWSER_ANALYTICS_SITES_JSON`, then set both values before starting the showcase:

```sh
SHOWCASE_ANALYTICS_API_BASE_URL=https://api.clearideas.com \
SHOWCASE_ANALYTICS_SITE_KEY=ci-runtime-demo npm start
```

The server exposes only these public settings. It serves the pinned npm client's
script and stylesheet locally, keeps the existing strict CSP, and permits network
connections to the configured collector origin. The built-in consent banner owns
optional tracking. A footer **Cookie settings** link reopens preferences and replaces
the floating settings button. Chat is disabled for the showcase.

For local API testing, use `https://api.clearideas.local` and explicitly register the
local showcase origin (including its port). Do not point a development site key at
an unregistered production collector. Omitting both variables disables analytics;
partial or invalid configuration fails at startup.
