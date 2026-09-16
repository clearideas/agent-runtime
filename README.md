# Clear Ideas Agent Runtime

A standalone, provider-neutral TypeScript runtime for defining, running, and
observing AI agents locally, inside an application, or on remote compute.

Agent Runtime separates portable agent manifests from execution infrastructure,
so the same agent contracts can run in-process, in a child process, through a
remote worker, or with host-provided adapters. Applications retain control of
models, credentials, tools, persistence, compute, sandboxes, and telemetry.
It is an independent open-source project licensed under Apache 2.0.

## Try it in five minutes

Use Agent Runtime when you want declarative agents with checkpoints, tool
execution, and observable progress while keeping control of providers and
infrastructure. Start locally; use the same manifests when embedding in an app.

**Prerequisites:** Node.js 24 or newer and an OpenAI API key for this example.
No database or container runtime is required.

```sh
mkdir my-agent && cd my-agent
npm init -y
npm install --save-dev @clearideas/agent-runtime-cli
export OPENAI_API_KEY="..."
npx agent-runtime examples run variables --stream
```

Expect step progress followed by `PORTABLE_AGENT is ready.` (model wording can
vary). Runs and checkpoints are saved under `.agent-runtime/`.

Next, [create your own agent](https://agent-runtime.clearideas.com/quickstart).
The quickstart includes a complete YAML manifest and troubleshooting.

For TypeScript applications:

```sh
npm install @clearideas/agent-runtime
```

See [embedding](https://agent-runtime.clearideas.com/embedding) for a minimal host.

## Learn three patterns

From a source checkout, `npm ci && npm run build`, then try the
[three runnable examples](examples/patterns/README.md):

- **Prompt chain:** typed invocation variables and structured final output.
- **Tool agent:** visible tool calls and recovery from a temporary read failure.
- **Approval:** persist a suspended run and resume it in a new process.

All three have a deterministic path that needs no credentials.

## Documentation

The complete documentation is available at
[agent-runtime.clearideas.com](https://agent-runtime.clearideas.com/).

- [Quickstart](https://agent-runtime.clearideas.com/quickstart)
- [Build agents](https://agent-runtime.clearideas.com/build-agents)
- [Embed Agent Runtime](https://agent-runtime.clearideas.com/embedding)
- [Connections and tools](https://agent-runtime.clearideas.com/connections-and-tools)
- [Contract reference](https://agent-runtime.clearideas.com/reference)
- [Production guide](https://agent-runtime.clearideas.com/production)

## Capabilities

- Versioned YAML and TypeScript agent manifests
- Manifest-to-graph scheduling with deterministic orchestration and dependency-safe fan-out
- Streaming model output and ordered tool execution
- Native authorization boundaries for credentials, connections, and tools
- Native sandbox contracts for code execution and generated artifacts
- Durable checkpoints, suspension, fresh-process resume, and cancellation
- Cumulative model-token budgets with durable suspension and raised-limit resume
- Local, child-process, and remote execution engines
- Host-resolved Modal Sandbox networking with blocked, direct-domain, and
  proxy-only modes
- Memory, file, and SQLite run stores; JSONL and console event sinks
- Provider-neutral model, compute, sandbox, artifact, and telemetry adapters
- Privacy-conscious OpenTelemetry integration

For each run, Agent Runtime resolves the manifest's variable reads and outputs
into a dependency-aware execution plan. With parallel mode enabled, eligible
independent prompt branches execute concurrently while dependent, stateful, and
tool-enabled work remains ordered. Results commit in manifest order, preserving
deterministic orchestration while reducing elapsed time when the graph contains
independent work.

## Dependency-aware graph execution

[![Watch Agent Runtime resolve a manifest into a dependency-aware execution graph](https://clearideas.com/assets/images/agent-runtime-parallel-poster.png)](https://clearideas.com/open-source/agent-runtime#manifest-graph-execution)

[Watch the 27-second manifest graph execution demonstration](https://clearideas.com/open-source/agent-runtime#manifest-graph-execution).

## A declarative alternative

For teams evaluating LangChain, LangGraph, or a custom agent harness, Agent
Runtime provides a manifest-first option:

- agent behavior and run inputs use portable, versioned contracts;
- local and remote execution share the same event and checkpoint model;
- providers, persistence, compute, sandboxes, and telemetry are adapters;
- credentials and tool authorization remain host-controlled; and
- graph-scheduled execution, loops, conditions, approvals, and resumable runs
  use one runtime.

Applications can embed the TypeScript API, invoke the CLI, or implement the
remote execution protocol without changing their agent manifests.

## Repository layout

| Path                      | Purpose                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `packages/agent-runtime`  | Primary `@clearideas/agent-runtime` entry point              |
| `packages/contracts`      | Versioned manifests, events, checkpoints, and schemas        |
| `packages/core`           | Deterministic execution engine and host ports                |
| `packages/runtime`        | Provider, model, connection, and secret configuration        |
| `packages/cli`            | `agent-runtime` command-line interface                       |
| `packages/step-*`         | Prompt, loop, approval, webhook, code, and sub-run executors |
| `packages/store-*`        | Local and SQLite persistence adapters                        |
| `packages/execution*`     | Execution contracts, engines, and compute adapters           |
| `packages/sandbox*`       | Sandbox contracts and provider adapters                      |
| `packages/artifacts`      | Sandboxed artifact generation                                |
| `packages/telemetry-otel` | OpenTelemetry event sink                                     |
| `docs`                    | VitePress documentation                                      |
| `examples`                | Manifests and runnable integrations                          |

## Use the repository

Requirements:

- Node.js 24 or newer
- npm 11

```bash
npm ci
npm run validate
```

Useful focused commands:

```bash
npm run build
npm test
npm run check:boundaries
npm run check:docs
npm run check:tarballs
```

For the smallest browser-hosting example, see the
[Agent Runner example](examples/agent-runner/README.md) and its
[code-first video walkthrough](examples/agent-runner/WALKTHROUGH.md).

These commands are for contributors developing Agent Runtime itself. Users of
the public packages can start with the
[quickstart](https://agent-runtime.clearideas.com/quickstart), then see
[concepts](https://agent-runtime.clearideas.com/concepts),
[embedding](https://agent-runtime.clearideas.com/embedding), and
[production guidance](https://agent-runtime.clearideas.com/production).

## Included adapters

Agent Runtime packages adapters separately from the core contracts. Install
only the integrations used by the host application.

| Capability     | Included implementations  |
| -------------- | ------------------------- |
| Models         | AI SDK provider adapter   |
| Persistence    | memory, files, and SQLite |
| Event sinks    | JSONL and console         |
| Conditions     | JEXL                      |
| Remote compute | Modal                     |
| Sandboxes      | Docker and Modal          |
| Telemetry      | OpenTelemetry             |

See the [adapter catalog](https://agent-runtime.clearideas.com/adapters) for
package names and integration guidance.

## Versioning and releases

Package changes use [Changesets](https://github.com/changesets/changesets):

```bash
npm run changeset
npm run version-packages
```

Releases use generated package changelogs and GitHub release notes. Publishing
remains manually approved through the protected GitHub workflow; local checks
do not publish. See [Contributing](CONTRIBUTING.md) for release validation.

## Project policies

- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)
- [Support](SUPPORT.md)
- [Provenance](PROVENANCE.md)

## License

Agent Runtime is licensed under the Apache License 2.0. See [LICENSE](LICENSE).

Copyright 2026 Clear Ideas Incorporated. Clear Ideas is a trademark of Clear
Ideas Incorporated. See [TRADEMARKS.md](TRADEMARKS.md).
