# Security review record

## GHSA-7p8r-x3mc-p8w7

Reviewed: August 6, 2026

Resolved: August 6, 2026

The workspace now resolves the `fast-uri` dependency used by
`@modelcontextprotocol/sdk` through Ajv to `fast-uri@3.1.5`, which contains the
host-confusion fix. Agent Runtime does not use `fast-uri` to authorize outbound
destinations, but the vulnerable production dependency has been removed.

Reference:
[GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7)

## GHSA-8j4g-w8fx-2239

Reviewed: August 6, 2026

Resolved: August 6, 2026

The workspace now resolves the Hono dependency used by
`@modelcontextprotocol/sdk` to `hono@4.13.0`, which contains the CORS middleware
ReDoS fix. Agent Runtime uses the MCP SDK client and does not configure Hono's
CORS middleware, but the vulnerable production dependency has been removed.

The production dependency audit reports no vulnerabilities.

Reference:
[GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239)

## GHSA-frvp-7c67-39w9

Reviewed: July 27, 2026

Resolved: July 28, 2026

`@clearideas/agent-runtime-config` now uses
`@modelcontextprotocol/sdk@1.30.0`. The workspace resolves its supported Hono
dependency to `@hono/node-server@2.0.12`, which contains the advisory fix.

The production dependency audit reports no vulnerabilities.

Reference:
[GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9)

## Documentation development server advisories

Reviewed: July 27, 2026

Status: confined to the local documentation development server.

Dependabot reports three Vite advisories and one esbuild advisory through the
documentation workspace:

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
