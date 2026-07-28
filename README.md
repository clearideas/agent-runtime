# Clear Ideas Agent Runtime

A standalone, provider-neutral TypeScript runtime for defining, running, and
observing AI agents locally, inside an application, or on remote compute.

Agent Runtime is distributed as npm packages and does not require a hosted
Clear Ideas service. It separates portable agent manifests from execution
infrastructure, so the same agent contracts can run in-process, in a child
process, through a remote worker, or with host-provided adapters.

> **Public release status:** the packages are ready for npm and remain
> restricted until the public release is enabled. Once public, installing and
> using Agent Runtime will not require building this repository from source.

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

These install commands will become available when the npm packages are made
public.

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
- Sequential execution by default with optional dependency-safe prompt fan-out
- Streaming model output and ordered tool execution
- Native authorization boundaries for credentials, connections, and tools
- Native sandbox contracts for code execution and generated artifacts
- Durable checkpoints, suspension, fresh-process resume, and cancellation
- Local, child-process, and remote execution engines
- Memory, file, and SQLite run stores; JSONL and console event sinks
- Provider-neutral model, compute, sandbox, artifact, and telemetry adapters
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

## Versioning and release safety

Package changes use [Changesets](https://github.com/changesets/changesets):

```bash
npm run changeset
npm run version-packages
```

The checked-in release workflow is manual and additionally gated by the
repository variable `NPM_RELEASES_ENABLED=true` and a protected GitHub
environment. It requests an OIDC identity token for npm trusted publishing. A
separate read-only `NPM_READ_TOKEN` is required while the packages are private
so Changesets can read package metadata; it cannot publish.

All publishable packages use the `@clearideas` scope and explicitly target the
npm registry. The repository `.npmrc`, each package's `publishConfig`,
Changesets, and the release workflow all resolve or publish these packages
through `https://registry.npmjs.org/`. The pre-release packages use restricted
npm visibility and the `alpha` distribution tag until the public release is
enabled. No Agent Runtime package is configured for GitHub Packages.

The same workflow builds the VitePress documentation before publishing and
deploys it to a private S3 origin behind CloudFront at
[agent-runtime.clearideas.com](https://agent-runtime.clearideas.com/) only
after Changesets reports a successful npm publish or when documentation
deployment is explicitly requested. The deployment job uses GitHub OIDC to
assume a repository-scoped AWS role. It does not store long-lived AWS
credentials in GitHub.

These controls do not replace review. Before the first release:

1. approve the package names and repository coordinates;
2. authenticate to npm and run `npm run release:bootstrap:private`;
3. configure an npm trusted publisher on every package for the exact workflow,
   repository, and `npm-production` environment;
4. create a project-specific, read-only npm token as the `NPM_READ_TOKEN`
   secret on the `npm-production` environment;
5. protect `main`, restrict the `npm-production` environment to `main`, and
   require deployment review;
6. set the Pages source to **GitHub Actions**, restrict the `github-pages`
   environment to `main`, and
7. set `NPM_RELEASES_ENABLED=true`.

Run `npm run release:bootstrap:check` at any time to validate the package set
without contacting npm or publishing anything. The bootstrap publish is
resumable: package versions already present on npm are skipped.

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
