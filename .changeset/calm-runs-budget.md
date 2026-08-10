---
"@clearideas/agent-runtime": minor
"@clearideas/agent-runtime-cli": minor
"@clearideas/agent-runtime-contracts": minor
"@clearideas/agent-runtime-core": minor
"@clearideas/agent-runtime-execution": minor
"@clearideas/agent-runtime-config": minor
"@clearideas/agent-runtime-step-prompt": minor
---

Add cumulative run-level model-token budgets with durable suspension. Token
limits and consumed usage persist across attempts; resume may replace the limit
with a higher value, while an unchanged or exhausted limit suspends again
before another model or pending tool call. Prompt continuations checkpoint tool
intent and results, and adapters receive a stable idempotency key so recovery
does not repeat a side effect when the tool honors that key.
