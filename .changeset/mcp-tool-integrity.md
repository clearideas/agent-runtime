---
"@clearideas/agent-runtime-config": minor
"@clearideas/agent-runtime-cli": minor
---

Add optional verification of MCP tool metadata before it reaches a model.

MCP connections accept a `toolIntegrity` block that pins a `sha256` digest per
tool; at discovery, a changed definition or an exposed tool without a digest
raises `McpToolIntegrityError` (or is dropped with `onFailure: exclude`). New
exports `computeMcpToolDigest`, `canonicalizeMcpToolMetadata`,
`discoverMcpConnectionTools`, and the `verifyToolMetadata` tool option let hosts
record and verify the definitions approved when a connection is created.
The CLI adds `connections inspect <config> [--connection <name>] [--format
json|yaml]` to print discovered tools with digests and a paste-ready
`toolIntegrity` block. Connections without `toolIntegrity` behave as before.
Tool discovery now follows `tools/list` pagination.
