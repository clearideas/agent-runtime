# Design: OpenAI-compatible agent server

Status: implemented (phases 0 and 1), with the notes below. The user
documentation is [Serve agents over an OpenAI-compatible API](../docs/serving.md).
The rest of this document is the accepted design, kept for its rationale.

## Implementation notes

Where building and testing required a choice the design did not make, or a
change, it is recorded here.

| Design | Implementation |
| --- | --- |
| Client tools are refused with 400 (§3 invariant 5, §8.2). | **Changed after testing with real clients.** Open WebUI's browser chat attaches its own 28 built-in tools to every request, so refusing them made the server unusable with it. Per model, `clientTools: ignore` (the default) drops `tools`, `functions`, `tool_choice`, `tool` messages, and assistant tool calls; `clientTools: reject` keeps the 400. The invariant that matters still holds: client tools are never exposed to the agent or executed, which is tested. |
| Shared host composition extracted from the CLI (§4.2). | It lives in `@clearideas/agent-runtime-server` (`host.ts`), used by `run`, `worker`, and `serve`. `hostRuntimeDependencies` and `composeHostRuntime` replace the two hand-written assemblies in the CLI. The CLI keeps its exported types as aliases. While moving it, a bug was found and fixed: `messages` options exported by a static runtime module (for example a host-enforced `requireSignature`) were silently dropped by the CLI, so forged history was accepted. A regression test covers it. |
| Startup preflight (§4.3). | `AgentRuntime.preflight(manifest)` was added to core. At startup, tool discovery is deferred (tool names are reported as "checked when a request runs") unless `--warmup` is given, so an MCP server being down does not stop startup. |
| Retention hooks (§11). | Optional `RunStore.deleteRun(runId)`, implemented by the memory and SQLite stores. The retention queue is kept in the key-value store, so with SQLite it survives restarts. |
| Which step streams live (§7.4). | The answer step is identified when its executor starts: the server wraps the prompt executor and receives that step's exact input variables, then evaluates each later contributing step's `when` against them. Variables written in between must be known (prompt steps' `outputVariable`), and conditions that read `messages` are never treated as provable. When steps mark `includeInFinalOutput`, later steps that are not marked cannot change the reply and may still run; without it, every later step counts as contributing. |
| Ledger key (§6.4). | The key also includes the served model name, so a conversation belongs to one served model; switching models mid-conversation is handled by `onUnrecognized`. |
| Token budget (§7.2). | When a run suspends on its budget, the response is `finish_reason: "length"` with whatever reply text was already streamed (none for a non-streamed request), and no ledger entry is recorded. |
| Request variables (§5.2). | The `client` source reads an extension field, `variables`, in the request body. |
| `--server-config="./config.yml"` in the original request. | CLI options now accept `--name=value` as well as `--name value`, for every command. With a configuration file, `--config` and `--runtime-module` override the file, as `--host` and `--port` do. |
| Streaming response start. | A streamed response starts when the run emits `run.started`, so errors found while creating the run (invalid or unsigned history, unknown variables) keep their HTTP status instead of arriving inside a 200 stream. |
| Storage defaults (§14, decisions 7 and 8). | Storage a configuration file leaves out is durable: runs and server state in SQLite, and stored media in a directory, under `.agent-runtime/serve` beside the file. Single-manifest mode keeps them for the life of the process (media in a temporary directory); a SQLite ledger there keeps media beside it, so conversations and the media they reference survive restarts together. |
| Runtime module per request (§4.4). | The module is loaded for every request, as the CLI loads it for every run, with `createRunStore` not called: the server owns the run store. |
| Ledger writes. | A failed ledger write is logged and does not fail the request; the reply is still delivered, and the next turn is handled by `onUnrecognized`. |

Client compatibility was verified outside the repository against Open WebUI
0.12.4 (its API path and its browser chat path), `@librechat/agents` 3.9.2
(including `formatAgentMessages` history replay), and the OpenAI SDKs for
Node.js 6.49 and 7.48 and Python 2.29. In each, conversations continued
through the ledger on every turn. LangChain.js `ChatOpenAI.invoke()` with
`streaming: true` did not complete in that environment against any server,
including a canonical mock of the OpenAI streaming format; `stream()` and
non-streaming `invoke()` work.

## 1. Summary

`agent-runtime serve` exposes agent manifests through an OpenAI-compatible
HTTP API. Each served manifest appears as a model on `/v1/models`. A chat
front end or SDK sends an ordinary `/v1/chat/completions` request to that
model with an API key the host issued. The server turns the request into a
validated agent run, executes the whole manifest, and returns its reply as a
chat completion, streamed or not.

```sh
# One manifest
agent-runtime serve ./review.agent.yml --served-model-name document-reviewer \
  --config ./runtime.yml --port 8000

# Several manifests
agent-runtime serve --server-config ./server.yaml
```

The server is a **host**. It decides what runs may use and exposes them over
HTTP. It does not change how the runtime executes a manifest. Everything the
runtime enforces still applies, unchanged:

- validation;
- model, tool, connection, and workspace authorization;
- policies, budgets, and checkpoints;
- conversation signing and compaction.

## 2. Goals and non-goals

Goals:

- Drop-in use by existing OpenAI clients: chat front ends such as Open WebUI
  and LibreChat, and the official SDKs.
- Multi-turn conversations for manifests that declare `messages`. Single-shot
  use for manifests that take variables.
- Production operation:
  - authentication;
  - admission control;
  - timeouts;
  - graceful shutdown;
  - health checks;
  - observability;
  - bounded storage.
- No widening of the host boundary. An HTTP request can never grant a run
  more than the operator configured.
- Embeddable. Applications with their own HTTP server can mount the handler
  without the CLI.

Non-goals:

- Executing client-defined tools (OpenAI `tools`/`functions`).
- A Files, Assistants, Embeddings, or Audio API.
- Passing sampling parameters through to the underlying model provider.
- Changing runtime contracts or execution semantics.

## 3. Trust model and invariants

| Source | Trust |
| --- | --- |
| Server configuration, runtime configuration, runtime/host module, manifest files loaded at startup | Operator-trusted |
| Everything in an HTTP request: body, headers, query | Untrusted |

Invariants. Each one has a regression test.

1. **Manifests come only from the operator.** A request selects a served
   model by name. It can never supply a manifest, manifest path, runtime
   configuration, configuration reference, or module.
2. **API keys are scoped to models.** A key sees and invokes only its models.
   An out-of-scope model returns `404 model_not_found`, so its existence does
   not leak.
3. **A request fills only host-mapped inputs.** Conversation manifests
   receive the converted chat history. Variable manifests receive only the
   variables the operator mapped. Both go through the runtime's own
   validation before a run is created.
4. **Request parameters never become provider options.** Sampling
   parameters are ignored. Model options belong to the manifest and the host
   model policy.
5. **Client tools are never exposed or executed.** By default they are
   dropped from the request, with tool-call history; with
   `clientTools: reject` such a request is refused. (See the implementation
   notes.)
6. **Host ceilings apply last.** Token budget, `enforcedPolicies`, execution
   concurrency, timeouts, and conversation limits can only be lowered by a
   request.
7. **Serve defaults never widen.** Webhook steps run only with a host
   destination authorizer. Approval, sub-run, and sandbox steps run only with
   host adapters. A manifest that needs something the host did not supply
   fails at startup.
8. **Responses contain the reply, usage, and identifiers only.** They never
   contain variables, transcripts, tool arguments, or tool results. Error
   messages are redacted unless the operator enables them.
9. **The host alone sets the signature scope.** `messagesScope` is derived
   from the authenticated principal. A request cannot choose or widen it.
10. **The ledger never launders unsigned history.** Client-held history is
    never presented to the runtime as signed. Only the runtime's own issued
    history carries a signature.
11. **No media fetching by default.** Remote `url` media is rejected unless
    the operator allowlists its origin.
12. **Dependencies point one way.** The server package depends on runtime
    packages. No runtime package depends on the server.

## 4. Architecture

### 4.1 Packages

```
packages/server            @clearideas/agent-runtime-server  (new)
  src/config.ts            server configuration schema and loading
  src/registry.ts          served models: load, validate, preflight, resolve input mode
  src/compose.ts           per-request runtime composition (shared host composition)
  src/auth.ts              API keys, scopes, principal, optional authenticate hook
  src/admission.ts         global and per-key concurrency, bounded queue
  src/ledger/              ConversationLedger interface; memory and sqlite drivers
  src/media.ts             content-addressed ingestion of inline media
  src/openai/schemas.ts    supported request/response subset (zod)
  src/openai/input.ts      request → run input (conversation or variable mode)
  src/openai/output.ts     run result → chat completion; error mapping
  src/openai/stream.ts     run events → SSE chunks
  src/http.ts              node:http server, routing, limits, shutdown
  src/index.ts             createServer(), createRequestHandler(), createFetchHandler()
packages/cli               `serve` command; depends on the server package
```

The HTTP layer uses `node:http` with no framework dependency. The API is six
routes, and SSE needs no library. `zod` is already a dependency. A
fetch-style handler is exported for hosts that use Hono, Next.js, or similar.

### 4.2 Shared host composition

The code that decides what a manifest may use, such as module loading,
adapter validation, configuration composition, and step-executor selection,
must exist once. It serves `run`, `worker`, and `serve`, with an explicit
trust mode:

| Mode | Used by | Webhooks | Request-supplied configuration |
| --- | --- | --- | --- |
| `local-operator` | `run`, `run-manifest`, `resume` | permitted for trusted local manifests | n/a |
| `untrusted-request` | `worker`, `serve` | only with a host `authorizeDestination` | never |

This is a prerequisite refactor of the CLI (§11). It keeps the boundary in
one audited place.

### 4.3 Startup

For each served model the server:

1. loads and parses the manifest;
2. validates it against the runtime configuration;
3. composes the runtime once and runs preflight, which checks executors,
   adapters, conditions, and tool names;
4. determines the input mode (§5.1) and the candidate answer steps (§7.4);
5. optionally runs MCP discovery, so pinned tool metadata is verified before
   traffic (`--warmup`).

Any failure stops startup with an actionable message. `/ready` reports ready
only after every model passes. `serve --check` performs startup and exits,
for CI.

### 4.4 Per-request composition

Each request gets its own `AgentRuntime`. Building one is cheap. Some
composed adapters, notably MCP tool discovery, hold per-instance state that
must not be shared between concurrent runs.

| Dependency | Source |
| --- | --- |
| `runStore` | server-owned store (shared, §8.6) |
| `artifacts` | server-owned artifact store (shared) |
| `model`, `tools`, `workspaces`, `runSandbox`, `messages.signer`, ceilings | `composeRuntime(manifest, runtimeConfig, …)` with the host model policy and tool options |
| `messages.compactor` | `PromptMessageHistoryCompactor` |
| `messages.authorizeArtifact` | approves artifact references minted by the server's media ingestion for this scope (§6.3); denies all others |
| step executors | prompt, loop, code, sub-run, approval; webhook only with a host authorizer |
| `conditionEvaluator` | JEXL |
| `policies`, `enforcedPolicies` | server configuration, then the host module |
| `eventSinks` | the request's stream translator and usage accumulator, plus configured sinks (OTel) |

### 4.5 Request lifecycle

```
request
 → limits (size, content type) → authenticate → resolve model (scoped)
 → parse request (supported subset)
 → build run input
     conversation mode: convert messages → ledger lookup → history + signature + scope
     variable mode:     map messages → variable overrides
 → apply host ceilings
 → admission (concurrency slot or 429)
 → compose runtime → AgentRuntime.run({ manifest, runId, …, signal })
      events → SSE translator (stream) / usage accumulator
 → reply → ledger record (conversation mode)
 → response or final chunk → release slot
```

One `AbortController` per request sets how a run ends:

| Trigger | Abort reason | Run ends |
| --- | --- | --- |
| Client disconnect | default | `cancelled` (operator may choose `onDisconnect: continue`) |
| Request timeout | default | `cancelled`; client receives 504, or an error chunk if streaming |
| Server shutdown | `RunInterruptedError` | `interrupted` (resumable, auditable) |

## 5. Input

### 5.1 Input mode

The input mode is decided per served model at startup:

| Manifest | Mode | Input |
| --- | --- | --- |
| Declares `messages` | **Conversation** | The chat history, as `messages` on the run (§6) |
| No `messages`, explicit `input` mapping | **Variable** | Mapped variables (§5.2) |
| No `messages`, exactly one `requiresOverride` string variable | **Variable** | That variable ← `last-user` |
| Otherwise | — | Startup fails and shows an example `--input` mapping |

### 5.2 Variable mode mappings

| Source | Value |
| --- | --- |
| `last-user` | Text of the final user message |
| `transcript` | Earlier turns rendered as `user: … / assistant: …` text, with an optional `maxMessages` |
| `system` | Concatenated system and developer message text |
| `json` | Final user message parsed as a JSON object. Only the listed keys are used. |
| `client` | The request's `variables` extension object, restricted to an operator allowlist |

The result is an override list. It is validated by the runtime for exact
keys, types, and required variables, exactly as for any other run.

## 6. Conversations

### 6.1 Overview

A conversation manifest receives the chat as real turns. The runtime does
the following:

- validates the history;
- verifies signatures;
- stores inline media;
- compacts the history once per run when it exceeds the declared limits;
- inserts each step's selection of it;
- returns the history with the reply appended, signed when signing is
  configured.

The runtime keeps no session. The server keeps continuity between turns.

### 6.2 Converting OpenAI messages

| OpenAI input | Conversion |
| --- | --- |
| `system`, `developer` messages | Removed. Instructions come from the manifest. With `clientInstructions: variable:<name>`, their text is supplied to a declared string variable instead. |
| `user` / `assistant`, string content | One text part |
| `text` part | `text` |
| `image_url` with a `data:` URL | Ingested by the server (§6.3). Supplied as an artifact reference. |
| `image_url` with an `http(s)` URL | Rejected unless the origin is allowlisted. Then passed as a `url` part. |
| `file` with `file_data` | Ingested like an image, with `name` and `mediaType` |
| `file` with `file_id`, `input_audio` | Rejected |
| `assistant.tool_calls`, `tool`, `function` messages | Dropped (`clientTools: ignore`, default) or rejected (`reject`) |
| `assistant.refusal` | Used as text |
| `name` | Dropped |

The request must end with a `user` message.

### 6.3 Media ingestion

The server stores inline media itself before calling the runtime. It uses
content addressing: the same bytes map to the same artifact reference,
indexed by SHA-256 per scope. The runtime receives references, never bytes.
The server's `authorizeArtifact` accepts exactly the references it minted
for the request's scope. Size is bounded by the configured inline-media
limit. This prevents repeated storage of media that clients resend every
turn. It also keeps cross-scope references out.

### 6.4 The conversation ledger

**Why it is needed.** Chat clients keep their own copy of what they
displayed and resend all of it with every request. They never hold the
runtime's compaction summary, artifact references, or history signature.
Passing the client's copy straight to the runtime on every turn would cause
three problems:

- compaction would repeat on every turn past the limit;
- summarizer cost would grow with the conversation;
- histories could never be verified, so manifests that require signatures
  could not be used at all.

**What it does.** The ledger maps what a client sends back to the history the
runtime issued. A returning conversation then continues from that
signed, compacted history.

**Recording.** After a conversation run completes, the server returns the
reply text `R`: the text of the last message in `RunResult.messages`. It
then stores:

```
key   = H(scope, project(clientMessages + assistant(R)))
value = { history: RunResult.messages, signature: RunResult.messagesSignature,
          scope, runId, model, manifestHash, createdAt, expiresAt }
```

**Lookup.** The client's converted messages are split into two parts:

- `prefix`: up to and including the last `assistant` message;
- `newTurn`: the trailing `user` messages.

| Case | Run input |
| --- | --- |
| Empty `prefix` (first turn) | `newTurn`, unsigned |
| Hit on `H(scope, project(prefix))` | `entry.history + newTurn`, `entry.signature`, same scope |
| Miss | per `onUnrecognized` (below) |

**Projection.** `project()` is the client-visible form of a message list:

- the role;
- text with normalized line endings and trailing whitespace trimmed;
- each media part replaced by the SHA-256 of its bytes, or by its URL.

`H` is SHA-256 over the RFC 8785 canonical JSON of `{ scope, projection }`.

**Properties:**

- **Regenerate** resends the same prefix, so it hits. The new branch is
  recorded under its own key.
- **Editing** an earlier message changes the prefix, so it misses. Entries
  form a tree. Branching needs no extra state.
- **An edited assistant message misses.** A client can never attach the
  runtime's signature to text it changed.
- **Keys include the scope,** so one API key, or one user when the scope
  includes it, can never reach another's conversations.
- **Manifest changes.** Entries record `model` and `manifestHash`.
  `onManifestChange` is `continue` (default) or `restart`.

**Match mode:**

| Mode | Keyed on | Behaviour |
| --- | --- | --- |
| `exact` (default) | the full projection | Robust against forgery. A client that rewrites assistant text misses. |
| `user-turns` | user messages plus the assistant count | Tolerates clients that rewrite assistant text. Always uses the runtime's own assistant text. Genuine edits to assistant text are ignored. |

**When the lookup misses:**

| `onUnrecognized` | Behaviour |
| --- | --- |
| `unsigned` (default when the manifest does not require signatures) | The client history is supplied unsigned. This is the same trust level as any Chat Completions API. |
| `reject` (required when signatures are required) | `409 conversation_not_recognized` |
| `restart` | Only `newTurn` is supplied. The response carries `x-agent-runtime-conversation: restarted`. |

**Storage.** `ConversationLedger` is backed by the key-value layer in §10.9:
`memory` and `sqlite` in phase 1, shared drivers such as Redis in phase 2,
and a module-supplied driver for anything else.

Entries contain conversation content and fall under the same data policy as
run stores. Ledger retention (`ttl`, default 30 days) is independent of run
retention. A replica that cannot reach the ledger degrades to
`onUnrecognized`. It never produces a wrong continuation.

### 6.5 Scope

`messagesScope` = `key:<apiKeyId>`, or `key:<apiKeyId>/user:<user>` when
`scope.includeUser` is set and the request carries `user`. A module
`authenticate` hook may return a principal with its own scope, for example a
tenant.

## 7. Output and streaming

### 7.1 Reply

| Mode | `message.content` |
| --- | --- |
| Conversation | The text of the last message in `RunResult.messages`, which is exactly the run's final output. If the run produces no final output, the server returns `agent_no_reply`. It never sends an empty assistant message, which would corrupt the next turn's history. |
| Variable | `RunResult.output` by default. Optionally `step:<id>` or `variable:<name>`. Non-string values are serialized as JSON. |

The manifest's own logic decides the reply. A typical pattern:

- a moderation step produces JSON;
- conditional steps for the allowed and refused cases each emit final
  output;
- the branch that runs is the reply.

The server never selects or rewrites the reply in conversation mode. Doing so
would break ledger matching and signatures.

### 7.2 Response fields

| Field | Value |
| --- | --- |
| `id` | `chatcmpl-<runId>` |
| `model` | served model name |
| `system_fingerprint` | manifest hash prefix and runtime version |
| `usage` | aggregated over every model call in the run, including history summarization: `prompt_tokens`, `completion_tokens`, `total_tokens`, `completion_tokens_details.reasoning_tokens`, `prompt_tokens_details.cached_tokens` |
| `finish_reason` | `stop` on completion. `length` when the run suspends on its token budget. |
| Headers | `x-agent-runtime-run-id`. In conversation mode, also `x-agent-runtime-turn`. |

### 7.3 Streaming protocol

SSE in Chat Completions chunk format:

- a role chunk is sent immediately;
- `delta.content` chunks follow;
- a final chunk carries `finish_reason`;
- a usage chunk follows when `stream_options.include_usage` is set;
- the stream ends with `data: [DONE]`.

SSE comment heartbeats are sent every 15 seconds while nothing is flowing,
for example during history compaction or a non-streamed step. An error after
headers are sent produces a final `data: {"error": …}` event, then `[DONE]`.

### 7.4 What may appear as content

**Only the reply is content.** `delta.content` carries the run's final
output and nothing else. No intermediate step output ever appears there: not
a moderation verdict, not a classification, not a draft a later step
rewrites, not a tool result. A client that concatenates `delta.content`
receives exactly the `message.content` of the non-streamed response, which is
also exactly the assistant turn appended to the conversation history. This
keeps the stream, the response, the stored history, and ledger matching in
agreement.

**Candidate answer steps** are determined at startup: the top-level steps
marked `includeInFinalOutput`, or the last top-level step when none are
marked. At run time the answer step is the candidate whose `step.started`
event arrives. With conditional branches, that is the branch the manifest
chose. Every other step's text deltas are discarded. The progress channel
reports only that such a step ran, never what it produced (§7.5).

| Mode | Behaviour |
| --- | --- |
| `live` | Forwards the answer step's text deltas as the reply is produced. The reply is still the only thing streamed; it is streamed while being written. |
| `committed` | Sends nothing as content until the run completes, then sends the committed reply in chunks. |
| `auto` (default) | `live` when the answer step is a prompt step without `outputSchema` or tools, and nothing after it can still change or replace the reply: later candidates must be mutually exclusive and skipped, and no later top-level step may run. `committed` otherwise, for example when a later step checks the generated reply. |

`committed` guarantees the streamed text equals the final reply. `live`
trades that for first-token latency: if a model call is retried or its output
is repaired after text was sent, the client has already received text that
the final reply does not contain. The final reply is always authoritative,
and a divergence costs a ledger miss on the next turn rather than a wrong
continuation. An operator who wants a strictly deterministic stream sets
`committed`.

### 7.5 Progress on the reasoning channel

The Chat Completions streaming schema defines `delta.role`,
`delta.content`, `delta.refusal`, and `delta.tool_calls`. It has no field for
progress. Reasoning is exposed only in the Responses API, not here.

In practice, an extra `delta.reasoning_content` field is widely used by
OpenAI-compatible servers and is rendered as collapsible "thinking" by chat
front ends. Clients that do not recognize it ignore the unknown field, as do
the official SDKs. The server uses that convention for progress, never for
the reply:

```jsonc
{"choices":[{"delta":{"reasoning_content":"searching documents…"},"index":0}]}
```

Two independent settings, both off by default, so a strict client sees
nothing but specification fields:

| Setting | Emits |
| --- | --- |
| `progress` | Runtime status derived from events: step started and completed (step id or name), tool called and finished (tool name), sandbox command started (command name), history compaction, model retry, approval requested. Names and counts only: never arguments, tool results, variables, or any step output. |
| `reasoning` | The answer step's model reasoning deltas, when the provider produces them. Off by default, because reasoning text is model output that an operator may not want to show. |

`progressField` selects the field name for compatibility:
`reasoning_content` (default) or `reasoning`. Both are outside
`delta.content`.

The `<think>…</think>` convention some clients render is deliberately not
offered. It would place non-reply text inside `delta.content`, breaking the
rule in §7.4 and corrupting the stored assistant turn.

Non-streamed responses never carry progress. The reply stands alone.

## 8. HTTP API

### 8.1 Endpoints

| Endpoint | Phase |
| --- | --- |
| `GET /v1/models`, `GET /v1/models/{id}` | 1 |
| `POST /v1/chat/completions` | 1 |
| `GET /health`, `GET /ready`, `GET /version` | 1 |
| `POST /v1/responses` (`previous_response_id` resolved through the ledger; `store: false` skips recording) | 2 |
| `GET /metrics` (Prometheus, metadata only; separate listener or key) | 2 |
| `POST /v1/completions` (legacy; `prompt` treated as one user message) | 2 |

`/v1/models` lists only models in the key's scope, with
`owned_by: "agent-runtime"` and the manifest description.

### 8.2 Request parameters

| Parameter | Handling |
| --- | --- |
| `model`, `messages`, `stream`, `stream_options` | Supported |
| `user` | Recorded as opaque metadata. Optionally part of the scope. |
| `temperature`, `top_p`, penalties, `seed`, `stop`, `logit_bias` | Accepted and ignored |
| `max_tokens`, `max_completion_tokens` | Ignored by default. Optionally mapped to the run token budget, capped by the host. |
| `response_format` | `text`/`json_object` accepted when the reply is compatible. `json_schema` only when it equals the answer step's `outputSchema`. |
| `tools`, `functions`, `tool_choice`, `parallel_tool_calls` | ignored (default) or 400 with `clientTools: reject` |
| `n > 1`, `logprobs`, audio | 400 |

### 8.3 Errors

Errors use the OpenAI shape `{ "error": { "message", "type", "param",
"code" } }`. Runtime error codes are passed through in `code`.

| Cause | Status | `code` |
| --- | --- | --- |
| Malformed body, unsupported parameter, conversion failure, invalid or missing history (`MESSAGES_INVALID`, `MESSAGES_REQUIRED`, `MESSAGES_NOT_ACCEPTED`, `MESSAGES_MEDIA_UNSUPPORTED`), unauthorized artifact, variable validation failure | 400 | `invalid_request_error` or the runtime code |
| Missing or invalid API key | 401 | `invalid_api_key` |
| Unknown or out-of-scope model | 404 | `model_not_found` |
| Signature required or invalid (`MESSAGES_SIGNATURE_REQUIRED`, `MESSAGES_SIGNATURE_INVALID`), ledger `reject` | 409 | `conversation_not_recognized` |
| Body too large, history over host ceilings (`MESSAGES_LIMIT_EXCEEDED`) | 413 | `context_length_exceeded` |
| Concurrency or queue limit | 429 + `Retry-After` | `rate_limit_exceeded` |
| Run failed | 500 | `agent_execution_failed` (message redacted unless `exposeErrors`) |
| No final output in conversation mode | 500 | `agent_no_reply` |
| Starting or draining | 503 | `service_unavailable` |
| Request timeout | 504 | `timeout` |

## 9. Configuration

### 9.1 CLI

```
agent-runtime serve [<manifest>]
    [--server-config <server.yaml>] [--no-server-config]
    [--served-model-name <name>] [--config <runtime.yaml>] [--runtime-module <host.mjs>]
    [--host 127.0.0.1] [--port 8000] [--api-key-env <VAR>]
    [--input <var>=<source>]... [--output <final|step:id|variable:name>]
    [--stream-mode <auto|live|committed>] [--progress <none|status>]
    [--store-driver <memory|sqlite>] [--store <path>]
    [--ledger <memory|sqlite:path>] [--on-unrecognized <unsigned|reject|restart>]
    [--max-concurrent-runs <n>] [--request-timeout <ms>] [--warmup] [--check]
```

**Finding the server configuration.** `--server-config` is optional. With no
manifest argument and no flag, the server looks beside the working directory
for, in order:

```
agent-runtime.server.yaml
agent-runtime.server.yml
agent-runtime.server.json
```

This matches the CLI's existing discovery of `agent-runtime.config.*` for
runtime configuration, so `agent-runtime serve` alone starts a configured
deployment.

| Invocation | Behaviour |
| --- | --- |
| `serve` | Uses the discovered file. If none exists, it fails and prints the file names it looked for and a single-manifest example. |
| `serve --server-config <file>` | Uses that file. A missing file is an error, never a silent fallback. |
| `serve <manifest>` | Single-manifest mode. An explicit argument beats an ambient file, so a discovered file is ignored and a note says so. `--no-server-config` silences the note. |
| `serve <manifest> --server-config <file>` | Rejected. Choose one source. |

A discovered or named server file may omit `runtimeConfig`; the CLI's normal
runtime-configuration discovery then applies, relative to the server file.
Flags such as `--host`, `--port`, and `--check` override file values in
either form.

- Single-manifest mode builds a one-model server configuration in memory.
  Both forms share one code path.
- `--config` is the runtime configuration, as in every other CLI command.
  `--runtime-config` is accepted as an alias.
- The server binds to `127.0.0.1` by default. Binding to a non-loopback
  address without authentication requires `--allow-unauthenticated`.
- API keys come from environment variables (`--api-key-env`, default
  `AGENT_RUNTIME_API_KEY`), never from command-line values.

### 9.2 Server configuration file

```yaml
version: "1.0"

server:
  host: 0.0.0.0
  port: 8000
  maxRequestBytes: 20971520
  requestTimeoutMs: 600000
  shutdownGraceMs: 30000
  maxConcurrentRuns: 32
  maxQueuedRequests: 64
  cors: { origins: [] }
  exposeErrors: false

runtimeConfig: ./runtime.yml # providers, models, connections, workspaces, sandbox, messages.signing
runtimeModule: ./host.mjs # optional: adapters, authorizeDestination, authenticate, ledger driver

store:
  driver: sqlite # memory | sqlite | module
  path: ./.agent-runtime/serve.sqlite
  retention: { completed: 7d, failed: 30d }

artifacts:
  path: ./.agent-runtime/artifacts

# Shared key-value stores. Phase 2 adds the redis driver.
stores:
  default: { driver: sqlite, path: ./.agent-runtime/state.sqlite }
  # ledger: { driver: redis, url: { env: REDIS_URL }, keyPrefix: "ar:ledger:" }
  # cache:  { driver: redis, url: { env: REDIS_CACHE_URL }, keyPrefix: "ar:cache:" }

conversations:
  ledger: { store: ledger, ttl: 30d }
  scope: { includeUser: false }
  match: exact # exact | user-turns
  onUnrecognized: unsigned # unsigned | reject | restart
  onManifestChange: continue # continue | restart
  media: { urls: reject, allowOrigins: [] }

auth:
  apiKeys:
    - id: webui
      key: { env: WEBUI_API_KEY } # or sha256: "<hex>"
      models: [support-chat, release-brief]
      maxConcurrentRuns: 4
      maxTotalTokensPerRequest: 200000

models:
  - name: support-chat
    manifest: ./support-chat.agent.yaml # declares messages → conversation mode
    description: Customer support assistant.
    clientInstructions: drop # drop | variable:<name>
    stream:
      mode: auto # auto | live | committed
      progress: none # none | status
      reasoning: none # none | answer-step
      progressField: reasoning_content # reasoning_content | reasoning
    budget: { maxTotalTokens: 150000 }
    onDisconnect: cancel

  - name: release-brief
    manifest: ./release-brief.agent.yaml # no messages → variable mode
    input:
      audience: last-user
    output: { from: final }
    execution: { mode: parallel, maxConcurrency: 4 }
    enforcedPolicies: { modelRetry: { maxAttempts: 3 } }
```

Secrets are always environment references or digests, never literal values.
Message-signing keys live in the runtime configuration's `messages.signing`
section. Signing is recommended for conversation manifests. Without it, the
ledger still prevents repeated compaction and media storage, but histories
are not verifiable.

## 10. Operations

### 10.1 Authentication

API keys are compared in constant time against environment references or
SHA-256 digests. Each key carries:

- an `id` used in logs, metrics, and scope;
- its model scopes;
- its limits.

An optional module `authenticate(request)` hook supports OIDC, JWT, or an
upstream gateway, and returns a principal with scopes and limits.

### 10.2 Admission control

Global and per-key concurrency limits, with a bounded FIFO queue. When the
queue is full the server returns 429 with `Retry-After`. In phase 2, request
and token rate limits use usage events.

### 10.3 Limits and timeouts

- request body size;
- header and idle timeouts;
- per-request run timeout;
- SSE heartbeats;
- HTTP keep-alive longer than the load balancer's idle timeout.

### 10.4 Shutdown

On SIGTERM/SIGINT the server:

1. reports not ready;
2. stops accepting requests;
3. lets in-flight runs finish within `shutdownGraceMs`;
4. interrupts the remaining runs;
5. flushes telemetry;
6. closes stores and the ledger;
7. calls the module `shutdown()`.

### 10.5 Observability

- **Logs:** structured JSON access logs with request id, key id, model, run
  id, status, duration, and token counts. Prompts, messages, and outputs are
  never logged.
- **Metrics:** requests, latency, queue wait, active runs, tokens, failures
  by code, ledger hits, misses, and restarts, and stream divergence.
- **Tracing:** OpenTelemetry through the runtime's OTel event sink, with
  inbound `traceparent` propagation.

### 10.6 Persistence and retention

- **Run store:** memory with a TTL, or SQLite for an auditable single-node
  record that `agent-runtime inspect` can read. A module-supplied
  transactional store is needed for multiple replicas.
- **Sweeper:** a server-owned sweeper applies retention to the stores the
  server created.
- **Data policy:** the ledger and artifact store follow the same data policy.

### 10.7 Idempotency

In phase 2, an `Idempotency-Key` header combined with the key id derives a
deterministic run id. A retried request waits for or replays the stored
result instead of re-running side effects.

### 10.8 Scaling

A single process serves many concurrent runs, because agent work is mostly
waiting on model calls. Horizontal scaling needs shared run, artifact, and
ledger stores behind a load balancer. Phase 3 can dispatch runs through the
runtime's `ExecutionEngine` interface, to a child process per run or to
remote compute, without changing the HTTP layer.

### 10.9 Shared state and caching

Several server-owned stores are key-value by nature:

| Store | Contents | Loss of an entry means |
| --- | --- | --- |
| Conversation ledger | Issued history, signature, scope, run id | The next turn is unrecognized and falls back to `onUnrecognized` |
| Media index | Content hash → artifact reference, by scope | The same upload is stored again |
| Idempotency records | Request key → run id and result | A retry re-runs instead of replaying |
| Rate-limit counters | Request and token counts per key | Limits reset early |
| MCP discovery cache | Tool metadata per connection | Discovery repeats on the next run |
| Authentication cache | Key digest → principal | A verification is recomputed |

They share one `KeyValueStore` interface: get, set with TTL, delete, and
optional atomic increment for counters. Drivers are configurable:

| Driver | Phase | Notes |
| --- | --- | --- |
| `memory` | 1 | Single process, bounded by entry count and TTL |
| `sqlite` | 1 | Single node, durable, no extra service |
| `redis` | 2 | Shared across replicas. Recommended for multi-replica deployments. Use a persistent instance for the ledger and idempotency records, and an `allkeys-lru` instance for caches. Supports atomic counters for rate limits. |
| `module` | 2 | Any other store supplied by the host module |

Each store is configured separately, so an operator can put caches in a
shared Redis while the ledger stays in SQLite, or the reverse. The default is
the server's primary driver.

Rules that keep this safe:

- **Correctness never depends on a cache.** Every cached value is
  recomputable. An empty cache costs latency only.
- **Entries that affect behaviour are not caches.** The ledger and
  idempotency records are durable state; their driver must not evict.
- **Keys are namespaced** by server instance identity, store name, and a
  schema version, so an upgrade cannot read a stale shape.
- **Scopes are part of every key** for ledger and media entries, so one key
  or tenant can never read another's.
- **Values are treated as conversation content** for encryption, access, and
  retention, and TTLs are always set.
- **A driver failure degrades, never fails**, for caches; for the ledger it
  follows `onUnrecognized`.

### 10.10 TLS and CORS

- **TLS:** terminated at a proxy by default. `--ssl-certfile` and
  `--ssl-keyfile` are optional.
- **CORS:** off by default, with an explicit origin allowlist.

## 11. Runtime prerequisites

Small, additive runtime changes that support the server:

| Item | Change | Needed |
| --- | --- | --- |
| Shared host composition | Extract the CLI's module loading, adapter validation, composition, and executor selection into one exported path with an explicit trust mode (§4.2). Keep existing CLI exports. | Before phase 1 |
| Public preflight | Expose `AgentRuntime.preflight(manifest)`, the existing check, so the server can fail fast at startup and on `/ready` | Phase 1 (can be emulated) |
| Retention hooks | Optional `RunStore.deleteRun`. Eviction for the in-process execution engine. | Phase 1 (server wraps its own stores); phase 3 (engine) |
| Tool adapter state | Make MCP discovery state call-scoped, or document composed adapters as per-run | Documentation now; fix later |

## 12. Phases

| Phase | Scope |
| --- | --- |
| 0 | Shared host composition, public preflight, package scaffolding (tsconfig reference, changeset group, metadata, tarball, and boundary checks) |
| 1 | Server package; `serve` in both forms with `--check`; `/v1/models` and `/v1/chat/completions` in conversation and variable mode; message conversion and media ingestion; conversation ledger (memory, sqlite); streaming; errors; authentication; admission control; timeouts; shutdown; health; retention; documentation |
| 2 | `/v1/responses`; metrics and tracing; rate limits; idempotency; CORS and TLS; configuration reload; shared key-value drivers (Redis, module) for the ledger, media index, idempotency, counters, and caches; `/v1/completions` |
| 3 | Execution through `ExecutionEngine` (child process, remote); multi-replica reference deployment |

## 13. Test plan

- **Unit:**
  - message conversion (every row of §6.2);
  - variable mappings;
  - projection and ledger keys;
  - reply extraction;
  - usage and `finish_reason` mapping;
  - error mapping;
  - SSE encoding.
- **Invariants:** one test per invariant in §3.
- **Conversations**, using the official `openai` SDK against a running server
  with a scripted model:
  - a multi-turn conversation compacts once rather than on every turn;
  - one stored artifact per unique image;
  - signed continuation with `requireSignature: true`;
  - regenerate hits the ledger and edit misses;
  - an edited assistant message misses;
  - lookups across keys miss;
  - TTL expiry;
  - each `onUnrecognized` policy;
  - an emptied cache changes latency only, never an answer;
  - an evicted ledger entry falls back to `onUnrecognized`.
- **Streaming:**
  - concatenated `delta.content` equals the non-streamed `message.content`
    and the appended assistant turn, in both `live` and `committed` mode;
  - no intermediate step output ever reaches `delta.content`, including a
    moderation verdict, a classification, and a draft a later step rewrites;
  - `auto` streams the conditional branch that runs;
  - `auto` uses `committed` when a later step can run;
  - progress appears only on the reasoning channel, carries names and counts
    only, and is absent by default;
  - heartbeats during compaction;
  - usage chunk;
  - error after headers.
- **Lifecycle:**
  - disconnect cancels;
  - timeout;
  - shutdown interrupts;
  - queue overflow returns 429;
  - retention sweeps.
- **Compatibility:**
  - the runtime's own `openai-compatible` provider driver as a client;
  - manual checks with Open WebUI and LibreChat.

## 14. Decisions for review

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Name of the server configuration flag | `--server-config`, keeping `--config` for the runtime configuration |
| 2 | Default streaming mode | `auto` |
| 3 | Client `system`/`developer` messages | Drop by default. Allow mapping to a declared variable. |
| 4 | `max_tokens` | Ignore by default |
| 5 | Ledger match mode | `exact` |
| 6 | `onUnrecognized` default when signatures are optional | `unsigned` |
| 7 | Default run store | Memory with TTL in single-manifest mode. SQLite with `--server-config`. |
| 8 | Default ledger storage | Memory in single-manifest mode. SQLite for a server configuration file. |
| 9 | HTTP stack | `node:http`, no framework |
| 10 | Discovered server file names | `agent-runtime.server.yaml`, `.yml`, `.json` |
| 11 | Progress on the reasoning channel | Off by default. `reasoning_content` when enabled. |
| 12 | Shared store drivers in phase 2 | Redis, plus a module-supplied driver |
