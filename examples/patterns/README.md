# Three agent patterns

Requirements: Node.js 24+, npm 11. From the repository root:

```sh
npm ci
npm run build
```

The commands below use the built workspace packages. Demo mode substitutes
model responses; orchestration, tools, persistence, and resume are real.
No provider account, database, or container is needed for the demos.

## 1. Release note: prompt chain and structured output

```sh
node examples/patterns/prompt-chain.mjs --demo
```

Expected output: an object with `title: "Durable checkpoints"` and a `summary`.
Read [prompt-chain.mjs](prompt-chain.mjs): the first step produces a draft, and
the second reads that draft and requests an object matching an output schema.
The invocation supplies a required string variable.

For a live model, set `OPENAI_API_KEY` and omit `--demo`. If authorization fails,
check the key and choose a model available to your account in the manifest.

## 2. Release lookup: tools and recovery

```sh
node examples/patterns/tool-agent.mjs --demo
```

Expect `model.tool.*` lifecycle events and `Release found after one temporary
lookup failure.` Read [tool-agent.mjs](tool-agent.mjs): the first local read
returns a classified error, then a second read succeeds. Demo mode makes the
model's decision to retry deterministic. With a live model, the prompt requests
one retry; model behavior can vary. The runtime does not automatically replay
arbitrary tool side effects.

To use a live model, set `OPENAI_API_KEY` and omit `--demo`. If your tool is not
called, check its description, schema, and the model's tool support.

## 3. Release approval: suspend and resume

```sh
node examples/patterns/approval.mjs
node examples/patterns/approval.mjs --approve
```

The first process prints `Suspended`; the second reads the checkpoint and prints
an object containing `approved: true`. No model key is needed. Read
[approval.mjs](approval.mjs): the host approval adapter changes its answer while
the persisted manifest stays identical. `--approve` is a local demo control;
a production host must authenticate the approving user.

If the run already exists, use a new directory for both commands:

```sh
DEMO_STORE=.agent-runtime/another-approval node examples/patterns/approval.mjs
DEMO_STORE=.agent-runtime/another-approval node examples/patterns/approval.mjs --approve
```

Run all deterministic examples with `npm run test:examples`.
