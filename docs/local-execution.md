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

Build Agent Runtime and set the provider key used by the agent manifest:

```sh
npm install
npm run build
export OPENAI_API_KEY="..."
```

## Agent manifest

This example uses the minimal manifest from the manifest library:

<<< ../examples/manifests/hello.agent.yaml

## Application

```ts
import path from "node:path";

import { executeWorkerInvocation } from "@clearideas/agent-runtime-cli";
import type { RunEvent } from "@clearideas/agent-runtime-contracts";
import {
  ExecutionClient,
  InProcessExecutionEngine,
} from "@clearideas/agent-runtime-execution";
import { FileAgentManifestSource } from "@clearideas/agent-runtime-store-local";

const manifest = await new FileAgentManifestSource(
  path.resolve("examples/manifests"),
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
node packages/cli/dist/bin.js run \
  examples/manifests/hello.agent.yaml \
  --stream \
  --format pretty
```

Use the TypeScript API for execution handles, event consumption, cancellation,
and host adapters. Use the CLI for direct execution and shell automation.

## Interactive example

The browser example can run the same agent through local or remote execution:

```sh
npm run build
export OPENAI_API_KEY="..."
npm --prefix examples/interactive-web start
```

Choose Local to use `InProcessExecutionEngine`. Choose Remote to use the worker
protocol and HTTP callbacks. Both modes stream through
`ExecutionClient.follow()`.
