"""``@ai-sdk/anthropic`` Messages API results (``AnthropicLanguageModel``).

Ports ``doGenerate``/``doStream`` for ``text``, ``thinking``,
``redacted_thinking``, and ``tool_use`` blocks (including the ``json`` tool the
AI SDK uses for structured output on models without native JSON output).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..._js import json as js_json
from .core import JsonObject
from .shape import arr, loose, obj, shape

_ITERATION = obj(
    "type", "model", "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"
)
#: ``usage`` of a Messages API response.
USAGE = loose(
    "service_tier",
    "input_tokens",
    "output_tokens",
    ("output_tokens_details", obj("thinking_tokens")),
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    ("iterations", arr(_ITERATION)),
)
#: ``message_start.message.usage``.
START_USAGE = loose("service_tier", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
#: ``message_delta.usage``.
DELTA_USAGE = USAGE
_TEXT_OR_THINKING = ("redacted_thinking", "text", "thinking")


@dataclass
class Context:
    #: The request used the ``json`` tool for structured output.
    json_tool: bool = False


def convert_usage(usage: JsonObject, raw: Any = None) -> JsonObject:
    """``convertAnthropicUsage``."""
    creation = usage.get("cache_creation_input_tokens") or 0
    read = usage.get("cache_read_input_tokens") or 0
    reasoning = (usage.get("output_tokens_details") or {}).get("thinking_tokens")
    iterations = usage.get("iterations")
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    fallback = bool(iterations) and any(item.get("type") == "fallback_message" for item in iterations)
    if iterations and not fallback:
        executors = [item for item in iterations if item.get("type") in ("compaction", "message")]
        if executors:
            input_tokens = sum(item["input_tokens"] for item in executors)
            output_tokens = sum(item["output_tokens"] for item in executors)
    return {
        "inputTokens": {
            "total": input_tokens + creation + read,
            "noCache": input_tokens,
            "cacheRead": read,
            "cacheWrite": creation,
        },
        "outputTokens": {
            "total": output_tokens,
            "text": None if reasoning is None else output_tokens - reasoning,
            "reasoning": reasoning,
        },
        "raw": raw if raw is not None else usage,
    }


def stop_reason(reason: Any, json_from_tool: bool) -> str:
    """``mapAnthropicStopReason``."""
    if reason in ("pause_turn", "end_turn", "stop_sequence"):
        return "stop"
    if reason == "refusal":
        return "content-filter"
    if reason == "tool_use":
        return "stop" if json_from_tool else "tool-calls"
    if reason in ("max_tokens", "model_context_window_exceeded"):
        return "length"
    return "other"


def _iterations(iterations: Any) -> Any:
    if not iterations:
        return None
    mapped = []
    for item in iterations:
        value: JsonObject = {"type": item.get("type")}
        if item.get("model") is not None:
            value["model"] = item["model"]
        value["inputTokens"] = item.get("input_tokens")
        value["outputTokens"] = item.get("output_tokens")
        if item.get("cache_creation_input_tokens"):
            value["cacheCreationInputTokens"] = item["cache_creation_input_tokens"]
        if item.get("cache_read_input_tokens"):
            value["cacheReadInputTokens"] = item["cache_read_input_tokens"]
        mapped.append(value)
    return mapped


def _stop_details(details: Any) -> JsonObject | None:
    if details is None:
        return None
    mapped: JsonObject = {"type": details.get("type")}
    for source, target in (
        ("category", "category"),
        ("explanation", "explanation"),
        ("recommended_model", "recommendedModel"),
    ):
        if details.get(source) is not None:
            mapped[target] = details[source]
    return mapped


def _context_management(value: Any) -> JsonObject | None:
    if not value:
        return None
    edits = []
    for edit in value.get("applied_edits") or []:
        kind = edit.get("type")
        if kind == "clear_tool_uses_20250919":
            edits.append(
                {
                    "type": kind,
                    "clearedToolUses": edit.get("cleared_tool_uses"),
                    "clearedInputTokens": edit.get("cleared_input_tokens"),
                }
            )
        elif kind == "clear_thinking_20251015":
            edits.append(
                {
                    "type": kind,
                    "clearedThinkingTurns": edit.get("cleared_thinking_turns"),
                    "clearedInputTokens": edit.get("cleared_input_tokens"),
                }
            )
        elif kind == "compact_20260112":
            edits.append({"type": kind})
    return {"appliedEdits": edits}


def _container(value: Any, skills: bool = True) -> JsonObject | None:
    if not value:
        return None
    return {
        "expiresAt": value.get("expires_at"),
        "id": value.get("id"),
        "skills": [
            {"type": skill.get("type"), "skillId": skill.get("skill_id"), "version": skill.get("version")}
            for skill in value.get("skills") or []
        ]
        if skills and value.get("skills") is not None
        else None,
    }


def _is_continuation(reason: Any) -> bool:
    return reason in ("pause_turn", "tool_use")


def _fallback_text(content: list[JsonObject], reason: Any) -> set[int]:
    """``getJsonResponseToolFallbackText``: indexes of the text blocks to keep."""
    kept: set[int] = set()
    if _is_continuation(reason):
        return kept
    for index, part in enumerate(content):
        if part.get("type") == "tool_use" and part.get("name") == "json":
            return set()
        if part.get("type") == "text":
            kept.add(index)
        elif part.get("type") not in _TEXT_OR_THINKING:
            kept.clear()
    return kept


@dataclass
class GenerateResult:
    content: list[JsonObject]
    finish_reason: JsonObject
    usage: JsonObject
    provider_metadata: JsonObject


def generate(response: JsonObject, context: Context) -> GenerateResult:
    blocks = response.get("content") or []
    reason = response.get("stop_reason")
    keep = _fallback_text(blocks, reason) if context.json_tool else None
    content: list[JsonObject] = []
    json_from_tool = False
    for index, part in enumerate(blocks):
        kind = part.get("type")
        if kind == "text":
            if keep is None or index in keep:
                text: JsonObject = {"type": "text", "text": part.get("text")}
                citations = part.get("citations") or []
                if citations:
                    text["providerMetadata"] = {"anthropic": {"citations": citations}}
                content.append(text)
        elif kind == "thinking":
            content.append(
                {
                    "type": "reasoning",
                    "text": part.get("thinking"),
                    "providerMetadata": {"anthropic": {"signature": part.get("signature")}},
                }
            )
        elif kind == "redacted_thinking":
            content.append(
                {"type": "reasoning", "text": "", "providerMetadata": {"anthropic": {"redactedData": part.get("data")}}}
            )
        elif kind == "tool_use":
            if context.json_tool and part.get("name") == "json":
                json_from_tool = True
                content.append({"type": "text", "text": js_json.stringify(part.get("input"))})
            else:
                content.append(
                    {
                        "type": "tool-call",
                        "toolCallId": part.get("id"),
                        "toolName": part.get("name"),
                        "input": js_json.stringify(part.get("input")),
                    }
                )
    usage = shape(response.get("usage") or {}, USAGE)
    service_tier = usage.get("service_tier") if usage.get("service_tier") is not None else response.get("service_tier")
    metadata: JsonObject = {"usage": usage, "stopSequence": response.get("stop_sequence")}
    if service_tier is not None:
        metadata["serviceTier"] = service_tier
    details = _stop_details(response.get("stop_details"))
    if details is not None:
        metadata["stopDetails"] = details
    if response.get("input_transformations") is not None:
        metadata["inputTransformations"] = response["input_transformations"]
    if response.get("safeguard_results") is not None:
        metadata["safeguardResults"] = response["safeguard_results"]
    metadata["iterations"] = _iterations(usage.get("iterations"))
    metadata["container"] = _container(response.get("container"))
    metadata["contextManagement"] = _context_management(response.get("context_management"))
    return GenerateResult(
        content=content,
        finish_reason={"unified": stop_reason(reason, json_from_tool), "raw": reason},
        usage=convert_usage(usage),
        provider_metadata={"anthropic": metadata},
    )


@dataclass
class _Block:
    type: str
    tool_call_id: Any = None
    tool_name: Any = None
    input: str = ""
    first_delta: bool = False


@dataclass
class _HeldText:
    id: str
    text: str = ""
    citations: list[Any] = field(default_factory=list)


class StreamParser:
    """``doStream``'s transform."""

    def __init__(self, context: Context) -> None:
        self.context = context
        self.finish: JsonObject = {"unified": "other", "raw": None}
        self.usage: JsonObject = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "iterations": None,
        }
        self.blocks: dict[Any, _Block] = {}
        self.raw_usage: JsonObject | None = None
        self.stop_sequence: Any = None
        self.service_tier: Any = None
        self.stop_details: Any = None
        self.input_transformations: Any = None
        self.safeguard_results: Any = None
        self.container: Any = None
        self.context_management: Any = None
        self.json_from_tool = False
        self.held: list[_HeldText] = []
        self.held_by_index: dict[Any, _HeldText] = {}
        self.message_open = False
        self.message_id: Any = None
        self.invalid_sequence = False
        self.block_type: Any = None
        # The wrapper stream's bookkeeping (an "interrupted" finish after trailing output).
        self.has_output = False
        self.has_error = False
        self.last_finish: JsonObject | None = None

    def feed(self, value: JsonObject) -> list[JsonObject]:
        parts = self._transform(value)
        for part in parts:
            kind = part["type"]
            if kind in ("response-metadata", "finish"):
                self.has_output = False
                if kind == "finish":
                    self.last_finish = part
            elif kind == "error":
                self.has_error = True
            elif kind in ("text-delta", "reasoning-delta", "tool-input-delta"):
                self.has_output = self.has_output or len(part.get("delta") or "") > 0
            elif kind == "tool-call":
                self.has_output = True
        return parts

    def close(self) -> list[JsonObject]:
        if self.has_output and not self.has_error:
            usage = (self.last_finish or {}).get("usage") or {
                "inputTokens": {"total": None, "noCache": None, "cacheRead": None, "cacheWrite": None},
                "outputTokens": {"total": None, "text": None, "reasoning": None},
            }
            return [{"type": "finish", "finishReason": {"unified": "interrupted", "raw": None}, "usage": usage}]
        return []

    def _text_end(self, block_id: str, citations: list[Any]) -> JsonObject:
        end: JsonObject = {"type": "text-end", "id": block_id}
        if citations:
            end["providerMetadata"] = {"anthropic": {"citations": citations}}
        return end

    def _transform(self, value: JsonObject) -> list[JsonObject]:
        if self.invalid_sequence:
            return []
        kind = value.get("type")
        out: list[JsonObject] = []
        if kind == "ping":
            return out
        if kind == "content_block_start":
            part = value.get("content_block") or {}
            block_kind = part.get("type")
            self.block_type = block_kind
            index = value.get("index")
            if block_kind not in _TEXT_OR_THINKING:
                self.held.clear()
            if block_kind == "text":
                if self.context.json_tool:
                    entry = _HeldText(str(index))
                    self.held.append(entry)
                    self.held_by_index[index] = entry
                    return out
                self.blocks[index] = _Block("text")
                out.append({"type": "text-start", "id": str(index)})
            elif block_kind == "thinking":
                self.blocks[index] = _Block("reasoning")
                out.append({"type": "reasoning-start", "id": str(index)})
            elif block_kind == "redacted_thinking":
                self.blocks[index] = _Block("reasoning")
                out.append(
                    {
                        "type": "reasoning-start",
                        "id": str(index),
                        "providerMetadata": {"anthropic": {"redactedData": part.get("data")}},
                    }
                )
            elif block_kind == "tool_use":
                if self.context.json_tool and part.get("name") == "json":
                    self.json_from_tool = True
                    self.blocks[index] = _Block("text")
                    out.append({"type": "text-start", "id": str(index)})
                else:
                    initial = part.get("input")
                    initial_text = js_json.stringify(initial) if isinstance(initial, dict) and initial else ""
                    self.blocks[index] = _Block(
                        "tool-call",
                        tool_call_id=part.get("id"),
                        tool_name=part.get("name"),
                        input=initial_text,
                        first_delta=initial_text == "",
                    )
                    out.append({"type": "tool-input-start", "id": part.get("id"), "toolName": part.get("name")})
            return out
        if kind == "content_block_stop":
            index = value.get("index")
            block = self.blocks.pop(index, None)
            if block is not None:
                if block.type == "text":
                    out.append(self._text_end(str(index), []))
                elif block.type == "reasoning":
                    out.append({"type": "reasoning-end", "id": str(index)})
                elif block.type == "tool-call" and not (self.context.json_tool and block.tool_name == "json"):
                    out.append({"type": "tool-input-end", "id": block.tool_call_id})
                    out.append(
                        {
                            "type": "tool-call",
                            "toolCallId": block.tool_call_id,
                            "toolName": block.tool_name,
                            "input": "{}" if block.input == "" else block.input,
                        }
                    )
            self.block_type = None
            return out
        if kind == "content_block_delta":
            delta = value.get("delta") or {}
            delta_kind = delta.get("type")
            index = value.get("index")
            if delta_kind == "text_delta":
                if self.context.json_tool:
                    entry = self.held_by_index.get(index)
                    if entry is not None:
                        entry.text += delta.get("text") or ""
                    return out
                out.append({"type": "text-delta", "id": str(index), "delta": delta.get("text")})
            elif delta_kind == "thinking_delta":
                out.append({"type": "reasoning-delta", "id": str(index), "delta": delta.get("thinking")})
            elif delta_kind == "signature_delta":
                if self.block_type == "thinking":
                    out.append(
                        {
                            "type": "reasoning-delta",
                            "id": str(index),
                            "delta": "",
                            "providerMetadata": {"anthropic": {"signature": delta.get("signature")}},
                        }
                    )
            elif delta_kind == "input_json_delta":
                block = self.blocks.get(index)
                text = delta.get("partial_json") or ""
                if not text:
                    return out
                if self.json_from_tool:
                    if block is None or block.type != "text":
                        return out
                    out.append({"type": "text-delta", "id": str(index), "delta": text})
                else:
                    if block is None or block.type != "tool-call":
                        return out
                    out.append({"type": "tool-input-delta", "id": block.tool_call_id, "delta": text})
                    block.input += text
                    block.first_delta = False
            elif delta_kind == "citations_delta":
                citation = delta.get("citation")
                entry = self.held_by_index.get(index)
                if entry is not None:
                    entry.citations.append(citation)
            return out
        if kind == "message_start":
            message = value.get("message") or {}
            if self.message_open:
                if self.message_id == message.get("id"):
                    return out
                self.invalid_sequence = True
                out.append(
                    {
                        "type": "error",
                        "error": f"Received message_start for message {js_json.stringify(message.get('id'))} "
                        f"while message {js_json.stringify(self.message_id)} is still open.",
                    }
                )
                return out
            usage = shape(message.get("usage") or {}, START_USAGE)
            service = usage.get("service_tier")
            self.service_tier = service if service is not None else message.get("service_tier")
            self.message_open = True
            self.message_id = message.get("id")
            self.held_by_index.clear()
            self.usage["input_tokens"] = usage.get("input_tokens")
            self.usage["cache_read_input_tokens"] = usage.get("cache_read_input_tokens") or 0
            self.usage["cache_creation_input_tokens"] = usage.get("cache_creation_input_tokens") or 0
            self.raw_usage = dict(usage)
            if message.get("input_transformations") is not None:
                self.input_transformations = message["input_transformations"]
            if message.get("container") is not None:
                self.container = _container(message["container"], skills=False)
            if message.get("stop_reason") is not None:
                self.finish = {
                    "unified": stop_reason(message["stop_reason"], self.json_from_tool),
                    "raw": message["stop_reason"],
                }
            out.append({"type": "response-metadata", "id": message.get("id")})
            out.append(
                {
                    "type": "custom",
                    "kind": "anthropic.message_start",
                    "providerMetadata": {
                        "anthropic": {"id": message.get("id"), "model": message.get("model"), "usage": self.raw_usage}
                    },
                }
            )
            for part in message.get("content") or []:
                if part.get("type") == "tool_use":
                    text = js_json.stringify(part.get("input") if part.get("input") is not None else {})
                    out.append({"type": "tool-input-start", "id": part.get("id"), "toolName": part.get("name")})
                    out.append({"type": "tool-input-delta", "id": part.get("id"), "delta": text})
                    out.append({"type": "tool-input-end", "id": part.get("id")})
                    out.append(
                        {"type": "tool-call", "toolCallId": part.get("id"), "toolName": part.get("name"), "input": text}
                    )
            return out
        if kind == "message_delta":
            usage = shape(value.get("usage") or {}, DELTA_USAGE)
            delta = value.get("delta") or {}
            if usage.get("input_tokens") is not None and self.usage["input_tokens"] != usage["input_tokens"]:
                self.usage["input_tokens"] = usage["input_tokens"]
            self.usage["output_tokens"] = usage.get("output_tokens")
            if usage.get("output_tokens_details") is not None:
                self.usage["output_tokens_details"] = usage["output_tokens_details"]
            for name in ("cache_read_input_tokens", "cache_creation_input_tokens", "iterations"):
                if usage.get(name) is not None:
                    self.usage[name] = usage[name]
            self.finish = {
                "unified": stop_reason(delta.get("stop_reason"), self.json_from_tool),
                "raw": delta.get("stop_reason"),
            }
            self.stop_sequence = delta.get("stop_sequence")
            self.stop_details = _stop_details(delta.get("stop_details"))
            self.container = _container(delta.get("container")) if delta.get("container") is not None else None
            if value.get("context_management"):
                self.context_management = _context_management(value["context_management"])
            if value.get("input_transformations") is not None:
                self.input_transformations = value["input_transformations"]
            if delta.get("safeguard_results") is not None:
                self.safeguard_results = delta["safeguard_results"]
            if usage.get("service_tier") is not None:
                self.service_tier = usage["service_tier"]
            self.raw_usage = {**(self.raw_usage or {}), **usage}
            return out
        if kind == "message_stop":
            self.message_open = False
            self.message_id = None
            metadata: JsonObject = {"usage": self.raw_usage, "stopSequence": self.stop_sequence}
            if self.service_tier is not None:
                metadata["serviceTier"] = self.service_tier
            if self.stop_details is not None:
                metadata["stopDetails"] = self.stop_details
            if self.input_transformations is not None:
                metadata["inputTransformations"] = self.input_transformations
            if self.safeguard_results is not None:
                metadata["safeguardResults"] = self.safeguard_results
            metadata["iterations"] = _iterations(self.usage.get("iterations"))
            metadata["container"] = self.container
            metadata["contextManagement"] = self.context_management
            if not self.json_from_tool and not _is_continuation(self.finish.get("raw")):
                for entry in self.held:
                    if not entry.text:
                        continue
                    out.append({"type": "text-start", "id": entry.id})
                    out.append({"type": "text-delta", "id": entry.id, "delta": entry.text})
                    out.append(self._text_end(entry.id, entry.citations))
            self.held.clear()
            out.append(
                {
                    "type": "finish",
                    "finishReason": self.finish,
                    "usage": convert_usage(self.usage, self.raw_usage),
                    "providerMetadata": {"anthropic": metadata},
                }
            )
            return out
        if kind == "error":
            error = value.get("error") or {}
            out.append({"type": "error", "error": error.get("message") if isinstance(error, dict) else error})
        return out
