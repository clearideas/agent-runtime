---
title: Clear Ideas Agent Runtime
description: Build and run declarative AI agents with your choice of models, tools, storage, and compute.
layout: doc
aside: false
---

<div class="runtime-hero">

# Portable, declarative agent execution

Define an agent once, then run it locally, in your application, or on remote
compute using your choice of models, tools, persistence, and sandboxes.

</div>

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
  <div><strong>Agent Runtime</strong><br/><small>State, models, tools, and execution</small></div>
  <span>→</span>
  <div><strong>Adapters</strong><br/><small>Storage and compute</small></div>
</div>

The agent manifest defines the agent. An agent run manifest references that
definition and supplies invocation values. Host configuration selects model
providers and connections. Adapters connect storage, compute, sandboxes, and
telemetry.

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
- Agent runs are sequential by default and can fan out dependency-safe prompt
  steps.
- Stateful steps and tool calls remain sequential.
- Host configuration and adapters authorize credentials, connections, network
  access, and compute.
