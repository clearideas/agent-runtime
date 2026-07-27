# Security review record

## GHSA-frvp-7c67-39w9

Reviewed: July 27, 2026

Status: not actionable for the current Agent Runtime implementation.

`@clearideas/agent-runtime-config` depends on
`@modelcontextprotocol/sdk@1.29.0`, which currently installs
`@hono/node-server@1.19.15`. The Hono dependency is within the advisory's
affected range.

The advisory applies when a Windows host serves static files through the
affected Hono adapter and protects a static subtree with prefix-mounted
middleware. An encoded backslash can then bypass that middleware prefix and
read a file within the configured static root.

Agent Runtime imports only MCP client modules:

- `@modelcontextprotocol/sdk/client/auth-extensions.js`
- `@modelcontextprotocol/sdk/client/auth.js`
- `@modelcontextprotocol/sdk/client/index.js`
- `@modelcontextprotocol/sdk/client/streamableHttp.js`
- `@modelcontextprotocol/sdk/shared/transport.js`

The runtime does not import an MCP server module, `@hono/node-server`, Hono, or
a static-file server. Its supported MCP path creates an outbound
`StreamableHTTPClientTransport` backed by `fetch`. The vulnerable static-file
code is therefore installed transitively but is not reachable through a
shipped Agent Runtime path.

The dependency remains visible to `npm audit`. Do not apply the suggested
forced downgrade of the MCP SDK solely to remove the report. Reassess this
disposition when:

- the MCP SDK changes its Hono dependency;
- Agent Runtime adds an MCP server or static-file serving surface; or
- a supported adapter begins importing the affected server implementation.

Reference:
[GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9)
