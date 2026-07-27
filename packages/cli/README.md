# Clear Ideas Agent Runtime CLI

The `agent-runtime` CLI validates and runs agent manifests, resumes stored
runs, inspects events, and starts worker processes.

```sh
agent-runtime validate ./agent.yaml
agent-runtime config validate ./agent-runtime.config.yaml
agent-runtime run ./agent.yaml --config ./agent-runtime.config.yaml --store ./.agent-runtime
agent-runtime resume run_123 --store ./.agent-runtime
agent-runtime inspect run_123 --store ./.agent-runtime
agent-runtime events ./.agent-runtime/events.jsonl --run run_123 --tail 20
agent-runtime examples list
agent-runtime examples run variables --stream
agent-runtime run ./agent.yaml --store-driver sqlite --store ./.agent-runtime/runs.sqlite
```

`--stream` shows model text on stdout and lifecycle progress on stderr. Use
`--format ndjson` for a machine-readable stream containing event and result
messages, and `--show-reasoning` to opt into reasoning deltas in the pretty
view. The bundled `variables`, `conditions`, and `loops` examples use OpenAI by
default. Use `--config` or `--runtime-module` to change their runtime
configuration.

For a local Gemma 4 model already installed in Ollama:

```sh
agent-runtime examples run variables \
  --config ./packages/cli/examples/ollama-gemma4.config.yaml \
  --stream
```

The Ollama configuration uses its OpenAI-compatible endpoint at
`http://127.0.0.1:11434/v1`; no provider API key is required.

## Runtime configuration

The CLI automatically loads `agent-runtime.config.yaml`, `agent-runtime.config.yml`,
or `agent-runtime.config.json` beside the agent manifest.
Use `--config` to select another file. The CLI configures built-in providers,
model profiles, and MCP connections without a JavaScript runtime module.

```yaml
version: "1.0"
providers:
  openai:
    driver: openai
  ollama:
    driver: openai-compatible
    baseURL: http://127.0.0.1:11434/v1
models:
  primary:
    provider: openai
    model: gpt-5.6
  local:
    provider: ollama
    model: qwen3:8b
connections:
  documents:
    driver: mcp
    url: https://mcp.example.com
    auth:
      type: bearer
      token:
        env: DOCUMENTS_MCP_TOKEN
    mode: read
    tools: [search, read]
    readTools: [search, read]
```

An explicit manifest reference such as `{ provider: openai, model: gpt-5.6 }`
uses `OPENAI_API_KEY` when no matching provider definition exists. The
manifest's `provider` field selects the provider.

Agent manifests may reference a model profile and bind configured connections:

```yaml
schemaVersion: "1.0"
model:
  ref: primary
connections:
  - ref: documents
    alias: docs
    mode: read
    tools: [search]
steps:
  - id: answer
    type: prompt
    prompt: Search the documents and answer the question.
    tools: [docs__search]
```

Configuration files contain secret references, not secret values. Native
provider drivers use their conventional environment variables by default.
An agent cannot elevate a connection beyond the host-configured mode.

## Local storage and output

Runs persist state beneath `.agent-runtime` and events in
`.agent-runtime/events.jsonl` by default. Override these with `--store`,
`--events`, and `--artifacts`. The literal value `none` disables the event or
artifact adapter. Paths are resolved locally; the CLI does not send state or
events to a service. Its completion summary omits variables,
transcripts, prompts, and model output because they may contain secrets.
The local JSONL sink also omits transient text/reasoning deltas, strips failure
messages, and redacts common credential fields. Custom event sinks receive raw
events and must define their retention and redaction policy.

The default file store is intended for one process. Select
`--store-driver sqlite --store ./runs.sqlite` for a transactional local store
that can safely fence resume attempts across processes. The SQLite driver uses
Node's built-in SQLite API and therefore requires Node 24 or newer.

For a reusable invocation, define an agent run manifest that references an
agent:

```yaml
schemaVersion: "1.0"
agent:
  ref: release.agent.yaml
variables:
  - key: audience
    value: partners
```

```sh
agent-runtime run-manifest ./release.run.yaml
```

For an ad hoc run, `--variables ./overrides.json` accepts the override array
directly. Agent Runtime rejects undeclared keys, duplicate keys, dotted override
keys, and values that do not match the declared type.

## Runtime modules

Capabilities that depend on the host are supplied by an optional local ESM
JavaScript module:

```js
export const modelAdapter = {
  generate: async (request) => ({/* ModelResult */}),
};
export const toolAdapter = {
  listTools: async () => [],
  executeTool: async (call) => ({/* ToolResult */}),
};
export const connectionCredentials = {
  getCredential: async (request) => ({/* ConnectionCredentialResult */}),
  invalidateCredential: async (request) => {},
};
export const approvalAdapter = {
  requestApproval: async (request) => ({/* ApprovalResult */}),
};
export const sandboxAdapter = {
  execute: async (request) => ({/* SandboxResult */}),
};
export const subRunAdapter = {
  execute: async (request) => ({/* SubRunResult */}),
};
export const eventSinks = [{ emit(event) {} }];
```

`credentialProvider` is an alias for `connectionCredentials`. The same fields
may be exported as `default`, as `runtime`, or returned from:

```js
export async function createRuntime(context) {
  // context contains manifest, optional runId, and resolved local paths.
  return { model, tools };
}
```

Export a static `runStore`/`store` or a manifest-independent factory so the CLI
can locate a run before loading its persisted manifest during `resume`:

```js
export async function createRunStore(context) {
  // context has runId and resolved store driver/location, but no manifest.
  return mongoRunStore;
}
```

After loading the manifest, the CLI calls `createRuntime(context)` to configure
the remaining adapters.

Use it with `--runtime-module ./runtime.mjs`. Prompt steps require `model`;
named tools require `tools`; approvals require `approvals`; code requires
`sandbox`; and sub-runs require `subRuns`. Missing adapters fail the run.
Runtime modules are trusted local code and can read the process environment.

Direct local `run` commands include a webhook executor for manifests you
trust. The worker command does not include one. A worker host enables webhooks
by supplying a `WebhookStepExecutor` with `authorizeDestination`.

Agent run manifests may select sequential or dependency-safe parallel step
scheduling. Resume uses the latest checkpoint and rejects a completed run or a
manifest/checkpoint mismatch.

## Worker command

`agent-runtime worker` reads one versioned invocation from stdin and writes
newline-delimited `ready`, `event`, `result`, or `error` messages to stdout.
Child-process and remote execution adapters launch this command. The worker
uses only host-pinned `--config` and `--runtime-module` files; request-supplied
paths and inline configuration are rejected by default.
