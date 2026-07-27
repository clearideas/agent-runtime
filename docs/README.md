# Clear Ideas Agent Runtime

Clear Ideas Agent Runtime executes declarative AI agents with interchangeable
model, persistence, and compute adapters. An agent manifest describes reusable
behavior. An agent run manifest references the agent and supplies runtime
inputs. Host configuration defines model providers and connections. Adapters
provide persistence, events, approvals, remote execution, sandboxes, artifacts,
and telemetry.

Agent runs are sequential by default. An agent run manifest can enable
dependency-safe prompt fan-out; stateful steps and tool calls remain ordered.

## Start here

- [Quick start](./quickstart.md) — run an agent with only a model API key
- [Core concepts](./concepts.md) — manifests, configuration, state, steps, and adapters
- [Build agents](./build-agents.md) — prompt chains, routing, loops, tools, and approvals
- [Agent manifests and agent run manifests](./manifests.md) — reusable definitions and runtime inputs
- [Models and providers](./models-and-providers.md) — hosted and local models
- [Connections and tools](./connections-and-tools.md) — MCP and custom tool adapters
- [Events and streaming](./events-and-streaming.md) — interactive output and lifecycle callbacks
- [Embed Agent Runtime](./embedding.md) — compose the TypeScript API in an application
- [Adapter catalog](./adapters.md) — packaged model, storage, compute, sandbox, and telemetry integrations
- [Persistence and recovery](./persistence-and-recovery.md) — stores, checkpoints, resume, and fencing
- [Local execution](./local-execution.md) — embed execution in a Node.js process
- [Remote execution](./remote-execution.md) — worker protocol, HTTPS, and compute adapters
- [Sandboxes and artifacts](./sandboxes-and-artifacts.md) — isolated code and generated files
- [Production guide](./production.md) — security, limits, observability, and operations
- [Contract reference](./reference.md) — fields, adapter interfaces, events, and packages

## Choose an integration path

| Goal                             | Start with              | Add when needed                                          |
| -------------------------------- | ----------------------- | -------------------------------------------------------- |
| Try an agent locally             | CLI quick start         | model profiles, SQLite                                   |
| Add agents to a Node application | embedding guide         | custom event and persistence adapters                    |
| Run on ad hoc compute            | remote execution        | durable control plane, secure transport, compute adapter |
| Allow code or file generation    | sandboxes and artifacts | select a local or remote sandbox provider                |
| Operate a multi-instance service | production guide        | transactional store, telemetry, reconciliation           |

## Components

| Component          | Contents                                                            |
| ------------------ | ------------------------------------------------------------------- |
| Agent manifest     | prompts, variables, conditions, loops, and connection bindings      |
| Agent run manifest | agent reference and runtime variable overrides                      |
| Host configuration | model providers, model profiles, connections, and secret references |
| Host adapters      | persistence, events, tools, approvals, compute, and sandboxes       |

Applications provide infrastructure integrations through adapters. Optional
host metadata belongs in namespaced `extensions`.

## Documentation site

Install the documentation dependencies and start VitePress:

```sh
npm install --prefix docs
npm run docs:dev
```

Open `http://localhost:5173`.

Build the static site:

```sh
npm run docs:build
```

The static output is written to `docs/.vitepress/dist`.

Run all documentation checks with:

```sh
npm run docs:check
```
