# Clear Ideas Agent Runtime (Python)

`clearideas-agent-runtime` is the Python implementation of Agent Runtime 1.0.0.
It writes checkpoint contract 1.1 and supports durable run limits, blocked
runs, restart points, workspace commit points, and cross-language resume with
the TypeScript runtime.

## Install

```sh
# from the repository root
make install          # uv sync --all-extras into python/.venv
```

Requires Python 3.11+. Extras:

| Extra       | Adds                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `providers` | `pydantic-ai-slim` provider clients (OpenAI, Anthropic, Google, Mistral, Groq, Cohere, OpenAI-compatible) |
| `mcp`       | configured MCP tools (`mcp` SDK, streamable HTTP)                                                         |
| `otel`      | `OpenTelemetryEventSink`                                                                                  |

## Use

```python
import asyncio
from clearideas_agent_runtime import FileRunStore, create_agent_runtime, define_agent

manifest = define_agent({
    "schemaVersion": "1.0",
    "model": {"provider": "openai", "model": "gpt-5-mini"},
    "steps": [{"id": "answer", "type": "prompt", "prompt": "Say hello", "includeInFinalOutput": True}],
})

async def main() -> None:
    runtime = create_agent_runtime(manifest=manifest, run_store=FileRunStore(".runs"))
    result = await runtime.run({"runId": "hello"})
    print(result["output"])

asyncio.run(main())
```

Like `@clearideas/agent-runtime`, the top-level package re-exports the
public API of every subpackage (`AgentRuntime`, `compose_runtime`,
`FileRunStore`, `PromptStepExecutor`, `AbortController`, …). API parity is
tracked by `tests/interop/test_api_surface.py`. The pydantic-ai adapter
(`PydanticAIModelAdapter`, the counterpart of `AiSdkModelAdapter`) is loaded
on first use, since it needs the `providers` extra.

The [showcase](../examples/showcase/README.md#run-it-on-the-python-runtime)
runs every demo on this runtime too (`npm run start:python` in
`examples/showcase`): its `host.py` files are complete host integrations —
workspaces and sandboxes, approvals and resume, MCP tools, execution engines
and a remote worker, context management, and signed conversations.

The CLI is `agent-runtime-py` and accepts the same arguments as the TypeScript
`agent-runtime` for `validate`, `config validate`, `run`, `run-manifest`, `resume`,
`inspect`, `events`, and `worker`.

## Package map

| TypeScript package                          | Python module                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `@clear-ideas/agent-runtime`                | `clearideas_agent_runtime` (`create_agent_runtime`, `define_agent`)       |
| `contracts`                                 | `contracts` (pydantic models with Zod 4 semantics, identical issues)      |
| `core`                                      | `core` (`AgentRuntime`, hashing, signing, messages, tool policy)          |
| `condition-jexl`                            | `conditions` (jexl's grammar, evaluated by pyjexl with JavaScript rules)  |
| `step-prompt`, `step-loop`, `step-standard` | `steps.prompt`, `steps.loop`, `steps.standard`                            |
| `store-local`, `store-sqlite`               | `stores.local`, `stores.sqlite` (same on-disk/SQLite layout)              |
| `model-ai-sdk`                              | `models` (pydantic-ai adapter; AI SDK `providerOptions` translated)       |
| `runtime`                                   | `config` (host configuration, composition, MCP/composite/workspace tools) |
| `sandbox`, `sandbox-modal`                  | `sandbox` (Docker, bubblewrap, Modal gateway, host test provider)         |
| `execution`                                 | `execution` (in-process, child-process, remote engines; worker protocol)  |
| `artifacts`, `telemetry-otel`, `cli`        | `artifacts`, `telemetry`, `cli`                                           |

Contract data stays JSON dictionaries with camelCase keys; Python APIs are
snake_case. See [PORTING_NOTES.md](PORTING_NOTES.md).

## Model layer

The TypeScript runtime calls providers through the AI SDK; the Python runtime
uses pydantic-ai's model classes and the official provider SDKs for the HTTP
calls, with small translation layers so both runtimes send the same requests
and produce the same `ModelResult`s:

- **Requests.** `models/pydantic_ai.py` maps `ModelRequest`s to pydantic-ai
  messages and settings; `models/provider_options.py` translates AI SDK
  `providerOptions`. Where pydantic-ai builds a request differently from the
  AI SDK provider, a thin subclass changes that mapping only:
  `ResponsesChatModel` (OpenAI/xAI Responses reasoning, `include`, replayed
  assistant items), `CohereChatModel`, `GroqChatModel`, `GoogleChatModel`.
- **Responses.** `models/ai_sdk/` reads the provider's raw response body or
  event stream (recorded by a wrapped HTTP transport) and interprets it the way
  the AI SDK provider does: content parts and their replay metadata, usage
  (including the raw usage object), finish reason, and provider metadata. AI
  SDK Core's tool-call parsing, response messages, and stream accumulation are
  reproduced, so transcripts, usage, and streamed events are identical.
- **Errors and retries.** Failed calls become `AI_APICallError`s with the
  provider's error message, and retryable ones are retried like the AI SDK
  (two retries, exponential back-off honouring `retry-after`), ending in an
  `AI_RetryError`. `JSON.parse` errors carry V8's messages.

Custom pydantic-ai models (without the wrapped transport) fall back to
pydantic-ai's own response mapping.

## Tests

One command sets up dependencies and runs Python lint, type checks, and unit
tests:

```sh
make test
```

It installs uv if needed (a private copy in `python/.bootstrap`), runs
`npm ci` when `node_modules` is missing, rebuilds the TypeScript packages when
a source changed since the last build, syncs `python/.venv` (uv downloads a
suitable Python if necessary), then runs ruff, pyright, the Python runtime
unit tests, and the Python showcase library tests. Node.js 22+ and npm are
the only prerequisites.

The suite is strict: any warning is an error (apart from two deprecations
raised inside third-party packages, listed in `pyproject.toml`), and a test
that would be skipped fails instead, so a green run means every test ran.
`make test STRICT=0` allows skips on a platform without a prerequisite (for
example bubblewrap with unprivileged user namespaces on Linux).

```sh
make check          # full compatibility gate: make test, npm test, showcase parity
make test-showcase  # showcase HTTP and parity tests against server.py
make interop        # cross-language compatibility gate
make typecheck  # only pyright
make clean      # remove python/.venv, python/.bootstrap, and the build stamp
```

Cross-language tests (`tests/interop/`) run the built TypeScript packages
through `interop/oracle.mjs` (function-level), `interop/driver.mjs` (whole
scenarios) and `interop/wire.mjs` (the AI SDK adapter against a mock
provider), and require identical output. They cover contract parsing and
issues, manifest hashes and canonical JSON, JEXL conditions, YAML, scenario
runs (events, records, checkpoints, signatures), cross-language resume,
prompt-context budgeting, host configuration and MCP digests, sandbox policy,
sealed execution envelopes, and the CLI. For the model layer they compare, for
all seven drivers: provider HTTP requests (about 300 cases, including every
supported provider option and replayed history), the complete `ModelResult`
or streamed event sequence, failed calls (error, message, attempts), and
whole manifest runs through the production adapters
(`test_scenarios_providers.py`). `make test` runs them as part of the Python
gate; `python -m
tests.interop.wire_diff [driver] [case]` prints a provider difference.

`make test-showcase` runs the showcase's HTTP test suite against the Python
showcase server and the showcase parity tests: every demo, in scripted mode,
on both runtimes, with the browser streams, host state, and model requests
compared, and paused runs and chats continued across the two runtimes (see
the showcase's [Test](../examples/showcase/README.md#test) section).

## Known differences

- Steps of a parallel wave run concurrently, and JavaScript's microtask
  scheduling interleaves their clock reads and id draws differently from
  asyncio. With an injected deterministic clock, timestamps and ids inside a
  wave can differ; state, outputs, and step results are identical.
- Provider HTTP requests are equivalent but not byte-identical: the Python
  SDKs send some defaults explicitly (`stream: false`, `n: 1`, ...), a few
  fields in another accepted form, and JSON members in another order (the
  order of a tool schema's `properties`, which the model sees, is kept). The list is `KNOWN_DIFFERENCES` in
  `tests/interop/test_provider_wire.py`; model results are identical.
- Response interpretation covers what a runtime request can produce
  (function tools only): text, reasoning, tool calls, refusals, generated
  files, usage, and provider metadata. Results of provider-executed tools
  (web search, code execution, MCP servers) and Gemini's continuation and
  streamed-argument modes are not ported.
- Connection failures report Node's messages for refused connections, failed
  DNS lookups, and resets; other transport errors keep Python's message.
- Host-supplied regular expressions (tool/command patterns) are compiled with
  Python `re`; JavaScript-only syntax is rejected.
- Configured workspace tools call the workspace session directly instead of
  relaying through an in-process MCP server; results are identical.
- MCP tool results are the server's reply as sent, as in TypeScript, but the
  Python MCP SDK validates it first: a reply without `content` (which the
  TypeScript SDK defaults to `[]`) fails the call.
- Not ported yet: `execution-modal` (Modal compute launcher, worker, egress
  policy) and the CLI commands `serve`, `examples`, and `connections`
  (plus the `--stream`/`--show-reasoning` display flags), and the HTTP server
  package. The showcase runs on both runtimes; its launcher and hosted
  deployment remain TypeScript-only.
