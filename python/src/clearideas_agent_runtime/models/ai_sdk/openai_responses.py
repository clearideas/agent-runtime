"""``@ai-sdk/openai`` Responses API results (``OpenAIResponsesLanguageModel``).

``generate`` ports the content, finish reason, usage, and provider metadata of
``doGenerate``; ``StreamParser`` ports ``doStream``'s event handling. Both
cover the output items a runtime request can produce (function tools only):
``reasoning``, ``message`` (text and refusals), and ``function_call``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .core import JsonObject, null_usage
from .shape import arr, obj, shape

PROVIDER = "openai"

#: ``logprobs`` of an output text part (``openaiResponsesChunkSchema`` / response schema).
LOGPROBS = arr(obj("token", "logprob", ("top_logprobs", arr(obj("token", "logprob")))))


@dataclass
class Context:
    key: str = PROVIDER
    #: ``providerOptions.openai.store === true`` (the stream concludes reasoning parts early).
    store: bool = False
    logprobs: bool = False
    json_response: bool = False


@dataclass
class GenerateResult:
    content: list[JsonObject]
    finish_reason: JsonObject
    usage: JsonObject
    provider_metadata: JsonObject
    structured_output_text: str | None = None


def convert_usage(usage: JsonObject | None) -> JsonObject:
    """``convertOpenAIResponsesUsage``."""
    if usage is None:
        return null_usage()
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    cached = (usage.get("input_tokens_details") or {}).get("cached_tokens")
    cached = 0 if cached is None else cached
    cache_write = (usage.get("input_tokens_details") or {}).get("cache_write_tokens")
    reasoning = (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
    reasoning = 0 if reasoning is None else reasoning
    return {
        "inputTokens": {
            "total": input_tokens,
            "noCache": input_tokens - cached - (cache_write or 0),
            "cacheRead": cached,
            "cacheWrite": cache_write,
        },
        "outputTokens": {"total": output_tokens, "text": output_tokens - reasoning, "reasoning": reasoning},
        "raw": usage,
    }


def finish_reason(reason: str | None, has_function_call: bool, has_refusal: bool = False) -> str:
    """``mapOpenAIResponseFinishReason``."""
    if reason is None:
        if has_function_call:
            return "tool-calls"
        return "content-filter" if has_refusal else "stop"
    if reason == "max_output_tokens":
        return "length"
    if reason == "content_filter":
        return "content-filter"
    return "tool-calls" if has_function_call else "other"


def _metadata(key: str, response_id: Any, logprobs: list[Any], response: JsonObject) -> JsonObject:
    values: JsonObject = {"responseId": response_id}
    if logprobs:
        values["logprobs"] = logprobs
    if isinstance(response.get("service_tier"), str):
        values["serviceTier"] = response["service_tier"]
    if (response.get("reasoning") or {}).get("context") is not None:
        values["reasoningContext"] = response["reasoning"]["context"]
    return {key: values}


def _call_metadata(item: JsonObject, extra_async: Any = None) -> JsonObject:
    values: JsonObject = {"itemId": item.get("id")}
    if item.get("async") is not None:
        values["async"] = item["async"]
    elif extra_async is not None:
        values["async"] = extra_async
    if item.get("namespace") is not None:
        values["namespace"] = item["namespace"]
    caller = item.get("caller")
    if caller is not None:
        values["caller"] = (
            {"type": "program", "callerId": caller.get("caller_id")} if caller.get("type") == "program" else caller
        )
    return values


class ResponseError(Exception):
    """The response reported an error (``APICallError``)."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def generate(response: JsonObject, context: Context) -> GenerateResult:
    key = context.key
    if response.get("error") is not None:
        raise ResponseError(response["error"].get("message", ""), 400)
    if response.get("output") is None:
        detail = (response.get("incomplete_details") or {}).get("reason")
        message = f"Responses API returned no output ({detail})" if detail else "Responses API returned no output"
        raise ResponseError(message, 500)
    content: list[JsonObject] = []
    logprobs: list[Any] = []
    has_function_call = False
    has_refusal = False
    structured: str | None = None
    for part in response["output"]:
        kind = part.get("type")
        if kind == "reasoning":
            summaries = part.get("summary") or []
            if not summaries:
                summaries = [{"type": "summary_text", "text": ""}]
            for summary in summaries:
                content.append(
                    {
                        "type": "reasoning",
                        "text": summary.get("text"),
                        "providerMetadata": {
                            key: {"itemId": part.get("id"), "reasoningEncryptedContent": part.get("encrypted_content")}
                        },
                    }
                )
        elif kind == "message":
            phase = part.get("phase")
            if context.json_response and phase == "final_answer":
                structured = "".join(
                    item.get("text") if item.get("type") == "output_text" else item.get("refusal") or ""
                    for item in part.get("content") or []
                )
            for item in part.get("content") or []:
                if item.get("type") == "refusal":
                    has_refusal = True
                    values: JsonObject = {"itemId": part.get("id")}
                    if phase is not None:
                        values["phase"] = phase
                    content.append({"type": "text", "text": item.get("refusal"), "providerMetadata": {key: values}})
                    continue
                if context.logprobs and item.get("logprobs") is not None:
                    logprobs.append(shape(item["logprobs"], LOGPROBS))
                values = {"itemId": part.get("id")}
                if phase is not None:
                    values["phase"] = phase
                annotations = item.get("annotations") or []
                if annotations:
                    values["annotations"] = annotations
                content.append({"type": "text", "text": item.get("text"), "providerMetadata": {key: values}})
        elif kind == "function_call":
            has_function_call = True
            content.append(
                {
                    "type": "tool-call",
                    "toolCallId": part.get("call_id"),
                    "toolName": part.get("name"),
                    "input": part.get("arguments"),
                    "providerMetadata": {key: _call_metadata(part)},
                }
            )
    reason = (response.get("incomplete_details") or {}).get("reason")
    return GenerateResult(
        content=content,
        finish_reason={"unified": finish_reason(reason, has_function_call, has_refusal), "raw": reason},
        usage=convert_usage(response.get("usage")),
        provider_metadata=_metadata(key, response.get("id"), logprobs, response),
        structured_output_text=structured,
    )


@dataclass
class _Reasoning:
    encrypted_content: Any
    summary_parts: dict[Any, str] = field(default_factory=dict)


class StreamParser:
    """``doStream``'s transform: Responses API events → AI SDK stream parts."""

    def __init__(self, context: Context) -> None:
        self.context = context
        self.finish: JsonObject = {"unified": "interrupted", "raw": None}
        self.usage: JsonObject | None = None
        self.logprobs: list[Any] = []
        self.response_id: Any = None
        self.tool_calls: dict[Any, JsonObject] = {}
        self.annotations: list[Any] = []
        self.message_phase: Any = None
        self.has_function_call = False
        self.has_refusal = False
        self.reasoning: dict[str, _Reasoning] = {}
        self.output_item_ids: dict[Any, Any] = {}
        self.service_tier: Any = None
        self.reasoning_context: Any = None
        self.stream_error = False
        self.error: Any = None

    def _item_id(self, item_id: Any, output_index: Any) -> Any:
        if output_index is None:
            return item_id
        resolved = self.output_item_ids.get(output_index)
        return item_id if resolved is None else resolved

    def feed(self, value: JsonObject) -> list[JsonObject]:
        key = self.context.key
        kind = value.get("type")
        parts: list[JsonObject] = []
        if kind == "response.output_item.added":
            item = value["item"]
            item_type = item.get("type")
            if item_type == "function_call":
                self.tool_calls[value["output_index"]] = {
                    "toolName": item.get("name"),
                    "toolCallId": item.get("call_id"),
                    "async": item.get("async"),
                }
                parts.append({"type": "tool-input-start", "id": item.get("call_id"), "toolName": item.get("name")})
            elif item_type == "message":
                self.output_item_ids[value["output_index"]] = item.get("id")
                self.annotations = []
                self.message_phase = item.get("phase")
                values: JsonObject = {"itemId": item.get("id")}
                if item.get("phase") is not None:
                    values["phase"] = item["phase"]
                parts.append({"type": "text-start", "id": item.get("id"), "providerMetadata": {key: values}})
            elif item_type == "reasoning":
                self.output_item_ids[value["output_index"]] = item.get("id")
                self.reasoning[item.get("id")] = _Reasoning(item.get("encrypted_content"), {0: "active"})
                parts.append(
                    {
                        "type": "reasoning-start",
                        "id": f"{item.get('id')}:0",
                        "providerMetadata": {
                            key: {"itemId": item.get("id"), "reasoningEncryptedContent": item.get("encrypted_content")}
                        },
                    }
                )
        elif kind == "response.output_item.done":
            item = value["item"]
            item_type = item.get("type")
            if item_type == "message":
                item_id = self._item_id(item.get("id"), value.get("output_index"))
                phase = item.get("phase") if item.get("phase") is not None else self.message_phase
                self.message_phase = None
                values = {"itemId": item_id}
                if phase is not None:
                    values["phase"] = phase
                if self.annotations:
                    values["annotations"] = self.annotations
                parts.append({"type": "text-end", "id": item_id, "providerMetadata": {key: values}})
                self.output_item_ids.pop(value.get("output_index"), None)
            elif item_type == "function_call":
                ongoing = self.tool_calls.pop(value.get("output_index"), None) or {}
                self.has_function_call = True
                end: JsonObject = {"type": "tool-input-end", "id": item.get("call_id")}
                if item.get("namespace") is not None:
                    end["providerMetadata"] = {key: {"namespace": item["namespace"]}}
                parts.append(end)
                parts.append(
                    {
                        "type": "tool-call",
                        "toolCallId": item.get("call_id"),
                        "toolName": item.get("name"),
                        "input": item.get("arguments"),
                        "providerMetadata": {key: _call_metadata(item, ongoing.get("async"))},
                    }
                )
            elif item_type == "reasoning":
                item_id = self._item_id(item.get("id"), value.get("output_index"))
                active = self.reasoning.get(item_id)
                if active is not None:
                    for index, status in active.summary_parts.items():
                        if status in ("active", "can-conclude"):
                            parts.append(
                                {
                                    "type": "reasoning-end",
                                    "id": f"{item_id}:{index}",
                                    "providerMetadata": {
                                        key: {
                                            "itemId": item_id,
                                            "reasoningEncryptedContent": item.get("encrypted_content"),
                                        }
                                    },
                                }
                            )
                    del self.reasoning[item_id]
                self.output_item_ids.pop(value.get("output_index"), None)
        elif kind == "response.function_call_arguments.delta":
            ongoing = self.tool_calls.get(value.get("output_index"))
            if ongoing is not None:
                parts.append({"type": "tool-input-delta", "id": ongoing["toolCallId"], "delta": value.get("delta")})
        elif kind == "response.created":
            self.response_id = value["response"].get("id")
            parts.append({"type": "response-metadata", "id": self.response_id})
        elif kind == "response.output_text.delta":
            item_id = self._item_id(value.get("item_id"), value.get("output_index"))
            parts.append({"type": "text-delta", "id": item_id, "delta": value.get("delta")})
            if self.context.logprobs and value.get("logprobs") is not None:
                self.logprobs.append(shape(value["logprobs"], LOGPROBS))
        elif kind == "response.refusal.delta":
            self.has_refusal = True
            item_id = self._item_id(value.get("item_id"), value.get("output_index"))
            parts.append({"type": "text-delta", "id": item_id, "delta": value.get("delta")})
        elif kind == "response.refusal.done":
            self.has_refusal = True
        elif kind == "response.reasoning_summary_part.added":
            item_id = self._item_id(value.get("item_id"), value.get("output_index"))
            index = value.get("summary_index")
            if index and index > 0:
                active = self.reasoning.get(item_id)
                if active is not None:
                    active.summary_parts[index] = "active"
                    for summary_index, status in list(active.summary_parts.items()):
                        if status == "can-conclude":
                            parts.append(
                                {
                                    "type": "reasoning-end",
                                    "id": f"{item_id}:{summary_index}",
                                    "providerMetadata": {key: {"itemId": item_id}},
                                }
                            )
                            active.summary_parts[summary_index] = "concluded"
                    parts.append(
                        {
                            "type": "reasoning-start",
                            "id": f"{item_id}:{index}",
                            "providerMetadata": {
                                key: {"itemId": item_id, "reasoningEncryptedContent": active.encrypted_content}
                            },
                        }
                    )
        elif kind == "response.reasoning_summary_text.delta":
            item_id = self._item_id(value.get("item_id"), value.get("output_index"))
            parts.append(
                {
                    "type": "reasoning-delta",
                    "id": f"{item_id}:{value.get('summary_index')}",
                    "delta": value.get("delta"),
                    "providerMetadata": {key: {"itemId": item_id}},
                }
            )
        elif kind == "response.reasoning_summary_part.done":
            item_id = self._item_id(value.get("item_id"), value.get("output_index"))
            active = self.reasoning.get(item_id)
            if active is not None:
                index = value.get("summary_index")
                if self.context.store:
                    parts.append(
                        {
                            "type": "reasoning-end",
                            "id": f"{item_id}:{index}",
                            "providerMetadata": {key: {"itemId": item_id}},
                        }
                    )
                    active.summary_parts[index] = "concluded"
                else:
                    active.summary_parts[index] = "can-conclude"
        elif kind in ("response.completed", "response.incomplete"):
            response = value.get("response") or {}
            reason = (response.get("incomplete_details") or {}).get("reason")
            if not self.stream_error:
                self.finish = {
                    "unified": finish_reason(reason, self.has_function_call, self.has_refusal),
                    "raw": reason,
                }
            self.usage = response.get("usage")
            if isinstance(response.get("service_tier"), str):
                self.service_tier = response["service_tier"]
            if (response.get("reasoning") or {}).get("context") is not None:
                self.reasoning_context = response["reasoning"]["context"]
        elif kind == "response.failed":
            response = value.get("response") or {}
            reason = (response.get("incomplete_details") or {}).get("reason")
            self.finish = {
                "unified": finish_reason(reason, self.has_function_call) if reason else "error",
                "raw": reason or "error",
            }
            self.usage = response.get("usage")
            if (response.get("reasoning") or {}).get("context") is not None:
                self.reasoning_context = response["reasoning"]["context"]
            if not self.stream_error and response.get("error") is not None:
                self.stream_error = True
                self.error = response["error"]
                parts.append({"type": "error", "error": response["error"]})
        elif kind == "response.output_text.annotation.added":
            self.annotations.append(value.get("annotation"))
        elif kind == "error":
            self.stream_error = True
            self.finish = {"unified": "error", "raw": "error"}
            self.error = value
            parts.append({"type": "error", "error": value})
        return parts

    def close(self) -> list[JsonObject]:
        values: JsonObject = {"responseId": self.response_id}
        if self.logprobs:
            values["logprobs"] = self.logprobs
        if self.service_tier is not None:
            values["serviceTier"] = self.service_tier
        if self.reasoning_context is not None:
            values["reasoningContext"] = self.reasoning_context
        return [
            {
                "type": "finish",
                "finishReason": self.finish,
                "usage": convert_usage(self.usage),
                "providerMetadata": {self.context.key: values},
            }
        ]
