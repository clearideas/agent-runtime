---
title: Showcase
description: Six self-hosted, animated demos of workspaces, durable runs, guardrails, document tools, orchestration, and context management.
---

# Showcase

The showcase is a small web app you run on your own machine. Each of its six
demos runs a real agent through the real runtime and animates the event
stream as it happens. Every demo page also shows the manifest, host
configuration, and integration code that produced it.

| Demo                   | What it shows                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| **Repo Mechanic**      | A workspace, the run sandbox, an allowlisted test command, an `authorizeCommand` hook, and sync-back  |
| **Durable Runs**       | An approval step and a token budget that pause the run; resume in a new attempt, even after a restart |
| **Guardrails**         | An untrusted agent and a hostile model stopped by configuration, path rules, hooks, and the sandbox   |
| **Document Library**   | A read-only workspace with visibility globs, an image passed as an artifact, and an MCP tool          |
| **Orchestration**      | Parallel waves, a condition, collection and goal loops, in this process or a remote worker process    |
| **Long Investigation** | A step that reads three times its input limit; the runtime prunes or summarizes its context to finish |

## Run it

Requirements: Node.js 24 or newer and one of these sandbox setups:

- Docker Desktop or Docker Engine, using Linux containers. Python runs inside
  the image; it does not need to be installed separately on the host.
- Linux with bubblewrap and host `python3`.
- Host `python3` for the local, Scripted-only fallback when neither isolated
  sandbox is available.

```sh
git clone https://github.com/clearideas/agent-runtime.git
cd agent-runtime/examples/showcase
npm ci
npm run doctor
npm start
```

Open [http://127.0.0.1:4178](http://127.0.0.1:4178). These commands run from
`examples/showcase`, which has its own dependency lockfile and uses the
published runtime. A repository build is not required.

`npm run doctor` checks the sandbox and runs Repo Mechanic, Durable Runs and
Guardrails with scripted model decisions. Docker may pull its Python image
on the first run. Successful checks report a synced fix, an approval/resume
cycle, and blocked network access when the sandbox is isolated.

No API key is needed. In **Scripted** mode only the model's decisions are
scripted: the runtime, sandbox, workspace stores, policy hooks, checkpoints,
and MCP calls are real, and each next step is chosen from the real tool
results. Set `OPENAI_API_KEY` (or `SHOWCASE_PROVIDER` and `SHOWCASE_MODEL`)
and choose **Live** to use a real model.

## Sandboxes

Workspace demos need a run sandbox. The server uses
[bubblewrap](./workspaces.md#bubblewrap) on Linux, then Docker, and shows
which one is active. When neither is available it falls back to running
commands as ordinary processes in a temporary directory. That fallback is
only offered on `127.0.0.1` with the scripted model, and every page labels it
**Not isolated**. Guardrails shows the consequence: without a sandbox, the
agent's script reaches the network.

On Windows, install and start Docker Desktop (Linux containers). Then run
`npm run doctor`: it pulls the sandbox image, runs three demos inside Docker,
and with `-- --live` checks your model key, tool calls, and structured
output with three small calls. The
[showcase README](https://github.com/clearideas/agent-runtime/tree/main/examples/showcase#windows-with-docker)
has step-by-step PowerShell instructions.

On Ubuntu 24.04 and later, AppArmor blocks the unprivileged user namespaces
bubblewrap needs. Use Docker, or allow them on a development machine with
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

## Try each demo

Open a demo from the gallery, keep **Scripted** selected, and click **Run agent**.
The top bar shows the selected sandbox. Expand **More options** for model mode,
speed and demo-specific choices; **Under the hood** shows the actual manifest,
host code, audit trail and raw events.

### Repo Mechanic

Run with **Allow writes** enabled. Watch the tests fail, the agent edit the
invoice code, and the tests pass. The host file view shows the synced change.
After that successful fix, turn **Start from the buggy version** off under
**More options** and run again: the agent should find the workspace healthy
and skip the fix.

To try a refusal, turn **Start from the buggy version** back on, disable
**Allow writes**, and run again. The host refuses the write and the agent
reports a patch it could not apply.

### Durable Runs

Run once and wait for the approval panel. Choose **Approve and resume** to
publish the report, or **Reject** to finish without publication. The resumed
attempt uses a fresh sandbox and the saved draft.

For the budget path, enable **Token budget** before running. When it pauses,
use **Raise the limit … and resume**, then approve the report. To try restart
recovery, stop the server while the run is paused, restart with the same data
directory, and reopen the demo. Its pending approval or budget decision remains.

### Guardrails

Click **Run agent** and follow the attack board. It identifies the layer that
refused each attempt: configuration, tool integrity, path rules, host policy,
or sandbox isolation. The changed MCP tool is removed before model discovery.

This demo always uses its scripted hostile model. With an isolated sandbox,
the canary is not reached. With the fallback, the network attempt succeeds
and is displayed as an escape; the demo does not claim isolation in that mode.

### Document Library

Choose a question, then run. The annual-leave question uses a published policy;
the expense question reads a diagram as an image artifact; the home-office
stipend question files a ticket through the demo's local MCP endpoint because
no published policy answers it. Drafts and archived policies remain hidden,
and the library is read-only.

### Orchestration

Run the launch-plan agent and watch independent research branches overlap.
Use **More options** to compare parallel and sequential scheduling, change the
market condition, or choose the remote worker. Collection and goal loops are
shown in both modes. **Remote worker** starts a separate local Node.js process;
it does not require a cloud account.

### Long Investigation

An on-call agent reads sixteen service logs and a long runbook, more than
three times its step's `limits.maxInputBytes`, to find an incident's root
cause. Choose a **Context strategy** and watch the **Context window** chart:
every model request is a bar, split by message kind, against the limit.

- **Summarize** condenses the runbook before the first request, then folds
  older tool rounds into a running summary (Σ) while the newest two rounds stay
  verbatim.
- **Prune** clips the runbook, stubs older tool outputs, and removes the oldest
  rounds with a note (✂), with no extra model calls.
- **Off** reduces nothing: the step fails at the limit, as before context
  management existed. A dashed bar shows the request that was never sent.

**What the model sees now** lists the messages of the latest request. The
durable transcript keeps every tool result either way. See
[Context management](./context-management.md).

Long Investigation needs a runtime with context management. Until that
release is published, the showcase's published 0.6.3 packages mark it **Needs a
newer runtime**; run `npm run use-local-runtime` in `examples/showcase` (after
`npm ci` and `npm run build` at the repository root) to use the repository's
packages.

## Use a live model

Scripted mode needs no API key. To make real provider calls, use an isolated
sandbox and set the provider key in the same terminal that starts the server.
For OpenAI on Windows PowerShell:

```powershell
$env:OPENAI_API_KEY = "your-key"
npm run doctor -- --live
npm start
```

On macOS or Linux:

```sh
export OPENAI_API_KEY="your-key"
npm run doctor -- --live
npm start
```

Choose **Live** in a demo's model options after restarting. The live doctor
check makes three small real calls to verify tools, a reply using a tool result,
and structured output. Set SHOWCASE_MODEL to a model your account can use.
For another provider, set SHOWCASE_PROVIDER, SHOWCASE_MODEL, and that provider's
key; see the [README's provider setup](https://github.com/clearideas/agent-runtime/tree/main/examples/showcase#windows-with-docker).
Guardrails remains Scripted-only. Live model choices and wording can vary from
the scripted walkthrough.

## Saved state and troubleshooting

Run stores, artifacts and copied demo workspaces live in examples/showcase/.data
by default. Keep that directory to resume a paused run. Set SHOWCASE_DATA to
choose another location. The original fixtures and runtime package are not
edited by the demos.

| What you see                        | Next step                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| No sandbox or Docker is unreachable | Start Docker Desktop with Linux containers, then restart the server and run npm run doctor. |
| Live is unavailable                 | Check isolation and the provider key in the server terminal, then restart.                  |
| A failed tool call                  | Read the reason beneath it and the matching message in the server terminal.                 |
| A provider or model error           | Run npm run doctor -- --live and check the key and SHOWCASE_MODEL.                          |
| A saved run is no longer shown      | Confirm the restarted server is using the same SHOWCASE_DATA directory.                     |

## Read the code

Each demo lives in `examples/showcase/demos/<name>/`:

```text
agent.yaml            the portable agent manifest
runtime.config.yaml   host configuration: workspaces, sandbox, connections
host.ts               the integration, in numbered sections
script.ts             scripted-mode model decisions
```

Start with `host.ts`. Repo Mechanic, for example, composes configured
adapters with a host policy hook and runs the agent:

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

The browser receives the runtime's events unchanged as newline-delimited JSON.
`model.tool.*` events carry tool names, not payloads, so the showcase wraps its
`ToolAdapter` to mirror inputs and outputs to the page. Apply your own
redaction policy before doing the same in production.

## Test it

```sh
npm test
```

The tests type-check the host code and run every demo end to end through the
HTTP API with the scripted model and whichever sandbox the machine provides.
The suite also exercises the Live adapter path with mock provider responses;
it needs no provider credentials. On macOS/Linux, force the fallback with
`SHOWCASE_SANDBOX=unisolated npm test`. In PowerShell, set
`$env:SHOWCASE_SANDBOX = "unisolated"` before running `npm test`.
