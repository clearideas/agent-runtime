---
"@clearideas/agent-runtime": patch
"@clearideas/agent-runtime-core": patch
"@clearideas/agent-runtime-store-local": patch
"@clearideas/agent-runtime-step-prompt": patch
"@clearideas/agent-runtime-step-standard": patch
---

Default local and configured host workspaces to staging; raw native read-only directory attachment now requires explicit `attach: auto`. Document the full-directory access granted by attachment and the fail-closed behavior of staging limits. Continue prompt steps when named MCP tools are explicitly excluded by integrity policy, while retaining errors for other unavailable tools. Render approval prompts with the same variable interpolation as prompt steps without placing rendered content in lifecycle events.
