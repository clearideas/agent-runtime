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

Tool descriptions and input schemas come from the MCP server and are forwarded
to the model. Pin the definitions the host approved so a changed definition
cannot reach a model:

```yaml
connections:
  documents:
    driver: mcp
    url: https://mcp.example.com
    tools: [search, read]
    readTools: [search, read]
    toolIntegrity:
      digests:
        search: sha256:550b84bb56a184c2f6d7d0eb1af6d08031657a045b6afdc0643440928bb93296
        read: sha256:c11cd404a1aa53e45645cb8c72d9666650d467adb681b670bed066d2e459dff7
      onFailure: fail # or exclude
```

`agent-runtime connections inspect <config> --format yaml` prints this block
after discovery. Programmatically, `discoverMcpConnectionTools` returns each
tool with its digest, `computeMcpToolDigest` produces the digest for a stored
definition, and a `verifyToolMetadata` tool option lets a host compare against
its own approval record. Verification failures raise `McpToolIntegrityError`
from discovery, even for optional connections. Digests are one-way: keep the
digest in configuration and the verbatim metadata in the host's own connection
record, so approved definitions can be displayed and digests recomputed. The
`sha256:` prefix fixes the canonicalization rules; any future change uses a new
prefix and keeps verifying existing pins.

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
`authorization_required` when interactive consent is needed.

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
