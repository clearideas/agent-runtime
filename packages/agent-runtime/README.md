# `@clearideas/agent-runtime`

The standalone TypeScript runtime for portable, declarative agents.

Clear Ideas Agent Runtime runs locally, inside your application, or through a
remote execution engine. It does not require a hosted Clear Ideas service.

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

The CLI persists runs and events locally by default. It does not send run state
to a Clear Ideas service.

## Documentation

- [Quickstart](https://github.com/clearideas/agent-runtime/blob/main/docs/quickstart.md)
- [Embed Agent Runtime](https://github.com/clearideas/agent-runtime/blob/main/docs/embedding.md)
- [Connections and tools](https://github.com/clearideas/agent-runtime/blob/main/docs/connections-and-tools.md)
- [Adapter catalog](https://github.com/clearideas/agent-runtime/blob/main/docs/adapters.md)
- [Production guide](https://github.com/clearideas/agent-runtime/blob/main/docs/production.md)

Licensed under the Apache License 2.0.
