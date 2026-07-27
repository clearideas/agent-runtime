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

## Documentation development server advisories

Reviewed: July 27, 2026

Status: not release-blocking; monitor the supported VitePress dependency line.

Dependabot also reports three Vite advisories and one esbuild advisory through
the private documentation workspace:

- `GHSA-v6wh-96g9-6wx3`
- `GHSA-fx2h-pf6j-xcff`
- `GHSA-4w7w-66w2-5vf9`
- `GHSA-67mh-4wv8-2f99`

The affected copies are development dependencies of
`@clearideas/agent-runtime-docs`: VitePress 1.6.4 currently resolves Vite
5.4.21 and esbuild 0.21.5. VitePress 1.6.4 is the latest stable release and
declares Vite `^5.4.14`; the first Vite version containing all three fixes is
6.4.3, outside that supported range. The workspace's other esbuild and Vite
copies are already patched.

These dependencies are not included in any of the 18 npm package tarballs. CI
builds the static documentation and does not start a development server. Local
documentation `dev` and `preview` scripts explicitly bind to `127.0.0.1`, not
to a network interface.

Do not force an unsupported Vite major into the stable VitePress dependency
line solely to clear the alerts. Upgrade when VitePress publishes a stable
release supporting a fully patched Vite version. Reassess sooner if the
documentation development server is exposed beyond loopback or incorporated
into a deployed service.
