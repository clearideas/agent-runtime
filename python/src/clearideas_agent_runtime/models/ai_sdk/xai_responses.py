"""``@ai-sdk/xai`` Responses API results (``XaiResponsesLanguageModel``).

Ports ``doGenerate``/``doStream`` for ``message``, ``reasoning``, and
``function_call`` output items.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .core import JsonObject
from .shape import loose, shape

#: ``xaiResponsesUsageSchema`` (``z.object(...).catchall(z.json())``).
USAGE = loose(
    "input_tokens",
    "output_tokens",
    "total_tokens",
    ("input_tokens_details", loose("cached_tokens")),
    ("output_tokens_details", loose("reasoning_tokens")),
    "num_sources_used",
    "num_server_side_tools_used",
    "cost_in_usd_ticks",
)

_ZERO_USAGE: JsonObject = {
    "inputTokens": {"total": 0, "noCache": 0, "cacheRead": 0, "cacheWrite": 0},
    "outputTokens": {"total": 0, "text": 0, "reasoning": 0},
}


def convert_usage(usage: JsonObject) -> JsonObject:
    """``convertXaiResponsesUsage``."""
    usage = shape(usage, USAGE)
    cached = (usage.get("input_tokens_details") or {}).get("cached_tokens")
    cached = 0 if cached is None else cached
    reasoning = (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
    reasoning = 0 if reasoning is None else reasoning
    includes_cached = cached <= usage["input_tokens"]
    return {
        "inputTokens": {
            "total": usage["input_tokens"] if includes_cached else usage["input_tokens"] + cached,
            "noCache": usage["input_tokens"] - cached if includes_cached else usage["input_tokens"],
            "cacheRead": cached,
            "cacheWrite": None,
        },
        "outputTokens": {
            "total": usage["output_tokens"],
            "text": usage["output_tokens"] - reasoning,
            "reasoning": reasoning,
        },
        "raw": usage,
    }


def finish_reason(reason: Any) -> str:
    """``mapXaiResponsesFinishReason``."""
    if reason in ("stop", "completed"):
        return "stop"
    if reason in ("length", "max_output_tokens"):
        return "length"
    if reason in ("tool_calls", "function_call"):
        return "tool-calls"
    if reason == "content_filter":
        return "content-filter"
    return "other"


def _metadata(cost: Any, service_tier: Any, cache_key: Any, safety: Any) -> JsonObject | None:
    if cost is None and service_tier is None and cache_key is None and safety is None:
        return None
    values: JsonObject = {}
    if cost is not None:
        values["costInUsdTicks"] = cost
    if service_tier is not None:
        values["serviceTier"] = service_tier
    if cache_key is not None:
        values["promptCacheKey"] = cache_key
    if safety is not None:
        values["safetyIdentifier"] = safety
    return {"xai": values}


@dataclass
class GenerateResult:
    content: list[JsonObject]
    finish_reason: JsonObject
    usage: JsonObject
    provider_metadata: JsonObject | None


def generate(response: JsonObject) -> GenerateResult:
    content: list[JsonObject] = []
    has_function_call = False
    for part in response.get("output") or []:
        kind = part.get("type")
        if kind == "message":
            for item in part.get("content") or []:
                if item.get("text"):
                    content.append({"type": "text", "text": item["text"]})
        elif kind == "function_call":
            has_function_call = True
            content.append(
                {
                    "type": "tool-call",
                    "toolCallId": part.get("call_id"),
                    "toolName": part.get("name"),
                    "input": part.get("arguments"),
                }
            )
        elif kind == "reasoning":
            summary = part.get("summary") or []
            texts = (
                [item.get("text") for item in summary]
                if summary
                else [item.get("text") for item in part.get("content") or []]
            )
            text = "".join(item for item in texts if item)
            encrypted = part.get("encrypted_content")
            if text or encrypted:
                reasoning: JsonObject = {"type": "reasoning", "text": text}
                if encrypted or part.get("id"):
                    values: JsonObject = {}
                    if encrypted:
                        values["reasoningEncryptedContent"] = encrypted
                    if part.get("id"):
                        values["itemId"] = part["id"]
                    reasoning["providerMetadata"] = {"xai": values}
                content.append(reasoning)
    usage_value = response.get("usage")
    reason = (response.get("incomplete_details") or {}).get("reason")
    raw = reason if reason is not None else response.get("status")
    return GenerateResult(
        content=content,
        finish_reason={"unified": "tool-calls" if has_function_call else finish_reason(raw), "raw": raw},
        usage=convert_usage(usage_value) if usage_value is not None else dict(_ZERO_USAGE),
        provider_metadata=_metadata(
            (usage_value or {}).get("cost_in_usd_ticks"),
            response.get("service_tier"),
            response.get("prompt_cache_key"),
            response.get("safety_identifier"),
        ),
    )


#: Event types ``xaiResponsesChunkSchema`` accepts (others fail validation).
KNOWN_EVENTS = frozenset(
    [
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.output_item.done",
        "response.content_part.added",
        "response.content_part.done",
        "response.output_text.delta",
        "response.output_text.done",
        "response.output_text.annotation.added",
        "response.reasoning_summary_part.added",
        "response.reasoning_summary_part.done",
        "response.reasoning_summary_text.delta",
        "response.reasoning_summary_text.done",
        "response.reasoning_text.delta",
        "response.reasoning_text.done",
        "response.custom_tool_call_input.delta",
        "response.custom_tool_call_input.done",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.incomplete",
        "response.failed",
        "error",
        "response.done",
        "response.completed",
    ]
    + [
        f"response.{tool}.{state}"
        for tool in ("web_search_call", "x_search_call", "file_search_call")
        for state in ("in_progress", "searching", "completed")
    ]
    + [f"response.image_generation_call.{state}" for state in ("in_progress", "generating", "completed")]
    + [f"response.code_execution_call.{state}" for state in ("in_progress", "executing", "completed")]
    + [f"response.code_interpreter_call.{state}" for state in ("in_progress", "executing", "interpreting", "completed")]
    + ["response.code_interpreter_call_code.delta", "response.code_interpreter_call_code.done"]
    + [f"response.mcp_call.{state}" for state in ("in_progress", "executing", "completed", "failed")]
    + [f"response.mcp_call_{part}.{state}" for part in ("arguments", "output") for state in ("delta", "done")]
)


class StreamParser:
    """``doStream``'s transform."""

    def __init__(self) -> None:
        self.finish: JsonObject = {"unified": "interrupted", "raw": None}
        self.has_function_call = False
        self.usage: JsonObject | None = None
        self.cost: Any = None
        self.service_tier: Any = None
        self.cache_key: Any = None
        self.safety: Any = None
        self.blocks: dict[str, str] = {}
        self.tool_calls: dict[Any, JsonObject] = {}
        self.reasoning: set[Any] = set()

    def _reasoning_start(self, item_id: Any, parts: list[JsonObject]) -> None:
        if item_id not in self.reasoning:
            self.reasoning.add(item_id)
            parts.append(
                {
                    "type": "reasoning-start",
                    "id": f"reasoning-{item_id}",
                    "providerMetadata": {"xai": {"itemId": item_id}},
                }
            )

    def feed(self, event: JsonObject) -> list[JsonObject]:
        kind = event.get("type")
        parts: list[JsonObject] = []
        if kind not in KNOWN_EVENTS:
            self.finish = {"unified": "error", "raw": None}
            parts.append({"type": "error", "error": f"Type validation failed: unknown xAI event type {kind!r}"})
        elif kind == "response.reasoning_summary_part.added":
            self._reasoning_start(event.get("item_id"), parts)
        elif kind in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
            if kind == "response.reasoning_text.delta":
                self._reasoning_start(event.get("item_id"), parts)
            parts.append(
                {
                    "type": "reasoning-delta",
                    "id": f"reasoning-{event.get('item_id')}",
                    "delta": event.get("delta"),
                    "providerMetadata": {"xai": {"itemId": event.get("item_id")}},
                }
            )
        elif kind == "response.output_text.delta":
            block = f"text-{event.get('item_id')}"
            if block not in self.blocks:
                self.blocks[block] = "text"
                parts.append({"type": "text-start", "id": block})
            parts.append({"type": "text-delta", "id": block, "delta": event.get("delta")})
        elif kind in ("response.done", "response.completed", "response.incomplete"):
            response = event.get("response") or {}
            if response.get("usage") is not None:
                self.usage = convert_usage(response["usage"])
                self.cost = response["usage"].get("cost_in_usd_ticks")
            self.service_tier = response.get("service_tier")
            self.cache_key = response.get("prompt_cache_key")
            self.safety = response.get("safety_identifier")
            if kind == "response.incomplete":
                reason = (response.get("incomplete_details") or {}).get("reason")
                self.finish = {"unified": finish_reason(reason) if reason else "other", "raw": reason or "incomplete"}
            elif response.get("status"):
                self.finish = {
                    "unified": "tool-calls" if self.has_function_call else finish_reason(response["status"]),
                    "raw": response["status"],
                }
            elif self.finish["unified"] == "interrupted":
                self.finish = {"unified": "other", "raw": None}
        elif kind == "response.failed":
            response = event.get("response") or {}
            reason = (response.get("incomplete_details") or {}).get("reason")
            self.finish = {"unified": finish_reason(reason) if reason else "error", "raw": reason or "error"}
            if response.get("usage") is not None:
                self.usage = convert_usage(response["usage"])
            if response.get("error") is not None:
                parts.append({"type": "error", "error": response["error"].get("message")})
        elif kind == "error":
            self.finish = {"unified": "error", "raw": None}
            parts.append({"type": "error", "error": event.get("message")})
        elif kind == "response.function_call_arguments.delta":
            ongoing = self.tool_calls.get(event.get("output_index"))
            if ongoing is not None:
                parts.append({"type": "tool-input-delta", "id": ongoing["toolCallId"], "delta": event.get("delta")})
        elif kind in ("response.output_item.added", "response.output_item.done"):
            part = event.get("item") or {}
            item_type = part.get("type")
            if item_type == "reasoning":
                if kind == "response.output_item.done":
                    item_id = part.get("id")
                    if item_id not in self.reasoning:
                        parts.append(
                            {
                                "type": "reasoning-start",
                                "id": f"reasoning-{item_id}",
                                "providerMetadata": {"xai": {"itemId": item_id} if item_id else {}},
                            }
                        )
                    values: JsonObject = {}
                    if part.get("encrypted_content"):
                        values["reasoningEncryptedContent"] = part["encrypted_content"]
                    if item_id:
                        values["itemId"] = item_id
                    parts.append(
                        {"type": "reasoning-end", "id": f"reasoning-{item_id}", "providerMetadata": {"xai": values}}
                    )
                    self.reasoning.discard(item_id)
            elif item_type == "message":
                for item in part.get("content") or []:
                    if item.get("text"):
                        block = f"text-{part.get('id')}"
                        if block not in self.blocks:
                            self.blocks[block] = "text"
                            parts.append({"type": "text-start", "id": block})
                            parts.append({"type": "text-delta", "id": block, "delta": item["text"]})
            elif item_type == "function_call":
                if kind == "response.output_item.added":
                    self.tool_calls[event.get("output_index")] = {
                        "toolName": part.get("name"),
                        "toolCallId": part.get("call_id"),
                    }
                    parts.append({"type": "tool-input-start", "id": part.get("call_id"), "toolName": part.get("name")})
                else:
                    self.has_function_call = True
                    self.tool_calls.pop(event.get("output_index"), None)
                    parts.append({"type": "tool-input-end", "id": part.get("call_id")})
                    parts.append(
                        {
                            "type": "tool-call",
                            "toolCallId": part.get("call_id"),
                            "toolName": part.get("name"),
                            "input": part.get("arguments"),
                        }
                    )
        return parts

    def close(self) -> list[JsonObject]:
        parts: list[JsonObject] = [
            {"type": "text-end", "id": block} for block, kind in self.blocks.items() if kind == "text"
        ]
        finish: JsonObject = {"type": "finish", "finishReason": self.finish, "usage": self.usage or dict(_ZERO_USAGE)}
        metadata = _metadata(self.cost, self.service_tier, self.cache_key, self.safety)
        if metadata is not None:
            finish["providerMetadata"] = metadata
        parts.append(finish)
        return parts
