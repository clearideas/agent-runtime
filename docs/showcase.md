---
title: Showcase
description: Five self-hosted, animated demos of workspaces, durable runs, guardrails, document tools, and orchestration.
---

# Showcase

The showcase is a small web app you run on your own machine. Each of its five
demos runs a real agent through the real runtime and animates the event
stream as it happens. Every demo page also shows the manifest, host
configuration, and integration code that produced it.

| Demo                 | What it shows                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **Repo Mechanic**    | A workspace, the run sandbox, an allowlisted test command, an `authorizeCommand` hook, and sync-back  |
| **Durable Runs**     | An approval step and a token budget that pause the run; resume in a new attempt, even after a restart |
| **Guardrails**       | An untrusted agent and a hostile model stopped by configuration, path rules, hooks, and the sandbox   |
| **Document Library** | A read-only workspace with visibility globs, an image passed as an artifact, and an MCP tool          |
| **Orchestration**    | Parallel waves, a condition, collection and goal loops, in this process or a remote worker process    |

## Run it

Requirements: Node.js 24 or newer and `python3`.

```sh
git clone https://github.com/clearideas/agent-runtime.git
cd agent-runtime/examples/showcase
npm ci
npm start
```

Open [http://127.0.0.1:4178](http://127.0.0.1:4178).

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
Force the fallback with `SHOWCASE_SANDBOX=unisolated npm test`.
