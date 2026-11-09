---
title: Remote execution
description: Run agents through the worker protocol, HTTPS, or a remote compute adapter.
---

# Remote execution

Remote execution separates run lifecycle state from the compute process that
executes the agent.

| Component                     | Responsibility                                     |
| ----------------------------- | -------------------------------------------------- |
| `RemoteExecutionControlPlane` | status, events, results, idempotency, cancellation |
| `RemoteComputeLauncher`       | start and cancel execution on a compute service    |
| worker                        | execute a versioned invocation and report messages |

`RemoteExecutionEngine` combines the control plane and compute launcher behind
the same `ExecutionEngine` interface used for local execution.

## Worker protocol

A worker accepts a versioned `WorkerInvocation` containing the resolved agent
manifest, run ID, variables, conversation messages, optional configuration
references, and resume data. It reports `event`, `result`, or `error`
messages.

A run invocation may carry `messages`, `messagesSignature`, and the
control plane's `messagesScope`; a resume invocation carries none of them,
because the checkpoint holds the history. The worker verifies and signs with
keys from its own trusted configuration.

The CLI worker uses NDJSON over standard input and output:

```sh
agent-runtime worker
```

Compute adapters can carry the same invocation and messages over HTTPS,
queues, object storage, or a provider SDK.

`executeWorkerInvocation()` does not trust request-supplied filesystem paths.
Use `runtimeModule` and `configFile` for host-pinned files, or provide
`resolveRuntimeReference` and `resolveConfigReference` callbacks that map
opaque request IDs through a host allowlist.

Inline request configuration is disabled by default. An authenticated,
integrity-protected transport may enable it with an explicit environment
allowlist:

```ts
await executeWorkerInvocation(invocation, {
  storeDirectory,
  allowRequestConfiguration: true,
  environment: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },
  modelPolicy: {
    requireProfiles: true,
    allowedModels: ["primary-openai/gpt-5.6"],
    allowManifestOptions: false,
  },
  toolOptions: {
    authorizeConnection({ binding }) {
      authorizeConnectionForTenant(binding.ref);
    },
    authorizeTool({ toolName }, context) {
      authorizeToolCall(context.runId, toolName);
    },
  },
  runtime: {
    stepExecutors: [authorizedWebhookExecutor],
  },
  onMessage,
});
```

The environment map is the complete set of process variables visible to inline
configuration. Worker mode does not install a webhook executor; hosts add one
with an `authorizeDestination` policy when webhook steps are allowed.

## HTTP worker example

The [Showcase Orchestration demo](./showcase.md#orchestration) executes the same
agent locally or in a separate Node.js worker process. Choose **Remote worker**
under **Runs in** to try it without a cloud account or provider key.

1. RemoteExecutionEngine creates a versioned worker invocation.
2. The host's RemoteComputeLauncher starts the worker and sends the invocation
   to its authenticated HTTP endpoint.
3. The worker runs the agent and sends ordered events and the terminal result
   to an authenticated, execution-specific callback URL.
4. InMemoryRemoteExecutionControlPlane records the updates, and
   ExecutionClient.follow() streams them to the browser.

The host chooses an engine, then follows the same client interface:

```ts
const engine = remote
  ? new RemoteExecutionEngine(launcher, controlPlane)
  : localEngine;
const client = new ExecutionClient(engine);
const handle = await client.submit(executionRequest);
const completed = await client.follow(handle, {
  signal,
  onEvent: (event) => write({ kind: "event", event }),
});
```

See the runnable [host](https://github.com/clearideas/agent-runtime/blob/main/examples/showcase/demos/orchestration/host.ts)
and [worker](https://github.com/clearideas/agent-runtime/blob/main/examples/showcase/demos/orchestration/worker.ts)
for launch authentication, per-execution callback tokens and cancellation.

```sh
cd examples/showcase
npm ci
npm start
```

The demo uses loopback HTTP. Production deployments expose worker and
callback routes through HTTPS and provide a durable control plane.

## Compute adapters

A compute adapter implements `RemoteComputeLauncher` and transports the worker
invocation and messages using the selected service. The control plane and
`ExecutionClient` remain unchanged when the adapter changes.

Agent Runtime includes an HTTPS example and optional packaged compute adapters.
See the [adapter catalog](./adapters.md) for available integrations.

## Durable control plane

The example uses `InMemoryRemoteExecutionControlPlane`. A deployed host
supplies a durable implementation that stores:

- execution handles and lifecycle status;
- idempotency records;
- ordered events keyed by attempt and sequence;
- terminal results and errors; and
- cancellation state.

The compute adapter does not depend on the control plane's persistence
technology.

## Security and delivery

Remote execution requires:

- authenticated and integrity-protected launch and callback requests;
- encryption for secret-bearing configuration;
- key identifiers and rotation when multiple decryption keys are accepted;
- replay protection or idempotency;
- request size and schema validation before execution;
- host resolution of runtime and configuration references;
- an explicit environment allowlist for inline configuration;
- destination authorization for webhook and MCP network access;
- worker-to-control-plane authentication; and
- reconciliation when a terminal message cannot be delivered.

Provider credentials should remain in the worker environment or a compute
service secret store. Do not place plaintext credentials in an agent manifest,
execution handle, event, checkpoint, or result.
