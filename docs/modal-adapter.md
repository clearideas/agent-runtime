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

## Remote execution

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
