---
title: Embed Agent Runtime
description: Compose the Clear Ideas Agent Runtime TypeScript API and host adapters inside an application.
---

# Embed Agent Runtime

Applications can instantiate `AgentRuntime` and supply adapters directly.

## Minimal TypeScript host

```ts
import {
  AgentRuntime,
  JexlConditionEvaluator,
  LoopStepExecutor,
  MemoryRunStore,
  PromptStepExecutor,
  composeRuntime,
  emptyAgentRuntimeConfig,
  parseAgentManifest,
} from "@clearideas/agent-runtime";

const manifest = parseAgentManifest({
  schemaVersion: "1.0",
  model: { provider: "openai", model: "gpt-5.6" },
  variables: [{ key: "question", type: "string", requiresOverride: true }],
  steps: [
    {
      id: "answer",
      type: "prompt",
      prompt: "{{ question }}",
      outputVariable: "answer",
      includeInFinalOutput: true,
    },
  ],
});

const adapters = composeRuntime(manifest, emptyAgentRuntimeConfig());
const agentRuntime = new AgentRuntime({
  runStore: new MemoryRunStore(),
  stepExecutors: [new PromptStepExecutor(), new LoopStepExecutor()],
  conditionEvaluator: new JexlConditionEvaluator(),
  ...(adapters.model ? { model: adapters.model } : {}),
  ...(adapters.tools ? { tools: adapters.tools } : {}),
});

const result = await agentRuntime.run({
  manifest,
  variables: [{ key: "question", value: "Why are checkpoints useful?" }],
});

console.log(result.output);
```

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
host configuration's connection mode and tool allowlists.

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

Register the executors and adapters available to agents. A run fails validation
when its manifest requires an unavailable capability.

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

## Cancellation

Pass an `AbortSignal` to `agentRuntime.run()`. Adapters must propagate it to model,
tool, approval, sandbox, and network operations and must terminate underlying
resources when aborted.

## Custom step executors

A `StepExecutor` declares a `type` and receives immutable variables plus
runtime-provided capabilities. Return output, a state patch, transcript items,
artifacts, and metadata.

Custom step types require a corresponding manifest contract extension. Use
namespaced `extensions` for optional host metadata.
