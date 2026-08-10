# @clearideas/agent-runtime-step-prompt

Streaming prompt-step execution using `ModelAdapter` and `ToolAdapter`.
Text and reasoning deltas are emitted as transient events. Completed model and
tool rounds are checkpointed for recovery. Tool calls execute in model order
with a stable `ToolExecutionContext.idempotencyKey`; side-effecting adapters
must honor that key to prevent a repeated external effect after a lost result.

Prompt steps accept the backward-compatible `systemPrompt` plus `prompt`
shorthand or a mutually exclusive complete `messages` history. Rich histories
support system, user, assistant, and tool roles; tool-call/result replay;
provider options; and URL-, base64-, or artifact-backed image and file parts.

Provider timeouts and per-iteration tool-call limits come from agent manifest
limits.
