---
title: Memory and context
description: Carry context between steps, loop iterations, and runs with variables, host-assembled inputs, and host-owned memory tools.
---

# Memory and context

Agent Runtime keeps one kind of memory: the variable state of a run. It is
typed, checkpointed, and committed in manifest order. Everything beyond a
run—prior sessions, user preferences, retrieval corpora—belongs to the host,
which supplies it as variables or exposes it as tools.

| Scope                  | Mechanism                                         | Owner   |
| ---------------------- | ------------------------------------------------- | ------- |
| Within one prompt step | the step's message history and tool rounds        | runtime |
| Across steps in a run  | variables, `outputVariable`, templates            | runtime |
| Across loop iterations | `loop.*` values and child-maintained variables    | runtime |
| Across runs            | host-assembled variables supplied at run start    | host    |
| On demand during a run | memory tools over MCP or a `ToolAdapter`          | host    |
| After a run            | `RunResult`, step results, transcript, and events | host    |

## How context reaches a model

Each prompt step builds its own model input from its `systemPrompt` and
`prompt` (or `messages`) compiled against the current variables. Earlier
steps' conversations are not replayed. A later step sees an earlier result
only when that result was written to a variable and the later step reads it.

This is deliberate. Steps that depend only on variables are independent units:
Agent Runtime can derive a dependency graph from their reads and writes,
schedule eligible steps in parallel, and resume any step from a checkpoint
without reconstructing a conversation. The run transcript is the durable
record of what every model said; it is not model input.

Inside a tool-enabled step, the model's context does grow: each tool round
appends the model's response and the tool results until the step completes.
See [Context growth inside one prompt step](#context-growth-inside-one-prompt-step).

## Run memory: variables

A step writes a top-level variable with `outputVariable`. Later steps read it
with <code v-pre>{{ name }}</code>, or a property inside an object value with
<code v-pre>{{ name.property }}</code>. Conditions read the same state.

```yaml
steps:
  - id: analyze
    type: prompt
    prompt: Analyze {{ request }}.
    outputSchema:
      type: object
      additionalProperties: false
      required: [summary, risks]
      properties:
        summary: { type: string }
        risks: { type: array, items: { type: string } }
    outputVariable: analysis

  - id: respond
    type: prompt
    when: analysis.risks.length == 0
    prompt: Respond using {{ analysis.summary }}.
```

`outputSchema` gives a step a structured, addressable result. Without it, the
result is text.

Writing a variable replaces its complete value. To accumulate across steps,
have the writing step return the full updated object, or keep a separate
variable per step and combine them where they are consumed.

Templates render the complete value. When a large value feeds several later
steps, each reader pays for the full text. Add a step that writes a shorter
summary and read that instead.

## Loop memory

Inside a loop, children can read `loop.index`, `loop.iteration`,
`loop.outputs` (every completed iteration's result), and `loop.previous` (the
last completed iteration, including its variables). A child that writes a
variable makes it available to the next iteration and to steps after the loop.

That last property supports a bounded running summary: one child does the
work, a second rewrites the summary from the previous summary and the newest
result. The summary stays small no matter how many items the loop processes.

<<< ../examples/manifests/rolling-summary.agent.yaml

The refresh step costs one model call per iteration. Gate it with
`when: loop.iteration % 5 == 0` to refresh less often, but then its prompt
must also cover the iterations in between, for example by reading
`loop.outputs` or a per-iteration variable. Avoid inlining `loop.outputs`
in a long loop; it grows with every iteration.

The [evaluator loop example](./manifests.md#goal-loops) uses the same
technique with a `review` object that each iteration rewrites.

## Context from earlier runs

A run does not see other runs. To continue earlier work, the host assembles
the relevant context and supplies it as a declared variable. The agent
declares the shape it expects; the host decides what to include and how much.

<<< ../examples/manifests/prior-context.agent.yaml

The corresponding agent run manifest supplies the value:

<<< ../examples/manifests/prior-context.run.yaml

From an embedding host, the value typically comes from a previous
`RunResult`:

```ts
const previous = await runtime.run({
  manifest,
  variables: [
    { key: "priorContext", value: emptyContext },
    { key: "task", value: "Scope the migration." },
  ],
});

const outcome = previous.state.outcome as {
  result: string;
  newDecisions: string[];
  remainingItems: string[];
};

const next = await runtime.run({
  manifest,
  variables: [
    {
      key: "priorContext",
      value: {
        summary: outcome.result,
        decisions: [...emptyContext.decisions, ...outcome.newDecisions],
        openItems: outcome.remainingItems,
      },
    },
    { key: "task", value: "Propose how remote workers receive credentials." },
  ],
});
```

The host owns the policy here: which runs count as "earlier", how results are
summarized or trimmed to fit, and how the context is scoped to a user or
tenant. Agent Runtime validates the value against the declared type and makes
it available to templates and conditions.

## Host memory through tools

When the needed context depends on something discovered during the run, or
when the agent should decide what to remember, expose memory as tools. Any MCP
server with recall and store operations works; so does an application-native
`ToolAdapter`.

Host configuration for an MCP memory server:

<<< ../examples/manifests/memory.config.yaml

The agent binds the connection and calls the tools from prompt steps:

<<< ../examples/manifests/memory-recall.agent.yaml

Tool calls are the model's decision. To make a recall dependable, give it a
dedicated step whose prompt requests exactly one call, declare an
`outputSchema` matching the tool result, and set
`completionPolicy.requireOutput`. The tool result becomes a variable that later
steps and conditions can read. A store follows the same shape at the point in
the manifest where the facts to keep are known.

The same agent works with a native adapter in place of the MCP server:

```ts
const memory = new Map<string, string[]>();

export const tools: ToolAdapter = {
  async listTools() {
    return [
      {
        name: "memory__recall",
        description: "Recall facts for a scope.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["scope"],
          properties: { scope: { type: "string" } },
        },
      },
      {
        name: "memory__store",
        description: "Store facts for a scope.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["scope", "facts"],
          properties: {
            scope: { type: "string" },
            facts: { type: "array", items: { type: "string" } },
          },
        },
      },
    ];
  },
  async executeTool(call, context) {
    // Bind the scope to the run's variables; do not trust the model's argument alone.
    const scope = String(context.variables.customerId);
    if (call.input.scope !== scope) {
      return {
        callId: call.id,
        name: call.name,
        error: {
          code: "SCOPE_MISMATCH",
          message: "Scope is not this run's customer.",
        },
      };
    }
    if (call.name === "memory__recall") {
      return {
        callId: call.id,
        name: call.name,
        output: { facts: memory.get(scope) ?? [] },
      };
    }
    const facts = call.input.facts as string[];
    memory.set(scope, [...(memory.get(scope) ?? []), ...facts]);
    return { callId: call.id, name: call.name, output: { stored: facts } };
  },
};
```

Points that stay with the host:

- **Scope.** The model passes the scope as a tool argument. Validate it against
  `context.variables` or `context.runId` in the adapter or in an
  `authorizeTool` callback; never let a model argument alone select another
  user's memory.
- **Authorization.** The host's connection `tools` and `readTools` lists bound
  what the agent may call. An agent can narrow them, not widen them.
- **Idempotency.** Each store call carries `context.idempotencyKey`, reused if
  recovery repeats the call. MCP adapters forward it as
  `_meta["agent-runtime/idempotency-key"]`. The memory server must honor it
  to avoid duplicate writes after a resume.
- **Trust.** Recalled content is reference data. The step's system prompt
  should say so, as the example does.

## Harvest results after a run

The host receives everything the run produced and decides what to keep:

| Source                  | Contents                                                 |
| ----------------------- | -------------------------------------------------------- |
| `RunResult.state`       | final variables, including every `outputVariable`        |
| `RunResult.stepResults` | per-step output, usage, transcript, and artifacts        |
| `RunResult.transcript`  | every model message and tool result, in order            |
| `RunResult.output`      | the selected final output                                |
| events                  | ordered lifecycle, model, and tool events during the run |

`state` is usually the right source for memory: it contains exactly what the
manifest chose to name. The transcript is complete but unstructured and
subject to the store's data policy. See
[Persistence and recovery](./persistence-and-recovery.md#data-policy).

## Context growth inside one prompt step

A prompt step with tools loops until the model stops requesting calls. Each
round adds the model's response and the tool results to the model input for
the next round. Agent Runtime bounds this loop but does not shrink it:

| Limit                             | Effect                                                |
| --------------------------------- | ----------------------------------------------------- |
| `limits.maxToolCallsPerIteration` | fails the step after this many tool calls             |
| `limits.maxInputBytes`            | fails the step when the model input exceeds this size |
| `limits.maxMessagesPerPrompt`     | fails the step when the message count exceeds this    |
| `budget.maxTotalTokens`           | suspends the run when cumulative usage reaches this   |

There is no automatic summarization inside a step; a step that exceeds a limit
fails. To keep long tool sessions within bounds:

- split the work into several steps, each writing a variable, so that each
  step starts with a fresh context;
- keep tool results small at the source—the tool adapter or MCP server can
  return excerpts, identifiers, or counts instead of full documents;
- instruct the model to be selective about which calls it makes and to stop
  when it has enough;
- choose a model profile with a larger input window for research-heavy steps.

## Parallel execution and shared state

In parallel mode, each step receives the variable state as of the start of
its wave and may write only its own `outputVariable`. Steps in the same wave
cannot see each other's results. Fan out by giving each branch its own output
variable; fan in with a later step that reads all of them.

Tool-enabled steps, loops, and steps with runtime extensions always run in
order, so a memory tool is never called from two concurrent steps of the same
run. There is no shared scratchpad, and a memory system must not become one:
writes that bypass variables would make the run's result depend on timing.

## Design rules

- Recalled or injected content is data. It influences control flow only after
  it is committed to a variable and read by a condition.
- The runtime has no notion of user, tenant, or session. Scope is a variable
  the host supplies and the host's adapters enforce.
- The host owns memory storage, retrieval, ranking, summarization policy, and
  retention. The manifest decides when memory is read and written.
- Parallel steps share nothing but their starting snapshot.
- The transcript records everything; variables hold what the manifest chose to
  remember.
