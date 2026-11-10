# Serve agents to chat apps: a local walkthrough

This example runs the OpenAI-compatible server on your machine with two
agents, talks to it from the terminal, and then connects a chat front end:

- **support-chat** ([support-chat.agent.yaml](support-chat.agent.yaml))
  declares `messages`, so it receives the chat as conversation turns. A
  screening step decides whether the message is in scope, and one of two
  branches writes the reply.
- **topic-brief** ([brief.agent.yaml](brief.agent.yaml)) has no `messages`;
  the newest user message fills its required `topic` variable.

Both use the model profile `default`, which the runtime configuration maps
to a provider: OpenAI in [agent-runtime.config.yaml](agent-runtime.config.yaml),
or a local Ollama model in [ollama.config.yaml](ollama.config.yaml).

## 1. Build

Requirements: Node.js 22.20.0 or newer and npm. From the repository root:

```sh
npm ci
npm run build
```

## 2. Set two keys

The server requires an API key you choose, and signs conversation histories
with a key of its own. From the repository root:

```sh
cd examples/serving
export AGENT_RUNTIME_API_KEY="choose-a-local-key"
export AGENT_MESSAGES_KEY="hex:$(openssl rand -hex 32)"
```

Keep both values stable, for example in a shell profile or `.env` file you
source. If the signing key changes, conversations started before the change
are no longer recognized.

## 3. Start the server without a model account

The scripted model stands in for a provider, so every part of the server is
real except the model's words:

```sh
npx agent-runtime serve --runtime-module scripted-model.mjs
```

With no manifest argument, `serve` reads
[agent-runtime.server.yaml](agent-runtime.server.yaml) from the working
directory. Expect:

```text
Using …/examples/serving/agent-runtime.server.yaml.
Agent Runtime server listening on http://127.0.0.1:8000/v1 (support-chat, topic-brief; authentication required)
```

The server then logs one JSON line per request on standard error.

## 4. Chat from the terminal

In a second terminal, in this directory, with the same
`AGENT_RUNTIME_API_KEY`:

```sh
node chat.mjs
```

```text
you › How do I share a folder?
Step: Screen the request
Step: Answer
agent (turn 1) › (scripted) You asked: "How do I share a folder?". I can see 0 earlier message(s) of this conversation.

you › What is the weather?
Step: Screen the request
Step: Redirect
agent (turn 2) › (scripted) I can only help with questions about the product. …
```

What to notice:

- The dimmed `Step:` lines are progress, sent as `reasoning_content`. The
  screening verdict is never part of the reply.
- `chat.mjs` sends the whole conversation every time, as chat apps do. In the
  server's log the first request has `"ledger":"first-turn"` and the rest
  `"ledger":"hit"`: each turn continues from the runtime's own history.
- `/new` starts a new conversation. `node chat.mjs topic-brief` talks to the
  other agent.

The same requests with curl:

```sh
curl -s http://127.0.0.1:8000/v1/models -H "Authorization: Bearer $AGENT_RUNTIME_API_KEY"

curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $AGENT_RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"support-chat","messages":[{"role":"user","content":"How do I share a folder?"}]}'

curl -sN http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $AGENT_RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"topic-brief","stream":true,"messages":[{"role":"user","content":"durable checkpoints"}]}'
```

Runs, conversations, and uploaded images are kept in `./.data`, so
conversations continue after a restart. Delete the directory to start fresh.

## 5. Use a real model

Stop the server (Ctrl+C finishes active runs first) and start it without the
scripted model.

**OpenAI.** [agent-runtime.config.yaml](agent-runtime.config.yaml) maps
`default` to `gpt-5.6`; change `model` to one your account can use.

```sh
export OPENAI_API_KEY="…"
npx agent-runtime serve
```

**A local model with Ollama.** Pull a model that supports structured output,
then select the Ollama configuration:

```sh
ollama pull qwen3
npx agent-runtime serve --config ollama.config.yaml
```

`--config` replaces the file's `runtimeConfig` for this run. Chat again with
`node chat.mjs`; replies now come from the model.

## 6. Connect a chat front end

Chat front ends call the API the same way `chat.mjs` does. Two things to set
in any of them:

- **Turn off background tasks that use the chat model.** Front ends generate
  titles, tags, and follow-up suggestions by sending extra requests to the
  selected model. With an agent as the model, each of those runs the whole
  agent. Disable them, or point them at an ordinary model.
- **Reach the server from containers.** A front end in Docker cannot reach
  `127.0.0.1` on your machine. Start the server with `--host 0.0.0.0` (the
  API key keeps it closed) and use `http://host.docker.internal:8000/v1`.

### Open WebUI

Install it in a Python 3.11 or 3.12 virtual environment and start it with the
server as its OpenAI connection:

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install open-webui

OPENAI_API_BASE_URL=http://127.0.0.1:8000/v1 \
OPENAI_API_KEY="$AGENT_RUNTIME_API_KEY" \
ENABLE_OLLAMA_API=false \
ENABLE_TITLE_GENERATION=false \
ENABLE_TAGS_GENERATION=false \
ENABLE_FOLLOW_UP_GENERATION=false \
open-webui serve --port 3000
```

Open http://127.0.0.1:3000, create the first (administrator) account, and
choose **support-chat** in the model menu. Progress appears in Open WebUI's
collapsible "thinking" section above each reply.

Open WebUI stores these settings when it first starts. To change them later,
use **Admin Panel → Settings → Connections** for the server URL and key, and
**Admin Panel → Settings → Interface** for title, tag, and follow-up
generation (or choose a separate task model there).

With Docker instead (not covered by this repository's tests):

```sh
npx agent-runtime serve --host 0.0.0.0   # in this directory, with the keys set

docker run -d -p 3000:8080 --add-host=host.docker.internal:host-gateway \
  -e OPENAI_API_BASE_URL=http://host.docker.internal:8000/v1 \
  -e OPENAI_API_KEY="$AGENT_RUNTIME_API_KEY" \
  -e ENABLE_OLLAMA_API=false \
  -e ENABLE_TITLE_GENERATION=false \
  -e ENABLE_TAGS_GENERATION=false \
  -e ENABLE_FOLLOW_UP_GENERATION=false \
  -v open-webui:/app/backend/data --name open-webui \
  ghcr.io/open-webui/open-webui:main
```

### LibreChat

Add a custom endpoint to `librechat.yaml` and the key to LibreChat's `.env`
(`AGENT_RUNTIME_API_KEY=…`), then restart LibreChat:

```yaml
endpoints:
  custom:
    - name: "Agent Runtime"
      apiKey: "${AGENT_RUNTIME_API_KEY}"
      baseURL: "http://host.docker.internal:8000/v1"
      models:
        default: ["support-chat", "topic-brief"]
        fetch: true
      titleConvo: false
      modelDisplayLabel: "Agent Runtime"
```

Start the server with `--host 0.0.0.0` when LibreChat runs in Docker.
LibreChat shows progress as "thinking". This configuration follows
LibreChat's custom-endpoint format; the repository's tests cover LibreChat's
agent library, not the full application.

## What to try

- **Regenerate** a reply in the front end: it continues the same
  conversation. **Edit an earlier message**: it starts a new branch.
- **Send an image** (support-chat): it is stored once in `./.data/artifacts`,
  however many times the front end resends it.
- **Restart the server** mid-conversation: the next turn still logs
  `"ledger":"hit"`.
- **Stream both branches**: an in-scope question streams as it is written,
  because the redirect branch is provably skipped; a question about the
  weather takes the redirect branch, which streams too, because no step
  follows it.
- **Check without serving**: `npx agent-runtime serve --check` validates both
  manifests and the configuration, runs preflight, and prints a summary. It
  needs the same keys as serving (add `--runtime-module scripted-model.mjs`
  to check without a provider key).

## Files

| File                                                   | Purpose                                              |
| ------------------------------------------------------ | ---------------------------------------------------- |
| [agent-runtime.server.yaml](agent-runtime.server.yaml) | server configuration, found automatically by `serve` |
| [production.server.yaml](production.server.yaml)       | a production-style configuration for the same agents |
| [agent-runtime.config.yaml](agent-runtime.config.yaml) | runtime configuration: OpenAI and message signing    |
| [ollama.config.yaml](ollama.config.yaml)               | the same profiles with a local Ollama model          |
| [support-chat.agent.yaml](support-chat.agent.yaml)     | conversational agent with a screening step           |
| [brief.agent.yaml](brief.agent.yaml)                   | single-shot agent filled from the newest message     |
| [scripted-model.mjs](scripted-model.mjs)               | a model stand-in for trying the server offline       |
| [chat.mjs](chat.mjs)                                   | a dependency-free streaming terminal chat            |
| [serving.test.mjs](serving.test.mjs)                   | runs this walkthrough as part of `npm test`          |

See [Serve agents over an OpenAI-compatible API](../../docs/serving.md) for
every option.
