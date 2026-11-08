---
title: Contract reference
description: Manifest fields, runtime configuration, adapter interfaces, and Agent Runtime packages.
---

# Contract reference

## Agent manifest

The exported TypeScript type is `AgentManifest`; validate external input with
`agentManifestSchema` or `parseAgentManifest`.

| Field                       | Type                          | Notes                                                 |
| --------------------------- | ----------------------------- | ----------------------------------------------------- |
| `schemaVersion`             | `"1.0"`                       | required                                              |
| `id`, `name`, `description` | string                        | optional identity and documentation                   |
| `model`                     | explicit reference or profile | default for prompt steps                              |
| `variables`                 | variable declaration array    | typed inputs, defaults, requirements, documentation   |
| `connections`               | array                         | host connection bindings                              |
| `workspaces`                | array                         | host workspace bindings (code bases, document stores) |
| `steps`                     | array                         | ordered execution plan                                |
| `policies`                  | object                        | default execution policies; steps may override them   |
| `limits`                    | object                        | step, output, tool-call, and provider bounds          |
| `metadata`                  | JSON object                   | inert application metadata                            |
| `extensions`                | JSON object                   | namespaced host extensions                            |

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

## Execution policies

`policies` may appear on the manifest and on any step. Step values override
manifest values, which override host defaults (`AgentRuntimeDependencies.policies`).
Host-enforced policies (`AgentRuntimeDependencies.enforcedPolicies`) apply
last and override all of them.

| Field                             | Type                                                                                                                                                         | Notes                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `context.strategy`                | `summarize`, `prune`, `summarize-or-prune`, or `fail`                                                                                                        | default `prune`                                                                      |
| `context.summarizer`              | `model`, `systemPrompt`, `prompt`, `prompts`, `maxOutputTokens`, `summaryShare`, `minSummaryBytes`, `maxSummaryBytes`, `chunkBytes`, `maxCalls`, `maxPasses` | see [Controlling the summarizer](./context-management.md#controlling-the-summarizer) |
| `context.overflowRetries`         | integer from 0 to 10                                                                                                                                         | reduce-and-retry attempts after a provider overflow; default 3                       |
| `context.trigger`                 | `inputBytes`, `inputTokens`, `contextRatio`, `toolRounds`                                                                                                    | any satisfied criterion triggers; `contextRatio` in (0, 1]                           |
| `context.retain.recentToolRounds` | non-negative integer                                                                                                                                         | default 2                                                                            |
| `context.maxCompactions`          | non-negative integer                                                                                                                                         | summarizer compactions per step execution; default 25                                |
| `context.reduceTo`                | number from 0.05 to 0.95                                                                                                                                     | size a reduction aims for, × the trigger; default 0.25                               |
| `context.openingShare`            | number from 0.05 to 1                                                                                                                                        | opening-prompt budget, × the trigger; default 0.5 / 0.9                              |
| `context.maxToolResultBytes`      | positive integer                                                                                                                                             | single tool-result cap; overrides `toolResultShare`                                  |
| `context.toolResultShare`         | number from 0.05 to 1                                                                                                                                        | single tool-result cap, × the trigger; default 0.4                                   |
| `context.variables.<path>`        | `keep`, `strategy`, `maxBytes`                                                                                                                               | per-variable overrides for the opening prompt                                        |
| `toolCallLimit`                   | `finalize` or `fail`                                                                                                                                         | default `finalize`                                                                   |
| `modelRetry`                      | `maxAttempts` (1–10), `initialDelayMs`, `maxDelayMs`                                                                                                         | defaults 3, 1000, 20000                                                              |
| `outputRepair.maxAttempts`        | integer from 0 to 5                                                                                                                                          | default 1                                                                            |
| `onError`                         | `fail` or `continue`                                                                                                                                         | default `fail`; the only field allowed on non-prompt steps                           |

See [Execution policies](./execution-policies.md) and
[Context management](./context-management.md).

An approval step's `onReject` is `fail` (default), `cancel`, `complete`, or
`continue`.

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
budget:
  maxTotalTokens: 100000
```

| Field                      | Type                    | Notes                                               |
| -------------------------- | ----------------------- | --------------------------------------------------- |
| `schemaVersion`            | `"1.0"`                 | required                                            |
| `agent.ref`                | string                  | required host-resolved agent reference              |
| `runId`                    | string                  | optional caller-provided run identity               |
| `variables`                | variable override array | optional runtime values                             |
| `execution.mode`           | sequential or parallel  | optional; defaults to sequential                    |
| `execution.maxConcurrency` | integer from 1 to 64    | optional requested limit; the host may impose a cap |
| `budget.maxTotalTokens`    | positive integer        | optional cumulative model-token limit               |

The TypeScript shape is:

```ts
{
  schemaVersion: '1.0',
  agent: { ref: 'release-brief.agent.yaml' },
  execution: { mode: 'parallel', maxConcurrency: 4 },
  budget: { maxTotalTokens: 100000 },
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

`budget.maxTotalTokens` is cumulative across resume attempts. Agent Runtime
persists the effective limit and consumed reported tokens in every checkpoint.
Before another model call, a run whose consumed tokens meet or exceed its limit
suspends. Resume may provide a replacement limit; omitting it reuses the
persisted limit, and a limit that is not higher than consumed usage suspends
again. Budgeted model adapters should report `totalTokens`, or both
`inputTokens` and `outputTokens`; when they report neither, the prompt step
records an estimate marked `metadata.estimated: true` and emits a
`USAGE_ESTIMATED` diagnostic. Budgeted runs execute sequentially so concurrent
calls cannot overspend one shared limit.

## Workspace binding

Each entry in the agent manifest's `workspaces` array binds a host-defined
workspace:

| Field      | Type                   | Notes                                                              |
| ---------- | ---------------------- | ------------------------------------------------------------------ |
| `ref`      | string                 | required host workspace name                                       |
| `alias`    | `^[a-z][a-z0-9-]*$`    | tool prefix and sandbox mount name; defaults to `ref`              |
| `tools`    | string array           | optional narrowing of the tools the host exposes for the workspace |
| `mode`     | `read` or `read_write` | optional; may only narrow the configured mode                      |
| `required` | boolean                | `false` skips the binding when the host does not configure it      |

Workspace aliases and connection aliases share one namespace. A `code` step
may list bound aliases in `workspaces`, or set `sandbox: run`, to execute in
the run sandbox. See [Workspaces and the run sandbox](./workspaces.md).

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
is checked before every model request. The step's
[context policy](./context-management.md) reduces oversized input to fit these
limits before it would fail.

## Runtime configuration

```ts
{
  version: "1.0";
  providers: Record<string, ProviderDefinition>;
  models: Record<string, ConfiguredModelDefinition>;
  connections: Record<string, McpConnectionDefinition>;
  workspaces: Record<string, WorkspaceDefinition>;
  sandbox?: SandboxDefinition;
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

Workspace definitions use `driver: local` (`root`, `mode`, `include`,
`exclude`, size limits, `attach`) or `driver: host`. The `sandbox` section
selects `bubblewrap`, `docker`, or `host`, and declares the helper, limits,
`commands`, and `shell` policy for the run sandbox. Manifests that bind a
workspace require a `sandbox` section.

MCP tool metadata verification (optional):

```ts
toolIntegrity?: {
  digests: Record<string, string>; // tool name → "sha256:<hex>"
  onFailure?: "fail" | "exclude"; // default "fail"
}
```

Digests are produced by `computeMcpToolDigest` over the canonical form of
`name`, `title`, `description`, `inputSchema`, and `annotations`
(`canonicalizeMcpToolMetadata`). The `sha256:` prefix identifies those rules
and is stable; a rules change would introduce a new prefix while existing pins
continue to verify. `discoverMcpConnectionTools` lists a
connection's tools with digests and integrity status; `McpToolIntegrityError`
reports `mismatch`, `unpinned`, or `rejected` definitions. The
`verifyToolMetadata` tool option lets a host apply its own approval record.
See [connections and tools](./connections-and-tools.md#verifying-mcp-tool-metadata).

## Adapter interfaces

| Adapter interface              | Responsibility                                                           |
| ------------------------------ | ------------------------------------------------------------------------ |
| `AgentManifestSource`          | load an agent manifest by opaque reference                               |
| `RunStore`                     | durable lifecycle, checkpoints, and fencing                              |
| `ModelAdapter`                 | generation, optional streaming, and optional `describeModel` limits      |
| `ToolAdapter`                  | list and execute host-authorized tools; optional `unavailableToolReason` |
| `ConnectionCredentialProvider` | supply and invalidate host-managed connection auth                       |
| `EventSink`                    | observe ordered run events                                               |
| `ArtifactStore`                | put/get artifact bytes by reference                                      |
| `ApprovalAdapter`              | resolve a human approval request                                         |
| `SandboxAdapter`               | execute a per-step code sandbox                                          |
| `WorkspaceProvider`            | resolve workspace bindings to `WorkspaceStore`s                          |
| `WorkspaceStore`               | enumerate and move opaque workspace bytes                                |
| `RunSandboxProvider`           | open the per-run sandbox that executes commands                          |
| `SubRunAdapter`                | invoke an isolated child agent manifest                                  |
| `ConditionEvaluator`           | evaluate `when`, loop conditions, and goals; optional `validate`         |
| `StepExecutor`                 | execute one step type; optional `preflight` checks                       |
| `ContextSummarizerAdapter`     | observe, change, or replace context summarization                        |

`RunStore` implementations may add `interruptRun` to record the `interrupted`
status; without it, interruptions are stored as retryable failures.

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

| Package                                     | Purpose                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `@clearideas/agent-runtime-contracts`       | manifest schemas and TypeScript types                              |
| `@clearideas/agent-runtime-core`            | step scheduling, state, checkpoints, recovery                      |
| `@clearideas/agent-runtime-config`          | providers, model profiles, MCP, workspace, and sandbox composition |
| `@clearideas/agent-runtime-model-ai-sdk`    | AI SDK model adapter                                               |
| `@clearideas/agent-runtime-condition-jexl`  | standard condition evaluator                                       |
| `@clearideas/agent-runtime-step-prompt`     | prompt, streaming, and ordered tool calls                          |
| `@clearideas/agent-runtime-step-loop`       | collection and goal loops                                          |
| `@clearideas/agent-runtime-step-standard`   | webhook, approval, code, and sub-run steps                         |
| `@clearideas/agent-runtime-store-local`     | memory/file stores, JSONL, local artifacts and workspaces          |
| `@clearideas/agent-runtime-store-sqlite`    | transactional local store                                          |
| `@clearideas/agent-runtime-execution`       | engine lifecycle and worker protocol                               |
| `@clearideas/agent-runtime-execution-modal` | Modal compute adapter                                              |
| `@clearideas/agent-runtime-sandbox`         | sandbox contracts, run sandbox, Docker and bubblewrap providers    |
| `@clearideas/agent-runtime-sandbox-modal`   | Modal sandbox provider                                             |
| `@clearideas/agent-runtime-artifacts`       | sandboxed artifact generation                                      |
| `@clearideas/agent-runtime-telemetry-otel`  | OpenTelemetry event sink                                           |
| `@clearideas/agent-runtime-cli`             | CLI host and worker command                                        |
