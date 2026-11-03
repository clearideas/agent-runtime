# QC handoff: MCP tool metadata verification

Review package for the change that adds optional verification of MCP tool
metadata before it reaches a model. This document is a handoff for quality
control; it is not end-user documentation and can be removed once the change
is merged. The permanent record is the entry in
[SECURITY_REVIEW.md](SECURITY_REVIEW.md).

## Summary of the change

`ConfiguredMcpToolAdapter.listTools()` forwarded each allowlisted tool's
`description` (or `title`) and its complete `inputSchema` from the MCP server
to the model without verification, and discovery ran before every prompt step
that names a connection tool. A server could therefore present one definition
when the connection was reviewed and inject instructions through a different
definition at run time. A proof of concept against a local Streamable HTTP
server confirmed the injected description reached `ModelRequest.tools`.

The remediation is opt-in and additive:

- `toolIntegrity: { digests, onFailure }` on an MCP connection pins a
  `sha256:` digest per tool. Every tool the connection exposes to a model must
  match; `mismatch` and `unpinned` raise `McpToolIntegrityError` (default
  `onFailure: fail`, which propagates even for optional connections) or drop
  the tool (`onFailure: exclude`).
- `verifyToolMetadata` in `ConfiguredMcpToolAdapterOptions` lets a host
  compare against its own approval record.
- `computeMcpToolDigest`, `canonicalizeMcpToolMetadata`,
  `discoverMcpConnectionTools`, and `McpToolIntegrityError` are exported from
  `@clearideas/agent-runtime-config` and re-exported by
  `@clearideas/agent-runtime`.
- The CLI adds `connections inspect <config> [--connection <name>]
[--runtime-module <file>] [--format json|yaml]`.
- Discovery now follows `tools/list` pagination (previously only the first
  page was read).

Connections without `toolIntegrity` and hosts without `verifyToolMetadata`
behave exactly as before, apart from the pagination fix.

## Files changed

| Area                | Files                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core (read first)   | `packages/runtime/src/mcp-integrity.ts` (new), `packages/runtime/src/mcp-tools.ts`, `packages/runtime/src/config.ts`, `packages/runtime/src/index.ts`                                    |
| CLI                 | `packages/cli/src/index.ts`, `packages/cli/package.json` (adds `yaml`), `package-lock.json`                                                                                              |
| Tests               | `packages/runtime/src/mcp-integrity.test.ts` (new), `packages/runtime/src/mcp-tools.test.ts`, `packages/runtime/src/config.test.ts`, `packages/cli/src/index.test.ts`                    |
| Examples            | `examples/patterns/tool-integrity.mjs` (new), `examples/patterns/patterns.test.mjs`, `examples/patterns/README.md`, `examples/manifests/documents.config.yaml` (new)                     |
| Documentation       | `docs/connections-and-tools.md`, `docs/reference.md`, `docs/production.md`, `docs/embedding.md`, `packages/runtime/README.md`, `packages/cli/README.md`                                  |
| Records             | `SECURITY_REVIEW.md`, `.changeset/mcp-tool-integrity.md`                                                                                                                                 |
| Untouched by design | `core`, `contracts`, `step-prompt`, `model-ai-sdk`, all other packages; no port, manifest, event, or checkpoint contract changes; `examples/interactive-web` left unpinned intentionally |

## Reading guide

The security-relevant change to the execution path is small. Read in order:

1. `packages/runtime/src/mcp-integrity.ts`: the canonicalization and digest
   contract, and the error class.
2. `packages/runtime/src/mcp-tools.ts`: `#verifyTool`, the single insertion in
   the `listTools()` loop after the allowlist check, the `catch` rethrow for
   `McpToolIntegrityError`, `listAllTools` (pagination), and `discoverTools`.
3. `packages/runtime/src/config.ts`: `mcpToolIntegritySchema` and the
   `superRefine` rule that `digests` keys must be in `tools`.

Everything else is the CLI command, tests, documentation, examples, and
records.

## Validation status

Run in a Node 22 sandbox (the repository requires Node 24):

| Check              | Result                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check`     | pass                                                                                                                                                                         |
| `check:metadata`   | pass (18 public packages)                                                                                                                                                    |
| `build`            | pass                                                                                                                                                                         |
| `test`             | pass: 273 tests across all workspaces and example patterns, 0 failures (`config` 26, `cli` 30, patterns 4)                                                                   |
| `check:docs`       | pass (12 schema-validated YAML examples, including the new pinned config)                                                                                                    |
| `check:tarballs`   | pass (18 packages)                                                                                                                                                           |
| `check:boundaries` | false failure on the untouched `store-sqlite` package: `node:sqlite` is a Node 24 builtin absent from Node 22's list. With that builtin accounted for, boundaries are clean. |
| `check:consumer`   | not run (requires Node 24 and an out-of-workspace install)                                                                                                                   |

Quick functional check after `npm run build`:

```sh
node examples/patterns/tool-integrity.mjs            # prints: Release status found using notes__search.
node examples/patterns/tool-integrity.mjs --tamper   # prints: Run refused: mismatch for tool "changelog"... exit 1
node examples/patterns/tool-integrity.mjs --tamper --exclude   # completes using the verified tool
```

## QC must run

1. `npm run validate` on Node 24 (confirms `check:boundaries` passes there).
2. `npm run check:consumer` (the only step that exercises the new CLI `yaml`
   dependency from a consumer install).
3. A clean `npm ci` to confirm the `package-lock.json` change has no drift.

## Decisions for maintainers

4. `SECURITY_REVIEW.md` records the integration review date and keeps merge
   and release pending until maintainer approval.
5. The changeset is `minor` for `agent-runtime-config` and `agent-runtime-cli`.
   The fixed version group in `.changeset/config.json` moves all 18 packages
   to 0.6.0 together; confirm that is intended for this release.
6. `MAXIMUM_TOOL_LIST_PAGES = 100` is a defensive bound on `tools/list`
   pagination. Confirm the value or plan to make it configurable.
7. The `sha256:` prefix and the canonicalization rules are a published
   contract from this release forward; the known-answer test in
   `mcp-integrity.test.ts` pins them. Sign off on the covered field set
   (`name`, `title`, `description`, `inputSchema`, `annotations`). A future
   change requires a new prefix while continuing to verify existing pins.

## Known limitations (follow-up candidates, not blockers)

8. `onFailure: exclude` is silent at run time: the tool is dropped without an
   event because the adapter has no emit context during discovery. A
   `diagnostic` run event would be a reasonable follow-up.
9. Prompt steps must name tools, so with `exclude` a step that names the
   excluded tool fails with the pre-existing `Tool <name> is not available`
   message rather than an integrity-specific one. Improving that requires a
   change in `step-prompt`, which was kept out of scope.
10. `verifyToolMetadata` runs on every discovery, that is, before every prompt
    step that names a connection tool. Documented; hosts with a
    database-backed approval record should cache by digest.
11. Tool results remain unverified by design. Metadata verification covers what
    reaches the model before a call, not what a tool returns.

## Documentation conventions applied

New documentation and comments describe the host, the connection, and
approval rather than a "user". Pre-existing references to the `user` message
role and to "user-supplied" inputs in other pages were left unchanged. The
only remaining "user" in the added material is inside a simulated malicious
tool description in `mcp-tools.test.ts`.
