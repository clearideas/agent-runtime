# pyright: reportInvalidTypeForm=false, reportAssignmentType=false
# Field annotations are Zod-style schema calls resolved by the ZodModel layer at runtime.
"""The versioned contracts as pydantic models with Zod 4 semantics.

Field order is the Zod shape order of ``packages/contracts/src/index.ts``;
refinements mirror its ``refine``/``superRefine`` calls, including the key order
of every ``addIssue`` object, so parsed output and issues are byte-identical.
"""

from __future__ import annotations

from typing import Any

from .._js import strings as js_strings
from ._zod import (
    ZodModel,
    any_aborting,
    array,
    boolean,
    custom,
    discriminated,
    enum,
    integer,
    json_object,
    json_value,
    lazy,
    literal,
    number,
    optional,
    record,
    string,
    tag,
    union,
    validate,
)

AGENT_MANIFEST_SCHEMA_VERSION = "1.0"
AGENT_RUN_MANIFEST_SCHEMA_VERSION = "1.0"
MESSAGES_VARIABLE = "messages"
MESSAGES_SIGNATURE_VERSION = "1"
MESSAGES_SIGNATURE_ALGORITHM = "HMAC-SHA256"
AGENT_VARIABLE_TYPES = ("string", "number", "boolean", "object", "array", "json")
WORKSPACE_MODES = ("read", "read_write")
CONTEXT_STRATEGIES = ("summarize", "prune", "summarize-or-prune", "fail")
SUMMARY_KINDS = ("input", "transcript", "tool-result", "messages")
PROMPT_ONLY_POLICY_FIELDS = ("context", "toolCallLimit", "modelRetry", "outputRepair")
AGENT_RUN_EXECUTION_MODES = ("sequential", "parallel")

_RESERVED_SEGMENTS = {"__proto__", "prototype", "constructor"}


def is_safe_variable_path(value: str) -> bool:
    segments = [js_strings.trim(segment) for segment in value.split(".")]
    return len(segments) > 0 and all(
        len(segment) > 0 and js_strings.lower(segment) not in _RESERVED_SEGMENTS for segment in segments
    )


JsonValue = json_value()
JsonObject = json_object()
VariableState = json_object()

VariablePath = string(
    min=1,
    refine=[
        (
            is_safe_variable_path,
            "Variable paths cannot contain empty or prototype-sensitive segments.",
        )
    ],
)
AgentVariableKey = string(
    trim=True,
    min=1,
    max=100,
    refine=[
        (
            lambda value: "." not in value,
            "Variable keys cannot contain dots; use dot notation only to read properties inside object values.",
        ),
        (
            lambda value: js_strings.lower(value) not in _RESERVED_SEGMENTS,
            "Variable keys cannot use prototype-sensitive names.",
        ),
    ],
)

Str = string()
NonEmpty = string(min=1)
Bool = boolean()


def value_matches_agent_variable_type(value: Any, kind: str) -> bool:
    if kind == "array":
        return isinstance(value, list)
    if kind == "object":
        return isinstance(value, dict)
    if kind == "json":
        return isinstance(value, (list, dict))
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "string":
        return isinstance(value, str)
    return False


# ─── Variables ──────────────────────────────────────────────────────────────


class AgentVariableDefinition(ZodModel):
    key: AgentVariableKey
    type: enum(*AGENT_VARIABLE_TYPES)
    value: optional(JsonValue) = None
    requiresOverride: optional(Bool) = None
    description: optional(Str) = None
    metadata: optional(JsonObject) = None

    @classmethod
    def refine(cls, data: dict[str, Any]) -> list[dict[str, Any]]:
        if "value" in data and not value_matches_agent_variable_type(data["value"], data.get("type")):  # pyright: ignore[reportArgumentType]
            return [custom(f"Variable {data.get('key')} default must be {data.get('type')}.", ["value"])]
        return []


class AgentVariableOverride(ZodModel):
    key: AgentVariableKey
    value: JsonValue


def _refine_overrides(overrides: list[Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    keys: set[str] = set()
    for index, override in enumerate(overrides):
        key = override.get("key") if isinstance(override, dict) else None
        if not isinstance(key, str):
            continue
        normalized = js_strings.lower(key)
        if normalized in keys:
            issues.append(custom(f"Duplicate run variable override: {key}", [index, "key"]))
        keys.add(normalized)
    return issues


AgentVariableOverrides = array(AgentVariableOverride, refine=_refine_overrides)


# ─── Shared records ─────────────────────────────────────────────────────────


class ArtifactRef(ZodModel):
    id: NonEmpty
    name: NonEmpty
    mediaType: NonEmpty
    uri: optional(Str) = None
    size: optional(integer(ge=0)) = None
    sha256: optional(Str) = None
    metadata: optional(JsonObject) = None


_NonNegative = number(ge=0)


class ModelUsage(ZodModel):
    inputTokens: optional(_NonNegative) = None
    outputTokens: optional(_NonNegative) = None
    reasoningTokens: optional(_NonNegative) = None
    cachedInputTokens: optional(_NonNegative) = None
    cacheWriteTokens: optional(_NonNegative) = None
    totalTokens: optional(_NonNegative) = None
    estimatedCost: optional(_NonNegative) = None
    metadata: optional(JsonObject) = None


class RunError(ZodModel):
    code: NonEmpty
    message: Str
    retryable: optional(Bool) = None
    details: optional(JsonObject) = None
    stack: optional(Str) = None


class ToolCall(ZodModel):
    id: NonEmpty
    name: NonEmpty
    input: JsonObject
    stepId: optional(Str) = None
    providerExecuted: optional(Bool) = None
    metadata: optional(JsonObject) = None


class ToolResult(ZodModel):
    callId: NonEmpty
    name: NonEmpty
    output: optional(JsonValue) = None
    error: optional(RunError) = None
    artifacts: optional(array(ArtifactRef)) = None
    metadata: optional(JsonObject) = None


# ─── Content parts ──────────────────────────────────────────────────────────


class TextPart(ZodModel):
    type: tag("text")
    text: Str
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None


class ReasoningPart(ZodModel):
    type: tag("reasoning")
    text: optional(Str) = None
    encrypted: optional(Str) = None
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None


class JsonPart(ZodModel):
    type: tag("json")
    value: JsonValue
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None


class ImagePart(ZodModel):
    type: tag("image")
    artifact: optional(ArtifactRef) = None
    url: optional(NonEmpty) = None
    data: optional(NonEmpty) = None
    mediaType: optional(NonEmpty) = None
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None


class FilePart(ZodModel):
    type: tag("file")
    artifact: optional(ArtifactRef) = None
    url: optional(NonEmpty) = None
    data: optional(NonEmpty) = None
    name: optional(NonEmpty) = None
    mediaType: optional(NonEmpty) = None
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None


class ToolCallPart(ZodModel):
    type: tag("tool-call")
    call: ToolCall
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None


class ToolResultPart(ZodModel):
    type: tag("tool-result")
    result: ToolResult
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None


ContentPart = discriminated(
    "type", TextPart, ReasoningPart, JsonPart, ImagePart, FilePart, ToolCallPart, ToolResultPart
)


class ConversationTextPart(ZodModel):
    type: tag("text")
    text: Str
    metadata: optional(JsonObject) = None


class ConversationJsonPart(ZodModel):
    type: tag("json")
    value: JsonValue
    metadata: optional(JsonObject) = None


class ConversationImagePart(ZodModel):
    type: tag("image")
    artifact: optional(ArtifactRef) = None
    url: optional(NonEmpty) = None
    data: optional(NonEmpty) = None
    mediaType: optional(NonEmpty) = None
    metadata: optional(JsonObject) = None


class ConversationFilePart(ZodModel):
    type: tag("file")
    artifact: optional(ArtifactRef) = None
    url: optional(NonEmpty) = None
    data: optional(NonEmpty) = None
    name: optional(NonEmpty) = None
    mediaType: optional(NonEmpty) = None
    metadata: optional(JsonObject) = None


ConversationContentPart = discriminated(
    "type", ConversationTextPart, ConversationJsonPart, ConversationImagePart, ConversationFilePart
)


# ─── Prompt messages ────────────────────────────────────────────────────────


class PromptMessage(ZodModel):
    role: enum("system", "user", "assistant", "tool")
    content: array(ContentPart, min=1)
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None

    @classmethod
    def refine(cls, data: dict[str, Any]) -> list[dict[str, Any]]:
        issues: list[dict[str, Any]] = []
        role = data.get("role")
        parts = list(enumerate(data.get("content") or []))
        if role == "system":
            for index, part in parts:
                if isinstance(part, dict) and part.get("type") != "text":
                    issues.append(custom("System messages may contain only text parts.", ["content", index]))
        if role == "tool":
            for index, part in parts:
                if isinstance(part, dict) and part.get("type") != "tool-result":
                    issues.append(custom("Tool messages may contain only tool-result parts.", ["content", index]))
        if role == "user":
            for index, part in parts:
                if isinstance(part, dict) and part.get("type") in (
                    "reasoning",
                    "tool-call",
                    "tool-result",
                ):
                    issues.append(
                        custom(
                            f"User messages cannot contain {part.get('type')} parts.",
                            ["content", index],
                        )
                    )
        for index, part in parts:
            if not isinstance(part, dict) or part.get("type") not in ("image", "file"):
                continue
            sources = sum(1 for key in ("artifact", "url", "data") if key in part)
            if sources != 1:
                issues.append(
                    custom(
                        "History media parts require exactly one of artifact, url, or data.",
                        ["content", index],
                    )
                )
            if part.get("type") == "file" and part.get("artifact") is None and part.get("mediaType") is None:
                issues.append(
                    custom(
                        "History file parts without an artifact reference require mediaType.",
                        ["content", index, "mediaType"],
                    )
                )
        return issues


# ─── Model references and policies ──────────────────────────────────────────


class ExplicitModelReference(ZodModel):
    provider: NonEmpty
    model: NonEmpty
    options: optional(JsonObject) = None


class ProfileModelReference(ZodModel):
    ref: NonEmpty
    options: optional(JsonObject) = None


ModelReference = union(ExplicitModelReference, ProfileModelReference)

_NonEmptyOptional = optional(NonEmpty)


class SummarizerPrompts(ZodModel):
    input: _NonEmptyOptional = None
    transcript: _NonEmptyOptional = None
    toolResult: _NonEmptyOptional = None
    messages: _NonEmptyOptional = None


class ContextSummarizer(ZodModel):
    model: optional(ModelReference) = None
    systemPrompt: _NonEmptyOptional = None
    prompt: _NonEmptyOptional = None
    prompts: optional(SummarizerPrompts) = None
    maxOutputTokens: optional(integer(gt=0)) = None
    summaryShare: optional(number(gt=0, le=1)) = None
    minSummaryBytes: optional(integer(ge=128)) = None
    maxSummaryBytes: optional(integer(ge=256)) = None
    chunkBytes: optional(integer(ge=1024)) = None
    maxCalls: optional(integer(gt=0)) = None
    maxPasses: optional(integer(ge=1, le=10)) = None

    @classmethod
    def refine(cls, data: dict[str, Any]) -> list[dict[str, Any]]:
        low, high = data.get("minSummaryBytes"), data.get("maxSummaryBytes")
        if low is None or high is None or low <= high:
            return []
        return [custom("summarizer.minSummaryBytes cannot exceed maxSummaryBytes.")]


class ContextTrigger(ZodModel):
    inputBytes: optional(integer(gt=0)) = None
    inputTokens: optional(integer(gt=0)) = None
    contextRatio: optional(number(gt=0, le=1)) = None
    toolRounds: optional(integer(gt=0)) = None


class ContextRetain(ZodModel):
    recentToolRounds: optional(integer(ge=0)) = None


class ContextVariablePolicy(ZodModel):
    keep: optional(Bool) = None
    strategy: optional(enum(*CONTEXT_STRATEGIES)) = None
    maxBytes: optional(integer(gt=0)) = None


class ContextPolicy(ZodModel):
    strategy: optional(enum(*CONTEXT_STRATEGIES)) = None
    summarizer: optional(ContextSummarizer) = None
    trigger: optional(ContextTrigger) = None
    retain: optional(ContextRetain) = None
    reduceTo: optional(number(ge=0.05, le=0.95)) = None
    openingShare: optional(number(ge=0.05, le=1)) = None
    maxCompactions: optional(integer(ge=0)) = None
    overflowRetries: optional(integer(ge=0, le=10)) = None
    maxToolResultBytes: optional(integer(gt=0)) = None
    toolResultShare: optional(number(ge=0.05, le=1)) = None
    variables: optional(record(VariablePath, ContextVariablePolicy)) = None


class ModelRetryPolicy(ZodModel):
    maxAttempts: optional(integer(ge=1, le=10)) = None
    initialDelayMs: optional(integer(ge=0)) = None
    maxDelayMs: optional(integer(ge=0)) = None


class OutputRepairPolicy(ZodModel):
    maxAttempts: optional(integer(ge=0, le=5)) = None


class ExecutionPolicies(ZodModel):
    context: optional(ContextPolicy) = None
    toolCallLimit: optional(enum("finalize", "fail")) = None
    modelRetry: optional(ModelRetryPolicy) = None
    outputRepair: optional(OutputRepairPolicy) = None
    onError: optional(enum("fail", "continue")) = None


class StepHistoryOptions(ZodModel):
    last: optional(integer(gt=0)) = None
    summary: optional(Bool) = None
    insert: optional(Bool) = None
    media: optional(enum("include", "latest", "omit")) = None


StepHistory = union(literal("all"), StepHistoryOptions)


# ─── Bindings ───────────────────────────────────────────────────────────────

BindingAlias = optional(string(regex=("/^[a-z][a-z0-9-]*$/u", None)))


class AgentConnectionBinding(ZodModel):
    ref: NonEmpty
    alias: BindingAlias = None
    tools: optional(array(NonEmpty)) = None
    mode: optional(enum("read", "read_write")) = None
    required: optional(Bool) = None


class AgentWorkspaceBinding(ZodModel):
    ref: NonEmpty
    alias: BindingAlias = None
    tools: optional(array(NonEmpty)) = None
    mode: optional(enum(*WORKSPACE_MODES)) = None
    required: optional(Bool) = None


# ─── Steps ──────────────────────────────────────────────────────────────────


class StepBase(ZodModel):
    id: NonEmpty
    name: _NonEmptyOptional = None
    description: optional(Str) = None
    when: optional(Str) = None
    history: optional(StepHistory) = None
    outputVariable: optional(AgentVariableKey) = None
    includeInFinalOutput: optional(Bool) = None
    policies: optional(ExecutionPolicies) = None
    metadata: optional(JsonObject) = None
    extensions: optional(JsonObject) = None


class CompletionPolicy(ZodModel):
    onTruncation: optional(enum("fail", "accept")) = None
    requireOutput: optional(Bool) = None


class PromptStep(StepBase):
    type: tag("prompt")
    prompt: optional(Str) = None
    systemPrompt: optional(Str) = None
    messages: optional(array(PromptMessage, min=1)) = None
    model: optional(ModelReference) = None
    outputSchema: optional(JsonObject) = None
    tools: optional(array(Str)) = None
    maxOutputTokens: optional(integer(gt=0)) = None
    completionPolicy: optional(CompletionPolicy) = None

    @classmethod
    def refine(cls, step: dict[str, Any]) -> list[dict[str, Any]]:
        issues: list[dict[str, Any]] = []
        uses_legacy_prompt = "prompt" in step
        uses_messages = "messages" in step
        history = step.get("history")
        inserts_history = "history" in step and (
            history == "all" or (isinstance(history, dict) and history.get("insert") is not False)
        )
        if uses_legacy_prompt and uses_messages:
            issues.append(custom("Prompt steps require exactly one of prompt or messages.", order="code,message"))
        elif not uses_legacy_prompt and not uses_messages and not inserts_history:
            issues.append(
                custom(
                    "Prompt steps require prompt, messages, or history that inserts conversation turns.",
                    order="code,message",
                )
            )
        if uses_messages and "systemPrompt" in step:
            issues.append(
                custom(
                    "systemPrompt cannot be combined with a complete messages history.",
                    ["systemPrompt"],
                )
            )

        calls: dict[str, str] = {}
        results: set[str] = set()
        saw_non_system = False
        messages = step.get("messages") if isinstance(step.get("messages"), list) else []
        for message_index, message in enumerate(messages):  # pyright: ignore[reportArgumentType]
            if not isinstance(message, dict):
                continue
            if message.get("role") == "system" and saw_non_system:
                issues.append(
                    custom(
                        "System messages must precede user, assistant, and tool history.",
                        ["messages", message_index, "role"],
                    )
                )
            elif message.get("role") != "system":
                saw_non_system = True
            for part_index, part in enumerate(message.get("content") or []):
                if not isinstance(part, dict):
                    continue
                path = ["messages", message_index, "content", part_index]
                if part.get("type") == "tool-call":
                    call = part.get("call") or {}
                    if call.get("id") in calls:
                        issues.append(custom(f"Duplicate historical tool-call id: {call.get('id')}", path))
                    else:
                        calls[call.get("id")] = call.get("name")  # pyright: ignore[reportArgumentType]
                if part.get("type") == "tool-result":
                    result = part.get("result") or {}
                    call_id = result.get("callId")
                    expected_name = calls.get(call_id)  # pyright: ignore[reportArgumentType]
                    if expected_name is None:
                        issues.append(
                            custom(
                                f"Historical tool result {call_id} has no preceding tool call.",
                                path,
                            )
                        )
                    elif expected_name != result.get("name"):
                        issues.append(
                            custom(
                                f"Historical tool result {call_id} names {result.get('name')}; expected {expected_name}.",
                                path,
                            )
                        )
                    elif call_id in results:
                        issues.append(custom(f"Duplicate historical tool result: {call_id}", path))
                    else:
                        results.add(call_id)  # pyright: ignore[reportArgumentType]
        for call_id in calls:
            if call_id not in results:
                issues.append(custom(f"Historical tool call {call_id} has no tool result.", ["messages"]))
        return issues


class LoopDefinition(ZodModel):
    source: optional(Str) = None
    delimiter: optional(Str) = None
    itemVariable: optional(VariablePath) = None
    indexVariable: optional(VariablePath) = None
    condition: optional(Str) = None
    goal: optional(Str) = None
    outputMode: optional(enum("array", "final")) = None
    resultVariable: optional(VariablePath) = None
    maxIterations: optional(integer(gt=0)) = None


class LoopStep(StepBase):
    type: tag("loop")
    loop: LoopDefinition
    steps: array(lazy(lambda: AgentStep))


class WebhookStep(StepBase):
    type: tag("webhook")
    url: string(url=True)
    method: optional(enum("GET", "POST", "PUT", "PATCH", "DELETE")) = None
    headers: optional(record(Str, Str)) = None
    body: optional(JsonValue) = None
    timeoutMs: optional(integer(gt=0)) = None
    retries: optional(integer(ge=0)) = None
    idempotencyKey: optional(Str) = None


class ApprovalStep(StepBase):
    type: tag("approval")
    prompt: Str
    action: optional(enum("pause", "complete", "cancel")) = None
    onReject: optional(enum("fail", "cancel", "complete", "continue")) = None


class SubRunStep(StepBase):
    type: tag("sub-run")
    manifest: optional(lazy(lambda: AgentManifestSchema)) = None
    manifestRef: optional(Str) = None
    variableMappings: optional(record(AgentVariableKey, Str)) = None

    @classmethod
    def refine(cls, step: dict[str, Any]) -> list[dict[str, Any]]:
        if step.get("manifest") is not None or step.get("manifestRef") is not None:
            return []
        return [custom("A sub-run step requires manifest or manifestRef.")]


class CodeStep(StepBase):
    type: tag("code")
    language: NonEmpty
    code: Str
    timeoutMs: optional(integer(gt=0)) = None
    environment: optional(record(Str, Str)) = None
    workspaces: optional(array(NonEmpty)) = None
    sandbox: optional(enum("run", "step")) = None


AgentStep = discriminated("type", PromptStep, LoopStep, WebhookStep, ApprovalStep, SubRunStep, CodeStep)


# ─── Messages declaration ───────────────────────────────────────────────────


class MessagesContextPolicy(ContextPolicy):
    @classmethod
    def refine(cls, policy: dict[str, Any]) -> list[dict[str, Any]]:
        if "trigger" not in policy:
            return []
        return [
            custom(
                "messages.context cannot set trigger; maxMessages and maxBytes are the history's compaction triggers."
            )
        ]


class MessagesMarkers(ZodModel):
    summary: _NonEmptyOptional = None
    note: _NonEmptyOptional = None


class AgentMessagesDeclaration(ZodModel):
    required: optional(Bool) = None
    description: optional(Str) = None
    maxMessages: optional(integer(ge=2)) = None
    maxBytes: optional(integer(ge=1024)) = None
    requireSignature: optional(Bool) = None
    context: optional(MessagesContextPolicy) = None
    markers: optional(MessagesMarkers) = None
    metadata: optional(JsonObject) = None


# ─── Manifest ───────────────────────────────────────────────────────────────

MAXIMUM_AGENT_MANIFEST_STRUCTURE_DEPTH = 128
MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES = 100_000


def agent_manifest_structure_issue(value: Any) -> str | None:
    ancestors: set[int] = set()
    stack: list[tuple[Any, int, bool]] = [(value, 0, False)]
    nodes = 0
    while stack:
        current, depth, exiting = stack.pop()
        if exiting:
            ancestors.discard(id(current))
            continue
        nodes += 1
        if nodes > MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES:
            return f"Agent manifest exceeds the {MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES}-node structure limit."
        if depth > MAXIMUM_AGENT_MANIFEST_STRUCTURE_DEPTH:
            return f"Agent manifest exceeds the {MAXIMUM_AGENT_MANIFEST_STRUCTURE_DEPTH}-level manifest structure depth limit."
        if not isinstance(current, (dict, list)):
            continue
        if id(current) in ancestors:
            return "Agent manifest cannot contain cyclic data."
        children = list(current) if isinstance(current, list) else list(current.values())
        if nodes + len(children) > MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES:
            return f"Agent manifest exceeds the {MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES}-node structure limit."
        ancestors.add(id(current))
        stack.append((current, depth, True))
        for child in reversed(children):
            stack.append((child, depth + 1, False))
    return None


class ManifestLimits(ZodModel):
    maxSteps: optional(integer(gt=0)) = None
    maxMessagesPerPrompt: optional(integer(gt=0)) = None
    maxInputBytes: optional(integer(gt=0)) = None
    maxOutputBytes: optional(integer(gt=0)) = None
    maxToolCallsPerIteration: optional(integer(gt=0)) = None
    providerTimeoutMs: optional(integer(gt=0)) = None


def _walk_steps(steps: Any):
    return list(enumerate(steps)) if isinstance(steps, list) else []


def _validate_sibling_step_ids(steps: Any, issues: list[Any], path: list[Any]) -> None:
    seen: set[Any] = set()
    for index, step in _walk_steps(steps):
        if step.get("id") in seen:
            issues.append(
                custom(
                    f"Duplicate sibling step id: {step.get('id')}",
                    [*path, index, "id"],
                    order="code,message,path",
                )
            )
        seen.add(step.get("id"))
        if step.get("type") == "loop":
            _validate_sibling_step_ids(step.get("steps"), issues, [*path, index, "steps"])


def _validate_code_step_workspaces(steps: Any, aliases: set[str], issues: list[Any], path: list[Any]) -> None:
    for index, step in _walk_steps(steps):
        if step.get("type") == "loop":
            _validate_code_step_workspaces(step.get("steps"), aliases, issues, [*path, index, "steps"])
            continue
        if step.get("type") != "code":
            continue
        workspaces = step.get("workspaces") or []
        if step.get("sandbox") == "step" and len(workspaces) > 0:
            issues.append(
                custom(
                    f"Code step {step.get('id')} cannot mount workspaces in a per-step sandbox; use sandbox: run.",
                    [*path, index, "sandbox"],
                    order="code,message,path",
                )
            )
        seen: set[str] = set()
        for alias_index, alias in enumerate(workspaces):
            if alias not in aliases:
                issues.append(
                    custom(
                        f"Code step {step.get('id')} references an undeclared workspace alias: {alias}",
                        [*path, index, "workspaces", alias_index],
                        order="code,message,path",
                    )
                )
            if alias in seen:
                issues.append(
                    custom(
                        f"Code step {step.get('id')} lists workspace {alias} more than once",
                        [*path, index, "workspaces", alias_index],
                        order="code,message,path",
                    )
                )
            seen.add(alias)


def _validate_step_policies(steps: Any, issues: list[Any], path: list[Any]) -> None:
    for index, step in _walk_steps(steps):
        if step.get("type") == "loop":
            _validate_step_policies(step.get("steps"), issues, [*path, index, "steps"])
        policies = step.get("policies")
        if step.get("type") == "prompt" or not policies:
            continue
        for field in PROMPT_ONLY_POLICY_FIELDS:
            if field in policies:
                issues.append(
                    custom(
                        f"policies.{field} applies only to prompt steps; {step.get('type')} step {step.get('id')} cannot set it.",
                        [*path, index, "policies", field],
                        order="code,message,path",
                    )
                )


def _is_reserved_messages_name(value: Any) -> bool:
    return isinstance(value, str) and js_strings.lower(js_strings.trim(value.split(".")[0])) == MESSAGES_VARIABLE


def _validate_step_history(steps: Any, declared: bool, issues: list[Any], path: list[Any]) -> None:
    for index, step in _walk_steps(steps):
        step_path = [*path, index]
        history = step.get("history")
        if "history" in step and not declared:
            issues.append(
                custom(
                    f"Step {step.get('id')} sets history, but the manifest does not declare messages.",
                    [*step_path, "history"],
                    order="code,message,path",
                )
            )
        if (
            "history" in step
            and history != "all"
            and isinstance(history, dict)
            and "insert" in history
            and step.get("type") != "prompt"
        ):
            issues.append(
                custom(
                    f"history.insert applies only to prompt steps; {step.get('type')} step {step.get('id')} cannot set it.",
                    [*step_path, "history", "insert"],
                    order="code,message,path",
                )
            )
        if declared and _is_reserved_messages_name(step.get("outputVariable")):
            issues.append(
                custom(
                    f"Step {step.get('id')} cannot write the reserved messages variable.",
                    [*step_path, "outputVariable"],
                    order="code,message,path",
                )
            )
        if step.get("type") == "loop":
            loop = step.get("loop") or {}
            if declared:
                for field in ("itemVariable", "indexVariable", "resultVariable"):
                    if _is_reserved_messages_name(loop.get(field)):
                        issues.append(
                            custom(
                                f"Loop step {step.get('id')} cannot write the reserved messages variable.",
                                [*step_path, "loop", field],
                                order="code,message,path",
                            )
                        )
            _validate_step_history(step.get("steps"), declared, issues, [*step_path, "steps"])


class AgentManifestSchema(ZodModel):
    schemaVersion: literal(AGENT_MANIFEST_SCHEMA_VERSION)
    id: optional(Str) = None
    name: optional(Str) = None
    description: optional(Str) = None
    model: optional(ModelReference) = None
    variables: optional(array(AgentVariableDefinition)) = None
    connections: optional(array(AgentConnectionBinding)) = None
    workspaces: optional(array(AgentWorkspaceBinding)) = None
    messages: optional(AgentMessagesDeclaration) = None
    steps: array(AgentStep)
    policies: optional(ExecutionPolicies) = None
    limits: optional(ManifestLimits) = None
    metadata: optional(JsonObject) = None
    extensions: optional(JsonObject) = None

    @classmethod
    def preprocess(cls, value: Any) -> Any:
        issue = agent_manifest_structure_issue(value)
        if issue is not None:
            from ._zod import fail

            fail([custom(issue, order="code,message,fatal", fatal=True)])
        return value

    @classmethod
    def refine(cls, manifest: dict[str, Any]) -> list[dict[str, Any]]:
        issues: list[dict[str, Any]] = []
        connection_aliases: set[str] = set()
        for index, connection in enumerate(manifest.get("connections") or []):
            alias = connection.get("alias") if connection.get("alias") is not None else connection.get("ref")
            if alias in connection_aliases:
                issues.append(
                    custom(
                        f"Duplicate connection alias: {alias}",
                        ["connections", index, "alias"],
                        order="code,message,path",
                    )
                )
            connection_aliases.add(alias)
        workspace_aliases: set[str] = set()
        for index, workspace in enumerate(manifest.get("workspaces") or []):
            alias = workspace.get("alias") if workspace.get("alias") is not None else workspace.get("ref")
            if alias in workspace_aliases:
                issues.append(
                    custom(
                        f"Duplicate workspace alias: {alias}",
                        ["workspaces", index, "alias"],
                        order="code,message,path",
                    )
                )
            elif alias in connection_aliases:
                issues.append(
                    custom(
                        f"Workspace alias collides with a connection alias: {alias}",
                        ["workspaces", index, "alias"],
                        order="code,message,path",
                    )
                )
            workspace_aliases.add(alias)
        steps = manifest.get("steps")
        _validate_sibling_step_ids(steps, issues, ["steps"])
        _validate_step_policies(steps, issues, ["steps"])
        _validate_code_step_workspaces(steps, workspace_aliases, issues, ["steps"])
        _validate_step_history(steps, manifest.get("messages") is not None, issues, ["steps"])
        variable_keys: set[str] = set()
        for index, definition in enumerate(manifest.get("variables") or []):
            key = definition.get("key")
            normalized = js_strings.lower(key) if isinstance(key, str) else key
            if manifest.get("messages") is not None and normalized == MESSAGES_VARIABLE:
                issues.append(
                    custom(
                        "The messages variable is reserved in a manifest that declares messages.",
                        ["variables", index, "key"],
                        order="code,message,path",
                    )
                )
            if normalized in variable_keys:
                issues.append(
                    custom(
                        f"Duplicate agent variable: {key}",
                        ["variables", index, "key"],
                        order="code,message,path",
                    )
                )
            variable_keys.add(normalized)
        return issues


# ─── Run manifests, budgets, execution ──────────────────────────────────────


class AgentRunBudget(ZodModel):
    maxTotalTokens: integer(gt=0, safe=True)


class RunBudgetState(ZodModel):
    maxTotalTokens: integer(gt=0, safe=True)
    consumedTokens: integer(ge=0, safe=True)


class AgentRunExecution(ZodModel):
    mode: enum(*AGENT_RUN_EXECUTION_MODES)
    maxConcurrency: optional(integer(ge=1, le=64)) = None


class AgentReference(ZodModel):
    ref: string(trim=True, min=1)


class MessagesMarker(ZodModel):
    kind: enum("summary", "note")
    replaces: integer(ge=0, safe=True)
    turns: optional(integer(ge=0, safe=True)) = None
    sequence: integer(gt=0, safe=True)
    strategy: enum("summarize", "prune")


def messages_marker_of(message: Any) -> dict[str, Any] | None:
    """Reads a leading marker from message metadata; ``None`` when there is none."""
    if not isinstance(message, dict):
        return None
    metadata = message.get("metadata")
    runtime = metadata.get("agentRuntime") if isinstance(metadata, dict) else None
    if not isinstance(runtime, dict):
        return None
    if "messages" not in runtime:
        return None
    parsed, issues = validate(MessagesMarker, runtime.get("messages"))
    return None if issues else parsed


class ConversationMessage(ZodModel):
    role: enum("user", "assistant")
    content: array(ConversationContentPart, min=1)
    metadata: optional(JsonObject) = None


class ConversationMessageInput(ConversationMessage):
    """A supplied message: string ``content`` is shorthand for one text part."""

    @classmethod
    def preprocess(cls, value: Any) -> Any:
        if isinstance(value, dict) and isinstance(value.get("content"), str):
            return {**value, "content": [{"type": "text", "text": value["content"]}]}
        return value


def _validate_conversation_messages(messages: list[Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for message_index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if isinstance(metadata, dict) and "agentRuntime" in metadata:
            runtime = metadata["agentRuntime"]
            if message_index > 0:
                issues.append(
                    custom(
                        "metadata.agentRuntime is reserved for the runtime marker, which may only be the first message.",
                        [message_index, "metadata", "agentRuntime"],
                    )
                )
            elif (
                not isinstance(runtime, dict)
                or any(key != "messages" for key in runtime)
                or validate(MessagesMarker, runtime.get("messages"))[1]
                or "messages" not in runtime
            ):
                issues.append(
                    custom(
                        "metadata.agentRuntime is not a valid runtime marker.",
                        [message_index, "metadata", "agentRuntime"],
                    )
                )
        for part_index, part in enumerate(message.get("content") or []):
            if not isinstance(part, dict) or part.get("type") not in ("image", "file"):
                continue
            sources = sum(1 for key in ("artifact", "url", "data") if key in part)
            if sources != 1:
                issues.append(
                    custom(
                        "Message media parts require exactly one of artifact, url, or data.",
                        [message_index, "content", part_index],
                    )
                )
            if part.get("type") == "file" and part.get("artifact") is None and part.get("mediaType") is None:
                issues.append(
                    custom(
                        "Message file parts without an artifact reference require mediaType.",
                        [message_index, "content", part_index, "mediaType"],
                    )
                )
            if "data" in part and part.get("mediaType") is None:
                issues.append(
                    custom(
                        "Message media parts with inline data require mediaType.",
                        [message_index, "content", part_index, "mediaType"],
                    )
                )
    return issues


ConversationMessages = array(ConversationMessage, refine=_validate_conversation_messages)
ConversationMessagesInput = array(ConversationMessageInput, refine=_validate_conversation_messages)


class MessagesSignature(ZodModel):
    version: literal(MESSAGES_SIGNATURE_VERSION)
    algorithm: literal(MESSAGES_SIGNATURE_ALGORITHM)
    keyId: string(min=1, max=200)
    count: integer(ge=0, safe=True)
    value: string(min=1, regex=("/^[A-Za-z0-9_-]+$/u", "Signature value must be base64url."))


class RunMessagesState(ZodModel):
    history: ConversationMessages
    compaction: enum("pending", "complete")
    signedCount: integer(ge=0, safe=True)
    scope: optional(Str) = None
    journal: optional(JsonObject) = None


class AgentRunManifest(ZodModel):
    schemaVersion: literal(AGENT_RUN_MANIFEST_SCHEMA_VERSION)
    agent: AgentReference
    runId: optional(string(trim=True, min=1)) = None
    variables: optional(AgentVariableOverrides) = None
    execution: optional(AgentRunExecution) = None
    budget: optional(AgentRunBudget) = None
    messages: optional(ConversationMessagesInput) = None
    messagesSignature: optional(MessagesSignature) = None


# ─── Transcript, results, checkpoints ───────────────────────────────────────

IsoDateTime = string(datetime=True)


class TranscriptItem(ZodModel):
    id: NonEmpty
    type: enum("message", "reasoning", "tool-call", "tool-result", "artifact", "error")
    role: optional(enum("system", "user", "assistant", "tool")) = None
    content: array(ContentPart)
    createdAt: IsoDateTime
    model: optional(Str) = None
    usage: optional(ModelUsage) = None
    metadata: optional(JsonObject) = None
    providerOptions: optional(JsonObject) = None


class ExecutionCursor(ZodModel):
    stepIndex: integer(ge=0)
    stepId: optional(Str) = None
    stepPath: optional(Str) = None
    loopIteration: optional(integer(ge=0)) = None
    childIndex: optional(integer(ge=0)) = None


class StepResult(ZodModel):
    stepId: NonEmpty
    stepIndex: integer(ge=0)
    status: literal("completed")
    output: optional(JsonValue) = None
    variables: optional(VariableState) = None
    transcript: optional(array(TranscriptItem)) = None
    artifacts: optional(array(ArtifactRef)) = None
    usage: optional(ModelUsage) = None
    completedAt: IsoDateTime
    metadata: optional(JsonObject) = None


class RunCheckpoint(ZodModel):
    id: NonEmpty
    runId: NonEmpty
    sequence: integer(gt=0, safe=True)
    attempt: optional(integer(gt=0, safe=True)) = None
    manifestHash: NonEmpty
    contractVersion: NonEmpty
    runtimeVersion: NonEmpty
    cursor: ExecutionCursor
    state: VariableState
    stepResults: array(StepResult)
    transcript: array(TranscriptItem)
    artifacts: array(ArtifactRef)
    activeStepTranscript: optional(array(TranscriptItem)) = None
    activeStepArtifacts: optional(array(ArtifactRef)) = None
    continuation: optional(JsonObject) = None
    budget: optional(RunBudgetState) = None
    messages: optional(lazy(lambda: RunMessagesState)) = None
    createdAt: IsoDateTime
    metadata: optional(JsonObject) = None


__all__ = [
    "AGENT_MANIFEST_SCHEMA_VERSION",
    "AGENT_RUN_EXECUTION_MODES",
    "AGENT_RUN_MANIFEST_SCHEMA_VERSION",
    "AGENT_VARIABLE_TYPES",
    "CONTEXT_STRATEGIES",
    "MAXIMUM_AGENT_MANIFEST_STRUCTURE_DEPTH",
    "MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES",
    "MESSAGES_SIGNATURE_ALGORITHM",
    "MESSAGES_SIGNATURE_VERSION",
    "MESSAGES_VARIABLE",
    "PROMPT_ONLY_POLICY_FIELDS",
    "SUMMARY_KINDS",
    "WORKSPACE_MODES",
    "AgentConnectionBinding",
    "AgentManifestSchema",
    "AgentMessagesDeclaration",
    "AgentReference",
    "AgentRunBudget",
    "AgentRunExecution",
    "AgentRunManifest",
    "AgentStep",
    "AgentVariableDefinition",
    "AgentVariableKey",
    "AgentVariableOverride",
    "AgentVariableOverrides",
    "AgentWorkspaceBinding",
    "Any",
    "ApprovalStep",
    "ArtifactRef",
    "BindingAlias",
    "Bool",
    "CodeStep",
    "CompletionPolicy",
    "ContentPart",
    "ContextPolicy",
    "ContextRetain",
    "ContextSummarizer",
    "ContextTrigger",
    "ContextVariablePolicy",
    "ConversationContentPart",
    "ConversationFilePart",
    "ConversationImagePart",
    "ConversationJsonPart",
    "ConversationMessage",
    "ConversationMessageInput",
    "ConversationMessages",
    "ConversationMessagesInput",
    "ConversationTextPart",
    "ExecutionCursor",
    "ExecutionPolicies",
    "ExplicitModelReference",
    "FilePart",
    "ImagePart",
    "IsoDateTime",
    "JsonObject",
    "JsonPart",
    "JsonValue",
    "LoopDefinition",
    "LoopStep",
    "ManifestLimits",
    "MessagesContextPolicy",
    "MessagesMarker",
    "MessagesMarkers",
    "MessagesSignature",
    "ModelReference",
    "ModelRetryPolicy",
    "ModelUsage",
    "NonEmpty",
    "OutputRepairPolicy",
    "ProfileModelReference",
    "PromptMessage",
    "PromptStep",
    "ReasoningPart",
    "RunBudgetState",
    "RunCheckpoint",
    "RunError",
    "RunMessagesState",
    "StepBase",
    "StepHistory",
    "StepHistoryOptions",
    "StepResult",
    "Str",
    "SubRunStep",
    "SummarizerPrompts",
    "TextPart",
    "ToolCall",
    "ToolCallPart",
    "ToolResult",
    "ToolResultPart",
    "TranscriptItem",
    "VariablePath",
    "VariableState",
    "WebhookStep",
    "ZodModel",
    "agent_manifest_structure_issue",
    "annotations",
    "any_aborting",
    "array",
    "boolean",
    "custom",
    "discriminated",
    "enum",
    "integer",
    "is_safe_variable_path",
    "js_strings",
    "json_object",
    "json_value",
    "lazy",
    "literal",
    "messages_marker_of",
    "number",
    "optional",
    "record",
    "string",
    "tag",
    "union",
    "validate",
    "value_matches_agent_variable_type",
]
