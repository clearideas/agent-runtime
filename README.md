# Clear Ideas Agent Runtime

A standalone, provider-neutral TypeScript runtime for defining, running, and
observing AI agents locally, inside an application, or on remote compute.

Agent Runtime separates portable agent manifests from execution infrastructure,
so the same agent contracts can run in-process, in a child process, through a
remote worker, or with host-provided adapters. Applications retain control of
models, credentials, tools, persistence, compute, sandboxes, and telemetry.
It is an independent open-source project licensed under Apache 2.0.

## Install from npm

Install the standard TypeScript composition:

```sh
npm install @clearideas/agent-runtime
```

Or install the CLI locally and run it with `npx`:

```sh
npm install --save-dev @clearideas/agent-runtime-cli
npx agent-runtime examples list
```

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

The release workflow is manually dispatched, gated by the repository variable
`NPM_RELEASES_ENABLED=true`, and protected by the `npm-production` GitHub
environment. npm trusted publishing uses GitHub OIDC, so publishing does not
require a long-lived npm token.

All publishable packages use the `@clearideas` scope and explicitly target the
npm registry. The repository `.npmrc`, each package's `publishConfig`,
Changesets, and the release workflow all resolve or publish these packages
through `https://registry.npmjs.org/` with public access and npm provenance. No
Agent Runtime package is configured for GitHub Packages.

The same workflow builds the VitePress documentation before publishing and
deploys it to a private S3 origin behind CloudFront at
[agent-runtime.clearideas.com](https://agent-runtime.clearideas.com/) after a
successful npm publish or when documentation deployment is explicitly
requested. The deployment job uses GitHub OIDC to assume a repository-scoped
AWS role. It does not store long-lived AWS credentials in GitHub.

Run `npm run release:check` to validate the complete package set without
publishing. Official releases are produced only by the protected GitHub
workflow.

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
