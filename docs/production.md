---
title: Production guide
description: Secure, observe, limit, recover, and upgrade a production Clear Ideas Agent Runtime deployment.
---

# Production guide

## Recommended baseline

- Node.js 22.20.0 or newer
- transactional `RunStore` with attempt fencing
- explicit manifest and runtime-config validation before submission
- idempotency keys at the execution boundary
- bounded model, tool, webhook, sandbox, and total execution time
- metadata-only OpenTelemetry plus durable operational metrics
- authenticated remote worker/control-plane communication
- encrypted secret delivery for remote execution
- periodic reconciliation for abandoned executions

## Security boundaries

Agent Runtime separates what a manifest requests from what the host authorizes.
Manifests cannot grant themselves credentials, connections, tools, sandbox
images, network access, model access, or compute. Native runtime enforcement
includes:

- host-defined MCP connection modes and tool allowlists that a manifest may
  narrow but not expand;
- host-defined workspaces whose every model operation executes as one
  policy-admitted, reported command inside an isolated per-run sandbox; the
  agent process never interprets workspace content;
- optional pinning of MCP tool descriptions and schemas to host-approved
  digests, verified before a definition reaches a model;
- credential references, OAuth credential providers, authorization hooks, and
  retry-after-refresh behavior;
- sandbox contracts, bounded artifact collection, and Docker defaults with no
  network, a read-only root filesystem, dropped capabilities, and resource
  limits;
- model policy hooks, execution attempt fencing, and worker-side rejection of
  request-supplied runtime paths;
- conversation histories that cannot carry system instructions, tool history,
  reasoning, or provider options, are never templated, and can be required to
  carry a valid signature bound to a host scope.

Treat manifests as untrusted input unless only trusted operators can create
them, and configure deployment-specific permissions in host policy. Treat MCP
servers as untrusted too: record the approved tool metadata when a
connection is created and pin it with `toolIntegrity` or verify it with
`verifyToolMetadata`, so a server cannot later inject instructions through a
tool description or schema. Remote
workers reject request-supplied runtime and configuration filesystem paths
unless host callbacks resolve opaque IDs. Inline configuration requires an
explicit environment allowlist and cannot define MCP connections, workspaces,
a sandbox, or message signing keys. Worker hosts must supply a webhook executor with destination
authorization when webhook steps are enabled.

## Conversation histories

A history the client holds can be edited. If clients keep the conversation,
configure a message signer and set `requireSignature` in the host
configuration, so forged or reordered messages are refused before a run is
created. Bind `messagesScope` to the tenant, user, and conversation from the
authenticated session, never from the request body, so a history cannot be
replayed for someone else. If the host stores the conversation server-side,
signing still detects tampering in transit and storage.

Authorize artifact references in new messages with `authorizeArtifact`; the
default rejects any reference the runtime did not sign or ingest. Keep the
default history ceilings, or lower them, to bound the cost of one request.
See [Conversation messages](./conversations.md).

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
- workspace staging size, per-command timeouts, sandbox command and
  second budgets, and output ceilings;
- per-tenant concurrency and spend budgets.

Every run has [run limits](./execution-policies.md#run-limits) against
runaways (tokens, active time, recoveries, crash loops, turns, iterations,
artifacts, checkpoint size), with defaults far above normal use. Change them
for every run with `new AgentRuntime({ limits })`, add `maxEstimatedCost` if
your adapters report cost, and set ceilings with `enforcedLimits`; manifests
may change limits within the ceilings. Sandbox resources and usage ceilings
stay in the sandbox configuration. A run that reaches a limit is blocked
(`awaiting-host`) rather than failed: decide whether to grant more with
`limits` on the resume request, and validate the grant against the tenant's
ceilings first.

Enforce billing and authorization limits in the host application or provider
configuration.

`budget.maxTotalTokens` provides a durable per-run ceiling based on reported
model usage. Hosted systems should still validate the requested limit against a
tenant ceiling before submission or resume; a run may replace its persisted
limit only through a new host-authorized request.

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

## Serving over HTTP

[`agent-runtime serve`](./serving.md) applies the worker's trust rules to
every request. For production:

- configure API keys by environment reference or digest, with model scopes
  and per-key limits, or an `authenticate` hook for your identity provider;
- configure message signing, and run from a configuration file, whose runs,
  ledger, and stored media default to durable storage beside it; several
  replicas need shared stores;
- terminate TLS at a proxy whose read timeout exceeds your longest run for
  non-streamed requests; streamed responses send heartbeats;
- turn off chat front ends' title, tag, and follow-up generation, or point
  it at an ordinary model, so each message runs the agent once;
- keep `conversations.media.urls: reject` unless you allowlist origins;
- set `store.retention` and `conversations.ledger.ttl` to your data policy.

## Failure and recovery

Choose [execution policies](./execution-policies.md) as host defaults so every
agent gets the same mitigations: context reduction, model retries, output
repair, and the tool-call limit. Decide which steps may continue after a
failure with `onError: continue`; a step whose failure would make later steps
meaningless should keep the default `fail`.

Reconcile `interrupted` runs automatically: they were stopped by
infrastructure, not by the agent. A step failure that is not fatal blocks the
run (`awaiting-host`) instead of failing it, keeping its work: read
`ledger.blocked` from the latest checkpoint, fix the cause, then resume, or
[restart from an earlier step](./persistence-and-recovery.md#restart-from-a-step).
Resuming without fixing anything counts toward the crash-loop guard. Review
`failed` runs before resuming them, because the same step fails again unless
its cause has changed. Throw `RunFatalError` from hosts' authorization hooks
when a refusal should fail the run outright.

Classify failures as retryable only when repeating the operation is safe.
Webhook steps support an explicit idempotency key. Prompt tool calls receive a
stable runtime-generated `ToolExecutionContext.idempotencyKey`; side-effecting
adapters must make it atomic with the external effect. Sub-run and custom
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
5. resume old checkpoints only with manifests the fingerprint rules accept
   (changed limits, policies, or steps not yet reached); publish other
   changes as a new definition or restart from a step before the change.

### Upgrading to 0.10

Runs behave differently in these ways; each can be turned back where noted.

| Change                                                                                                 | Before 0.10                              | To keep the earlier behavior                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------- |
| A step failure that is not fatal blocks the run (`suspended`, kind `awaiting-host`)                    | the run failed                           | `policies: { onFailure: "fail" }` on the host or manifest |
| Every run has [run limits](./execution-policies.md#run-limits) with anti-runaway defaults              | no limits beyond the manifest's          | raise values with the host's `limits` or the manifest     |
| An exhausted sandbox command or seconds budget blocks the run                                          | the model got `sandbox_budget_exhausted` | raise the host's `sandbox.limits`                         |
| A shell or configured command interrupted by a crash is not run again; the model is told               | it ran again                             | a custom `ToolAdapter.replaySafe` returning `true`        |
| A code step interrupted in the run sandbox blocks the run once before running again                    | it ran again                             | `onFailure: fail`                                         |
| A resume accepts a manifest with changed limits, policies, or steps not yet reached                    | any change was refused                   | compare manifests before resuming                         |
| Higher sandbox defaults: 2,000 commands, 4 h, 5 min / 1 h command timeouts, 500 output files / 500 MiB | 200, 15 min, 60 s / 15 min, 50 / 50 MiB  | set the values in `sandbox.limits`                        |

`run()` rejects a blocked run with a `RunSuspendedError` whose `cause` is the
original error; hosts that checked for a failed status should also handle
`suspended` with kind `awaiting-host`. Checkpoints are written with contract
`1.1`, which earlier releases cannot read: once runs have checkpointed under
0.10, rolling back cannot resume them.

## Diagnosing failures

Adapters can throw `AgentRuntimeError(message, code, retryable, suggestedAction)`.
Persisted errors preserve validated uppercase codes and explicit retryability;
unclassified exceptions remain `AGENT_EXECUTION_FAILED` and non-retryable.
Retryability is diagnostic metadata, not an instruction to repeat a side effect.
Use idempotency and host policy before retrying. Keep messages and suggested
remedies free of credentials and user content.

The CLI warns once per failing event sink while allowing execution to continue.
Embedded hosts can use `onEventSinkError(error, event, sink)` for alerts or select
`eventSinkFailurePolicy: "fail-run"` for strict delivery before durable completion.
A telemetry failure cannot roll back an already committed result. Pretty CLI
output includes suspension reasons and webhook retry delays.

### Documentation consent client

The documentation site builds with the public `@clearideas/consent-analytics`
package, installed from `vendor/` in this repository until its release
candidate is available from every npm registry. Its default production hostname is `agent-runtime.clearideas.com`, using
`ci-docs` to retain the existing reporting destination. The API registry must allow
that hostname for `ci-docs`. A footer link opens cookie settings; the floating
settings button stays automatic and is hidden while that link exists.

Override `VITE_ANALYTICS_API_BASE_URL` and `VITE_ANALYTICS_SITE_KEY` for a registered
staging site. Local documentation builds do not enable analytics unless a site key
is explicitly supplied. See the showcase README for its separate opt-in settings.
