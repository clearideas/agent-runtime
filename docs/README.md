# Clear Ideas Agent Runtime

Clear Ideas Agent Runtime is a standalone TypeScript runtime for declarative AI
agents. It runs independently of a hosted Clear Ideas service and installs from
npm for use inside applications, from the CLI, or through remote execution
engines.

An agent manifest describes reusable behavior. An agent run manifest references
the agent and supplies runtime inputs. Host configuration defines model
providers, credentials, and connections. Native authorization boundaries,
sandbox contracts, durable state, and execution engines remain under host
control, with adapters for persistence, compute, sandbox providers, artifacts,
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

## Public deployment

The release workflow builds the documentation before package publishing and
deploys it to GitHub Pages only when Changesets reports that npm publishing
occurred. The documentation build job has read-only repository access and no
npm credentials. The deployment job receives only Pages and OIDC permissions.

Before the first deployment, configure the repository's Pages source as
**GitHub Actions**. Protect the `github-pages` environment so only `main` may
deploy. The workflow reads the Pages base path from GitHub, so it supports both
the default project URL and a configured custom domain.
