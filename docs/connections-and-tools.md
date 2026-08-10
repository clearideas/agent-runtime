---
title: Connections and tools
description: Connect agents to MCP servers and application-native tools without placing credentials in manifests.
---

# Connections and tools

## MCP connections

Connections are defined by the host and bound by the agent. Agent Runtime
supports MCP over Streamable HTTP.

Host configuration:

```yaml
version: "1.0"
connections:
  documents:
    driver: mcp
    transport: streamable-http
    url:
      env: DOCUMENTS_MCP_URL
    auth:
      type: bearer
      token:
        env: DOCUMENTS_MCP_TOKEN
    headers:
      X-Workspace:
        env: DOCUMENTS_WORKSPACE
    mode: read
    tools: [search, read]
    readTools: [search, read]
    required: true
    connectTimeoutMs: 10000
    toolTimeoutMs: 30000
```

Agent manifest:

```yaml
connections:
  - ref: documents
    alias: docs
    mode: read
    tools: [search]

steps:
  - id: answer
    type: prompt
    prompt: Find the answer in the connected documents.
    tools: [docs__search]
```

Tool names are prefixed with `<alias>__` to prevent collisions. The agent may
narrow the configured tool list or request a less privileged mode. It cannot
add tools or elevate `read` to `read_write`.

`tools` is the host's complete allowlist. `readTools` is the subset the host
has classified as read-only. Server annotations are displayed as metadata but
are never used as authorization because they are supplied by the MCP server.
Use `read_write` only when the host has separately authorized those actions.

The default MCP transport rejects HTTP redirects. Supply a policy-enforcing
`fetch` implementation only when redirects or private-network destinations are
required. Hosted applications can also provide `authorizeConnection` and
`authorizeTool` callbacks to bind connections and calls to the current user,
tenant, and run.

Optional connections use `required: false` on the manifest binding. Required
bindings fail runtime validation when the host has not configured them.

## MCP authentication

An MCP connection accepts four authentication modes.

### No authentication

```yaml
auth:
  type: none
```

### Bearer token

```yaml
auth:
  type: bearer
  token:
    env: DOCUMENTS_MCP_TOKEN
```

Agent Runtime resolves the token from the environment and sends it in the
`Authorization` header.

### OAuth

```yaml
auth:
  type: oauth
  profile: customer-documents
```

OAuth connections use `ConnectionCredentialProvider`. The provider returns
request headers for the connection:

```ts
interface ConnectionCredentialProvider {
  getCredential(
    request: ConnectionCredentialRequest,
  ): Promise<ConnectionCredentialResult>;

  invalidateCredential?(
    request: ConnectionCredentialRequest & {
      reason: "expired" | "unauthorized";
    },
  ): Promise<void>;
}
```

Export the provider from a CLI runtime module:

```js
export const connectionCredentials = {
  async getCredential(request) {
    const credential = await credentialStore.get({
      profile: request.credentialProfile,
      forceRefresh: request.forceRefresh === true,
    });
    if (!credential) return { status: "authorization_required" };
    return {
      status: "ready",
      headers: { Authorization: `Bearer ${credential.accessToken}` },
      expiresAt: credential.expiresAt,
    };
  },

  async invalidateCredential(request) {
    await credentialStore.invalidate(request.credentialProfile);
  },
};
```

The provider may return:

| Status                   | Result                                      |
| ------------------------ | ------------------------------------------- |
| `ready`                  | request headers and an optional expiry time |
| `authorization_required` | the connection requires user authorization  |
| `unavailable`            | credentials cannot be supplied              |

On an unauthorized MCP response, Agent Runtime invalidates the credential,
requests it again with `forceRefresh: true`, and retries the connection once.
An authorization-required result produces
`connection_authorization_required`.

The host application performs consent, callback handling, encrypted token
storage, refresh, rotation, and revocation. Agent manifests contain only the
connection reference.

### Client credentials

```yaml
auth:
  type: client_credentials
  clientId:
    env: DOCUMENTS_MCP_CLIENT_ID
  clientSecret:
    env: DOCUMENTS_MCP_CLIENT_SECRET
  scopes: [documents.read]
```

Agent Runtime uses the MCP SDK client-credentials provider for token discovery,
acquisition, and refresh. Client identifiers and secrets must use environment
references.

## Application tools

Application-native tools implement `ToolAdapter`:

```ts
interface ToolAdapter {
  listTools(): Promise<AgentTool[]>;
  executeTool(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}
```

Example runtime module:

```js
const tools = [
  {
    name: "lookup_status",
    description: "Look up a shipment status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["trackingNumber"],
      properties: {
        trackingNumber: { type: "string" },
      },
    },
  },
];

export const toolAdapter = {
  async listTools() {
    return tools;
  },
  async executeTool(call, context) {
    if (call.name !== "lookup_status") {
      return {
        callId: call.id,
        name: call.name,
        error: { code: "UNKNOWN_TOOL", message: "Tool is not available." },
      };
    }
    const output = await lookupAuthorizedShipment(
      call.input.trackingNumber,
      context.idempotencyKey,
      context.signal,
    );
    return { callId: call.id, name: call.name, output };
  },
};
```

Load the runtime module with:

```sh
agent-runtime run ./agent.yaml --runtime-module ./runtime.mjs --stream
```

Runtime modules are trusted application code and can access the process
environment.

## Ordering and limits

Tool calls execute sequentially in model order. Set
`limits.maxToolCallsPerIteration` to bound each model/tool cycle.

Before invocation, Agent Runtime checkpoints the tool intent and supplies a
stable `context.idempotencyKey`. It reuses that key if recovery repeats the
logical call, then checkpoints the returned result. Side-effecting application
adapters must pass the key to an atomic deduplication mechanism in the target
system. Configured MCP adapters forward it as
`_meta["agent-runtime/idempotency-key"]`; the MCP server must honor that value.

The tool adapter is also responsible for authorization, input validation
beyond the declared schema, timeouts for non-MCP tools, rate limits, and
redaction. Return errors as `ToolResult.error` when the model may recover;
throw when the entire step must fail.

## Events

Tool activity produces:

- `model.tool.requested`
- `model.tool.started`
- `model.tool.completed`

Lifecycle events exclude tool arguments and results. Tool values remain in the
durable transcript and follow the configured store's data policy.
