# `@clearideas/agent-runtime-config`

Configures model providers, model profiles, connection aliases, credentials,
connection permissions, host workspaces, and the run sandbox for Clear Ideas
Agent Runtime.

```yaml
version: "1.0"

providers:
  openai:
    driver: openai
  local:
    driver: openai-compatible
    baseURL: http://127.0.0.1:11434/v1

models:
  quality:
    provider: openai
    model: gpt-5.6
  private:
    provider: local
    model: qwen3:8b

connections:
  documents:
    driver: mcp
    transport: streamable-http
    url: https://mcp.example.com
    auth:
      type: bearer
      token:
        env: DOCUMENTS_MCP_TOKEN
    mode: read
    tools: [search, read]
    readTools: [search, read]
```

Common providers use their conventional environment variables when `apiKey`
is omitted: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, and
`COHERE_API_KEY`. An explicit secret reference can override the environment
variable name. Secret values cannot be embedded directly in the configuration
schema.

An agent may use a configured model profile and bind a connection:

```yaml
schemaVersion: "1.0"
model:
  ref: quality
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

A manifest binding may reduce configured connection access but cannot expand
it. A read-only connection cannot be elevated to `read_write`, and read-mode
MCP connections expose only the host-declared `readTools` subset. MCP server
annotations are descriptive hints, not authorization controls. MCP tool names
use `<alias>__<tool>` to prevent collisions and satisfy model-provider
function-name restrictions. Prompt tool idempotency keys are forwarded as
`_meta["agent-runtime/idempotency-key"]`; side-effecting MCP servers must honor
that metadata to deduplicate recovery attempts.

MCP authentication modes are `none`, `bearer`, `oauth`, and
`client_credentials`. OAuth connections obtain request headers from a
`ConnectionCredentialProvider` passed to `composeRuntime`:

```ts
const runtime = composeRuntime(
  manifest,
  config,
  {},
  {
    modelPolicy: {
      requireProfiles: true,
      allowedModels: ["openai/gpt-5.6"],
      allowManifestOptions: false,
    },
    toolOptions: {
      credentialProvider: connectionCredentials,
      authorizeConnection({ binding }) {
        authorizeConnectionForTenant(binding.ref);
      },
      authorizeTool({ toolName }, context) {
        authorizeToolCall(context.runId, toolName);
      },
    },
  },
);
```

On an unauthorized response, the adapter invalidates the credential, requests
it again with `forceRefresh: true`, and retries once. The provider returns
`authorization_required` when user consent is needed.

The default MCP transport rejects redirects. Hosts that supply a custom
`fetch` implementation through `toolOptions` must validate every redirect and
destination against their network policy.

Client-credentials connections use environment references:

```yaml
auth:
  type: client_credentials
  clientId:
    env: MCP_CLIENT_ID
  clientSecret:
    env: MCP_CLIENT_SECRET
  scopes: [documents.read]
```

## Workspaces and the run sandbox

A `workspaces` section defines host-owned file collections such as a code
base or document store, and a `sandbox` section defines the isolated
environment and command policy under which agents operate on them:

```yaml
workspaces:
  source-code:
    driver: local
    root: ./repo
    mode: read
    include: ["src/**", "**/*.md"]
  notes:
    driver: local
    root: { env: AGENT_NOTES_ROOT }
    mode: read_write
sandbox:
  driver: bubblewrap # or docker with image, or host with a SandboxProvider
  commands:
    pytest: { program: pytest, args: { maxCount: 8 } }
  shell:
    enabled: false
```

An agent binds a workspace with `workspaces: [{ ref: source-code, alias: code, mode: read }]`
and receives `code__list_files`, `code__read_file`, `code__search_files`, and
`code__pytest`; `read_write` bindings add `write_file` and `delete_file`. As
with connections, a manifest may narrow the configured mode and tools but
never widen them. `composeRuntime` returns `workspaces` and `runSandbox`
providers for `AgentRuntime` and merges workspace tools with remote MCP tools
through `CompositeToolAdapter`. Every tool call executes as one command in the
run sandbox; `authorizeCommand` vetoes before execution and `sandbox.*` events
report after it.

The package includes native AI SDK drivers for OpenAI, Anthropic, Google, xAI,
Groq, and Cohere. Ollama, LM Studio, vLLM, and other compatible endpoints can
use `openai-compatible`. Use `runtime.mjs` for custom provider or connection
adapters.
