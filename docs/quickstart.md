---
title: Quick start
description: Run your first agent locally with one model-provider API key.
---

# Quick start

Requirements:

- Node.js 24 or newer
- one model-provider API key

The CLI uses the local file store and requires no database or container
runtime.

## 1. Build the CLI

From the repository root:

```sh
npm install
npm run build
alias agent-runtime='node ./packages/cli/dist/bin.js'
```

## 2. Set a provider key

Choose one:

```sh
export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."
export XAI_API_KEY="..."
export GROQ_API_KEY="..."
export COHERE_API_KEY="..."
```

Agent Runtime selects the provider from the manifest's `provider` field.

## 3. Create an agent

Save this as `hello.agent.yaml`:

<<< ../examples/manifests/hello.agent.yaml

## 4. Validate and run it

```sh
agent-runtime validate ./hello.agent.yaml
agent-runtime run ./hello.agent.yaml --stream --format pretty
```

The default local files are:

```text
.agent-runtime/
  events.jsonl
  runs/
    <run-id>/
      run.json
      checkpoint.json
  artifacts/
    <artifact-id>/
      data
      metadata.json
```

The JSON completion summary omits prompts, variables, transcripts, and model
output. Use `--format pretty` for interactive output or inspect a persisted run
to view its stored data.

## Supply invocation variables

Use an agent run manifest when invocation values must be supplied at runtime.
It references the reusable agent:

<<< ../examples/manifests/release-brief.run.yaml

Start it with:

```sh
agent-runtime run-manifest ./release-brief.run.yaml \
  --stream
```

The referenced agent may declare defaults and may mark inputs with
`requiresOverride: true`. Override keys must exactly match top-level agent
declarations. A run cannot introduce a variable or use a dotted path as a key.

For ad hoc local use, `agent-runtime run <agent> --variables
<overrides.json>` applies the same validated runtime overrides without saving
an agent run manifest.

## Try the bundled examples

```sh
agent-runtime examples list
agent-runtime examples run variables --stream
agent-runtime examples run conditions --stream
agent-runtime examples run loops --stream
```

## Try the browser example

The interactive example creates an `AgentRunManifest`, executes the referenced
agent locally or through the remote worker protocol, and streams model, tool,
checkpoint, and lifecycle events to a browser:

```sh
npm run example:web
```

The example uses OpenAI's `gpt-5.6-luna` model, the public Context7 MCP
endpoint, and an OpenTelemetry event sink. Set `OPENAI_API_KEY` before starting
it. A Context7 key is optional.

See
`examples/interactive-web/README.md` in the repository for hosted-provider and
Ollama configuration.

## Use a local model

Ollama, LM Studio, vLLM, and compatible remote endpoints use the
`openai-compatible` driver. For Ollama with Gemma 4:

Save this as `agent-runtime.config.yaml`:

<<< ../examples/manifests/ollama.config.yaml

Reference the profile from the manifest:

```yaml
model:
  ref: local
```

Then run:

```sh
ollama pull gemma4
agent-runtime run ./hello.agent.yaml \
  --config ./agent-runtime.config.yaml \
  --stream
```

No provider API key is required for an unauthenticated local endpoint.

## Next

- Embed an execution engine in [Local execution](./local-execution.md).
- Launch remote compute in [Remote execution](./remote-execution.md).
- Add reusable model profiles in [Models and providers](./models-and-providers.md).
- Add MCP or application tools in [Connections and tools](./connections-and-tools.md).
- Consume machine-readable output in [Events and streaming](./events-and-streaming.md).
- Supply invocation variables in [Embed Agent Runtime](./embedding.md).
