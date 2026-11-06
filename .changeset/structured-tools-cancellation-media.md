---
"@clearideas/agent-runtime-model-ai-sdk": patch
"@clearideas/agent-runtime-step-prompt": patch
"@clearideas/agent-runtime-step-standard": patch
---

Allow tool-call turns in steps with structured output without parsing an unfinished answer. Use tagged file data for tool-result artifact replay. Prevent cancelled operations from starting work or leaving rejected promises unobserved, observe aborts during adapter startup, and let streaming cancellation and timeouts finish without waiting for a non-cooperative iterator. Preserve cancellation errors when iterator cleanup fails and retain approval prompt interpolation.
