---
title: Adapter catalog
description: Select packaged integrations for models, storage, compute, sandboxes, conditions, and telemetry.
---

# Adapter catalog

Agent manifests describe agent behavior. The host application selects the
infrastructure used to execute them by installing and configuring adapters.
Changing an adapter does not require a different agent manifest.

## Adapter contracts

| Capability     | Contract or extension point | Purpose                                      |
| -------------- | --------------------------- | -------------------------------------------- |
| Models         | `ModelAdapter`              | model generation and streaming               |
| Tools          | `ToolAdapter`               | tool discovery and execution                 |
| Persistence    | `RunStore`, `ArtifactStore` | run state, checkpoints, and artifact storage |
| Conditions     | `ConditionEvaluator`        | conditions and loop goals                    |
| Execution      | `ExecutionEngine`           | run lifecycle and event delivery             |
| Remote compute | `RemoteComputeLauncher`     | submit and cancel remote compute             |
| Sandboxes      | `SandboxProvider`           | isolated processes and filesystems           |
| Telemetry      | `EventSink`                 | lifecycle and model events                   |

## Included adapters

| Capability     | Package                                     | Implementation                       |
| -------------- | ------------------------------------------- | ------------------------------------ |
| Models         | `@clearideas/agent-runtime-model-ai-sdk`    | AI SDK providers and compatible APIs |
| Conditions     | `@clearideas/agent-runtime-condition-jexl`  | JEXL                                 |
| Persistence    | `@clearideas/agent-runtime-store-local`     | memory, files, JSONL, and console    |
| Persistence    | `@clearideas/agent-runtime-store-sqlite`    | SQLite                               |
| Remote compute | `@clearideas/agent-runtime-execution-modal` | Modal functions and execution queues |
| Sandboxes      | `@clearideas/agent-runtime-sandbox`         | Docker                               |
| Sandboxes      | `@clearideas/agent-runtime-sandbox-modal`   | Modal sandboxes                      |
| Telemetry      | `@clearideas/agent-runtime-telemetry-otel`  | OpenTelemetry                        |

The core packages also provide in-process and child-process execution, the
worker protocol, and the interfaces used by remote adapters.

## Configure an adapter

Install the packages required by the host and pass their implementations when
composing the runtime:

```ts
const runtime = new AgentRuntime({
  runStore,
  model,
  tools,
  conditionEvaluator,
  sandbox,
  artifacts,
  eventSinks,
  stepExecutors,
});
```

Remote execution is configured outside the agent manifest:

```ts
const client = new ExecutionClient(executionEngine);
const handle = await client.submit(executionRequest);
```

See [Embed Agent Runtime](./embedding.md) for runtime composition,
[Remote execution](./remote-execution.md) for execution engines, and
[Sandboxes and artifacts](./sandboxes-and-artifacts.md) for sandbox providers.

## Add an adapter

Implement the contract for the capability and supply it through the host
configuration. Provider SDK types, credentials, retry behavior, and service
handles remain inside the adapter. Agent manifests reference models,
connections, and steps without depending on the infrastructure package.

Adapter implementations must enforce authorization, resource limits,
destination policy, cancellation, and secret handling for their service.

## Adapter guides

- [Modal adapters](./modal-adapter.md)
