---
title: Modal adapters
description: Configure the optional Modal remote execution and sandbox adapters.
---

# Modal adapters

Modal support is distributed in two optional packages:

| Package                                     | Purpose                              |
| ------------------------------------------- | ------------------------------------ |
| `@clearideas/agent-runtime-execution-modal` | remote agent execution               |
| `@clearideas/agent-runtime-sandbox-modal`   | code and artifact sandbox operations |

The packages implement the same execution and sandbox contracts used by other
adapters.

## Function remote execution

`ModalExecutionEngine` maps the remote execution lifecycle to Modal function
calls and a per-execution message queue:

```ts
import {
  AesGcmWorkerInvocationCodec,
  ExecutionClient,
} from "@clearideas/agent-runtime-execution";
import {
  ModalExecutionEngine,
  ModalSdkGateway,
} from "@clearideas/agent-runtime-execution-modal";

const invocationCodec = new AesGcmWorkerInvocationCodec({
  activeKeyId: process.env.AGENT_INVOCATION_ACTIVE_KEY_ID!,
  keys: JSON.parse(process.env.AGENT_INVOCATION_KEYS!) as Record<
    string,
    string
  >,
});

const gateway = new ModalSdkGateway(modalClient, {
  appName: "agent-runtime",
  functionName: "run_worker",
  environment: "production",
});

const engine = new ModalExecutionEngine(gateway, controlPlane, {
  invocationCodec,
  audience: "modal-production-worker",
});
const client = new ExecutionClient(engine);
```

The worker constructs a codec from the same keyring and decodes the request
before execution:

```ts
import { AesGcmWorkerInvocationCodec } from "@clearideas/agent-runtime-execution";
import { decodeModalWorkerInvocation } from "@clearideas/agent-runtime-execution-modal";

const invocationCodec = new AesGcmWorkerInvocationCodec({
  activeKeyId: process.env.AGENT_INVOCATION_ACTIVE_KEY_ID!,
  keys: JSON.parse(process.env.AGENT_INVOCATION_KEYS!) as Record<
    string,
    string
  >,
});

const invocation = decodeModalWorkerInvocation(request, invocationCodec, {
  executionId: request.executionId,
  runId: request.runId,
  audience: "modal-production-worker",
});
```

The envelope authenticates the protocol version, execution ID, run ID, action,
attempt, audience, issue time, and expiry time. The worker rejects tampering,
expired envelopes, unknown key IDs, and mismatched execution bindings.

String keys use `base64:<unpadded-base64url>` or
`hex:<64-hex-characters>` and decode to exactly 32 bytes. During rotation, the
keyring contains the active encryption key and prior decryption keys required
for unexpired invocations. The host and worker load the keyring from their
secret managers.

The execution queue carries standard `WorkerMessage` values. The control plane
receives the same ordered events and terminal result used by other execution
engines. The adapter removes the queue after a terminal message, cancellation,
or abnormal observer exit.

Modal can reuse containers. Keep decrypted credentials scoped to one
invocation and exclude them from shared volumes, handles, events, checkpoints,
and result metadata.

For an isolated development worker, plaintext can be enabled explicitly:

```ts
const gateway = new ModalSdkGateway(modalClient, {
  allowPlaintextInvocationForDevelopment: true,
});
const engine = new ModalExecutionEngine(gateway, controlPlane, {
  allowPlaintextInvocationForDevelopment: true,
});
```

Do not enable plaintext invocation for shared or remote production compute.

## Sandbox remote execution

`ModalSandboxExecutionEngine` runs the complete agent worker in a Modal
Sandbox rather than a reusable Function container. The host resolves the
launch policy before the encrypted invocation crosses the provider boundary:

```ts
import {
  ModalSandboxExecutionEngine,
  ModalSandboxSdkGateway,
  resolveAgentRunnerEgressPolicy,
  resolveModalSandboxNetworkPolicy,
} from "@clearideas/agent-runtime-execution-modal";

const gateway = new ModalSandboxSdkGateway(modalClient, {
  appName: "agent-runtime",
  imageName: "agent-runtime-worker:stable",
  environment: "production",
});

const engine = new ModalSandboxExecutionEngine(gateway, controlPlane, {
  invocationCodec,
  resolveSandbox: async (invocation) => {
    const egressPolicy = await resolveAgentRunnerEgressPolicy(
      invocation.request.manifest,
      {
        controlPlaneOrigins: ["https://control.example.com"],
        defaultModel: hostDefaultModel,
        resolveModelOrigins: (model) => modelCatalog.originsFor(model),
        resolveConnectionOrigins: (binding) =>
          connectionRegistry.originsFor(binding.ref),
        resolveToolOrigins: (tool) => toolRegistry.originsFor(tool),
        resolveManifestRef: (ref) => agentRegistry.load(ref),
      },
    );

    return {
      networkPolicy: resolveModalSandboxNetworkPolicy({
        mode: "direct-domains",
        egressPolicy,
      }),
      timeoutMs: invocation.request.timeoutMs,
      secrets: [modalInvocationKeyringSecret],
    };
  },
});
```

The worker image uses `agent-runtime-modal-worker` as its entrypoint. The
bootstrap reads one authenticated envelope from stdin, binds it to the trusted
execution and run IDs injected by the gateway, removes the envelope keyring
from the child environment, and starts `agent-runtime worker`. Worker messages
are streamed back over stdout; stderr is not persisted in execution state.

### Network modes

The host, not the agent manifest, selects the Modal network policy:

| Mode             | Modal enforcement                                                 |
| ---------------- | ----------------------------------------------------------------- |
| `block`          | all networking disabled                                           |
| `direct-domains` | direct TLS domains derived from the host-resolved run policy      |
| `proxy-only`     | exact proxy CIDRs or exact TLS proxy hostnames supplied by a host |

Agent Runtime extracts domain entries from normalized origins; it does not
perform DNS lookups or derive CIDRs. This keeps CDN and regional provider
routing stable. Origins on non-443 ports fail resolution because Modal domain
allowlisting cannot faithfully represent them.

The ownership boundary is:

| Concern                          | Owner                                       |
| -------------------------------- | ------------------------------------------- |
| Portable agent behavior          | `AgentManifest`                             |
| Model, tool, and connection URLs | trusted host callbacks                      |
| Resolved downstream origins      | `resolveAgentRunnerEgressPolicy`            |
| Modal network boundary           | `resolveModalSandboxNetworkPolicy`          |
| DNS-to-CIDR resolution           | host or infrastructure, never Agent Runtime |
| Signed proxy authorization       | host and proxy, not the manifest or worker  |

For direct-domain enforcement, pass the resolved policy to `direct-domains`.
For proxy-mediated enforcement, pass only the proxy endpoint to `proxy-only`
and use the resolved policy at the proxy authorization layer.

```ts
const directNetwork = resolveModalSandboxNetworkPolicy({
  mode: "direct-domains",
  egressPolicy,
});

const proxyNetwork = resolveModalSandboxNetworkPolicy({
  mode: "proxy-only",
  proxyDomains: ["runner-egress.example.com"],
  // Or: proxyCidrs: ["203.0.113.10/32"]
});
```

Modal combines domain and CIDR allowlists additively. `proxy-only` must contain
only proxy endpoints. Adding downstream model, tool, connection, webhook, or
control-plane domains would create direct routes around the proxy.

When a host coordinates a referenced sub-run through its own control plane,
`resolveManifestRef` may return `null`. That means the reference adds no direct
network destination to the current Sandbox. Returning `undefined` or omitting
the resolver for an unresolved reference fails closed.

`direct-domains` lets Modal enforce the resolved TLS domain set directly.
`proxy-only` lets Modal enforce the route to the proxy while the proxy handles
downstream DNS and destination authorization. Both avoid requiring Agent
Runtime to resolve provider or CDN domains into CIDRs.

## Sandbox provider

`ModalSandboxProvider` maps the sandbox lifecycle to a host-provided
`ModalSandboxGateway`:

```ts
import {
  ModalSandboxProvider,
  type ModalSandboxGateway,
} from "@clearideas/agent-runtime-sandbox-modal";
import { ProviderSandboxAdapter } from "@clearideas/agent-runtime-sandbox";

const provider = new ModalSandboxProvider(modalSandboxGateway);
const sandbox = new ProviderSandboxAdapter({
  provider,
  artifacts,
  allowedEnvironment: ["SAFE_PUBLIC_SETTING"],
  memoryMb: 512,
  cpuCount: 1,
  processLimit: 64,
  maximumOutputFiles: 20,
  maximumOutputBytes: 25 * 1024 * 1024,
});
```

The gateway implements sandbox creation, file staging, command execution, file
collection, and termination using the Modal SDK. Apply image, network,
environment, resource, and output policies before dispatching the request.
