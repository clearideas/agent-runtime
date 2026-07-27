# @clearideas/agent-runtime-step-prompt

Streaming prompt-step execution using `ModelAdapter` and `ToolAdapter`.
Text and reasoning deltas are emitted as transient events; the completed transcript is committed
at the step checkpoint. Tool calls execute in model order.

Provider timeouts and per-iteration tool-call limits come from agent manifest
limits.
