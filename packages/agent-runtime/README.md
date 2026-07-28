# `@clearideas/agent-runtime`

The standalone TypeScript runtime for portable, declarative agents. Run agents
locally, inside an application, or through a remote execution engine while
retaining control of providers, credentials, tools, state, and compute.

[Documentation](https://agent-runtime.clearideas.com/) ·
[GitHub repository](https://github.com/clearideas/agent-runtime)

## Install

```sh
npm install @clearideas/agent-runtime
```

Requires Node.js 24 or newer.

## What is included

The package exports the standard Agent Runtime composition:

- versioned Agent Manifest and Agent Run Manifest contracts;
- the execution core, checkpoints, resume, cancellation, and ordered events;
- model profiles and AI SDK model-provider configuration;
- MCP connections with credential references, connection modes, tool
  allowlists, and host authorization hooks;
- prompt, loop, approval, webhook, code, and sub-run step contracts and
  executors;
- local persistence and local or remote execution interfaces.

Authorization policy and sandbox contracts are native runtime capabilities.
Concrete compute, sandbox, persistence, artifact, and telemetry providers are
available as separate `@clearideas/agent-runtime-*` packages so applications
install only the infrastructure they use. The project includes Docker and Modal
sandbox providers, SQLite persistence, generated-file handling, Modal compute,
and OpenTelemetry.

## Use the CLI

For a first local run:

```sh
npm install --save-dev @clearideas/agent-runtime-cli
npx agent-runtime examples list
npx agent-runtime examples run variables --stream
```

The CLI persists runs and events locally by default.

## Documentation

The complete guides and reference are available at
[agent-runtime.clearideas.com](https://agent-runtime.clearideas.com/).

- [Quickstart](https://agent-runtime.clearideas.com/quickstart)
- [Build agents](https://agent-runtime.clearideas.com/build-agents)
- [Embed Agent Runtime](https://agent-runtime.clearideas.com/embedding)
- [Connections and tools](https://agent-runtime.clearideas.com/connections-and-tools)
- [Adapter catalog](https://agent-runtime.clearideas.com/adapters)
- [Contract reference](https://agent-runtime.clearideas.com/reference)
- [Production guide](https://agent-runtime.clearideas.com/production)

Licensed under the Apache License 2.0.
