# Porting notes

Conventions used when porting a TypeScript package to this Python package.

## Data and APIs

- Contract data (manifests, events, checkpoints, records, model requests and
  results, tool calls, step results) stays **JSON dictionaries with camelCase
  keys**, built in the same key order as the TypeScript object literal.
- Python APIs are snake_case: classes, functions, methods, keyword arguments.
  Ports are `Protocol`s with snake_case methods (`load_run`, `execute_tool`).
- Objects that carry functions (step execution context, history context, tool
  execution context) are dataclasses with snake_case attributes.
- JavaScript `undefined` as a _value_ (a missing output, a missing property in a
  condition) is `clearideas_agent_runtime._js.ops.UNDEFINED`; a missing key is
  an absent key, never `None`.
- JavaScript truthiness differs for `{}` and `[]` (truthy in JavaScript). Port
  `x ? {...} : {}` on objects/arrays as `is not None`.

## Host code

The showcase's `host.py` files (`examples/showcase/demos/*/host.py`) are
complete host integrations next to their TypeScript originals. Conventions
they follow:

- Import from the top-level package, as TypeScript hosts import from
  `@clearideas/agent-runtime`; for example `AgentRuntime`, `compose_runtime`,
  `FileRunStore`, and `AbortController` all come from
  `clearideas_agent_runtime`.
- Options objects become dataclasses or keyword arguments:
  `ValueResolutionContext`, `ComposeRuntimeOptions`, and
  `WorkspaceCompositionOptions` for `compose_runtime`; keyword arguments for
  `AgentRuntime(run_store=..., step_executors=[...])` and
  `runtime.run(manifest=..., run_id=..., signal=...)`.
- Host hooks receive every argument the runtime passes (JavaScript callbacks
  may ignore trailing ones): `authorize_command(request, context)`,
  `authorize_tool(request, context)`, `authorize_sandbox(request)`,
  `authorize_workspace(request)`.
- Adapters are objects with snake_case methods (`request_approval`,
  `execute_tool`, `summarize(request, next)`, event sinks' `emit`); an
  optional method is absent, or `None` (`stream = None` means non-streaming).

## JavaScript semantics (`clearideas_agent_runtime._js`)

| Need                                                   | Module            |
| ------------------------------------------------------ | ----------------- |
| `JSON.stringify`, `JSON.parse`, byte lengths, RFC 8785 | `_js.json`        |
| UTF-16 `length`/`slice`, `trim`, `toLowerCase`         | `_js.strings`     |
| `Error`/`TypeError` with `name`, `error.message`       | `_js.errors`      |
| `AbortController`/`AbortSignal`                        | `_js.abort`       |
| `toISOString`, `Date.parse`, `Date.now`                | `_js.time`        |
| `localeCompare` (ICU)                                  | `_js.collation`   |
| YAML 1.2 (`yaml` package)                              | `_js.yaml`        |
| WHATWG `URL`, `net.isIP`                               | `_js.url`         |
| `atob`/`btoa`/base64url                                | `_js.base64`      |
| JS operators and coercion                              | `_js.ops`         |
| JS `\s` in regular expressions                         | `_js.regex.WS`    |
| V8 `JSON.parse` syntax-error messages                  | `_js.json_syntax` |

Use `[0-9]` instead of `\d` in ported regular expressions (JavaScript `\d` is ASCII).

## Tests

- Each vitest file is ported to pytest with the same test names (snake_case)
  under `tests/<package>/`.
- Cross-language tests live in `tests/interop/`. `interop/oracle.mjs` evaluates
  inputs with the built TypeScript packages; `interop/driver.mjs` and
  `tests/interop/driver.py` run whole scenarios and report every observable
  output, which must be byte-identical.
- `make interop` runs `tests/interop` against the current TypeScript runtime.
  `AGENT_RUNTIME_TEST_PYTHON_INTEROP=1 npm test` adds it to the npm test runner
  when `python/.venv` exists. CI runs the Python unit suite with `make test`;
  the interop gate remains separate until the 0.10 durability behavior is ported.
- Known, documented differences are listed in README.md ("Known differences").

## Dependencies

| TypeScript                  | Python                            | Translation layer                                                                                                                                  |
| --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai` (AI SDK) + `@ai-sdk/*` | `pydantic-ai-slim` (pinned minor) | `models/pydantic_ai.py`, `models/provider_options.py`, `models/ai_sdk/`                                                                            |
| `zod`                       | `pydantic`                        | `contracts/_zod.py` (Zod 4 issue codes, messages, output key order)                                                                                |
| `jexl`                      | `pyjexl-extended`                 | `conditions/jexl_parser.py` (jexl's lexer and parser, its error messages), `conditions/jexl.py` (JavaScript operators, truthiness, missing values) |
| `yaml`                      | `ruamel.yaml`                     | `_js/yaml.py` (YAML 1.2 core schema)                                                                                                               |
| `localeCompare` (ICU)       | `pyicu-wheels`                    | `_js/collation.py`                                                                                                                                 |
| `@modelcontextprotocol/sdk` | `mcp`                             | `config/mcp_tools.py`                                                                                                                              |
| `better-sqlite3`            | `sqlite3` (stdlib)                | `stores/sqlite.py`                                                                                                                                 |
| `node:crypto`               | `cryptography`                    | `core/signing`, `execution/secure_invocation.py`                                                                                                   |
| `@opentelemetry/api`        | `opentelemetry-api`               | `telemetry.py`                                                                                                                                     |

## Model layer

When porting or updating provider behaviour, keep the three layers apart:

- Request shape: `models/pydantic_ai.py` (messages, settings, output modes),
  `models/provider_options.py` (one handler per supported AI SDK option), and
  the per-provider model subclasses (`openai.py`, `cohere.py`, `groq.py`,
  `google.py`, `responses_input.py`).
- Response interpretation: `models/ai_sdk/<provider>.py` ports the AI SDK
  provider's `doGenerate`/`doStream` for the parts a runtime request can
  produce; `models/ai_sdk/core.py` ports AI SDK Core and the adapter's result
  assembly; `models/ai_sdk/shape.py` reproduces the key order and stripping of
  the Zod schemas whose parsed values reach results (`raw` usage, logprobs).
- Errors and retries: `models/ai_sdk/errors.py`.

After upgrading `ai`/`@ai-sdk/*` or `pydantic-ai-slim`, run
`uv run python -m tests.interop.wire_diff` (from `python/`) and follow any
difference back to the provider code.

## Type checking

`make typecheck` (pyright, standard mode) is clean. Two exceptions are
deliberate: the schema modules (`contracts/schemas.py`, `config/schema.py`)
use Zod-style call annotations that pyright cannot read, and the Optional
narrowing rules are off because contract-validated values are used the way
TypeScript uses non-null assertions. Remaining single-line suppressions are
`# pyright: ignore[rule]` comments on the line.
