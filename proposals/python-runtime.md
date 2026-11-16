# Proposal: Python runtime with TypeScript parity

Status: implemented in `python/` (phases 1–6, except the Modal compute
launcher below). Decisions D1–D7 were accepted as recommended, with one
change: the user chose native libraries with small translation layers
(Appendix B/C) over maintaining ports of `jexl`, `zod`, and `yaml`.

Validation showed that byte-identical run records need more than equivalent
requests: the AI SDK's interpretation of provider responses (replay metadata,
raw usage, provider metadata, error messages, retries) reaches transcripts and
run records. The model layer therefore keeps pydantic-ai and the provider SDKs
for requests and HTTP, and adds `models/ai_sdk/`, which reads the recorded raw
responses the way the AI SDK providers do (see `python/README.md`, "Model
layer").

| Area                                                                                                                               | State                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| contracts, core, conditions, steps, stores, models, config, sandbox, sandbox-modal, execution, artifacts, telemetry, agent-runtime | ported with unit tests and interop tests                                                      |
| CLI                                                                                                                                | `validate`, `config validate`, `run`, `run-manifest`, `resume`, `inspect`, `events`, `worker` |
| `execution-modal` (Modal launcher, worker, egress policy)                                                                          | not ported yet                                                                                |
| showcase                                                                                                                           | every demo runs on both runtimes (`server.py`, `host.py`); HTTP suite and parity tests        |
| CLI `serve`, `examples`, `connections`; server; showcase launcher and hosting                                                      | out of scope for this phase                                                                   |
| `npm test`                                                                                                                         | runs `python/tests/interop` as `python-interop` when `python/.venv` exists                    |
| CI                                                                                                                                 | `python` job runs `make test` (lint, pyright, strict pytest) on 3.11 and 3.13                 |
| CI                                                                                                                                 | `showcase-python` job runs `make test-showcase` with bubblewrap and with the fallback         |

Known differences are listed in `python/README.md`. The original proposal
follows unchanged.

### Showcase port: what it found

Porting the showcase (eight demos, about 5,000 lines of host code) exercised
the runtime the way a host application does, and compared both runtimes on
the same pages: the showcase's HTTP tests run against `server.py`, and
`examples/showcase/test/parity.python.ts` runs every demo on both servers and compares the browser
streams, host state, model requests, and stored run records and checkpoints,
after normalizing IDs, times, ports, and measured durations. It found and
fixed:

- **MCP tool results** carried members the server never sent (`isError` and
  `resultType` defaults) and lost members it did send (unknown fields,
  `_meta`, content annotations), because the Python MCP SDK's models
  add defaults and drop extras. Tool results reach model requests and
  transcripts, so Python run records differed from TypeScript's. The adapter
  now keeps the server's reply as sent (`tests/interop/test_mcp_tools.py`
  compares both runtimes against one server).
- **MCP tool calls sent an extra request.** The Python SDK's `call_tool`
  lists the server's tools again before every call (to check structured
  content against output schemas); the TypeScript SDK does not on a new
  connection. Each call now sends exactly the requests TypeScript sends, and
  the interop test compares every JSON-RPC request both runtimes send.
- **Public API surface.** The top-level package exported only
  `create_agent_runtime` and `define_agent`; hosts had to know the internal
  module layout, and `AbortController` (needed to pass a run `signal`) was
  private. It now re-exports every subpackage like `@clearideas/agent-runtime`,
  and `tests/interop/test_api_surface.py` requires a Python counterpart for
  every TypeScript value export (which found the missing `config` schema
  handles and `mcp_tool_digest_pattern`).
- **Message signature verification** raised `AttributeError` for a signature
  that is not an object (a browser-supplied value), where TypeScript reports
  `unknown-key`.
- **The test-only host-process sandbox** named its working directory with
  eight random characters where Node's `mkdtemp` uses six, so command output
  that shows the path (tracebacks) differed in size between runtimes.

Confirmed identical across runtimes: scripted runs of all eight demos
(events, tool results, sandbox command records, sync-back, checkpoints and
resume, approvals and token budgets, code-step artifacts, MCP integrity
checks, execution engines and the worker protocol, context reduction and
summarization, history compaction, and HMAC history signatures byte for
byte), and, in Live mode, the requests both runtimes' OpenAI adapters send
the provider (apart from the documented defaults and JSON member order).
Runs paused on one
runtime resume on the other, and chats continue across them, with one shared
data directory.

## 1. Goal

Add a Python implementation of Agent Runtime to this repository. It should
behave the same as the TypeScript runtime. One manifest must run in either
language and produce the same results, serialized bytes, and hashes.
Cross-language tests that prove this are part of the deliverable.

- `npm run test` continues to pass (baseline: 670/670, see §11).
- `make test` runs the Python suite and the cross-language suite.
- Out of scope for now: the OpenAI-compatible server (`packages/server`,
  `agent-runtime serve`), the showcase, the agent-runner and serving examples,
  and the docs site.

## 2. What "parity" means in practice

Model output from a live provider is not deterministic, so parity is defined at
three levels. Each level has its own tests.

| Level                    | Definition                                                                                                                                                                                                                       | How it is tested                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Byte parity**          | The same input gives byte-identical output: parsed manifests, manifest hashes, `RunCheckpoint`, `RunEvent`, `RunResult`, `RunRecord`, messages signatures, MCP tool digests, store files and SQLite rows, validation error text. | Golden scenarios run through a TS driver and a Python driver with a fixed clock, sequential ids, and scripted model, tool, and approval adapters. The normalized outputs must be identical. |
| **State interchange**    | A run started in one language can be resumed in the other from the same file or SQLite store. Encrypted worker envelopes and message signatures produced by one language verify in the other.                                    | Cross-resume scenarios in both directions: suspend (approval, budget, pause), then resume. Seal/open and sign/verify vectors in both directions.                                            |
| **Provider-wire parity** | For a given `ModelRequest`, the Python adapter sends an equivalent provider request to the AI SDK adapter: same messages, tools, tool choice, structured output, and `providerOptions` effect.                                   | A local mock HTTP provider records requests from both adapters for a fixed scenario set. Documented known differences are allow-listed.                                                     |

Live-model runs are smoke-tested only. They are never compared for equality.

## 3. Scope

In-scope TypeScript: about **29.8k source lines and 24.2k test lines** (about
570 tests). Add about 600 lines of `server/src/host.ts`, the host composition
the CLI uses (no HTTP). The Python package lives in `python/` and mirrors the
TS package boundaries as subpackages:

| TS package              | Src lines | Tests | Python module              | Notes                                                                                                                    |
| ----------------------- | --------: | ----: | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `contracts`             |      2052 |    40 | `contracts`                | pydantic models + `zodcompat` layer (§5.2, App. B). Error messages reach run errors, so they must match.                 |
| `core`                  |      4992 |    98 | `core`                     | Engine, state, templates, execution plan, policies, messages (signing, compaction planning), ports, testing utilities.   |
| `step-prompt`           |      4599 |    99 | `steps.prompt`             | Largest behavioral surface: tool loop, context reduction, summarizer journals, recovery.                                 |
| `step-standard`         |      1084 |    24 | `steps.standard`           | Approval, webhook (httpx), code, sub-run.                                                                                |
| `step-loop`             |       424 |     7 | `steps.loop`               |                                                                                                                          |
| `condition-jexl`        |        82 |     4 | `conditions.jexl`          | `pyjexl-extended` + JS-semantics shim (§5.4, App. C).                                                                    |
| `model-ai-sdk`          |      1031 |    38 | `models.pydantic_ai`       | Adapter over pydantic-ai's model layer (§4), plus a translation layer for AI SDK `providerOptions`.                      |
| `runtime` (config)      |      3220 |    46 | `config`                   | Config schema, providers, MCP tools and integrity digests, workspace tools, composition.                                 |
| `sandbox`               |      3663 |    42 | `sandbox`                  | Policy, run sandbox, Docker, bubblewrap, host-process test provider. Reuses the existing `agent-fs.py` helper unchanged. |
| `sandbox-modal`         |       129 |     1 | `sandbox.modal`            | Gateway interface only. No Modal SDK dependency, same as TS.                                                             |
| `artifacts`             |       319 |     2 | `artifacts`                |                                                                                                                          |
| `execution`             |      2155 |    44 | `execution`                | In-process, child-process, and remote engines; worker protocol; AES-256-GCM envelopes (`cryptography`).                  |
| `execution-modal`       |      1740 |    19 | `execution.modal`          | Launcher and egress policy. Gateway interface only.                                                                      |
| `store-local`           |      1607 |    37 | `stores.local`             | Same on-disk layout, so TS and Python share a store directory.                                                           |
| `store-sqlite`          |       511 |     6 | `stores.sqlite`            | stdlib `sqlite3`, same schema, so TS and Python share a database.                                                        |
| `telemetry-otel`        |       583 |     7 | `telemetry.otel`           | `opentelemetry-api`, same span names and attributes.                                                                     |
| `agent-runtime`         |       106 |    15 | top-level package          | `create_agent_runtime`, `define_agent`.                                                                                  |
| `cli` (without `serve`) |      1670 |    40 | `cli` (`agent-runtime-py`) | Needs the non-HTTP part of `server/src/host.ts`. `--runtime-module` loads a local `.py` file instead of a `.js` file.    |
| `server` (except host)  |         — |     — | —                          | **Out of scope.**                                                                                                        |

## 4. Model layer: AI SDK replacement

The TS adapter makes **one model turn per call** with `generateText` or
`streamText`. Tools are advertised without `execute`, because Agent Runtime
owns tool execution, retries, checkpoints, and the loop. The adapter uses
`Output.object(jsonSchema)` for structured output, passes `providerOptions`
through, and turns `response.messages` into replayable transcript items.
Replay metadata such as OpenAI `itemId`/`reasoningEncryptedContent` and
Anthropic `signature` is stored in `providerOptions` on content parts.
Seven drivers are supported: openai, anthropic, google, xai, groq, cohere,
openai-compatible.

So the Python dependency only needs a **provider-neutral single-turn request
API**. An agent framework is not needed.

### Options evaluated (package contents inspected, not just READMEs)

| Criterion                      | `vercel-ai-sdk` (vercel-labs/ai-python)                                                 | `pydantic-ai-slim` (pydantic/pydantic-ai)                                                                    | Official provider SDKs directly                          |
| ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Maturity                       | `0.0.1.dev10`. README: "experimental… not guaranteed to be maintained".                 | 2.66.0, 351 releases since 2024, 46 in the last 90 days.                                                     | Mature.                                                  |
| Last release                   | 2026-04-13 (7 months ago)                                                               | 2026-11-04                                                                                                   | Current                                                  |
| Providers vs our 7 drivers     | openai, anthropic, Vercel gateway only (**3 of 7** missing + google, groq, cohere, xai) | openai (Chat + Responses), anthropic, google, groq, cohere, xai, OpenAI-compatible via base URL (**7 of 7**) | 7 of 7, written by us                                    |
| Single-turn API without a loop | `ai.stream`/`ai.generate`                                                               | `pydantic_ai.direct.model_request` / `model_request_stream`, `ModelRequestParameters(function_tools=…)`      | Yes                                                      |
| Tool choice, structured output | Partial                                                                                 | `tool_choice` setting; native or tool-based structured output                                                | Yes                                                      |
| Replay metadata                | Minimal                                                                                 | `ThinkingPart.signature/id/provider_details`, `TextPart.id`, `provider_details`                              | Full                                                     |
| `providerOptions` vocabulary   | Passed through only to the gateway                                                      | Own vocabulary (`openai_reasoning_effort`, …), so we translate                                               | We implement the AI SDK mapping ourselves                |
| Effort for us                  | High: fill in 4 providers, plus instability risk                                        | Medium: about 1.2k-line adapter plus a translation layer                                                     | Very high: AI SDK provider code is about 37k lines of JS |

**Recommendation: `pydantic-ai-slim`, model layer only** (`direct` API and
`Model.request` / `request_stream`), behind our `ModelAdapter` port. Extras:
`openai, anthropic, google, groq, cohere, xai`. Its release pace is high, so
pin a compatible range and keep it confined to one module.
`vercel-ai-sdk` is not viable now. It covers 3 of the 7 drivers, and its own
README says it is experimental and unmaintained. Re-evaluate it if it
stabilizes.

### AI SDK-specific behaviors the adapter must reproduce

1. **`providerOptions` translation.** Manifests and config profiles carry AI
   SDK `providerOptions` (e.g. `openai: { reasoningEffort: low }`). This is
   part of the manifest contract (`docs/manifests.md`). Plan:
   - An explicit per-provider mapping table to pydantic-ai `ModelSettings` for
     the documented options.
   - OpenAI-family leftovers go to `extra_body` with camelCase → snake_case.
   - Anything else is a clear error naming the unsupported option, never
     silently dropped.
     This is the main known **parity gap by construction**. It will be documented
     as a supported-options matrix.
2. **Replay metadata in both directions.** AI SDK `providerOptions` on
   transcript parts ↔ pydantic-ai parts, so a checkpoint written mid tool loop
   by TS resumes in Python and vice versa.
3. **Error shape.** Step-prompt classifies provider errors by `statusCode`,
   `isRetryable`, `responseBody`, and a context-overflow regex. The adapter
   normalizes pydantic-ai errors (`ModelHTTPError` etc.) to those fields.
4. **SDK-level retries.** The AI SDK retries twice by default inside one model
   call. The Python adapter configures the same count. Backoff timing can
   differ; the runtime's own `modelRetry` policy is unaffected.
5. **Invalid tool calls.** Unknown tool names and unparsable input are marked
   `metadata.agentRuntime.invalid`, as the AI SDK does.

## 5. Parity hazards found (each verified by running code)

Most parity issues come from JavaScript language behavior, not from the
runtime logic. Each item below becomes a shared utility with conformance
vectors.

### 5.1 Manifest hash ordering depends on the host locale (TS behavior)

`defaultManifestHasher` sorts object keys with `String.prototype.localeCompare`
(ICU collation, host locale), not by code point:

- Node, en-US: `["_x","-y","10","9","a","A","ä","alpha","b","B","x_","z","Zeta"]`
- Node, sv-SE: same, except `"ä"` sorts **last**.
- Plain code-point sort: `["-y","10","9","A","B","Zeta","_x","a",…]`

So the **TS hash already differs between hosts** with different locales when
keys contain non-ASCII characters. Python cannot match "whatever the host
locale is". Feasibility check: a pure-Python Unicode Collation Algorithm
(`pyuca`) reproduced Node's en-US order **exactly on 2,341 generated keys**,
including accented, CJK, Turkish, and punctuation keys. The chosen package is
`pyicu-wheels`, which bundles the same ICU version as Node 22 (Appendix C). See
decision D2.

Messages signatures use RFC 8785 (`canonicalJson`, code-unit order), which
ports exactly.

### 5.2 Zod output is re-ordered to match the schema

`parseAgentManifest` returns keys in **schema declaration order**, not input
order. Step `{type, prompt, id}` becomes `{id, type, prompt}`. The hash,
checkpoints, and `JSON.stringify`-based fingerprints all see that order. Zod's
default messages ("Invalid input: expected string, received number",
"Unrecognized key…") reach `MANIFEST_INVALID` and messages errors.

Decision (revised in review, see Appendix B): contracts are **pydantic
models** with a thin **`zodcompat`** layer (about 220 lines). The layer
reports errors as Zod issues (code, path, message), emits output in Zod's
order, and applies Zod's rules for unions, refinements, and numbers. Data
still crosses module boundaries as plain `dict`/`list` JSON values.

### 5.3 JavaScript JSON and string behavior

- **Object key order:** JS lists integer-like keys first in ascending order
  (`{"b":1,"2":2,"a":3}` → `{"2":2,"b":1,"a":3}`). Python dicts keep
  insertion order. This matters for `JSON.stringify` output, `Object.keys`,
  and `Object.entries`.
- **Number formatting:** JS prints `1.0` → `1`, `5e-7` → `5e-7`,
  `1e21` → `1e+21`, `-0` → `0`. Python prints `1.0`, `5e-07`, `-0.0`.
  Integers above 2^53 need defined handling.
- **`undefined` vs absent:** JS omits `undefined` members. Python must never
  emit `None` for an absent optional field.
- **UTF-16 lengths:** `text.length` and `slice` count UTF-16 code units.
  `"😀".length` is 2 in JS and 1 in Python. Prune markers print
  "omitted N characters", and head/tail clipping avoids splitting surrogate
  pairs. Both need UTF-16-aware helpers.
- `JSON.stringify` is used as an **identity/fingerprint** input: the
  idempotency key `sha256(JSON.stringify(request))`, summarizer journals, and
  transcript fingerprints. So the serializer must match byte for byte.
- `toISOString()` format: `YYYY-MM-DDTHH:mm:ss.sssZ`.

All of this goes into one `jsjson`/`jsstr` utility module with fuzzed
conformance tests against Node.

### 5.4 JEXL conditions use JavaScript semantics

jexl 2.3 evaluates with JS operators: `"9" == 9` → `true`, `[] == false` →
`true`, `1 + "a"` → `"1a"`, `0.1 + 0.2` → `0.30000000000000004`. Then
`Boolean(result)`. `pyjexl` (last release 2021) uses Python semantics, so
it does not match as-is. Plan (revised in review, see Appendices B and C):
`pyjexl-extended` (the maintained fork) configured through its public operator API, plus a small evaluator subclass
for jexl 2 property access and filters (about 60 lines over the shared
`jsops` module).

### 5.5 YAML must follow YAML 1.2 the way the `yaml` package does

Input `a: yes, b: on, c: 0o17, d: 010, e: 1_000, f: 1.0, g: 2001-12-14, h: .inf`:

| Parser                       | Differences from the TS `yaml` package                                       |
| ---------------------------- | ---------------------------------------------------------------------------- |
| PyYAML (YAML 1.1)            | 6 of 8 differ (`yes`/`on` → bool, `010` → 8, `1_000` → 1000, date object, …) |
| ruamel.yaml, `version=(1,2)` | 2 of 8 differ (`1_000`, date object)                                         |

Plan: ruamel.yaml with a custom YAML 1.2 core-schema resolver (no underscores,
no timestamps), checked against a YAML conformance corpus parsed by both sides.

### 5.6 Other items

- JS regex vs Python `re`: e.g. `\b` and `\w` are ASCII-only in JS (`u` flag)
  but Unicode in Python. Each regex is translated and tested individually.
- Case-insensitive variable lookup uses `toLowerCase()`. Python `lower()`
  matches it for the cases checked; this stays on the vector list.
- **Parallel waves:** event interleaving depends on the JS event loop versus
  asyncio. Committed state, checkpoints, and results must be byte-identical;
  events inside a parallel wave are compared as per-step sequences plus the
  sequence-number set. Sequential execution compares the full stream exactly.
- Cancellation: `AbortSignal`/`reason` semantics (a suspension error used as
  an abort reason) get a small `AbortController`/`AbortSignal` equivalent
  over asyncio.

## 6. Dependencies

Core, always installed. Each choice was measured against the TS library it
replaces (Appendices B and C).

| Need                                       | Python choice                                      | Replaces                                      | Parity evidence                              |
| ------------------------------------------ | -------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| Schema validation                          | `pydantic` v2 + `zodcompat` layer (~220 lines)     | `zod`                                         | 99.90% of 4,002 manifests (App. B)           |
| JEXL conditions                            | `pyjexl-extended` + JS-semantics shim (~180 lines) | `jexl`                                        | 19,728 / 19,729 expressions (App. C)         |
| YAML 1.2                                   | `ruamel.yaml` + core-schema resolver (~25 lines)   | `yaml`                                        | 133 / 140 documents, all real files (App. C) |
| Canonical JSON (message signatures)        | `rfc8785`                                          | `canonicalJson`                               | 3,000 / 3,000 fuzzed values (App. C)         |
| `JSON.stringify` (hashes, stores)          | `rfc8785` for scalars + ~15-line walker            | `JSON.stringify`                              | 3,000 / 3,000 fuzzed values (App. C)         |
| Collation for the manifest hash            | `pyicu-wheels` (ICU 77.1, same as Node 22)         | ICU `localeCompare`                           | 4,691 / 4,691 keys (App. C)                  |
| URL parsing (`new URL`, `z.url()`)         | `ada-url` (the parser inside Node)                 | WHATWG `URL`                                  | 48 / 48 URLs (App. C)                        |
| IP checks (`isIP`)                         | stdlib `ipaddress`                                 | `node:net`                                    | 17 / 17 (App. C)                             |
| AES-256-GCM                                | `cryptography`                                     | `node:crypto`                                 | Standard algorithm                           |
| HTTP (webhook step)                        | `httpx`                                            | `fetch`                                       | Already used by pydantic-ai                  |
| SHA-256, HMAC, SQLite, subprocess, asyncio | stdlib                                             | `node:crypto`, `node:sqlite`, `child_process` |                                              |

Optional extras:

| Extra         | Packages                                                                                      | Replaces                              |
| ------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| `[providers]` | `pydantic-ai-slim[openai,anthropic,google,groq,cohere,xai]`                                   | `ai`, `@ai-sdk/*`                     |
| `[mcp]`       | `mcp` (2.x: streamable HTTP, OAuth client-credentials extension, in-memory transport checked) | `@modelcontextprotocol/sdk`           |
| `[otel]`      | `opentelemetry-api`                                                                           | `@opentelemetry/api` (peer dep in TS) |
| `[all]`       | all of the above                                                                              |                                       |

Dev tooling: `uv` (env and lockfile), `pytest` + `pytest-asyncio`, `ruff`,
`pyright`, and `hypothesis` for serializer fuzzing. Python **≥ 3.11**, tested
on 3.11–3.13; pydantic-ai itself requires ≥ 3.11.

## 7. Python package design

- One distribution with extras, rather than 18 distributions (TS splits
  packages for install size; Python uses extras for that). Subpackages keep
  the TS boundaries, and a boundary check mirrors
  `scripts/check-package-boundaries.mjs`.
- Wire data stays camelCase JSON (`dict`/`list`, `TypedDict`-typed).
  The Python API uses snake_case (`create_agent_runtime`, `AgentRuntime.run`,
  `RunRequest` fields). Adapters and ports are `Protocol`s.
- Async-first (asyncio), like TS, with thin `run_sync` helpers.
- Injectable clock, id generator, and transcript-id generator everywhere TS
  allows them, so scenarios are deterministic.

## 8. Cross-language test plan (part of the final package)

```
interop/
  fixtures/           # shared scenarios: manifest, inputs, scripted model/tool/approval script, expected artifacts
  vectors/            # primitive conformance vectors (JSON, UTF-16, YAML, JEXL, templates, Zod errors, canonical JSON, hashes)
  driver.mjs          # runs a scenario on the built TS packages → normalized JSON
  driver.py           # same on the Python package
```

1. **Primitive vectors**: JSON.stringify and numbers (fuzzed with
   hypothesis → Node), key ordering, UTF-16 ops, canonical JSON, manifest
   hashes, templates, JEXL corpus, YAML corpus, Zod error messages for an
   invalid-manifest corpus, HMAC signatures, MCP digests, path-component hashes.
2. **Scenario parity**: each fixture runs in both drivers. Parsed manifest,
   hash, events, checkpoints, result, and store records must be byte-equal.
   Initial corpus: every manifest in `examples/manifests` and
   `packages/cli/examples`, plus targeted scenarios for context reduction,
   messages and compaction, budgets, loops, sub-runs, `onError`, and parallel
   waves.
3. **Cross-resume**: TS → suspend → Python resume, and the reverse, over the
   file store and SQLite.
4. **Crypto and protocol interchange**: TS seals → Python opens, and the
   reverse. A TS `ChildProcessExecutionEngine` drives a Python worker and the
   reverse (worker protocol).
5. **Provider wire**: mock HTTP provider; compare requests from the AI SDK and
   pydantic-ai adapters (§2).
6. **Test-map completeness**: every in-scope vitest `it(...)` maps to a pytest
   test (`interop/test-map.json`). A check fails when a TS test has no Python
   counterpart, so parity of the unit suites is enforced as well.

Where tests run:

- `make test` (repo root) runs ruff, pyright, pytest, then the interop suite.
  It builds the TS packages first if `dist/` is missing.
- `npm run test`: an `interop` row is added to `scripts/run-tests.mjs`. It runs
  when the Python environment exists and otherwise reports "skipped"
  (decision D4), like the existing python3/bubblewrap gating.
- CI: a Python job in `.github/workflows/ci.yml`.

## 9. Phases

Each phase ends with its ported unit tests and the interop vectors for that
layer passing.

1. **Foundations**: `python/` layout, pyproject, Makefile, CI job; `jsjson`,
   `jsstr`, canonical JSON, hash collation, YAML loader, ISO time, abort
   signal; interop harness plus primitive vectors.
2. **Contracts**: schema engine and all schemas; manifest/messages corpora,
   including error text.
3. **Core, stores, and conditions**: engine, state, templates, plan,
   policies, messages, testing utilities, JEXL, file and SQLite stores. First
   end-to-end scenario parity and cross-resume.
4. **Steps**: prompt (tool loop, context reduction, recovery, history
   compactor), loop, approval, webhook, code, sub-run.
5. **Model and configuration**: pydantic-ai adapter and option translation,
   config schema and providers, MCP tools and integrity, workspace tools,
   sandbox (policy, Docker, bubblewrap), artifacts. Provider-wire tests.
6. **Execution and edges**: execution engines, worker protocol, AES-GCM,
   Modal launcher and egress policy, OpenTelemetry sink, host composition,
   CLI. Cross-language worker tests.
7. **Hardening**: test-map completeness at 100%, supported-options matrix,
   docs page, release metadata.

Expected size: roughly 25–30k lines of Python source and a comparable amount
of tests.

## 10. Decisions needed

| #   | Decision                                 | Recommendation                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Model library                            | `pydantic-ai-slim` model layer (§4).                                                                                                                                                                                                                                                                                                                                                   |
| D2  | Manifest hash key ordering               | Keep today's hash. Make it deterministic with a one-line TS change: `localeCompare(right, "en")`. Verified: identical to the current default on en-US and C/POSIX hosts (so no existing hashes change there), and independent of host locale afterwards. Python implements the same collation. Alternative: a new versioned RFC 8785 hash (`sha256v2:`) that still verifies `sha256:`. |
| D3  | Package and import names                 | Distribution `clearideas-agent-runtime`, import `clearideas_agent_runtime`, CLI `agent-runtime-py`. This mirrors the npm scope and avoids the generic `agent_runtime` name.                                                                                                                                                                                                            |
| D4  | Interop in `npm test`                    | Yes, gated on the Python environment existing (skipped otherwise). `make test` always runs it.                                                                                                                                                                                                                                                                                         |
| D5  | CLI scope                                | Port everything except `serve`, including the host composition from `server/src/host.ts`.                                                                                                                                                                                                                                                                                              |
| D6  | `providerOptions` outside the mapped set | Fail with a clear error (never drop silently). OpenAI-family options pass through `extra_body`.                                                                                                                                                                                                                                                                                        |
| D7  | Minimum Python                           | 3.11.                                                                                                                                                                                                                                                                                                                                                                                  |

## 11. Baseline and repository notes

- `npm ci` fails on a clean checkout. `@clearideas/consent-analytics@0.1.1`
  (used only by `docs` and the showcase) is not on the public npm registry.
  The runtime packages don't need it.
- With the docs workspace excluded and the lockfile honored, the build passes
  and **`npm test` passes 670/670**. In this sandbox, two lockfile versions
  (`@ai-sdk/cohere@4.0.78`, `@ai-sdk/xai@5.0.40`) were missing from the
  registry mirror and were pinned to the nearest available versions for the
  baseline only.
- Installing without the lockfile pulled a newer zod, and the `config` tests
  then failed at import time (`Cannot convert undefined or null to object` in
  `z.enum(WORKSPACE_MODES)`). The lockfile is load-bearing; the Python lockfile
  (`uv.lock`) will be committed for the same reason.

## Appendix A: library evaluation for JEXL and Zod

Question from review: are in-repo implementations of JEXL and Zod needed, or
can existing libraries be used? Every candidate was installed and run against
reference output from the real TS libraries.

### JEXL: 59-expression corpus

The corpus holds the condition patterns from the repo's manifests plus JS
semantics edge cases (loose equality, `+` coercion, truthiness, missing
variables, filters).

| Candidate                      | Result        | Notes                                                                                                                                                                                    |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pyjexl` 0.3.0 (2021)          | **39/59**     | Python semantics. Fails common cases: `missing.deep` raises instead of being `undefined`/false, `score == 9` with `"9"` is false, `!empty` inverts. Depends on `future` (Python 2 shim). |
| Real jexl in `mini-racer` (V8) | 59/59         | Parity by construction. 82 MB native dependency, about 7 ms per evaluation.                                                                                                              |
| Real jexl in `quickjs`         | 59/59         | No wheels for Python ≥ 3.13 or Linux ARM; last release 2023.                                                                                                                             |
| Real jexl in `dukpy`           | fails to load | ES5 engine.                                                                                                                                                                              |
| **In-repo port of jexl 2.3**   | (planned)     | About 800 lines. The target is stable: 2.3.0 is the latest release. The JS operator semantics it needs (`==`, `+`, truthiness) are already required by the JSON layer (§5.3).            |

### Zod: 20-manifest corpus (2 valid, 18 invalid, 23 issues)

| Candidate                                        | Valid output, incl. key order | Error messages                                  | Notes                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON Schema from `z.toJSONSchema` + `jsonschema` | no transforms or reordering   | different                                       | **Refinements are dropped: 7 of 18 invalid manifests accepted** (duplicate step ids, dotted variable keys, step-type policy rules, …).                                                                                                                           |
| `zon` 3.0.1                                      | input order (wrong)           | different                                       | No discriminated union, `lazy`, `superRefine`, `preprocess`, or defaults.                                                                                                                                                                                        |
| `pyzod` 1.0.0                                    | —                             | —                                               | 439 lines; no unions or refinements.                                                                                                                                                                                                                             |
| `pydantic` 2.14 (idiomatic models)               | **2/2 identical**             | **4/20** (only our custom messages), paths 7/20 | Unknown keys reported per key (Zod: one issue per object); union tags inserted into paths; "Field required" without the expected type; `.default()` vs `exclude_unset` conflict. Matching Zod means a translation layer that re-derives Zod's reporting rules.   |
| Real contracts bundle in `mini-racer`            | 20/20                         | 20/20                                           | Parity by construction and stays in sync with TS automatically. But: V8 dependency, about 7 ms per parse, a Node build step is needed to package the Python distribution, and one unexplained hang at interpreter exit in testing (not reproduced).              |
| **In-repo Zod-compatible engine**                | (planned)                     | (planned)                                       | Not a port of Zod: the ~25 combinators used in `contracts` and `runtime/config` plus Zod's 10-case English message table (`zod/v4/locales/en.js`, 125 lines). About 800 lines. Schema definitions must be written in Python with any library, pydantic included. |

### Decision

Superseded by Appendix B: native libraries (`pyjexl`, `pydantic`) with thin
compatibility layers, not in-repo implementations.

## Appendix B: native libraries with compatibility layers

Review asked for native Python libraries with only a small translation layer.
Both layers were prototyped and measured against the real TS libraries, with
Node as the oracle.

### pyjexl + shim

Shared `jsops.py` (~120 lines: JS truthiness, `==`, `+`, relational and
arithmetic coercion, number-to-string; the JSON layer needs it anyway) plus
`jexl_compat.py` (~60 lines). The shim uses pyjexl's public
`add_binary_operator`/`add_unary_operator` and subclasses its `Evaluator` for
jexl 2 lookups: a missing key is `undefined`, a property of an array reads its
first element, relative filters wrap non-arrays, and `?:` uses JS truthiness.

Generated corpus: every operator × 35 operand kinds (literals of each JSON
type, variables of each type, missing paths, filters, unicode), **19,729
expressions**. Compared: the boolean the runtime uses (`ConditionEvaluator`
returns `Boolean(result)`), and whether validation accepts the expression.

| Configuration | Identical           |
| ------------- | ------------------- |
| pyjexl as-is  | 7,199 (36.5%)       |
| pyjexl + shim | **19,727 (99.99%)** |

Known differences, all documented:

- `[1,2][1]`: pyjexl accepts indexing an array literal; jexl 2 rejects it.
- `fn()`: jexl 2 parses function-call syntax and fails at evaluation (no
  functions are registered); pyjexl fails at validation. The run fails in
  both, but Python fails at preflight.
- Syntax-error wording inside `Step X has an invalid when expression: …`
  comes from the parser and differs. Interop tests compare that failure by
  prefix.

Verified on Python 3.11, 3.13, and 3.14 with `DeprecationWarning` as error.
pyjexl has been inactive since 2021; it is pinned, and the interop corpus
guards every upgrade.

### pydantic + zodcompat

`zodcompat.py` (~220 lines) provides:

- `ZodModel`: strict models, unknown keys rejected, output in declaration
  order, defaults emitted.
- Helpers for Zod constructs pydantic can't express directly: `string()`,
  `integer()`, `union()`, `discriminated()`.
- `translate()`: pydantic errors → Zod issues.

It encodes these Zod 4 rules:

- The English message table.
- Unknown keys reported once per object.
- `record` vs `object` wording.
- `.optional()` rejects `null`.
- Union branch selection: one non-aborted branch is reported, otherwise
  `Invalid input`.
- Discriminator errors at `<path>.type`.
- Refinements run unless an aborting issue (`invalid_type`, `invalid_value`,
  `invalid_union`) occurred.
- Every failing check is reported, including the implicit safe-integer bound.
- Length checks still run on arrays after a string type error.

Schemas are ordinary pydantic models; refinements are `refine(cls, data)`
classmethods returning issues.

A slice of `agentManifestSchema` (all step types, model references, policies,
variables, limits, manifest refinements) was modelled and compared on **4,002
generated manifests**: 2 bases plus 1–3 random mutations each (deleted
fields, wrong types, unknown keys, bad enums, bounds, padded/dotted/empty
strings, duplicate ids, prompt-only policies).

| Stage                                | Byte-identical to Zod |
| ------------------------------------ | --------------------- |
| Idiomatic pydantic, first translator | 77.9%                 |
| + rules above                        | **99.90%**            |
| Valid/invalid verdict                | 100%                  |
| Original 20 hand-written cases       | 20/20                 |

The remaining 4 cases involve nested prompt `messages`, which this slice did
not model; they are not translator gaps. The layer depends on pydantic's
documented error `type` codes, and the interop corpus fails if either a
pydantic or a Zod upgrade changes behavior.

### Revised decision

`pyjexl` and `pydantic` are the validation and condition libraries. The only
in-repo code is the two compatibility layers (~400 lines together, of which
`jsops` is shared with the JSON layer). The 19,729-expression and
4,002-manifest corpora become interop vectors.

## Appendix C: maintained packages for everything else

Review asked for more recently maintained alternatives to `pyjexl` (last
release 2021), and whether anything else planned as in-repo code has a
package. The full PyPI index (927,088 projects) was searched, and every
candidate was measured against Node.

### JEXL: `pyjexl-extended`

PyPI has three JEXL packages: `pyjexl` (2021), `tcjexl` (2024, a wrapper of
`pyjexl`), and `pyjexl-extended` (konnektr-io; first release 2025-09, 0.2.6 on
2026-10-06). `pyjexl-extended` is a maintained fork whose base `JEXL` class
targets JS parity: array property access, filter wrapping, and jexl 2
function-call syntax. Its 80+ extra functions live in a separate
`JexlExtended` class, which the runtime does not use.

| 19,729-expression corpus          | Identical           |
| --------------------------------- | ------------------- |
| `pyjexl` 0.3.0 + shim             | 19,727 (99.99%)     |
| `pyjexl-extended` as-is           | 7,886 (40.0%)       |
| `pyjexl-extended` + operator shim | 19,079 (96.7%)      |
| `pyjexl-extended` + full shim     | **19,728 (99.99%)** |

- The remaining gap without the evaluator subclass: jexl 2 has no `null`
  literal (`null` is a missing variable, i.e. `undefined`), and `undefined`
  coerces differently from `null` (`missing < 1` is false).
- The only residual difference is `[1,2][1]`, which pyjexl accepts.
- Caveats:
  - It installs the same top-level module name `pyjexl` (conflicts with
    `pyjexl`).
  - It still depends on `future`, plus `python-dateutil` and `pytz`.
  - It is young and single-organization.
  - The `undefined` and JS-operator behavior is a candidate to contribute
    upstream, given the project's stated JS-parity goal; that would shrink the
    shim.

### Inventory of planned in-repo code

| Planned in-repo code        | Package now                           | Result                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JEXL port                   | `pyjexl-extended` + shim              | See above.                                                                                                                                                                                                                                                                                                                                                                             |
| Zod engine                  | `pydantic` + `zodcompat`              | Appendix B.                                                                                                                                                                                                                                                                                                                                                                            |
| YAML 1.2 resolver           | `ruamel.yaml` (0.19.1, 2026-01)       | With the spec's core-schema regexes as a resolver: 133/140; duplicate keys and multi-document input rejected like TS. Remaining: explicit `!!float`/`!!binary` tags, custom tags (a passthrough hook), `true:`/`null:` keys, complex keys, `%YAML 1.1`. Compared: PyYAML 111, `py-yaml12` 130 (accepts duplicate keys), `yaml-rs` 131 (`1_000` → 1000, multi-doc → list), `ryaml` 128. |
| RFC 8785 canonical JSON     | `rfc8785` (Trail of Bits)             | 3,000/3,000 after converting integers ≥ 2^53−1 to floats, as JS does.                                                                                                                                                                                                                                                                                                                  |
| `JSON.stringify` serializer | `rfc8785` per scalar + 15-line walker | 3,000/3,000, including integer-key ordering.                                                                                                                                                                                                                                                                                                                                           |
| Collation (pyuca, 2017)     | `pyicu-wheels` 2.15.2 (2026-03)       | Bundles ICU 77.1, the version in Node 22. 4,691/4,691 multi-script keys. `icu4py` has no collator; `PyICU` ships no wheels. Alternative: move the TS hash to RFC 8785 order with a versioned prefix, which removes the collation dependency (needs legacy-hash handling).                                                                                                              |
| WHATWG URL checks           | `ada-url` 4.0.0 (2026-07)             | 48/48 vs `new URL()`; parse success equals the `z.url()` verdict 48/48. `pywhatwgurl` also 48/48.                                                                                                                                                                                                                                                                                      |
| `isIP`                      | stdlib `ipaddress`                    | 17/17.                                                                                                                                                                                                                                                                                                                                                                                 |

Still in-repo, because no package fits or because TS itself implements it:

- `jsops` JS coercion helpers (~100 lines; only the JEXL shim uses them,
  and number-to-string now comes from `rfc8785`).
- The sandbox glob matcher (TS's own 25-line rule).
- An `AbortSignal` equivalent over asyncio.
- UTF-16 length and slicing (stdlib codecs).
- `{{ path }}` templates and `providerOptions` translation (runtime logic).
