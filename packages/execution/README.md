# `@clearideas/agent-runtime-execution`

Defines `ExecutionEngine`, `ExecutionClient`, execution handles, and the worker
protocol for running agent executions in processes, containers, and remote
compute services. Engines implement submit, resume, status, event streaming,
result, and cancellation.

`InProcessExecutionEngine` invokes an `ExecutionHandler` in the current
process. Remote adapters launch the worker protocol and store provider job data
in the execution handle.

Event streams accept an `(attempt, sequence)` cursor and can be reconnected
without replaying events already observed by the client. Submission
idempotency is explicit and conflicting reuse is rejected.

## Secure remote invocations

`AesGcmWorkerInvocationCodec` encrypts a `WorkerInvocation` for a remote
worker. Its AES-256-GCM envelope authenticates the execution protocol version,
execution ID, run ID, action, attempt, audience, issue time, and expiry time.
The keyring supports an active encryption key plus older decryption keys during
rotation.

```ts
import {
  AesGcmWorkerInvocationCodec,
  createWorkerInvocation,
} from "@clearideas/agent-runtime-execution";

const codec = new AesGcmWorkerInvocationCodec({
  activeKeyId: process.env.AGENT_INVOCATION_ACTIVE_KEY_ID!,
  keys: JSON.parse(process.env.AGENT_INVOCATION_KEYS!) as Record<
    string,
    string
  >,
});

const envelope = codec.seal(createWorkerInvocation(request), {
  executionId,
  runId,
  audience: "production-agent-worker",
});

const invocation = codec.open(envelope, {
  executionId,
  runId,
  audience: "production-agent-worker",
});
```

Encoded keys must be exactly 32 bytes and use an explicit
`base64:<unpadded-base64url>` or `hex:<64-hex-characters>` prefix. Keep the
keyring in a secret manager and construct the codec separately in the host and
worker. Do not include keys in manifests, envelopes, queues, or logs.

The envelope uses a 12-byte random nonce and 16-byte authentication tag,
encoded as unpadded base64url. Its authenticated data is compact UTF-8 JSON
without whitespace, with these properties in order:

```json
{
  "envelopeVersion": "1.0",
  "algorithm": "A256GCM",
  "keyId": "...",
  "metadata": {
    "protocolVersion": "1.0",
    "executionId": "...",
    "runId": "...",
    "action": "run",
    "attempt": 1,
    "audience": "...",
    "issuedAt": "...",
    "expiresAt": "..."
  }
}
```

The encrypted plaintext is the UTF-8 JSON representation of
`WorkerInvocation`. Non-JavaScript workers must reproduce this authenticated
data exactly and apply the same binding, timestamp, and invocation validation.
