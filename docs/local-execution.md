---
title: Local execution
description: Execute an agent in the current Node.js process and stream its events.
---

# Local execution

`InProcessExecutionEngine` executes an agent in the current Node.js process.
It supports the same submission, event, result, resume, and cancellation
interface as remote execution engines.

## Requirements

- Node.js 24 or newer
- a model-provider API key

Create a project, install Agent Runtime and its CLI, and set the provider key
used by the agent manifest:

```sh
mkdir agent-runtime-local
cd agent-runtime-local
npm init -y
npm install @clearideas/agent-runtime @clearideas/agent-runtime-cli
export OPENAI_API_KEY="..."
```

## Agent manifest

This example uses the minimal manifest from the manifest library:

<<< ../examples/manifests/hello.agent.yaml

## Application

```ts
import path from "node:path";

import {
  ExecutionClient,
  FileAgentManifestSource,
  InProcessExecutionEngine,
  type RunEvent,
} from "@clearideas/agent-runtime";
import { executeWorkerInvocation } from "@clearideas/agent-runtime-cli";

const manifest = await new FileAgentManifestSource(
  path.resolve("."),
  "hello.agent.yaml",
).loadManifest();

const engine = new InProcessExecutionEngine((request, context) =>
  executeWorkerInvocation(
    {
      protocolVersion: "1.0",
      action: context.mode,
      request: { ...request, runId: context.handle.runId },
    },
    {
      storeDirectory: path.resolve(".agent-runtime"),
      allowRequestConfiguration: true,
      environment: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
      signal: context.signal,
      onMessage: async (message) => {
        if (message.type === "event") await context.emit(message.event);
      },
    },
  ),
);

const client = new ExecutionClient(engine);
const handle = await client.submit({
  manifest,
  configuration: { version: "1.0", providers: {}, models: {}, connections: {} },
  variables: [{ key: "topic", value: "local agent execution" }],
});
const completed = await client.follow(handle, {
  onEvent(event: RunEvent) {
    if (event.type === "model.text.delta") {
      process.stdout.write(String(event.data?.delta ?? ""));
    }
  },
});

if (!completed.result) {
  throw new Error(completed.status.error?.message ?? completed.status.status);
}
```

The handler forwards worker events to `ExecutionClient.follow()`. Run state is
stored in `.agent-runtime`, and only the explicitly allowlisted
`OPENAI_API_KEY` is available to request-supplied configuration.

## Local CLI

The same agent can run without application code:

```sh
npx agent-runtime run \
  ./hello.agent.yaml \
  --stream \
  --format pretty
```

Use the TypeScript API for execution handles, event consumption, cancellation,
and host adapters. Use the CLI for direct execution and shell automation.

## Browser showcase

The [Showcase](./showcase.md) runs real agents from a browser. In the
Orchestration demo, choose **This process** to use InProcessExecutionEngine,
or **Remote worker** to run the same agent in a separate Node.js process.
Both stream through ExecutionClient.follow().

```sh
git clone https://github.com/clearideas/agent-runtime.git
cd agent-runtime/examples/showcase
npm ci
npm start
```

Scripted mode needs no provider key. The Showcase guide explains the sandbox
requirements, demo controls and expected results.
