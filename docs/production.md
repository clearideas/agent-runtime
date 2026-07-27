---
title: Production guide
description: Secure, observe, limit, recover, and upgrade a hosted Clear Ideas Agent Runtime deployment.
---

# Production guide

## Recommended baseline

- Node.js 24 or newer
- transactional `RunStore` with attempt fencing
- explicit manifest and runtime-config validation before submission
- idempotency keys at the execution boundary
- bounded model, tool, webhook, sandbox, and total execution time
- metadata-only OpenTelemetry plus durable operational metrics
- authenticated remote worker/control-plane communication
- encrypted secret delivery for remote execution
- periodic reconciliation for abandoned executions

## Security boundaries

Treat manifests as untrusted input unless only trusted operators can create
them. A strict schema prevents accidental fields but does not authorize:

- outbound webhook destinations;
- MCP endpoints or individual tool actions;
- sandbox images, environment, or network;
- sub-run targets;
- model spend or data residency.

Configure these permissions in host adapters and infrastructure policy.
Remote workers reject request-supplied runtime and configuration filesystem
paths unless host callbacks resolve opaque IDs. Inline configuration requires
an explicit environment allowlist. Worker hosts must supply a webhook executor
with destination authorization when webhook steps are enabled.

## Secrets

Configuration should reference environment variables. Do not serialize raw
provider or connection secrets into persisted manifests. For remote execution,
use `AesGcmWorkerInvocationCodec` or an equivalent authenticated encrypted
envelope and a worker-side key source. Configure an active key ID and a
keyring containing the active encryption key plus prior decryption keys needed
for unexpired invocations. Remove retired keys after the maximum envelope
lifetime. Keep key material out of the payload.

Bind every envelope to its protocol version, execution ID, run ID, action,
attempt, audience, issue time, and expiry time. The remote worker must validate
the expected execution ID, run ID, and deployment-specific audience before
executing it. Remote compute adapters should fail closed when encryption is not
configured. Plaintext transport should require an explicit development-only
option.

Reused remote containers must not retain invocation credentials in global
variables, files, volumes, process arguments, logs, queues, or caches.

Keep OAuth refresh tokens and client credentials in the trusted control plane.
Remote workers should receive a current access token or request one through a
signed credential callback. On an unauthorized response, invalidate the access
token, refresh it in the control plane, and retry once. Never send OAuth
refresh tokens to reusable compute.

## Limits and cost controls

Set manifest limits and enforce host ceilings that an agent cannot raise:

- maximum steps and loop iterations;
- maximum tool calls per model iteration;
- input/output token and byte limits;
- provider, tool, webhook, sandbox, and run timeouts;
- artifact file count and aggregate size;
- per-tenant concurrency and spend budgets.

Enforce billing and authorization limits in the host application or provider
configuration.

## Observability

Add `OpenTelemetryEventSink` to receive nested run, step, model, and tool spans.
It records identifiers, timing, token counts, and error codes by default—not
prompts, deltas, variables, tool values, outputs, stacks, or error messages.

Operational dashboards should cover:

- queue delay and run duration;
- completion, suspension, cancellation, and failure rates;
- retries and resumed attempts;
- model latency, tokens, and estimated cost;
- tool and sandbox latency/failure;
- stale runs and reconciliation outcomes;
- execution-engine startup and transport failures.

Call `shutdown()` on the telemetry sink during process teardown and configure
exporter flushing in the OpenTelemetry SDK.

## Failure and recovery

Classify failures as retryable only when repeating the operation is safe.
Webhook steps support an explicit idempotency key. Tool, sub-run, and custom
adapter retries require their own idempotency design.

Use heartbeats or provider status to establish ownership. Do not take over a
run still marked running solely because a process has been quiet.

## Upgrade policy

Persist `schemaVersion`, checkpoint `contractVersion`, `runtimeVersion`, and a
manifest hash. Before rollout:

1. run contract and adapter tests;
2. verify old checkpoints can still be read;
3. canary the new worker against representative manifests;
4. retain the previous worker through the canary and rollback window;
5. never resume an old checkpoint with a changed manifest.
