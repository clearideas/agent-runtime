"""AI SDK Core and ``AiSdkModelAdapter`` result assembly.

Provider modules produce what an AI SDK provider's ``doGenerate``/``doStream``
produces: content parts (``text``, ``reasoning``, ``tool-call``, ...) with
``providerMetadata``, a usage object (``{inputTokens: {total, noCache,
cacheRead, cacheWrite}, outputTokens: {total, text, reasoning}, raw}``), a
finish reason, and provider metadata. This module does what AI SDK Core does
with them (tool-call parsing, response messages, usage totals) and what the
TypeScript ``AiSdkModelAdapter`` does with the result (the neutral
``ModelResult``: transcript, usage, tool calls, output).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..._js import json as js_json
from ..._js import strings as js_strings
from ..._js.errors import SyntaxError_

JsonObject = dict[str, Any]


# ─── Usage ──────────────────────────────────────────────────────────────────


def null_usage() -> JsonObject:
    return {
        "inputTokens": {"total": None, "noCache": None, "cacheRead": None, "cacheWrite": None},
        "outputTokens": {"total": None, "text": None, "reasoning": None},
        "raw": None,
    }


def _add(first: Any, second: Any) -> Any:
    if first is None and second is None:
        return None
    return (first or 0) + (second or 0)


def language_model_usage(usage: JsonObject | None) -> JsonObject:
    """``asLanguageModelUsage``: a provider usage object as the AI SDK reports it."""
    usage = usage or null_usage()
    inputs = usage.get("inputTokens") or {}
    outputs = usage.get("outputTokens") or {}
    return {
        "inputTokens": inputs.get("total"),
        "inputTokenDetails": {
            "noCacheTokens": inputs.get("noCache"),
            "cacheReadTokens": inputs.get("cacheRead"),
            "cacheWriteTokens": inputs.get("cacheWrite"),
        },
        "outputTokens": outputs.get("total"),
        "outputTokenDetails": {"textTokens": outputs.get("text"), "reasoningTokens": outputs.get("reasoning")},
        "totalTokens": _add(inputs.get("total"), outputs.get("total")),
        "raw": usage.get("raw"),
    }


def model_usage(usage: JsonObject | None) -> JsonObject | None:
    """``toModelUsage`` (``AiSdkModelAdapter``): the runtime's ``ModelUsage``."""
    if usage is None:
        return None
    mapped: JsonObject = {}
    if usage.get("inputTokens") is not None:
        mapped["inputTokens"] = usage["inputTokens"]
    if usage.get("outputTokens") is not None:
        mapped["outputTokens"] = usage["outputTokens"]
    reasoning = (usage.get("outputTokenDetails") or {}).get("reasoningTokens")
    if reasoning is not None:
        mapped["reasoningTokens"] = reasoning
    cache_read = (usage.get("inputTokenDetails") or {}).get("cacheReadTokens")
    if cache_read is not None:
        mapped["cachedInputTokens"] = cache_read
    cache_write = (usage.get("inputTokenDetails") or {}).get("cacheWriteTokens")
    if cache_write is not None:
        mapped["cacheWriteTokens"] = cache_write
    if usage.get("totalTokens") is not None:
        mapped["totalTokens"] = usage["totalTokens"]
    raw = to_json_object(usage.get("raw"))
    if raw is not None:
        mapped["metadata"] = raw
    return mapped or None


# ─── JSON helpers (``toJsonValue`` / ``toJsonObject``) ───────────────────────


_OMIT = object()


def to_json_value(value: Any) -> Any:
    """``toJsonValue``: ``undefined`` entries are dropped, non-finite numbers become strings."""
    if value is None or value is _OMIT:
        return None
    if isinstance(value, bool | str):
        return value
    if isinstance(value, int | float):
        return js_json.normalize(value) if _finite(value) else js_json.number_to_string(value)
    if isinstance(value, list | tuple):
        return [to_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): to_json_value(item) for key, item in value.items() if item is not _OMIT}
    return str(value)


def _finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


def to_json_object(value: Any) -> JsonObject | None:
    converted = to_json_value(value)
    return converted if isinstance(converted, dict) else None


def omit_none(**values: Any) -> JsonObject:
    """An object literal with ``undefined`` (``None``) members left out."""
    return {key: value for key, value in values.items() if value is not None}


# ─── Tool calls (``parseToolCall``) ──────────────────────────────────────────


def to_string(error: BaseException) -> str:
    """``Error.prototype.toString``: ``name: message``."""
    name = getattr(error, "name", None)
    name = name if isinstance(name, str) else "Error"
    message = getattr(error, "message", None)
    message = message if isinstance(message, str) else str(error)
    if not name:
        return message
    return f"{name}: {message}" if message else name


class AiSdkError(Exception):
    name = "AI_SDKError"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class NoSuchToolError(AiSdkError):
    name = "AI_NoSuchToolError"

    def __init__(self, tool_name: str, available: list[str] | None) -> None:
        listed = "No tools are available." if available is None else f"Available tools: {', '.join(available)}."
        super().__init__(f"Model tried to call unavailable tool '{tool_name}'. {listed}")


class JsonParseError(AiSdkError):
    name = "AI_JSONParseError"

    def __init__(self, text: str, cause: BaseException) -> None:
        super().__init__(f"JSON parsing failed: Text: {text}.\nError message: {error_message(cause)}")
        self.cause = cause


class InvalidToolInputError(AiSdkError):
    name = "AI_InvalidToolInputError"

    def __init__(self, tool_name: str, text: str, cause: BaseException) -> None:
        super().__init__(f"Invalid input for tool {tool_name}: {error_message(JsonParseError(text, cause))}")


_SUSPECT_PROTO = re.compile(
    r'"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)'
    r'(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:'
)
_SUSPECT_CONSTRUCTOR = re.compile(
    r'"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)'
    r'(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:'
)


def secure_json_parse(text: str) -> Any:
    """``secureJsonParse`` (provider-utils): ``JSON.parse`` that rejects prototype keys."""
    value = js_json.parse(text)
    if not isinstance(value, dict | list):
        return value
    if not _SUSPECT_PROTO.search(text) and not _SUSPECT_CONSTRUCTOR.search(text):
        return value
    pending: list[Any] = [value]
    while pending:
        nodes, pending = pending, []
        for node in nodes:
            if isinstance(node, dict):
                constructor = node.get("constructor")
                if "__proto__" in node or (isinstance(constructor, dict) and "prototype" in constructor):
                    raise SyntaxError_("Object contains forbidden prototype property")
                items = node.values()
            else:
                items = node
            pending.extend(item for item in items if isinstance(item, dict | list) and item)
    return value


def parse_tool_call(part: JsonObject, tools: list[str] | None) -> JsonObject:
    """A provider ``tool-call`` part (input as text) as AI SDK Core reports it.

    Provider-executed calls are kept as parsed JSON; calls to unknown tools or
    with unparsable input are marked ``invalid`` with the AI SDK's error.
    """
    text = part.get("input")
    text = text if isinstance(text, str) else js_json.stringify(text)
    try:
        if tools is None or part["toolName"] not in tools:
            if part.get("providerExecuted"):
                value = {} if js_strings.trim(text) == "" else secure_json_parse(text)
                return _tool_call(part, value)
            raise NoSuchToolError(part["toolName"], tools)
        try:
            value = {} if js_strings.trim(text) == "" else secure_json_parse(text)
        except ValueError as error:
            raise InvalidToolInputError(part["toolName"], text, error) from error
        return _tool_call(part, value)
    except (AiSdkError, ValueError) as error:
        try:
            value = secure_json_parse(text)
        except ValueError:
            value = text
        call = _tool_call(part, value)
        call["dynamic"] = True
        call["invalid"] = True
        call["error"] = error
        return call


def _tool_call(part: JsonObject, value: Any) -> JsonObject:
    call: JsonObject = {"type": "tool-call", "toolCallId": part["toolCallId"], "toolName": part["toolName"]}
    call["input"] = value
    if part.get("providerExecuted") is not None:
        call["providerExecuted"] = part["providerExecuted"]
    if part.get("providerMetadata") is not None:
        call["providerMetadata"] = part["providerMetadata"]
    return call


def error_message(error: Any) -> str:
    """``getErrorMessage``: ``String(error)`` for errors."""
    if error is None:
        return "unknown error"
    if isinstance(error, str):
        return error
    if isinstance(error, BaseException):
        return to_string(error)
    return js_json.stringify(error)


# ─── Step content and response messages ─────────────────────────────────────


def step_content(content: list[JsonObject], tools: list[str] | None) -> list[JsonObject]:
    """``generateText``: provider content with tool calls parsed and tool errors for invalid calls."""
    step: list[JsonObject] = []
    for part in content:
        if part["type"] == "tool-call":
            call = parse_tool_call(part, tools)
            step.append(call)
            if call.get("invalid"):
                step.append(
                    {
                        "type": "tool-error",
                        "toolCallId": call["toolCallId"],
                        "toolName": call["toolName"],
                        "input": call["input"],
                        "error": error_message(call["error"]),
                        "dynamic": True,
                    }
                )
        elif part["type"] in ("tool-approval-request", "source"):
            step.append(part)
        else:
            step.append(part)
    return step


def response_messages(content: list[JsonObject]) -> list[JsonObject]:
    """``toResponseMessages`` for the content a prompt step receives."""
    messages: list[JsonObject] = []
    order: dict[str, int] = {}
    assistant: list[JsonObject] = []
    for part in content:
        kind = part["type"]
        if kind == "source":
            continue
        if kind in ("tool-result", "tool-error") and not part.get("providerExecuted"):
            continue
        if kind == "text" and part.get("text", "") == "" and part.get("providerMetadata") is None:
            continue
        if kind == "text":
            assistant.append(_with_options({"type": "text", "text": part["text"]}, part))
        elif kind == "custom":
            assistant.append(_with_options({"type": "custom", "kind": part["kind"]}, part))
        elif kind == "reasoning":
            assistant.append(_with_options({"type": "reasoning", "text": part["text"]}, part))
        elif kind in ("file", "reasoning-file"):
            assistant.append(
                _with_options(
                    {"type": kind, "data": part["file"]["base64"], "mediaType": part["file"]["mediaType"]}, part
                )
            )
        elif kind == "tool-call":
            order.setdefault(part["toolCallId"], len(order))
            value = part["input"]
            # `typeof part.input !== "object"` (null is an object in JavaScript).
            if part.get("invalid") and value is not None and not isinstance(value, dict | list):
                value = {}
            item: JsonObject = {
                "type": "tool-call",
                "toolCallId": part["toolCallId"],
                "toolName": part["toolName"],
                "input": value,
            }
            if part.get("providerExecuted") is not None:
                item["providerExecuted"] = part["providerExecuted"]
            assistant.append(_with_options(item, part))
        elif kind == "tool-result":
            assistant.append(
                _with_options(
                    {
                        "type": "tool-result",
                        "toolCallId": part["toolCallId"],
                        "toolName": part["toolName"],
                        "output": _tool_output(part.get("output"), "none"),
                    },
                    part,
                )
            )
        elif kind == "tool-error":
            assistant.append(
                _with_options(
                    {
                        "type": "tool-result",
                        "toolCallId": part["toolCallId"],
                        "toolName": part["toolName"],
                        "output": _tool_output(part.get("error"), "json"),
                    },
                    part,
                )
            )
    if assistant:
        messages.append({"role": "assistant", "content": assistant})
    results: list[JsonObject] = []
    for part in content:
        if part["type"] not in ("tool-result", "tool-error") or part.get("providerExecuted"):
            continue
        error = part["type"] == "tool-error"
        result: JsonObject = {
            "type": "tool-result",
            "toolCallId": part["toolCallId"],
            "toolName": part["toolName"],
            "output": _tool_output(part.get("error") if error else part.get("output"), "text" if error else "none"),
        }
        if part.get("providerMetadata") is not None:
            result["providerOptions"] = part["providerMetadata"]
        results.append(result)
    if results:
        results.sort(key=lambda item: order.get(item["toolCallId"], len(order)))
        messages.append({"role": "tool", "content": results})
    return messages


def _with_options(item: JsonObject, part: JsonObject) -> JsonObject:
    item["providerOptions"] = part.get("providerMetadata")
    return item


def _tool_output(output: Any, error_mode: str) -> JsonObject:
    """``createToolModelOutput`` for tools without ``toModelOutput``."""
    if error_mode == "text":
        return {"type": "error-text", "value": error_message(output)}
    if error_mode == "json":
        return {"type": "error-json", "value": to_json_value(output)}
    if isinstance(output, str):
        return {"type": "text", "value": output}
    return {"type": "json", "value": to_json_value(output)}


# ─── ModelResult (``AiSdkModelAdapter.#buildModelResult``) ───────────────────


def _part_options(part: JsonObject) -> JsonObject:
    options = part.get("providerOptions")
    if options is None:
        return {}
    converted = to_json_object(options)
    return {"providerOptions": converted if converted is not None else {"value": to_json_value(options)}}


def _tool_result_output(output: Any) -> JsonObject:
    if not isinstance(output, dict):
        return {"output": to_json_value(output)}
    kind = output.get("type")
    if kind in ("text", "json"):
        return {"output": to_json_value(output.get("value"))}
    if kind in ("error-text", "error-json"):
        value = output.get("value")
        return {
            "error": {"code": "tool_error", "message": value if isinstance(value, str) else js_json.stringify(value)}
        }
    if kind == "execution-denied":
        reason = output.get("reason")
        return {
            "error": {
                "code": "tool_execution_denied",
                "message": reason if isinstance(reason, str) else "Tool execution was denied.",
            }
        }
    return {"output": to_json_value(output)}


def _runtime_part(part: JsonObject) -> JsonObject:
    kind = part["type"]
    if kind == "text":
        text = part.get("text")
        return {"type": "text", "text": text if isinstance(text, str) else "", **_part_options(part)}
    if kind == "reasoning":
        text = part.get("text")
        return {"type": "reasoning", **({"text": text} if isinstance(text, str) else {}), **_part_options(part)}
    if kind == "tool-call":
        value = part.get("input")
        call: JsonObject = {
            "id": part["toolCallId"],
            "name": part["toolName"],
            "input": _json_object_or_value(value),
        }
        if isinstance(part.get("providerExecuted"), bool):
            call["providerExecuted"] = part["providerExecuted"]
        return {"type": "tool-call", "call": call, **_part_options(part)}
    if kind == "tool-result":
        return {
            "type": "tool-result",
            "result": {
                "callId": part["toolCallId"],
                "name": part["toolName"],
                **_tool_result_output(part.get("output")),
            },
            **_part_options(part),
        }
    if kind == "file":
        data = part.get("data")
        if not isinstance(data, str):
            raise ValueError("AI SDK returned file content that cannot be durably replayed")
        if not isinstance(part.get("mediaType"), str):
            raise ValueError("AI SDK returned file content without a media type")
        file: JsonObject = {"type": "file", "data": data, "mediaType": part["mediaType"]}
        if isinstance(part.get("filename"), str):
            file["name"] = part["filename"]
        return {**file, **_part_options(part)}
    raise ValueError(f"AI SDK returned unsupported replay content: {kind}")


def transcript_item(message: JsonObject, item_id: str, created_at: str, model: str) -> JsonObject | None:
    """``fromAiSdkResponseMessage``."""
    role = message["role"]
    if role not in ("assistant", "tool"):
        return None
    raw = message["content"]
    raw = [{"type": "text", "text": raw}] if isinstance(raw, str) else raw
    content = [
        _runtime_part(part)
        for part in raw
        if not (role == "assistant" and part.get("type") == "custom" and part.get("kind") == "anthropic.message_start")
    ]
    item: JsonObject = {
        "id": item_id,
        "type": "tool-result" if role == "tool" else "message",
        "role": role,
        "content": content,
        "createdAt": created_at,
        "model": model,
    }
    options = to_json_object(message.get("providerOptions"))
    if options:
        item["providerOptions"] = options
    return item


def _json_object_or_value(value: Any) -> JsonObject:
    converted = to_json_object(value)
    return converted if converted is not None else {"value": to_json_value(value)}


def to_tool_call(call: JsonObject) -> JsonObject:
    """``toToolCall``."""
    value = call.get("input")
    mapped: JsonObject = {
        "id": call["toolCallId"],
        "name": call["toolName"],
        "input": _json_object_or_value(value),
    }
    if call.get("providerExecuted") is not None:
        mapped["providerExecuted"] = call["providerExecuted"]
    if call.get("invalid") is True:
        error = call.get("error")
        message = (
            str(error) if isinstance(error, BaseException) else "Invalid tool call." if error is None else str(error)
        )
        mapped["metadata"] = {"agentRuntime": {"invalid": True, "error": message}}
    return mapped


@dataclass
class StepResult:
    """What ``AiSdkModelAdapter`` reads from ``generateText``/``streamText``."""

    text: str = ""
    reasoning: str = ""
    tool_calls: list[JsonObject] = field(default_factory=list)
    finish_reason: str | None = None
    usage: JsonObject | None = None
    provider_metadata: Any = None
    response_messages: list[JsonObject] | None = None
    structured_output: Any = _OMIT


def build_model_result(
    request: JsonObject, step: StepResult, now: Callable[[], str], generate_id: Callable[[], str]
) -> JsonObject:
    """``#buildModelResult``."""
    content: list[JsonObject] = []
    if step.reasoning:
        content.append({"type": "reasoning", "text": step.reasoning})
    if step.text:
        content.append({"type": "text", "text": step.text})
    content.extend({"type": "tool-call", "call": call} for call in step.tool_calls)
    if not step.response_messages:
        transcript: list[JsonObject] = [
            {
                "id": generate_id(),
                "type": "message",
                "role": "assistant",
                "content": content,
                "createdAt": now(),
                "model": request["model"],
            }
        ]
    else:
        transcript = []
        for message in step.response_messages:
            item = transcript_item(message, generate_id(), now(), request["model"])
            if item is not None:
                transcript.append(item)
    usage = model_usage(step.usage)
    usage_item = next((item for item in reversed(transcript) if item["role"] == "assistant"), None)
    if usage is not None and usage_item is not None:
        usage_item["usage"] = usage
    result: JsonObject = {
        "output": step.text if step.structured_output is _OMIT else to_json_value(step.structured_output),
        "transcript": transcript,
        "toolCalls": step.tool_calls,
    }
    if step.finish_reason is not None:
        result["finishReason"] = step.finish_reason
    metadata = to_json_object(step.provider_metadata)
    if metadata is not None:
        result["providerMetadata"] = metadata
    return result


OMIT = _OMIT


# ─── generateText / streamText ───────────────────────────────────────────────


class StructuredOutputError(Exception):
    """``NoObjectGeneratedError`` (raised by the adapter as its own error type)."""

    def __init__(self, text: str) -> None:
        super().__init__("No object generated: could not parse the response.")
        self.text = text


def _structured(request: JsonObject, tool_calls: list[JsonObject], text: str) -> Any:
    if request.get("outputSchema") is None or tool_calls:
        return _OMIT
    try:
        return secure_json_parse(text)
    except ValueError as error:
        raise StructuredOutputError(text) from error


def generate_step(
    request: JsonObject,
    content: list[JsonObject],
    finish_reason: JsonObject,
    usage: JsonObject | None,
    provider_metadata: Any,
    tools: list[str] | None,
    structured_output_text: str | None = None,
) -> StepResult:
    """``generateText`` for one step, as ``AiSdkModelAdapter`` reads it."""
    step = step_content(content, tools)
    calls = [part for part in step if part["type"] == "tool-call"]
    text = "".join(part["text"] for part in step if part["type"] == "text")
    reasoning = [part["text"] for part in step if part["type"] == "reasoning"]
    tool_calls = [to_tool_call(call) for call in calls]
    return StepResult(
        text=text,
        reasoning="".join(reasoning) if reasoning else "",
        tool_calls=tool_calls,
        finish_reason=finish_reason.get("unified"),
        usage=language_model_usage(usage),
        provider_metadata=provider_metadata,
        response_messages=response_messages(step),
        structured_output=_structured(
            request, tool_calls, structured_output_text if structured_output_text is not None else text
        ),
    )


class StreamError(Exception):
    """An ``error`` stream part (``normalizeError``)."""


class StreamAccumulator:
    """``streamText`` (one step) and ``AiSdkModelAdapter.stream``'s handling of its parts."""

    def __init__(self, request: JsonObject, tools: list[str] | None) -> None:
        self.request = request
        self.tools = tools
        self.content: list[JsonObject] = []
        self._text: dict[Any, JsonObject] = {}
        self._reasoning: dict[Any, JsonObject] = {}
        self.text = ""
        self.reasoning = ""
        self.tool_calls: list[JsonObject] = []
        self.finish_reason: str | None = None
        self.usage: JsonObject | None = None
        self.provider_metadata: Any = None

    def process(self, part: JsonObject) -> list[JsonObject]:
        """One provider stream part; returns the runtime ``ModelEvent``s it produces."""
        kind = part["type"]
        events: list[JsonObject] = []
        if kind == "text-start":
            active = {"type": "text", "text": "", "providerMetadata": part.get("providerMetadata")}
            self._text[part["id"]] = active
            self.content.append(active)
        elif kind == "text-delta":
            delta = part.get("delta") or ""
            if delta == "" and part.get("providerMetadata") is None:
                return events
            active = self._text.get(part["id"])
            if active is None:
                raise StreamError(f"text part {part['id']} not found")
            active["text"] += delta
            if part.get("providerMetadata") is not None:
                active["providerMetadata"] = part["providerMetadata"]
            self.text += delta
            events.append({"type": "text-delta", "delta": delta})
        elif kind == "text-end":
            active = self._text.pop(part["id"], None)
            if active is None:
                raise StreamError(f"text part {part['id']} not found")
            if part.get("providerMetadata") is not None:
                active["providerMetadata"] = part["providerMetadata"]
        elif kind == "reasoning-start":
            active = {"type": "reasoning", "text": "", "providerMetadata": part.get("providerMetadata")}
            self._reasoning[part["id"]] = active
            self.content.append(active)
        elif kind == "reasoning-delta":
            active = self._reasoning.get(part["id"])
            if active is None:
                raise StreamError(f"reasoning part {part['id']} not found")
            delta = part.get("delta") or ""
            active["text"] += delta
            if part.get("providerMetadata") is not None:
                active["providerMetadata"] = part["providerMetadata"]
            self.reasoning += delta
            events.append({"type": "reasoning-delta", "delta": delta})
        elif kind == "reasoning-end":
            active = self._reasoning.pop(part["id"], None)
            if active is None:
                raise StreamError(f"reasoning part {part['id']} not found")
            if part.get("providerMetadata") is not None:
                active["providerMetadata"] = part["providerMetadata"]
        elif kind == "tool-call":
            call = parse_tool_call(part, self.tools)
            self.content.append(call)
            mapped = to_tool_call(call)
            self.tool_calls.append(mapped)
            events.append({"type": "tool-call", "call": mapped})
            if call.get("invalid"):
                self.content.append(
                    {
                        "type": "tool-error",
                        "toolCallId": call["toolCallId"],
                        "toolName": call["toolName"],
                        "input": call["input"],
                        "error": error_message(call["error"]),
                        "dynamic": True,
                    }
                )
        elif kind in ("tool-result", "file", "reasoning-file", "custom", "source"):
            self.content.append(part)
        elif kind == "error":
            error = part.get("error")
            raise StreamError(error if isinstance(error, str) else js_json.stringify(error))
        elif kind == "finish":
            self.finish_reason = (part.get("finishReason") or {}).get("unified")
            self.usage = language_model_usage(part.get("usage"))
            self.provider_metadata = part.get("providerMetadata")
        return events

    def step(self) -> StepResult:
        return StepResult(
            text=self.text,
            reasoning=self.reasoning,
            tool_calls=self.tool_calls,
            finish_reason=self.finish_reason,
            usage=self.usage,
            provider_metadata=self.provider_metadata,
            response_messages=response_messages(self.content),
            structured_output=_structured(self.request, self.tool_calls, self.text),
        )
