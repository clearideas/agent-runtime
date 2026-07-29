---
title: Agent manifests and agent run manifests
description: Define reusable agents and start runs with validated runtime inputs.
---

# Agent manifests and agent run manifests

## Agent manifest

An agent manifest declares models, input variables, connections, steps, limits,
and output behavior.

Use `metadata` for inert application data. Use namespaced `extensions` for
behavior implemented by an application adapter.

<<< ../examples/manifests/release-brief.agent.yaml

## Agent variable declarations

Each declaration describes one top-level input:

```yaml
variables:
  - key: audience
    type: string
    requiresOverride: true
    description: Intended readers.
  - key: style
    type: object
    value:
      tone: direct
      maxWords: 180
```

`value` sets the agent default. `requiresOverride: true` requires every new run
to supply the variable, including declarations that also contain a default.

Variable keys are top-level names and cannot contain dots. Dot notation
reads a property inside an object value: <code v-pre>{{ style.tone }}</code>
reads the `tone` property of the `style` variable.

## Agent run manifest

An agent run manifest references an agent and supplies runtime values:

<<< ../examples/manifests/release-brief.run.yaml

A run may override any declared variable and must supply every variable marked
`requiresOverride: true`. Agent Runtime applies run values after agent defaults.

Set `execution.mode` to `parallel` to have Agent Runtime resolve manifest
variable dependencies into execution waves and schedule eligible independent
prompt branches concurrently:

```yaml
schemaVersion: "1.0"
agent:
  ref: research-brief.agent.yaml
execution:
  mode: parallel
  maxConcurrency: 4
variables:
  - key: topic
    value: Remote MCP clients
```

The default mode is `sequential`. In parallel mode, Agent Runtime derives a
dependency-aware execution plan from template and condition references, step
outputs, and manifest order. It waits when a step consumes a prior
`outputVariable`, fans eligible independent prompt branches out, and commits
each wave in manifest order. Tool-enabled prompts, loops, approvals, webhooks,
code, sub-runs, and steps with runtime extensions remain ordered. Tool calls
within a prompt step also remain ordered.

Use the embedding API to start the same run:

```ts
await agentRuntime.run({
  agentRunManifest: {
    schemaVersion: "1.0",
    agent: { ref: "release-brief.agent.yaml" },
    execution: { mode: "parallel", maxConcurrency: 4 },
    variables: [{ key: "audience", value: "partners" }],
  },
});
```

Run overrides use complete values:

```ts
{
  variables: [
    { key: "audience", value: "partners" },
    { key: "style", value: { tone: "concise", maxWords: 120 } },
  ];
}
```

Overrides must use exact declared keys. Unknown keys, duplicate overrides, and
values that do not match the declared type fail before the run is created. An
override replaces the complete variable value; nested values are not
deep-merged.

Supported types are `string`, `number`, `boolean`, `object`, `array`, and
`json`. The `json` type accepts an object or array.

## Step output variables

`outputVariable` writes a step result to top-level execution state. Step output
variables do not require agent variable declarations.

`outputVariable` must be a top-level key and cannot contain dots. If a step
returns an object into `brief`, later steps can read `brief.draft` or
`brief.review` with dot notation.

## Final output

Set `includeInFinalOutput: true` on each top-level step whose output belongs in
the run result. When several steps are selected, their outputs follow manifest
order. When none are selected, Agent Runtime returns the last completed step
output.

## Template expressions

Templates use <code v-pre>{{ path.to.value }}</code>. Missing values render as an empty string.
Objects and arrays render as JSON. Template lookup is case-insensitive, while
stored paths retain their declared spelling. Template interpolation applies
only to prompt and system-prompt text. Direct JEXL variable access is
case-sensitive. Template-wrapped <code v-pre>{{ path }}</code> operands in
conditions are resolved case-insensitively. Webhook, approval, code, and
sub-run fields are passed to their adapters as declared.

## Model selection

Explicit provider and model:

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-5
```

Model profile:

```yaml
model:
  ref: quality
```

A prompt step may override the manifest model.

`options` accepts an AI SDK `providerOptions` object keyed by provider. Its keys
and values are provider-specific. For example:

```yaml
model:
  provider: openai
  model: gpt-5.6
  options:
    openai:
      reasoningEffort: low
```

## Structured output

`outputSchema` is a JSON Schema object passed through the model adapter:

```yaml
variables:
  - key: text
    type: string
    value: Please explain durable checkpoints.

steps:
  - id: classify
    type: prompt
    prompt: Classify {{ text }}.
    outputSchema:
      type: object
      additionalProperties: false
      required: [category, confidence]
      properties:
        category:
          type: string
          enum: [question, request, feedback]
        confidence:
          type: number
    outputVariable: classification
```

Choose a model/provider combination that supports structured output and declare
that capability in its model profile.

## Conditions

`when` uses the registered condition evaluator. The standard CLI uses JEXL:

```yaml
variables:
  - key: priority
    type: string
    value: normal

steps:
  - id: classify
    type: prompt
    prompt: Classify the request and return a confidence score.
    outputSchema:
      type: object
      additionalProperties: false
      required: [confidence]
      properties:
        confidence:
          type: number
    outputVariable: classification

  - id: escalate
    type: prompt
    when: classification.confidence < 0.7 || priority == "high"
    prompt: Explain why this item needs review.
```

Skipped steps still advance the durable checkpoint.

## Collection loops

<<< ../examples/manifests/collection-loop.agent.yaml

The loop executes children sequentially and checkpoints nested progress.
`source` may resolve to an array, an object containing an array, a JSON-encoded
array, or delimited text.

## Goal loops

<<< ../examples/manifests/evaluator-loop.agent.yaml

`maxIterations` is required for goal loops.

## Standard steps

Webhook:

```yaml
- id: notify
  type: webhook
  url: https://hooks.example.com/agent
  method: POST
  body:
    status: completed
  timeoutMs: 10000
  retries: 2
  idempotencyKey: release-notification-v1
```

Approval:

```yaml
- id: confirm
  type: approval
  prompt: Approve publishing this result?
  action: pause
```

Code:

```yaml
variables:
  - key: items
    type: array
    value: [one, two, three]

steps:
  - id: calculate
    type: code
    language: python
    timeoutMs: 30000
    code: |
      import json, os
      with open(os.environ["AGENT_VARIABLES_FILE"]) as source:
          variables = json.load(source)
      print(json.dumps({"count": len(variables["items"])}))
```

Sub-run:

```yaml
variables:
  - key: request
    type: object
    value:
      question: How should this request be handled?

steps:
  - id: specialist
    type: sub-run
    manifestRef: agents/specialist.yaml
    variableMappings:
      question: request.question
    outputVariable: specialistAnswer
```

Host adapters authorize network access, approvals, sandboxes, and sub-runs.
