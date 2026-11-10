---
title: Serve agents over an OpenAI-compatible API
description: Expose agent manifests as OpenAI models, so chat front ends and SDKs can run whole agents through /v1/chat/completions.
---

# Serve agents over an OpenAI-compatible API

`agent-runtime serve` exposes agent manifests as models on an
OpenAI-compatible API. A chat front end such as Open WebUI or LibreChat, or
any OpenAI SDK, sends an ordinary chat completion request; the server turns
it into a validated run, executes the whole manifest, and returns the run's
reply, streamed or not.

```sh
npm install --save-dev @clearideas/agent-runtime-cli
export OPENAI_API_KEY="..."
export AGENT_RUNTIME_API_KEY="a-key-you-choose"
npx agent-runtime serve ./support-chat.agent.yaml --port 8000
```

The model is named after the manifest's `id` (or its file name). Point a
client at `http://127.0.0.1:8000/v1` with the key you chose and select it:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8000/v1",
  apiKey: process.env.AGENT_RUNTIME_API_KEY,
});
const completion = await client.chat.completions.create({
  model: "support-chat",
  messages: [{ role: "user", content: "How do I share a folder?" }],
});
console.log(completion.choices[0].message.content);
```

The server is a host. A request can only choose a model its key may use and
supply its conversation or the variables the operator mapped. It never
supplies a manifest, configuration, tools, or provider options, and every
runtime validation and authorization applies as for any other run.

## Try it locally

The [serving example](https://github.com/clearideas/agent-runtime/tree/main/examples/serving)
is a complete local setup: two agents, a scripted model that needs no
provider account, a streaming terminal chat, and steps for Open WebUI and
LibreChat. From a checkout:

```sh
npm ci && npm run build
cd examples/serving
export AGENT_RUNTIME_API_KEY="choose-a-local-key"
export AGENT_MESSAGES_KEY="hex:$(openssl rand -hex 32)"
npx agent-runtime serve --runtime-module scripted-model.mjs
# In a second terminal, in the same directory, with the same API key:
node chat.mjs
```

Drop `--runtime-module` and set `OPENAI_API_KEY` to use a real model, or add
`--config ollama.config.yaml` for a local one.

## Connect a chat front end

Set the front end's OpenAI base URL to the server's `/v1` address and its
API key to one of the server's keys. Then:

- **Turn off background tasks that use the chat model.** Front ends generate
  titles, tags, and follow-up suggestions by sending extra requests to the
  selected model. With an agent as the model, each one runs the whole agent:
  with Open WebUI's defaults, one user message ran the agent four times and
  the agent's reply became the chat's title. Disable these tasks, or point
  them at an ordinary model.
- **Expect client instructions to be dropped.** A front end's system prompt
  reaches the agent only if the model maps it with
  `clientInstructions: variable:<name>`.
- **Reach the server from containers.** A front end in Docker cannot reach
  `127.0.0.1` on the host. Start the server with `--host 0.0.0.0`
  (authentication stays required) and use
  `http://host.docker.internal:8000/v1`.

### Open WebUI

Start Open WebUI with the server as its OpenAI connection and its
model-driven tasks off:

```sh
OPENAI_API_BASE_URL=http://127.0.0.1:8000/v1 \
OPENAI_API_KEY="$AGENT_RUNTIME_API_KEY" \
ENABLE_OLLAMA_API=false \
ENABLE_TITLE_GENERATION=false \
ENABLE_TAGS_GENERATION=false \
ENABLE_FOLLOW_UP_GENERATION=false \
open-webui serve --port 3000
```

Open WebUI reads these variables on its first start and stores them; change
them later in **Admin Panel → Settings → Connections** and **Interface**,
where you can also choose a separate task model. Progress appears in its
collapsible reasoning section. The tools Open WebUI attaches to each request
are ignored (see [Client tools](#client-tools)).

### LibreChat

Add a custom endpoint to `librechat.yaml`, with the key in LibreChat's
`.env`:

```yaml
endpoints:
  custom:
    - name: "Agent Runtime"
      apiKey: "${AGENT_RUNTIME_API_KEY}"
      baseURL: "http://host.docker.internal:8000/v1"
      models:
        default: ["support-chat"]
        fetch: true
      titleConvo: false
      modelDisplayLabel: "Agent Runtime"
```

LibreChat shows progress as "thinking".

### Tested clients

The server has been exercised with Open WebUI 0.12 (through its API and its
browser chat path), LibreChat's agent framework (`@librechat/agents` 3.9,
including its history replay), and the OpenAI SDKs for Node.js and Python.
In each, every turn after the first continued from the runtime's own
history, and progress appeared as reasoning.

## How a request becomes a run

Each served manifest gets one of two input modes when the server starts:

| Manifest                                              | Mode         | What the run receives                               |
| ----------------------------------------------------- | ------------ | --------------------------------------------------- |
| Declares [`messages`](./conversations.md)             | conversation | the chat as conversation turns                      |
| No `messages`, with an `input` mapping                | variable     | the mapped variables                                |
| No `messages`, exactly one required `string` variable | variable     | that variable, filled with the newest user message  |
| Anything else                                         | —            | the server refuses to start and shows how to map it |

### Conversation mode

The chat becomes the run's conversation history:

| OpenAI input                                    | Becomes                                                   |
| ----------------------------------------------- | --------------------------------------------------------- |
| `user` and `assistant` text                     | conversation turns                                        |
| `image_url` or `file` with a base64 `data:` URL | an image or file reference (see [Media](#media))          |
| `system` and `developer` messages               | dropped, or a declared variable with `clientInstructions` |
| `tool` messages and assistant `tool_calls`      | dropped (see [Client tools](#client-tools))               |
| `file_id`, audio, unlisted media URLs           | refused with 400                                          |

The manifest's own steps decide the reply, as for any run. In this example a
screening step produces a verdict, and one of two conditional steps writes
the final output:

<<< ../examples/serving/support-chat.agent.yaml

### Variable mode

For a manifest without `messages`, map request content to declared
variables:

| Source       | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| `last-user`  | text of the newest user message                                     |
| `transcript` | earlier messages as `user: …` / `assistant: …` text (`maxMessages`) |
| `system`     | text of the client's system and developer messages                  |
| `json`       | a field of the newest user message, parsed as a JSON object (`key`) |
| `client`     | a field of the request's `variables` object (`key`)                 |

```sh
npx agent-runtime serve ./release-brief.agent.yaml \
  --input audience=last-user --input style=client
```

`variables` is an extension field a caller may add to the request body. Only
mapped keys are read. Values are validated against the manifest's
declarations, and a mismatch is a 400.

## Conversations continue from the runtime's history

Chat clients keep their own copy of what they displayed and send all of it
with every request. They never hold what the runtime returns in
`RunResult.messages`: the compaction summary, artifact references, and the
history signature. The server keeps a **conversation ledger** that maps the
conversation a client sends back to the history the runtime issued, so every
turn continues from the runtime's own signed, compacted history:

- a conversation is compacted when it grows past its limits, not on every
  turn;
- an image the client resends every turn is stored once;
- manifests with `requireSignature` work with ordinary clients.

Regenerating a reply finds the same entry; editing an earlier message starts
a new branch. A client that alters an earlier assistant reply is not
recognized, so it can never attach the runtime's signature to altered text.
Conversations are scoped to the API key (and, with `scope.includeUser`, to
the request's `user`), so one key cannot continue another's conversation.

When the ledger does not recognize a conversation, `onUnrecognized` decides:

| Policy     | Behavior                                                                   |
| ---------- | -------------------------------------------------------------------------- |
| `unsigned` | use the client's history, unsigned (default when signatures are optional)  |
| `reject`   | refuse with 409 `conversation_not_recognized` (default when required)      |
| `restart`  | use only the new message; the response sets `x-agent-runtime-conversation` |

Configure [signing keys](./conversations.md#signing) in the runtime
configuration's `messages.signing` section. Without signing, the ledger still
prevents repeated compaction and repeated media storage, but histories are
not verifiable.

## Streaming

Only the reply is ever `delta.content`. Intermediate values, such as a
screening verdict, a classification, or a draft a later step rewrites, are
never streamed as content in the default `auto` mode. For a successfully
completed `auto` or `committed` stream, concatenated content equals the
non-streamed `message.content` and the assistant turn stored in the history.
Custom `output.from` selectors always wait for the committed result, including
with `stream.mode: live`.

A provider failure can be retried before reply text is sent. If a retry is
needed after reply text has already been sent, the stream ends with an
OpenAI-shaped `stream_interrupted` error followed by `[DONE]`, without a
successful finish chunk; the run is stopped. A mismatch between live
text and the committed reply also ends with `stream_interrupted`. Clients
should discard the partial reply and let the user retry. Use `committed` mode
to allow provider retries without exposing partial attempts.

| `stream.mode`    | Behavior                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `auto` (default) | streams the reply as it is written when its step is certain to be the reply; otherwise sends it when the run completes               |
| `live`           | streams a final-output step as it is written, without proving that later steps are skipped; a changed reply ends with a stream error |
| `committed`      | sends the reply only when the run completes                                                                                          |

A step is certain to be the reply when it is a prompt step without
`outputSchema` or tools, and every later step that could add to or replace
the final output is provably skipped: its `when` condition is false for the
variables the step started with, and no step in between changes what the
condition reads. Either branch of the example above streams live; a reply
followed by a step that reviews it is sent when the run completes.

While nothing is being sent, the server writes an SSE comment every 15
seconds (`server.heartbeatMs`), so proxies keep the connection open during
long steps and conversation compaction.

### Progress

Chat Completions has no field for progress. Many OpenAI-compatible servers
send `delta.reasoning_content`, and chat front ends show it as collapsible
"thinking". With `stream.progress: status`, the server reports steps, tool
calls, sandbox commands, compaction, and retries there by name only, never
arguments, tool results, variables, or step output. With
`stream.reasoning: answer-step`, it also forwards the answer step's model
reasoning. Both are off by default, so strict clients see only standard
fields. `stream.progressField: reasoning` sends them in a field named
`reasoning` instead.

## Requests and responses

| Parameter                                         | Handling                                                    |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `model`, `messages`, `stream`, `stream_options`   | supported                                                   |
| `user`                                            | recorded; part of the conversation scope with `includeUser` |
| `temperature`, `top_p`, penalties, `seed`, `stop` | ignored: model options belong to the manifest               |
| `max_tokens`, `max_completion_tokens`             | ignored, or the run's token budget with `maxTokens: budget` |
| `response_format`                                 | accepted when it matches what the agent produces            |
| `tools`, `functions`, `tool_choice`               | ignored, or refused with `clientTools: reject`              |
| `n > 1`, `logprobs`, audio                        | refused with 400                                            |

Responses carry `id: chatcmpl-<run id>`, the served model name, a
`system_fingerprint` derived from the runtime version and manifest hash, and
usage summed over every model call in the run. The headers
`x-agent-runtime-run-id` and, for conversations, `x-agent-runtime-turn`
identify the run. `finish_reason` is `stop`, or `length` when the run's token
budget is exhausted.

Errors use the OpenAI shape:

| Status | `code`                                         | Cause                                                      |
| ------ | ---------------------------------------------- | ---------------------------------------------------------- |
| 400    | `invalid_request_error` or a `MESSAGES_*` code | malformed request, refused parameter, invalid input        |
| 401    | `invalid_api_key`                              | missing or wrong key                                       |
| 404    | `model_not_found`                              | unknown model, or one the key may not use                  |
| 409    | `conversation_not_recognized`                  | unverifiable or unrecognized history where one is required |
| 413    | `context_length_exceeded`, `request_too_large` | history, media, or body over its limit                     |
| 429    | `rate_limit_exceeded`                          | concurrency or queue limit; `Retry-After` is set           |
| 500    | `agent_execution_failed`, `agent_no_reply`     | the run failed; the message carries only its error code    |
| 503    | `service_unavailable`                          | shutting down                                              |
| 504    | `timeout`                                      | the request exceeded `requestTimeoutMs`                    |

Set `server.exposeErrors: true` to include run error messages, which can
contain model output or configuration detail.

### Client tools

Tools a client defines are never shown to the agent or executed: the agent's
tools come only from its manifest and the host configuration. Chat front ends
such as Open WebUI attach their own tools to every request, so by default the
server ignores `tools`, `functions`, and `tool_choice`, and drops `tool`
messages and assistant tool calls from the history, keeping any assistant
text. Set a model's `clientTools: reject` (or `--client-tools reject`) to
refuse such requests with 400 instead.

## Media

Inline images and files (`data:` URLs) are stored once per conversation
scope, addressed by content, and reach the runtime as artifact references
that only this server minted for that scope. Remote `url` media is refused
unless `conversations.media.urls` is `allow` with an origin allowlist,
because the server would otherwise fetch or forward URLs a client chose.

## Configuration

`agent-runtime serve` with no arguments reads the first of
`agent-runtime.server.yaml`, `agent-runtime.server.yml`, or
`agent-runtime.server.json` in the working directory; `--server-config`
names another file. A manifest argument selects single-manifest mode and
takes precedence over a discovered file.

A production-style file for the serving example's two agents:

<<< ../examples/serving/production.server.yaml

| Section         | Purpose                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `server`        | address, body size, request timeout, shutdown grace, heartbeats, concurrency, queue, CORS, error detail            |
| `runtimeConfig` | providers, model profiles, connections, workspaces, sandbox, message signing                                       |
| `runtimeModule` | trusted adapters and hooks, including `authenticate` and an authorizing webhook executor                           |
| `store`         | run store (`memory`, `sqlite`, or `module`) and retention                                                          |
| `artifacts`     | directory for stored media                                                                                         |
| `stores`        | key-value stores for the ledger, media index, and retention queue (`memory` or `sqlite`)                           |
| `conversations` | ledger TTL, scope, `match` (`exact` or `user-turns`), `onUnrecognized`, media URL policy                           |
| `auth`          | API keys by environment reference or SHA-256 digest, with model scopes and per-key limits                          |
| `models`        | served name, manifest, input mapping, stream options, budget, policies, `onDisconnect`, `maxTokens`, `clientTools` |

Relative paths resolve against the configuration file. Durations accept
milliseconds or values such as `15s`, `10m`, and `7d`.

A configuration file describes a deployment, so storage it leaves out is
durable: runs, the ledger, and stored media are kept under
`.agent-runtime/serve` beside the file and survive restarts. Single-manifest
mode keeps them for the life of the process; to keep them, pass
`--store-driver sqlite --store <path>` for runs and `--ledger sqlite:<path>`
for conversations and their media.

The runtime module is loaded for every request, as the CLI loads it for every
run: `createRuntime(context)` receives the request's manifest and run id, and
`shutdown()` runs when the request ends. Create expensive clients once, at
module scope.

### Command line

```text
agent-runtime serve [<manifest>] [--server-config <file>] [--no-server-config]
  [--config <runtime.yaml>] [--runtime-module <module>]
  [--host 127.0.0.1] [--port 8000] [--api-key-env <VAR>] [--allow-unauthenticated]
  [--max-concurrent-runs <count>] [--request-timeout <ms>] [--warmup] [--check]

Single-manifest mode only:
  [--served-model-name <name>] [--input <variable>=<source>]...
  [--output <final|step:id|variable:name>] [--stream-mode <auto|live|committed>]
  [--progress <none|status>] [--client-tools <ignore|reject>]
  [--store-driver <memory|sqlite>] [--store <path>] [--ledger <memory|sqlite:path>]
  [--on-unrecognized <unsigned|reject|restart>]
```

Options accept `--name value` or `--name=value`; `--runtime-config` is an
alias of `--config`. With a configuration file, `--config`,
`--runtime-module`, `--host`, `--port`, and the limits override the file.
`--check` validates everything, runs preflight, prints a summary, and exits,
for CI. `--warmup` also runs MCP tool discovery at startup, so pinned tool
metadata is verified before traffic.

## Authentication

API keys are configured as environment references or SHA-256 digests, never
as values, and are compared in constant time. Each key has an `id` (used in
logs and the conversation scope), the models it may use, and optional
concurrency and token limits. A key can list and call only its models; any
other model name returns 404.

When no API keys are configured, `AGENT_RUNTIME_API_KEY` becomes a key for
every model. `--api-key-env <VAR>` adds a key from another variable in either
case. The server refuses to run without authentication on a non-loopback
address unless you set `allowUnauthenticated` or pass
`--allow-unauthenticated`.

A runtime module can export `authenticate(request)` to accept other
credentials, such as a JWT from your identity provider. It returns a
principal with an `id` and optional `models`, `scope`, and limits, or
`undefined` to decline.

## Operations

- **Endpoints:** `/health` and `/version` need no key. `/ready` returns 503
  while the server is shutting down, for load balancers.
- **Admission:** `maxConcurrentRuns` limits runs globally and per key, with a
  bounded queue (`maxQueuedRequests`, `queueTimeoutMs`). Requests beyond it
  receive 429.
- **Disconnects:** a client that disconnects cancels its run
  (`onDisconnect: continue` lets it finish).
- **Shutdown:** on SIGINT or SIGTERM the server stops admitting requests,
  lets active runs finish within `shutdownGraceMs`, then interrupts the rest,
  which stay resumable.
- **Logs:** one JSON line per request on standard error, with the request id,
  key id, model, run id, status, duration, tokens, and ledger outcome.
  Prompts, messages, and outputs are never logged.
- **Retention:** expired conversation-ledger and media-index rows are removed
  in batches of up to 1,000 per namespace during each minute's maintenance
  sweep. This removes stored index/history rows; artifact files require a
  separate host storage policy. Runs are deleted after `store.retention` when
  the run store supports deletion, as the memory and SQLite stores do. The ledger keeps
  conversations for `conversations.ledger.ttl`. Stored media is not yet
  deleted automatically.
- **Scaling:** one process serves many concurrent runs, because agent work
  mostly waits on model calls. The built-in stores are single-node; several
  replicas need shared run, artifact, and ledger stores.

Request deadlines cover body ingestion, queueing, runtime-module setup, and
execution. Timed-out uploads are stopped; the native HTTP transport returns
an error and closes unfinished uploads. Shutdown tracks queued and preparing
requests as well as executing runs, waits for the configured grace period,
then interrupts remaining requests before closing storage. A runtime factory
that finishes after cancellation has its returned resources shut down without
starting a run.

## Embedding

The server package can be mounted in an existing application:

```ts
import {
  AgentServer,
  createFetchHandler,
  listen,
  loadServerConfig,
} from "@clearideas/agent-runtime-server";

const server = await AgentServer.create({
  loaded: await loadServerConfig("./agent-runtime.server.yaml"),
  runtime: { model: myModelAdapter }, // optional adapters supplied in code
});

// node:http
const listening = await listen(server);

// or a Request → Response handler for Hono, Next.js, and similar
const handler = createFetchHandler(server, { basePath: "/agents" });
```
