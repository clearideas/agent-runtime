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

## 1. Install the CLI

Create a project and install the published CLI:

```sh
mkdir agent-runtime-quickstart
cd agent-runtime-quickstart
npm init -y
npm install --save-dev @clearideas/agent-runtime-cli
```

Run CLI commands in this guide with `npx agent-runtime`. No source checkout or
repository build is required.

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
npx agent-runtime validate ./hello.agent.yaml
npx agent-runtime run ./hello.agent.yaml --stream --format pretty
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
First save this reusable definition as `release-brief.agent.yaml`:

<<< ../examples/manifests/release-brief.agent.yaml

Then save this invocation as `release-brief.run.yaml`:

<<< ../examples/manifests/release-brief.run.yaml

Start it with:

```sh
npx agent-runtime run-manifest ./release-brief.run.yaml \
  --stream
```

The referenced agent may declare defaults and may mark inputs with
`requiresOverride: true`. Override keys must exactly match top-level agent
declarations. A run cannot introduce a variable or use a dotted path as a key.

For ad hoc local use, `npx agent-runtime run <agent> --variables
<overrides.json>` applies the same validated runtime overrides without saving
an agent run manifest.

## Try the bundled examples

```sh
npx agent-runtime examples list
npx agent-runtime examples run variables --stream
npx agent-runtime examples run conditions --stream
npx agent-runtime examples run loops --stream
```

## Develop the browser example from source

The npm package is the normal installation path. Contributors who want to
modify the interactive browser example can clone the repository and build the
workspace:

```sh
git clone https://github.com/clearideas/agent-runtime.git
cd agent-runtime
npm ci
npm run build
npm run example:web
```

The example creates an `AgentRunManifest`, executes the referenced agent locally
or through the remote worker protocol, and streams model, tool, checkpoint, and
lifecycle events to a browser. It uses OpenAI's `gpt-5.6-luna` model, the public
Context7 MCP endpoint, and an OpenTelemetry event sink. Set `OPENAI_API_KEY`
before starting it. A Context7 key is optional.

See the [interactive web example](./interactive-example.md) for execution
modes, parallel scheduling, MCP tools, streaming, persistence, and telemetry.

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
npx agent-runtime run ./hello.agent.yaml \
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
