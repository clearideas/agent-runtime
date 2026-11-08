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

Context management keeps a step inside `limits.maxInputBytes`,
`limits.maxMessagesPerPrompt`, configured triggers, the model's described input
window, and provider context-overflow errors. Oversized interpolated variables,
single large tool results, and older tool rounds are pruned (the default) or
summarized, with chunked summarization for material larger than the
summarizer's window. Reductions are transcript markers, so resume rebuilds the
same model input. Retryable model errors are retried with backoff; invalid
structured output, empty required output, and truncated responses get a repair
turn; reaching the tool-call limit asks for a final answer; and calls to tools
the step does not name are answered with an error instead of running. All of
this follows the step's resolved execution `policies`.
