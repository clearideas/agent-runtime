# @clearideas/agent-runtime-server

## 0.9.0

### Minor Changes

- Add an OpenAI-compatible server: `agent-runtime serve` exposes agent
  manifests as models on `/v1/models` and `/v1/chat/completions`, so chat front
  ends and OpenAI SDKs can run whole agents.

  - **Serve.** `agent-runtime serve <manifest>` serves one manifest.
    `agent-runtime serve` reads `agent-runtime.server.yaml`, or the file named
    by `--server-config`, to serve several, with API keys scoped to models,
    per-key limits, admission control, request timeouts, graceful shutdown,
    health endpoints, and run retention. Storage a configuration file leaves
    out is durable, under `.agent-runtime/serve` beside it. `--check`
    validates and preflights everything and exits.
  - **Conversations.** Manifests that declare `messages` receive the chat as
    conversation turns. A conversation ledger maps what a client sends back to
    the history the runtime issued, so conversations continue from the
    runtime's own signed, compacted history: compaction is not repeated every
    turn, resent media is stored once, and `requireSignature` manifests work
    with ordinary clients. Edited or foreign histories are not recognized.
    Manifests without `messages` receive operator-mapped variables.
  - **Streaming.** Only the run's final output is ever streamed as content. A
    reply streams as it is written when its step is provably the reply;
    otherwise it is sent when the run completes. Optional progress uses the
    `reasoning_content` convention, with names only.
  - **Boundary.** Requests never supply manifests, configuration, tools, or
    provider options. Serve uses the worker's trust rules: webhook steps need a
    host-supplied authorizing executor. Client system messages and client
    tools are dropped (with `clientTools: reject`, tools are refused instead),
    media URLs are refused unless allowlisted, and run failures are redacted to
    their code.
  - **Embedding.** `@clearideas/agent-runtime-server` exports `AgentServer`,
    `listen` (node:http), and `createFetchHandler` (Request → Response).

  Supporting changes:

  - Host composition (runtime-module loading, adapter validation,
    configuration composition, and step-executor selection) moved from the CLI
    into `@clearideas/agent-runtime-server`, with an explicit trust mode, and
    is shared by `run`, `worker`, and `serve`. The CLI's exported types and
    behavior are unchanged.
  - Fix: `messages` options a runtime module exports as plain values, such as
    a host-enforced `requireSignature` or `authorizeArtifact`, were ignored by
    the CLI; they now apply. Modules that use `createRuntime()` were not
    affected.
  - `AgentRuntime.preflight(manifest)` runs the pre-run checks without creating
    a run.
  - `RunStore.deleteRun(runId)` is an optional method for retention; the memory
    and SQLite stores implement it.
  - CLI options accept `--name=value` as well as `--name value`.

  Release validation also covers custom output selectors in streamed replies,
  provider retries before and after partial output, stalled uploads on both HTTP
  transports, queued/preparing requests during shutdown, late runtime-resource
  cleanup, and bounded deletion of expired SQLite conversation/index rows.
  Partial live answers that need a retry end with `stream_interrupted` rather
  than concatenating failed and successful attempts. Custom output selectors
  always use committed streaming. Request deadlines cover uploads and setup as
  well as execution.

### Patch Changes

- Updated dependencies
  - @clearideas/agent-runtime-core@0.9.0
  - @clearideas/agent-runtime-store-local@0.9.0
  - @clearideas/agent-runtime-store-sqlite@0.9.0
  - @clearideas/agent-runtime-condition-jexl@0.9.0
  - @clearideas/agent-runtime-config@0.9.0
  - @clearideas/agent-runtime-sandbox@0.9.0
  - @clearideas/agent-runtime-step-loop@0.9.0
  - @clearideas/agent-runtime-step-prompt@0.9.0
  - @clearideas/agent-runtime-step-standard@0.9.0
  - @clearideas/agent-runtime-contracts@0.9.0
