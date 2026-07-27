# Clear Ideas Agent Runtime

A declarative, provider-neutral TypeScript runtime for defining, running, and
observing AI agents locally or on remote compute.

The runtime separates agent manifests from execution infrastructure. An agent
can use the same contracts with in-process execution, a child process, a remote
worker, or host-provided adapters.

> **Pre-release:** this repository is an extracted release candidate. Every npm
> package remains `private: true`, and the release workflow is disabled by
> default. No package is ready to publish until the release checklist is
> approved.

## Capabilities

- Versioned YAML and TypeScript agent manifests
- Sequential execution by default with optional dependency-safe prompt fan-out
- Streaming model output and ordered tool execution
- Provider-neutral model, persistence, sandbox, artifact, and telemetry ports
- Durable checkpoints, suspension, fresh-process resume, and cancellation
- Local, child-process, and remote execution engines
- Memory, file, JSONL, console, and SQLite persistence options
- Privacy-conscious OpenTelemetry integration

Parallel mode is selected per agent run. It runs independent, tool-free prompt
steps concurrently and commits their results in manifest order. Stateful steps,
loops, and tool calls remain ordered.

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

## Develop locally

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

Start with the [quickstart](docs/quickstart.md), then see
[concepts](docs/concepts.md), [embedding](docs/embedding.md), and
[production guidance](docs/production.md).

## Included adapters

Agent Runtime packages adapters separately from the core contracts. Install
only the integrations used by the host application.

| Capability     | Included implementations                  |
| -------------- | ----------------------------------------- |
| Models         | AI SDK provider adapter                   |
| Persistence    | memory, files, JSONL, console, and SQLite |
| Conditions     | JEXL                                      |
| Remote compute | Modal                                     |
| Sandboxes      | Docker and Modal                          |
| Telemetry      | OpenTelemetry                             |

See the [adapter catalog](docs/adapters.md) for package names and integration
guidance.

## Versioning and release safety

Package changes use [Changesets](https://github.com/changesets/changesets):

```bash
npm run changeset
npm run version-packages
```

The checked-in release workflow is manual and additionally gated by the
repository variable `NPM_RELEASES_ENABLED=true` and a protected GitHub
environment. It requests an OIDC identity token for npm trusted publishing; it
does not contain an npm token.

All publishable packages use the `@clearideas` scope and explicitly target the
public npm registry. The repository `.npmrc`, each package's `publishConfig`,
Changesets, and the release workflow all resolve or publish these packages
through `https://registry.npmjs.org/`. No Agent Runtime package is configured
for GitHub Packages.

These controls do not replace review. Before the first release:

1. approve the package names and public repository coordinates;
2. complete [license review](LICENSE_REVIEW.md);
3. remove `private: true` only from packages intentionally being published;
4. configure npm trusted publishers for the exact GitHub workflow and
   environment;
5. enable required branch and environment protection; and
6. set `NPM_RELEASES_ENABLED=true`.

## Project policies

- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)
- [Support](SUPPORT.md)
- [Provenance](PROVENANCE.md)

## License

Apache License 2.0 is proposed for the public release. See [LICENSE](LICENSE) and
[LICENSE_REVIEW.md](LICENSE_REVIEW.md).

Copyright 2026 Clear Ideas Incorporated. Clear Ideas and the Clear Ideas logo
are trademarks of Clear Ideas Incorporated. See [TRADEMARKS.md](TRADEMARKS.md).
