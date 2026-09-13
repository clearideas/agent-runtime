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

## September 2026 GitHub dependency alerts

Reviewed: September 13, 2026

The local dependency update addresses all 17 open GitHub Dependabot alerts.
GitHub will reassess them after the updated lockfile reaches the default branch;
no alerts have been dismissed manually.

| GitHub alerts      | Component                      | Local remediation                                                                                      |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| #12, #13, #15, #16 | fast-uri                       | Resolve 3.1.7 through the MCP SDK's Ajv dependency.                                                    |
| #17, #18, #19      | Hono                           | Resolve 4.13.7 through the MCP SDK.                                                                    |
| #14, #20           | qs                             | Resolve 6.16.0 through the MCP SDK's HTTP dependencies.                                                |
| #21, #22           | Vitest and @vitest/mocker      | Resolve 4.1.11.                                                                                        |
| #23, #24           | js-yaml                        | Changesets 3 removes both vulnerable transitive copies; js-yaml is absent from the workspace lockfile. |
| #1, #2, #3, #4     | Documentation Vite and esbuild | Scope a Vite 6.4.3 override to VitePress; its esbuild resolves to 0.25.12.                             |

Source: [GitHub Dependabot alerts](https://github.com/clearideas/agent-runtime/security/dependabot).
The failing CI on PR #43 was the production audit rejecting fast-uri; that
production dependency is now patched.

## Documentation development server advisories

Reviewed: September 13, 2026

Status: affected dependency versions replaced locally.

The affected advisories are:

- [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3)
- [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff)
- [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9)
- [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)

VitePress 1.6.4 remains the latest stable release and declares Vite `^5.4.14`.
The root manifest now overrides only VitePress's Vite dependency to `^6.4.3`,
the first Vite 6 release containing all three Vite fixes. This also replaces
esbuild 0.21.5 with 0.25.12. Vitest keeps its separate Vite 8 dependency.

This is a deliberate, tested exception to the previous wait-for-upstream
policy. Loopback binding reduces network exposure but does not close the
launch-editor vulnerability: an attacker-controlled website can target a
localhost server on Windows and cause UNC filesystem access before an editor
is opened. Replacing the bundled vulnerable implementation closes that route;
merely changing the standalone launch-editor package does not.

The override is outside VitePress's declared Vite range. Its Vue plugin accepts
Vite 6, and validation covers the documentation client/SSR build, browser
navigation, local search, and Markdown hot reload. During development, new
headings did not appear immediately in an already initialized search index on
either the Vite 5 baseline or Vite 6 candidate; this is a retained behavior,
not evidence of an upgrade regression. Windows-specific UNC, ADS, and 8.3
filesystem behavior was not executed on the macOS validation host; those fixes
are verified by the resolved upstream patched version and dependency audit.

Keep local documentation scripts bound to `127.0.0.1`. CI and deployment build
static files; the development server is not shipped in the 18 npm packages.
CI now audits both production and development dependencies. Remove the scoped
override when stable VitePress supports a fully patched Vite directly, and
repeat the documentation compatibility checks when changing this override.

Regression coverage in `docs/dev-server.test.mjs` resolves Vite and esbuild
through VitePress. Both tests reproduce on Vite 5.4.21/esbuild 0.21.5 and pass
on the patched versions: outside-root source-map contents are no longer
returned, including encoded traversal attempts, and an arbitrary Origin no
longer receives permissive CORS headers. Ordinary local map and file requests
still succeed. `npm run validate`, `npm run docs:build`, a clean `npm ci`, and
`npm run audit:dependencies` pass; the full audit reports zero vulnerabilities.
