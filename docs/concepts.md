---
title: Core concepts
description: Understand manifests, runtime configuration, variables, steps, checkpoints, events, and adapters.
---

# Core concepts

## Agent manifest

An agent manifest is a reusable agent definition in YAML or JSON. It contains
model references, variables, connection references, steps, limits, and
metadata.

Unknown fields and unsafe variable paths fail validation. Use `metadata` for
inert application data and namespaced `extensions` for behavior interpreted by
an application adapter.

## Agent run manifest

An agent run manifest starts one execution by referencing an agent and supplying
runtime variable overrides and optional step scheduling. The agent definition is
reusable; the agent run manifest contains invocation-specific data.

The host resolves the agent reference before dispatching to a local or remote
execution engine.

## Runtime configuration

Runtime configuration defines model providers, model profiles, and
connections:

- provider definitions describe how to reach model APIs;
- model profiles select a provider, model identifier, defaults, and declared capabilities;
- connection definitions describe MCP endpoints and host-authorized tools.

Secret fields contain environment-variable references.

## Variables

The agent declares typed top-level input variables and optional default values.
A run may override a subset using exact keys and must supply variables marked
`requiresOverride`. Unknown keys and type mismatches fail before execution.

An override replaces the variable's complete value. Dot notation such as
`customer.summary` reads a nested property from an object variable; it is not a
variable key or an override syntax. `outputVariable` creates a top-level
execution-state value; it does not accept a dotted path.

## Steps

The built-in step types are:

| Type       | Purpose                                         | Required host capability                 |
| ---------- | ----------------------------------------------- | ---------------------------------------- |
| `prompt`   | model generation, structured output, and tools  | model; tools when named                  |
| `loop`     | collection or goal-driven sequential repetition | condition evaluator for conditions/goals |
| `webhook`  | bounded HTTP request with retry support         | authorized `fetch`/egress                |
| `approval` | request and resolve human approval              | approval adapter                         |
| `code`     | execute code in an isolated environment         | sandbox adapter                          |
| `sub-run`  | invoke another manifest with isolated state     | sub-run adapter                          |

Every step accepts `when`, `outputVariable`, `includeInFinalOutput`, `metadata`,
and `extensions`. `includeInFinalOutput` selects output only for top-level
steps.

## Checkpoints and attempts

Agent Runtime creates a checkpoint before execution and after each committed
step or parallel wave. A parallel wave commits atomically in manifest order.
Nested loops also checkpoint child progress. Resume verifies the manifest hash,
increments the attempt, and continues from the latest checkpoint.

Each resume increments the attempt number. A durable store rejects writes from
an older attempt after the resumed attempt takes ownership.

## Events and transcript

Events such as `step.started`, `model.text.delta`, and `checkpoint.saved`
provide ordered updates for clients and observability systems.

The transcript is durable model conversation content committed with run state.
Text and reasoning deltas are transient events; the completed transcript is the
authoritative record.

## Adapters

| Adapter                        | Responsibility                              |
| ------------------------------ | ------------------------------------------- |
| `RunStore`                     | run state, checkpoints, and attempt fencing |
| `ModelAdapter`                 | model generation and streaming              |
| `ToolAdapter`                  | tool discovery and execution                |
| `ConnectionCredentialProvider` | connection authentication and refresh       |
| `EventSink`                    | event delivery                              |
| `ArtifactStore`                | artifact bytes and metadata                 |
| `ApprovalAdapter`              | human approval requests                     |
| `SandboxAdapter`               | isolated code execution                     |
| `SubRunAdapter`                | child agent execution                       |
| `ExecutionEngine`              | local or remote run lifecycle               |
| `RemoteComputeLauncher`        | remote compute submission and cancellation  |
| `SandboxProvider`              | isolated process and filesystem lifecycle   |

Execution engines receive resolved agent execution requests. Sandbox providers
receive bounded requests for one code or artifact operation.

The [adapter catalog](./adapters.md) lists the implementations distributed with
Agent Runtime. Applications can supply other implementations of the same
contracts.
