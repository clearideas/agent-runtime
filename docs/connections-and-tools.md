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
Tool descriptions and schemas are also server-supplied; see
[verifying MCP tool metadata](#verifying-mcp-tool-metadata) to pin the
definitions a host approved. Discovery follows `tools/list` pagination.

The default MCP transport rejects HTTP redirects. Supply a policy-enforcing
`fetch` implementation only when redirects or private-network destinations are
required. Hosted applications can also provide `authorizeConnection` and
`authorizeTool` callbacks to bind connections and calls to the current
identity, tenant, and run.

Optional connections use `required: false` on the manifest binding. Required
bindings fail runtime validation when the host has not configured them.

## Verifying MCP tool metadata

An MCP server supplies each tool's name, description, and input schema. Agent
Runtime forwards the description and schema to the model as part of the tool
definition, so a compromised or malicious server can use them to inject
instructions. Discovery also runs before every prompt step that names a
connection tool, so a server may present benign metadata when the connection
is created and different metadata later.

`toolIntegrity` pins the metadata the host approved. At discovery, Agent
Runtime computes a digest for every tool the connection exposes and compares it
with the pinned value before the definition reaches a model.

<<< ../examples/manifests/documents.config.yaml

The digest covers `name`, `title`, `description`, `inputSchema`, and
`annotations` in a canonical form: keys are sorted recursively, empty or absent
top-level fields are equivalent, and nested `null` values and array order are
preserved. Fields that never reach a model, such as `outputSchema` and `_meta`,
are ignored.

Print the block for a configured connection after reviewing the discovered
tools:

```sh
agent-runtime connections inspect ./agent-runtime.config.yaml --format yaml
```

The JSON format (default) includes each tool's full metadata, digest, whether
it is in the host allowlist, and, when the connection already defines
`toolIntegrity`, whether it is `verified`, `mismatch`, or `unpinned`. Supply
`--runtime-module` when an OAuth connection needs `connectionCredentials`.

Rules:

- When a connection has no `toolIntegrity`, behavior is unchanged: nothing is
  verified.
- When it does, every tool the connection exposes to a model must have a
  matching digest. A changed definition is a `mismatch`; an exposed tool with
  no digest is `unpinned`. Tools outside the agent binding's narrowed list are
  not checked, so a host can pin only the tools agents use.
- `onFailure: fail` (default) throws `McpToolIntegrityError` from discovery.
  This fails the run even for optional connections, unlike other discovery
  errors.
- `onFailure: exclude` drops only the failing tool and continues. A prompt step
  that names the excluded tool still fails with `Tool <name> is not available`;
  steps that do not name it proceed.
- `digests` may only name tools present in `tools`; configuration validation
  rejects other keys.

Host applications that keep their own record of approved definitions can
verify in code instead of, or in addition to, configuration:

```ts
import {
  composeRuntime,
  discoverMcpConnectionTools,
} from "@clearideas/agent-runtime";

// When the connection is created: discover, review, and store.
const discovered = await discoverMcpConnectionTools(config, "documents");
await approvals.save(
  discovered.filter((tool) => tool.allowed),
  // each entry carries name, description, inputSchema, and digest
);

// At run time: reject anything that was not approved.
const runtime = composeRuntime(
  manifest,
  config,
  {},
  {
    toolOptions: {
      async verifyToolMetadata({ connection, tool, digest }) {
        const approved = await approvals.digest(connection, tool.name);
        if (approved !== digest)
          throw new Error(`Tool ${tool.name} changed since approval.`);
      },
    },
  },
);
```

`verifyToolMetadata` runs for every exposed tool after the configured digest
check and receives the runtime-computed `digest` and, when pinned, the
`expectedDigest`. Throwing rejects the tool and fails discovery with
`McpToolIntegrityError` (`reason: "rejected"`, original error in `cause`).
Discovery repeats before each prompt step that names a connection tool, so
the callback should be inexpensive; comparing against a cached digest per
connection and tool is sufficient.

The error exposes `connectionRef`, `toolName`, `reason`, `expectedDigest`,
`actualDigest`, and the discovered `tool` so a host can show what changed
before the connection is approved again. Tool results remain untrusted content; metadata
verification does not validate what a tool returns.

### What to store when a connection is approved

A digest is one-way: it proves that a definition matches what was approved,
but the definition cannot be recovered from it. Store both forms, in different
places:

| Store                                                                            | Where                                                | Purpose                                                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Digest                                                                           | `toolIntegrity.digests` in the runtime configuration | What the runtime compares. Compact, free of server content, safe to commit.                                |
| Verbatim metadata (`name`, `title`, `description`, `inputSchema`, `annotations`) | The host's own connection record                     | Displaying the approved definitions, diffing against `McpToolIntegrityError.tool`, and re-deriving digests |

`discoverMcpConnectionTools` returns both for every tool. A host that keeps
only digests can respond to a mismatch only by having the connection
reviewed and approved again.

The digest format is a published contract: `sha256:` identifies both the hash
and the canonicalization rules above, and Agent Runtime will not change those
rules for that prefix. If a future release must cover additional fields, it
will introduce a new prefix (for example `sha256v2:`) and continue to verify
existing `sha256:` pins, so an upgrade never invalidates approved connections.
A host that stored verbatim metadata can then compute new-format digests with
`computeMcpToolDigest` without a new review; a host that stored only
digests must have its connections approved again.

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
| `authorization_required` | the connection requires interactive consent |
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

## Workspace tools

Workspaces expose host-owned file collections through an in-process MCP server
that relays every call into an isolated per-run sandbox. They use the same
alias-prefixed tool names, the same read/read_write narrowing rules, and the
same authorization hooks as remote connections. See
[Workspaces and the run sandbox](./workspaces.md).

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
