---
title: Embed Agent Runtime
description: Compose the Clear Ideas Agent Runtime TypeScript API and host adapters inside an application.
---

# Embed Agent Runtime

Applications can instantiate `AgentRuntime` and supply adapters directly.

## Minimal TypeScript host

```ts
import { createAgentRuntime, defineAgent } from "@clearideas/agent-runtime";

const manifest = defineAgent({
  schemaVersion: "1.0",
  model: { provider: "openai", model: "gpt-5.6" },
  variables: [{ key: "question", type: "string", requiresOverride: true }],
  steps: [
    {
      id: "answer",
      type: "prompt",
      prompt: "{{ question }}",
      includeInFinalOutput: true,
    },
  ],
});
const runtime = createAgentRuntime({ manifest });
const result = await runtime.run({
  variables: [{ key: "question", value: "Why are checkpoints useful?" }],
});
console.log(result.output);
```

Requires Node.js 24+ and `OPENAI_API_KEY`. Save as `agent.ts`, install
`@clearideas/agent-runtime`, and run `node agent.ts`.

`defineAgent` provides contextual TypeScript completion and validates the manifest.
`createAgentRuntime` supplies memory persistence, prompt/loop/approval/code/sub-run
executors, conditions, and configured model/tool adapters. Its manifest is the
default source for `run()`. Supply a `runStore` for persistence across processes,
`model` or `tools` to inject adapters, and `composition` for host authorization
policies. Explicit dependency overrides take precedence. Webhooks require an
explicitly authorized executor supplied through `stepExecutors`; sandbox and
approval operations require host adapters. `stepExecutors` replaces the default set.

Use `new AgentRuntime(...)` for full manual composition. A lean installation can
use `@clearideas/agent-runtime-core`, `@clearideas/agent-runtime-step-prompt`,
`@clearideas/agent-runtime-store-local`, and only the model adapter/provider needed
by the application. The convenience package includes all built-in provider SDKs;
subpath imports do not reduce installed dependencies.

The [local execution guide](./local-execution.md) wraps execution in
`InProcessExecutionEngine` and consumes events through `ExecutionClient`.

`composeRuntime` resolves providers and declarative MCP tools. Hosted
applications can apply model, connection, and tool authorization while
supplying OAuth credentials:

```ts
const runtime = composeRuntime(
  manifest,
  config,
  {},
  {
    modelPolicy: {
      requireProfiles: true,
      allowedModels: ["primary-openai/gpt-5.6"],
      allowManifestOptions: false,
    },
    toolOptions: {
      credentialProvider: connectionCredentials,
      authorizeConnection({ binding }) {
        authorizeConnectionForTenant(binding.ref);
      },
      authorizeTool({ toolName }, context) {
        authorizeToolCall(context.runId, toolName);
      },
    },
  },
);
```

The authorization callbacks run before MCP discovery and before each tool
call. Throw from a callback to deny access. Agent bindings may only reduce the
host configuration's connection mode and tool allowlists. A
`verifyToolMetadata` callback, or a `toolIntegrity` block in the connection
configuration, checks discovered tool descriptions and schemas against
host-approved digests; see
[verifying MCP tool metadata](./connections-and-tools.md#verifying-mcp-tool-metadata).

Pass the resulting adapters to `AgentRuntime`.

## Configure `AgentRuntime`

```ts
const agentRuntime = new AgentRuntime({
  runStore,
  stepExecutors,
  model,
  tools,
  artifacts,
  approvals,
  sandbox,
  subRuns,
  conditionEvaluator,
  eventSinks,
  eventSinkFailurePolicy: "continue",
  onEventSinkError(error, event) {
    logger.warn(
      { error, eventId: event.id },
      "Agent Runtime event sink failed",
    );
  },
});
```

Register the executors and adapters available to agents. Before a run is
created, Agent Runtime checks that every step has a registered executor and
the adapters it needs, that every condition parses, and that every tool a
prompt step names exists. All problems are reported together in one
`MANIFEST_PREFLIGHT_FAILED` error, before any model call.

Set host default [execution policies](./execution-policies.md) with
`policies`; manifests and steps override them. `enforcedPolicies` apply last
and cannot be overridden. A `summarizer` adapter observes, changes, or replaces
[context summarization](./context-management.md#a-host-summarizer):

```ts
const agentRuntime = new AgentRuntime({
  runStore,
  stepExecutors,
  model,
  policies: {
    context: { strategy: "summarize-or-prune" },
    modelRetry: { maxAttempts: 4 },
  },
});
```

## Runtime modules

The CLI loads host adapters from a trusted ESM runtime module:

```js
export async function createRuntime(context) {
  return {
    model,
    tools,
    connectionCredentials,
    approvals,
    sandbox,
    subRuns,
    artifactStore,
    eventSinks,
  };
}
```

The alias `credentialProvider` is accepted for `connectionCredentials`. A
module that provides its own persistence adapter exports `runStore` or
`createRunStore(context)` separately. Resume loads the manifest from that store
before creating the remaining adapters.

## Cancellation, pausing, and interruption

Pass an `AbortSignal` to `agentRuntime.run()`. Adapters must propagate it to model,
tool, approval, sandbox, and network operations and must terminate underlying
resources when aborted.

The abort reason decides the outcome: `createRunPauseRequest()` suspends the
run with kind `paused`, `new RunInterruptedError(reason)` leaves it
`interrupted`, and any other reason cancels it. Paused and interrupted runs
resume from their latest checkpoint. See
[Pausing and interrupting a run](./persistence-and-recovery.md#pausing-and-interrupting-a-run).

## Custom step executors

A `StepExecutor` declares a `type` and receives immutable variables plus
runtime-provided capabilities, including the step's resolved `policies`.
Return output, a state patch, transcript items, artifacts, and metadata. Set
`endRun: true` to complete the run after this step. Implement
`preflight(step, host)` to report missing host configuration before a run
starts.

Custom step types require a corresponding manifest contract extension. Use
namespaced `extensions` for optional host metadata.

## Resource ownership

The embedding application owns stores, exporters, and adapters it supplies.
Abort active runs, await their completion, then close the store and flush/shut down
telemetry. The CLI closes its own SQLite store. A CLI runtime module can export
`shutdown()` to clean up resources it created; it is awaited once after execution
or a subsequent setup failure. Cleanup errors warn without masking the run error.
Embedded worker hosts retain ownership of their supplied adapters and stores.
