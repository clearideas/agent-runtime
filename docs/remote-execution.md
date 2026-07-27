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
manifest, run ID, variables, optional configuration references, and resume
data. It reports `event`, `result`, or `error` messages.

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

## HTTPS worker

The interactive example in `examples/interactive-web` can execute the same run
locally or through authenticated HTTP worker endpoints:

1. The host reserves an execution.
2. The compute launcher sends the invocation to the worker endpoint.
3. After the control plane records the launch, the host activates the worker.
4. The worker executes the agent.
5. The worker sends events and the terminal result to the host callback URL.
6. `ExecutionClient.follow()` reads the ordered event stream from the control
   plane.

The server creates the remote engine once:

```js
const remoteExecution = createRemoteExecution({
  baseUrl: serverBaseUrl,
  workerToken: crypto.randomUUID(),
  callbackToken: crypto.randomUUID(),
  dataDirectory: path.join(dataDirectory, "remote"),
  runtime,
});
const remoteClient = new ExecutionClient(remoteExecution.engine);
```

Its HTTP server delegates authenticated worker and callback requests to the
remote adapter:

```js
if (await remoteExecution.route(request, response, url)) return;
```

The run handler selects an execution client and consumes the same event stream
for both modes:

```js
const client = input.execution === "remote" ? remoteClient : localClient;
const handle = await client.submit(executionRequest);
const completed = await client.follow(handle, {
  signal,
  onEvent: (event) => write({ kind: "event", event }),
});
```

Run the interactive example and choose Remote:

```sh
npm run build
export OPENAI_API_KEY="..."
npm --prefix examples/interactive-web start
```

The example uses loopback HTTP. Deployments expose the worker and callback
routes through HTTPS.

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
