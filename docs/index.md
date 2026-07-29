---
title: Clear Ideas Agent Runtime
description: A standalone TypeScript runtime for portable, declarative agents with native authorization, sandboxing, durable state, and local or remote execution.
layout: doc
aside: false
---

<div class="runtime-hero">

# A standalone runtime for portable agents

Define portable agents with declarative manifests, then run them locally, inside
an application, or on remote compute. Choose the model providers,
infrastructure, and adapters that fit your deployment.

</div>

```sh
npm install @clearideas/agent-runtime
```

Agent Runtime is an independent Apache-2.0 open-source project. It offers a
manifest-first alternative for teams evaluating LangChain, LangGraph, or a
custom agent harness: agent definitions remain portable while the host controls
models, credentials, tools, storage, compute, and telemetry.

<div class="runtime-grid">
  <a class="runtime-card" href="./quickstart">
    <strong>Quick start</strong>
    <span>Run your first agent with one model API key.</span>
  </a>
  <a class="runtime-card" href="./build-agents">
    <strong>Build agents</strong>
    <span>Learn prompt chains, routing, loops, tools, and approvals.</span>
  </a>
  <a class="runtime-card" href="./embedding">
    <strong>Embed Agent Runtime</strong>
    <span>Compose the TypeScript API inside an application.</span>
  </a>
  <a class="runtime-card" href="./remote-execution">
    <strong>Remote execution</strong>
    <span>Run agents through HTTPS workers or remote compute adapters.</span>
  </a>
</div>

## How it fits together

<div class="runtime-flow">
  <div><strong>Agent manifest</strong><br/><small>Reusable definition</small></div>
  <span>→</span>
  <div><strong>Agent run manifest</strong><br/><small>Reference and inputs</small></div>
  <span>→</span>
  <div><strong>Execution graph</strong><br/><small>Resolved dependencies and scheduling</small></div>
  <span>→</span>
  <div><strong>Adapters</strong><br/><small>Storage and compute</small></div>
</div>

The agent manifest defines the agent. An agent run manifest references that
definition and supplies invocation values. Host configuration selects model
providers, credentials, and connections. Adapters connect persistence, compute,
sandbox providers, and telemetry.

Agent Runtime resolves manifest variable dependencies into an execution plan.
Sequential mode follows manifest order. Parallel mode schedules eligible
independent prompt branches concurrently, then commits their results in
manifest order; dependent, stateful, and tool-enabled work remains ordered.

Authorization policy, sandbox contracts, durable run state, and execution
engines are native parts of Agent Runtime. Agent manifests may narrow
host-authorized connections and tools, but cannot grant themselves credentials
or broader access. Modal remote execution can apply a host-resolved direct
domain list, allow only a host-provided proxy endpoint, or block networking
without adding egress fields to the manifest. Docker and Modal sandbox
providers ship as packages in the same project.

## Choose a path

| Goal                           | Start here                                          |
| ------------------------------ | --------------------------------------------------- |
| Try Agent Runtime locally      | [Quick start](./quickstart.md)                      |
| Learn the agent patterns       | [Build agents](./build-agents.md)                   |
| Use local or hosted models     | [Models and providers](./models-and-providers.md)   |
| Add MCP or application tools   | [Connections and tools](./connections-and-tools.md) |
| Add Agent Runtime to a service | [Embed Agent Runtime](./embedding.md)               |
| Choose packaged integrations   | [Adapter catalog](./adapters.md)                    |
| Run on ad hoc compute          | [Remote execution](./remote-execution.md)           |
| Prepare a hosted deployment    | [Production guide](./production.md)                 |

## Execution model

- Agent manifests are YAML or JSON documents containing serializable values.
- Model, persistence, compute, sandbox, and telemetry integrations use adapters.
- Checkpoints record committed state and nested progress.
- Agent manifests resolve into dependency-aware execution plans.
- Parallel mode can fan out eligible prompt branches while preserving
  deterministic orchestration and manifest-order commits.
- Stateful steps and tool calls remain sequential.
- Runtime policy and host configuration authorize credentials, connections,
  tools, network access, and compute.
