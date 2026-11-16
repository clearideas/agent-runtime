"""``@ai-sdk/cohere`` v2 chat results (``CohereChatLanguageModel``)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..._js import json as js_json
from ..._js import strings as js_strings
from .core import JsonObject, null_usage, secure_json_parse
from .shape import loose, shape

#: ``cohereUsageSchema``.
USAGE = loose(
    ("billed_units", loose("input_tokens", "output_tokens")),
    ("tokens", loose("input_tokens", "output_tokens")),
    "cached_tokens",
)


def convert_usage(usage: JsonObject | None) -> JsonObject:
    """``convertCohereUsage``."""
    if usage is None:
        return null_usage()
    usage = shape(usage, USAGE)
    tokens = usage.get("tokens") or {}
    inputs = tokens.get("input_tokens")
    outputs = tokens.get("output_tokens")
    cached = usage.get("cached_tokens")
    return {
        "inputTokens": {
            "total": inputs,
            "noCache": inputs - cached if inputs is not None and cached is not None else inputs,
            "cacheRead": cached,
            "cacheWrite": None,
        },
        "outputTokens": {"total": outputs, "text": outputs, "reasoning": None},
        "raw": usage,
    }


def finish_reason(reason: Any) -> str:
    """``mapCohereFinishReason``."""
    if reason in ("COMPLETE", "STOP_SEQUENCE"):
        return "stop"
    if reason == "MAX_TOKENS":
        return "length"
    if reason == "ERROR":
        return "error"
    if reason == "TOOL_CALL":
        return "tool-calls"
    return "other"


@dataclass
class GenerateResult:
    content: list[JsonObject]
    finish_reason: JsonObject
    usage: JsonObject
    provider_metadata: None = None


def generate(response: JsonObject) -> GenerateResult:
    message = response.get("message") or {}
    content: list[JsonObject] = []
    for item in message.get("content") or []:
        if item.get("type") == "text" and item.get("text"):
            content.append({"type": "text", "text": item["text"]})
        elif item.get("type") == "thinking" and item.get("thinking"):
            content.append({"type": "reasoning", "text": item["thinking"]})
    for call in message.get("tool_calls") or []:
        content.append(
            {
                "type": "tool-call",
                "toolCallId": call.get("id"),
                "toolName": call["function"]["name"],
                # Cohere sometimes returns `null` arguments for tools without parameters.
                "input": re.sub(r"^null\Z", "{}", call["function"]["arguments"]),
            }
        )
    return GenerateResult(
        content=content,
        finish_reason={"unified": finish_reason(response.get("finish_reason")), "raw": response.get("finish_reason")},
        usage=convert_usage(response.get("usage")),
    )


class StreamParser:
    """``doStream``'s transform."""

    def __init__(self) -> None:
        self.finish: JsonObject = {"unified": "interrupted", "raw": None}
        self.usage: JsonObject | None = None
        self.pending: JsonObject | None = None
        self.active_reasoning = False

    def feed(self, value: JsonObject) -> list[JsonObject]:
        kind = value.get("type")
        out: list[JsonObject] = []
        message = ((value.get("delta") or {}).get("message")) or {}
        index = str(value.get("index"))
        if kind == "content-start":
            if (message.get("content") or {}).get("type") == "thinking":
                out.append({"type": "reasoning-start", "id": index})
                self.active_reasoning = True
            else:
                out.append({"type": "text-start", "id": index})
        elif kind == "content-delta":
            content = message.get("content") or {}
            if "thinking" in content:
                out.append({"type": "reasoning-delta", "id": index, "delta": content["thinking"]})
            else:
                out.append({"type": "text-delta", "id": index, "delta": content.get("text")})
        elif kind == "content-end":
            if self.active_reasoning:
                out.append({"type": "reasoning-end", "id": index})
                self.active_reasoning = False
            else:
                out.append({"type": "text-end", "id": index})
        elif kind == "tool-call-start":
            call = message.get("tool_calls") or {}
            function = call.get("function") or {}
            arguments = function.get("arguments") or ""
            self.pending = {"id": call.get("id"), "name": function.get("name"), "arguments": arguments}
            out.append({"type": "tool-input-start", "id": call.get("id"), "toolName": function.get("name")})
            if arguments:
                out.append({"type": "tool-input-delta", "id": call.get("id"), "delta": arguments})
        elif kind == "tool-call-delta":
            if self.pending is not None:
                delta = ((message.get("tool_calls") or {}).get("function") or {}).get("arguments") or ""
                self.pending["arguments"] += delta
                out.append({"type": "tool-input-delta", "id": self.pending["id"], "delta": delta})
        elif kind == "tool-call-end":
            if self.pending is not None:
                pending, self.pending = self.pending, None
                out.append({"type": "tool-input-end", "id": pending["id"]})
                text = js_strings.trim(pending["arguments"] or "") or "{}"
                try:
                    parsed = secure_json_parse(text)
                    arguments = js_json.stringify(parsed if parsed is not None else {})
                except ValueError as error:
                    out.append(
                        {"type": "error", "error": f"JSON parsing failed: Text: {text}.\nError message: {error}"}
                    )
                    return out
                out.append(
                    {"type": "tool-call", "toolCallId": pending["id"], "toolName": pending["name"], "input": arguments}
                )
        elif kind == "message-start":
            out.append({"type": "response-metadata", "id": value.get("id")})
        elif kind == "message-end":
            delta = value.get("delta") or {}
            self.finish = {"unified": finish_reason(delta.get("finish_reason")), "raw": delta.get("finish_reason")}
            self.usage = delta.get("usage")
        return out

    def close(self) -> list[JsonObject]:
        return [{"type": "finish", "finishReason": self.finish, "usage": convert_usage(self.usage)}]
