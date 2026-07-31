# @clearideas/agent-runtime-step-prompt

Streaming prompt-step execution using `ModelAdapter` and `ToolAdapter`.
Text and reasoning deltas are emitted as transient events; the completed transcript is committed
at the step checkpoint. Tool calls execute in model order.

Prompt steps accept the backward-compatible `systemPrompt` plus `prompt`
shorthand or a mutually exclusive complete `messages` history. Rich histories
support system, user, assistant, and tool roles; tool-call/result replay;
provider options; and URL-, base64-, or artifact-backed image and file parts.

Provider timeouts and per-iteration tool-call limits come from agent manifest
limits.
