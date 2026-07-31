---
title: Contract reference
description: Manifest fields, runtime configuration, adapter interfaces, and Agent Runtime packages.
---

# Contract reference

## Agent manifest

The exported TypeScript type is `AgentManifest`; validate external input with
`agentManifestSchema` or `parseAgentManifest`.

| Field                       | Type                          | Notes                                               |
| --------------------------- | ----------------------------- | --------------------------------------------------- |
| `schemaVersion`             | `"1.0"`                       | required                                            |
| `id`, `name`, `description` | string                        | optional identity and documentation                 |
| `model`                     | explicit reference or profile | default for prompt steps                            |
| `variables`                 | variable declaration array    | typed inputs, defaults, requirements, documentation |
| `connections`               | array                         | host connection bindings                            |
| `steps`                     | array                         | ordered execution plan                              |
| `limits`                    | object                        | step, output, tool-call, and provider bounds        |
| `metadata`                  | JSON object                   | inert application metadata                          |
| `extensions`                | JSON object                   | namespaced host extensions                          |

Use `metadata` for descriptive application data that does not change execution.
Use namespaced `extensions` for behavior interpreted by an application adapter.
The `agentRuntime` namespace is reserved for runtime behavior. For example,
`extensions.agentRuntime.stateProjection: "step-output-state-v1"` projects each
step output into `step-N`, `step-previous`, and `outputVariable` state keys. A
step can override `step-N` with
`extensions.agentRuntime.stateKey`. This projection is sequential because
`step-previous` is order-dependent.

Variable keys and `outputVariable` values are non-empty top-level names. They
cannot contain dots or use `__proto__`, `prototype`, or `constructor`. Dot
notation is reserved for reading properties from object values.

Final output selection is declared with `includeInFinalOutput` on top-level
steps.

## Agent variable declaration

Each entry in the agent manifest's `variables` array has this shape:

| Field              | Type                                                        | Notes                                         |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------- |
| `key`              | string                                                      | exact top-level run input name                |
| `type`             | `string`, `number`, `boolean`, `object`, `array`, or `json` | required; `json` accepts an object or array   |
| `value`            | JSON value                                                  | optional agent-level default                  |
| `requiresOverride` | boolean                                                     | when true, every new run must supply this key |
| `description`      | string                                                      | optional developer-facing documentation       |
| `metadata`         | JSON object                                                 | optional application metadata                 |

The default value must match the declared type.

## Agent run manifest

The exported TypeScript type is `AgentRunManifest`; validate external input
with `agentRunManifestSchema` or `parseAgentRunManifest`.

An agent run references an agent and supplies runtime values:

```yaml
schemaVersion: "1.0"
agent:
  ref: release-brief.agent.yaml
variables:
  - key: audience
    value: partners
execution:
  mode: parallel
  maxConcurrency: 4
```

| Field                      | Type                    | Notes                                               |
| -------------------------- | ----------------------- | --------------------------------------------------- |
| `schemaVersion`            | `"1.0"`                 | required                                            |
| `agent.ref`                | string                  | required host-resolved agent reference              |
| `runId`                    | string                  | optional caller-provided run identity               |
| `variables`                | variable override array | optional runtime values                             |
| `execution.mode`           | sequential or parallel  | optional; defaults to sequential                    |
| `execution.maxConcurrency` | integer from 1 to 64    | optional requested limit; the host may impose a cap |

The TypeScript shape is:

```ts
{
  schemaVersion: '1.0',
  agent: { ref: 'release-brief.agent.yaml' },
  execution: { mode: 'parallel', maxConcurrency: 4 },
  variables: [
    { key: 'audience', value: 'partners' },
    { key: 'style', value: { tone: 'direct', maxWords: 120 } },
  ],
}
```

Each override contains only `key` and `value`. Keys must match declarations
exactly. Object overrides replace the complete declared object; values are not
deep-merged. Resume requests restore checkpointed state and do not accept new
overrides.

## Model reference

```ts
{ provider: string, model: string, options?: JsonObject }
```

or:

```ts
{ ref: string, options?: JsonObject }
```

## Prompt steps and complete message history

A prompt step uses exactly one input form:

- `prompt: string` with optional `systemPrompt: string`, retained as the
  backward-compatible shorthand.
- `messages: PromptMessage[]`, containing the complete ordered history.

`PromptMessage` has a `role` of `system`, `user`, `assistant`, or `tool`, a
`content` array, and optional inert `metadata` and replayed `providerOptions`.
Content parts support text, reasoning, JSON, images, files, tool calls, and tool
results. System messages contain text only; tool messages contain tool results
only. Historical tool calls and results must use matching IDs and names.

Images and files require exactly one source: `url`, base64-encoded `data`, or an
`artifact` reference. File content also requires a media type unless supplied
by its artifact. Opaque `metadata` is persisted but not forwarded to the model;
`providerOptions` is forwarded by compatible model adapters.

Use `limits.maxMessagesPerPrompt` and `limits.maxInputBytes` to bound complete
history size. Input-byte enforcement includes resolved base64 artifact data and
is checked again after each new tool result.

## Runtime configuration

```ts
{
  version: "1.0";
  providers: Record<string, ProviderDefinition>;
  models: Record<string, ConfiguredModelDefinition>;
  connections: Record<string, McpConnectionDefinition>;
}
```

Provider drivers: `openai`, `anthropic`, `google`, `xai`, `groq`, `cohere`,
and `openai-compatible`.

MCP connection authentication:

| `auth.type`          | Configuration                                               |
| -------------------- | ----------------------------------------------------------- |
| `none`               | no additional fields                                        |
| `bearer`             | `token` environment reference                               |
| `oauth`              | optional `profile`; requires `ConnectionCredentialProvider` |
| `client_credentials` | `clientId`, `clientSecret`, and optional `scopes`           |

`bearerToken` remains accepted as a deprecated alias for bearer
authentication. A connection cannot combine `auth` with `bearerToken` or an
`Authorization` entry in `headers`.

## Adapter interfaces

| Adapter interface              | Responsibility                                     |
| ------------------------------ | -------------------------------------------------- |
| `AgentManifestSource`          | load an agent manifest by opaque reference         |
| `RunStore`                     | durable lifecycle, checkpoints, and fencing        |
| `ModelAdapter`                 | generation and optional streaming                  |
| `ToolAdapter`                  | list and execute host-authorized tools             |
| `ConnectionCredentialProvider` | supply and invalidate host-managed connection auth |
| `EventSink`                    | observe ordered run events                         |
| `ArtifactStore`                | put/get artifact bytes by reference                |
| `ApprovalAdapter`              | resolve a human approval request                   |
| `SandboxAdapter`               | execute a code step                                |
| `SubRunAdapter`                | invoke an isolated child agent manifest            |
| `ConditionEvaluator`           | evaluate `when`, loop conditions, and goals        |

## Execution interface

Local and remote compute adapters implement:

```ts
interface ExecutionEngine {
  submit(request): Promise<ExecutionHandle>;
  resume(request): Promise<ExecutionHandle>;
  status(handle): Promise<ExecutionStatus>;
  events(handle, { after, signal }): AsyncIterable<RunEvent>;
  result(handle, { signal }): Promise<RunResult>;
  cancel(handle): Promise<void>;
}
```

`ExecutionClient.follow()` reconnects event streams using the last
`(attempt, sequence)` cursor. `wait()` drains the stream until the execution
reaches a terminal status.

Remote execution divides the implementation between
`RemoteExecutionControlPlane`, which owns lifecycle state, and
`RemoteComputeLauncher`, which starts and cancels compute.

## Package map

| Package                                     | Purpose                                        |
| ------------------------------------------- | ---------------------------------------------- |
| `@clearideas/agent-runtime-contracts`       | manifest schemas and TypeScript types          |
| `@clearideas/agent-runtime-core`            | step scheduling, state, checkpoints, recovery  |
| `@clearideas/agent-runtime-config`          | providers, model profiles, MCP composition     |
| `@clearideas/agent-runtime-model-ai-sdk`    | AI SDK model adapter                           |
| `@clearideas/agent-runtime-condition-jexl`  | standard condition evaluator                   |
| `@clearideas/agent-runtime-step-prompt`     | prompt, streaming, and ordered tool calls      |
| `@clearideas/agent-runtime-step-loop`       | collection and goal loops                      |
| `@clearideas/agent-runtime-step-standard`   | webhook, approval, code, and sub-run steps     |
| `@clearideas/agent-runtime-store-local`     | memory/file stores, JSONL, local artifacts     |
| `@clearideas/agent-runtime-store-sqlite`    | transactional local store                      |
| `@clearideas/agent-runtime-execution`       | engine lifecycle and worker protocol           |
| `@clearideas/agent-runtime-execution-modal` | Modal compute adapter                          |
| `@clearideas/agent-runtime-sandbox`         | sandbox provider interface and Docker provider |
| `@clearideas/agent-runtime-sandbox-modal`   | Modal sandbox provider                         |
| `@clearideas/agent-runtime-artifacts`       | sandboxed artifact generation                  |
| `@clearideas/agent-runtime-telemetry-otel`  | OpenTelemetry event sink                       |
| `@clearideas/agent-runtime-cli`             | CLI host and worker command                    |
