---
"@clearideas/agent-runtime-model-ai-sdk": patch
---

Allow Anthropic SDK 4.0.72 and newer to complete streamed responses by omitting
the metadata-only `anthropic.message_start` custom part from replay content.
Preserve existing text/tool replay, usage accounting, and provider options.
Other unknown content and semantic custom parts, including Anthropic fallback
blocks, remain explicit unsupported-content errors rather than being discarded.
