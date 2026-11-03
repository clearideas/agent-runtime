# Security review record

## November 2026 dependency audit remediation

Reviewed: November 3, 2026

Status: patched dependencies prepared for review; merge and release pending.

The workspace audit reported 21 affected packages, including three critical
and ten high-severity results. Require MCP SDK 1.32.2, Zod 4.6.6, and the
interactive example's DOMPurify 3.4.17 or newer. Refresh the affected
transitive HTTP, URI, sanitizer, Vue, and test-tool dependencies within their
supported dependency ranges. Both production and full workspace audits now
report zero vulnerabilities.

Keep stable VitePress 1.6.4 and raise its scoped Vite override to 6.4.5, retaining
the Vite 6 major supported by its Vue plugin. This replaces the affected
bundled editor middleware as well as the older documentation-server fixes.
The Hono Node adapter override now requires at least 2.1.3. Audit severity gates
and loopback-only documentation-server bindings remain enabled.

The affected runtime entry points are configured MCP client discovery/calls
and public manifest/configuration validation; the interactive example sanitizes
rendered Markdown with DOMPurify. No runtime API, manifest format, or checkpoint
contract changes. Regression coverage uses the real installed MCP SDK over HTTP
to check authenticated discovery/calls, idempotency metadata, and rejection of
302/307/308 redirects without forwarding credentials or request bodies. Existing
contract, documentation-server, consumer-installation, and documentation-build
checks cover legitimate workflows and compatibility.

## MCP tool metadata prompt injection

Integration reviewed: November 3, 2026

Status: remediation prepared on a review branch; merge and release pending.

Scope: `@clearideas/agent-runtime-config` (`ConfiguredMcpToolAdapter`) and
`@clearideas/agent-runtime-cli`. No advisory; internal review.

`ConfiguredMcpToolAdapter.listTools()` copied each allowlisted tool's
`description` (or `title`) and its complete `inputSchema` from the server's
`tools/list` response into the `AgentTool` definitions that
`PromptStepExecutor` passes to the model adapter. Both fields are rendered into
the model's context by every supported provider, including nested property
descriptions inside the schema. Discovery ran against the server before every
prompt step that names a connection tool, so a server could present one
definition when the host reviewed the connection and another at run
time. The existing controls (`tools` and `readTools` allowlists, aliasing,
redirect rejection, `authorizeConnection`, and `authorizeTool`) operate on tool
names and calls and did not inspect metadata content. A proof of concept
against a local Streamable HTTP server confirmed that a description changed
after review reached `ModelRequest.tools` unchanged.

Impact: a compromised, malicious, or intercepted MCP server (plain `http:` is
accepted) could inject instructions that steer the model, including calls to
other authorized tools and exfiltration through its own tool arguments. The
allowlist bounded which tools could be called, not what the model was
persuaded to do with them. Tool results were already documented as untrusted
and are unchanged by this review.

Remediation: connections accept an optional `toolIntegrity` block pinning a
`sha256` digest per tool, computed by the exported `computeMcpToolDigest` over
a canonical form of `name`, `title`, `description`, `inputSchema`, and
`annotations`. At discovery, every tool exposed to a model must match its
digest; a changed definition (`mismatch`) or an exposed tool without a digest
(`unpinned`) throws `McpToolIntegrityError` even for optional connections, or
is dropped when the host selects `onFailure: exclude`. A `verifyToolMetadata`
tool option lets hosts compare against their own approval record.
`discoverMcpConnectionTools` and `agent-runtime connections inspect` produce
the digests from a reviewed discovery. The feature is opt-in; connections
without `toolIntegrity` or a callback behave as before. Discovery now also
follows `tools/list` pagination so later pages are not silently omitted.

Regression coverage in `packages/runtime/src/mcp-integrity.test.ts`,
`packages/runtime/src/mcp-tools.test.ts`, `packages/cli/src/index.test.ts`, and
`examples/patterns/tool-integrity.mjs` covers canonicalization, matching,
mismatch, unpinned, exclusion, host rejection, pagination, and the CLI output.

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
