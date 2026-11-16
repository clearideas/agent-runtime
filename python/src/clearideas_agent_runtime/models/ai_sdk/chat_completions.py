"""Chat Completions results: ``@ai-sdk/groq`` and ``@ai-sdk/openai-compatible``.

Both parse ``choices[0].message`` (reasoning, content, tool calls) and stream
``choices[0].delta`` through ``StreamingToolCallTracker``; they differ in the
usage they read, the reasoning fields, refusals, and provider metadata.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .core import JsonObject, null_usage
from .google import generate_id
from .shape import loose, obj, shape
from .tool_calls import ToolCallTracker

#: ``groqChatResponseSchema.usage`` (``z.object``).
GROQ_USAGE = obj(
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    ("prompt_tokens_details", obj("cached_tokens")),
    ("completion_tokens_details", obj("reasoning_tokens")),
)
#: ``openaiCompatibleTokenUsageSchema`` (``z.looseObject``).
COMPATIBLE_USAGE = loose(
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    ("prompt_tokens_details", loose("cached_tokens")),
    (
        "completion_tokens_details",
        loose("reasoning_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"),
    ),
)


def groq_usage(usage: JsonObject | None) -> JsonObject:
    """``convertGroqUsage``."""
    if usage is None:
        return null_usage()
    usage = shape(usage, GROQ_USAGE)
    prompt = usage.get("prompt_tokens") or 0
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
    completion = usage.get("completion_tokens") or 0
    reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
    return {
        "inputTokens": {
            "total": prompt,
            "noCache": prompt - cached if cached is not None else prompt,
            "cacheRead": cached,
            "cacheWrite": None,
        },
        "outputTokens": {
            "total": completion,
            "text": max(0, completion - reasoning) if reasoning is not None else completion,
            "reasoning": reasoning,
        },
        "raw": usage,
    }


def compatible_usage(usage: JsonObject | None) -> JsonObject:
    """``convertOpenAICompatibleChatUsage``."""
    if usage is None:
        return null_usage()
    usage = shape(usage, COMPATIBLE_USAGE)
    prompt = usage.get("prompt_tokens") or 0
    completion = usage.get("completion_tokens") or 0
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
    return {
        "inputTokens": {"total": prompt, "noCache": prompt - cached, "cacheRead": cached, "cacheWrite": None},
        "outputTokens": {"total": completion, "text": max(0, completion - reasoning), "reasoning": reasoning},
        "raw": usage,
    }


def groq_finish(reason: Any) -> str:
    """``mapGroqFinishReason``."""
    if reason == "stop":
        return "stop"
    if reason == "length":
        return "length"
    if reason == "content_filter":
        return "content-filter"
    if reason in ("function_call", "tool_calls"):
        return "tool-calls"
    return "other"


def compatible_finish(reason: Any, has_refusal: bool = False) -> str:
    """``mapOpenAICompatibleFinishReason``."""
    if reason == "stop":
        return "content-filter" if has_refusal else "stop"
    return groq_finish(reason)


def metadata_key(name: str, provider_options: JsonObject | None) -> str:
    """``resolveProviderOptionsKey``: the camelCase name when the caller used it in ``providerOptions``."""
    camel = re.sub(r"[_-]([a-z])", lambda match: match.group(1).upper(), name)
    if camel != name and (provider_options or {}).get(camel) is not None:
        return camel
    return name


def _compatible_content(content: Any) -> list[JsonObject]:
    """``convertOpenAICompatibleContent``."""
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    result: list[JsonObject] = []
    for part in content:
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            if part["text"]:
                result.append({"type": "text", "text": part["text"]})
        elif part.get("type") == "thinking" and isinstance(part.get("thinking"), list):
            text = "".join(
                chunk["text"]
                for chunk in part["thinking"]
                if isinstance(chunk, dict) and chunk.get("type") == "text" and isinstance(chunk.get("text"), str)
            )
            if text:
                result.append({"type": "reasoning", "text": text})
    return result


def _refusal(value: Any) -> str | None:
    return value if isinstance(value, str) else None


@dataclass
class Context:
    #: ``groq`` or ``openai-compatible``.
    flavor: str
    #: The provider-metadata key (``openai-compatible``).
    key: str = "openaiCompatible"


@dataclass
class GenerateResult:
    content: list[JsonObject]
    finish_reason: JsonObject
    usage: JsonObject
    provider_metadata: JsonObject | None


class InvalidResponseData(Exception):
    name = "AI_InvalidResponseDataError"


def generate(response: JsonObject, context: Context) -> GenerateResult:
    choices = response.get("choices") or []
    if not choices:
        raise InvalidResponseData("Response did not contain any choices.")
    choice = choices[0]
    message = choice.get("message") or {}
    content: list[JsonObject] = []
    if context.flavor == "groq":
        reasoning = message.get("reasoning")
        if reasoning:
            content.append({"type": "reasoning", "text": reasoning})
        text = message.get("content")
        if text:
            content.append({"type": "text", "text": text})
        for call in message.get("tool_calls") or []:
            content.append(
                {
                    "type": "tool-call",
                    "toolCallId": call.get("id") or generate_id(),
                    "toolName": call["function"]["name"],
                    "input": call["function"]["arguments"],
                }
            )
        return GenerateResult(
            content=content,
            finish_reason={"unified": groq_finish(choice.get("finish_reason")), "raw": choice.get("finish_reason")},
            usage=groq_usage(response.get("usage")),
            provider_metadata=None,
        )
    reasoning_content = message.get("reasoning_content")
    reasoning = reasoning_content if reasoning_content is not None else message.get("reasoning")
    if reasoning:
        content.append({"type": "reasoning", "text": reasoning})
    content.extend(_compatible_content(message.get("content")))
    refusal = _refusal(message.get("refusal"))
    has_refusal = bool(refusal)
    if has_refusal:
        content.append({"type": "text", "text": refusal})
    key = context.key
    for call in message.get("tool_calls") or []:
        signature = (((call.get("extra_content") or {}).get("google")) or {}).get("thought_signature")
        part: JsonObject = {
            "type": "tool-call",
            "toolCallId": call.get("id") or generate_id(),
            "toolName": call["function"]["name"],
            "input": call["function"]["arguments"],
        }
        if signature:
            part["providerMetadata"] = {key: {"thoughtSignature": signature}}
        content.append(part)
    metadata: JsonObject = {key: {}}
    details = (shape(response.get("usage"), COMPATIBLE_USAGE) or {}).get("completion_tokens_details") or {}
    if details.get("accepted_prediction_tokens") is not None:
        metadata[key]["acceptedPredictionTokens"] = details["accepted_prediction_tokens"]
    if details.get("rejected_prediction_tokens") is not None:
        metadata[key]["rejectedPredictionTokens"] = details["rejected_prediction_tokens"]
    return GenerateResult(
        content=content,
        finish_reason={
            "unified": compatible_finish(choice.get("finish_reason"), has_refusal),
            "raw": choice.get("finish_reason"),
        },
        usage=compatible_usage(response.get("usage")),
        provider_metadata=metadata,
    )


class StreamParser:
    """``doStream``'s transform for either flavor."""

    def __init__(self, context: Context) -> None:
        self.context = context
        self.out: list[JsonObject] = []
        groq = context.flavor == "groq"
        key = context.key
        self.tracker = ToolCallTracker(
            emit=self.out.append,
            generate_id=generate_id,
            type_validation="required" if groq else "none",
            extract_metadata=None
            if groq
            else (
                lambda delta: (
                    {key: {"thoughtSignature": signature}}
                    if (
                        signature := (((delta.get("extra_content") or {}).get("google")) or {}).get("thought_signature")
                    )
                    else None
                )
            ),
            build_metadata=None if groq else (lambda metadata: metadata),
        )
        self.finish: JsonObject | None = {"unified": "interrupted", "raw": None} if groq else None
        self.raw_finish: Any = None
        self.usage: JsonObject | None = None
        self.first = True
        self.active_text = False
        self.active_reasoning = False
        self.has_refusal = False
        self.pending: dict[Any, JsonObject] = {}
        self.forwarded: set[Any] = set()

    def _reasoning_end(self) -> None:
        if self.active_reasoning:
            self.out.append({"type": "reasoning-end", "id": "reasoning-0"})
            self.active_reasoning = False

    def _reasoning(self, delta: str) -> None:
        if self.context.flavor != "groq" and self.active_text:
            self.out.append({"type": "text-end", "id": "txt-0"})
            self.active_text = False
        if not self.active_reasoning:
            self.out.append({"type": "reasoning-start", "id": "reasoning-0"})
            self.active_reasoning = True
        self.out.append({"type": "reasoning-delta", "id": "reasoning-0", "delta": delta})

    def _text(self, delta: str) -> None:
        self._reasoning_end()
        if not self.active_text:
            self.out.append({"type": "text-start", "id": "txt-0"})
            self.active_text = True
        self.out.append({"type": "text-delta", "id": "txt-0", "delta": delta})

    def _forward(self, delta: JsonObject) -> None:
        """openai-compatible buffers a call's arguments until its name arrives."""
        index = delta.get("index")
        if index is None or index in self.forwarded:
            self.tracker.process_delta(delta)
            return
        pending = self.pending.get(index)
        if pending is None:
            pending = {"id": delta.get("id"), "arguments": "", "extra": delta.get("extra_content")}
            self.pending[index] = pending
        else:
            if pending["id"] is None and delta.get("id") is not None:
                pending["id"] = delta["id"]
            if pending["extra"] is None and delta.get("extra_content") is not None:
                pending["extra"] = delta["extra_content"]
        function = delta.get("function") or {}
        if function.get("arguments") is not None:
            pending["arguments"] += function["arguments"]
        if function.get("name") is not None:
            forward: JsonObject = {
                "index": index,
                "id": pending["id"],
                "function": {"name": function["name"], "arguments": pending["arguments"]},
            }
            if pending["extra"] is not None:
                forward["extra_content"] = pending["extra"]
            self.tracker.process_delta(forward)
            del self.pending[index]
            self.forwarded.add(index)

    def feed(self, value: JsonObject) -> list[JsonObject]:
        self.out = []
        self.tracker.emit = self.out.append
        groq = self.context.flavor == "groq"
        if "error" in value:
            self.finish = {"unified": "error", "raw": None}
            self.raw_finish = None
            error = value.get("error")
            self.out.append({"type": "error", "error": error.get("message") if isinstance(error, dict) else error})
            return self.out
        if self.first and (groq or any(value.get(name) for name in ("id", "model", "created"))):
            self.first = False
            self.out.append({"type": "response-metadata", "id": value.get("id")})
        if groq:
            usage = (value.get("x_groq") or {}).get("usage")
            if usage is not None:
                self.usage = usage
        elif value.get("usage") is not None:
            self.usage = value["usage"]
        choices = value.get("choices") or []
        choice = choices[0] if choices else None
        if choice is not None and choice.get("finish_reason") is not None:
            if groq:
                self.finish = {"unified": groq_finish(choice["finish_reason"]), "raw": choice["finish_reason"]}
            else:
                self.raw_finish = choice["finish_reason"]
        delta = (choice or {}).get("delta")
        if delta is None:
            return self.out
        if groq:
            if delta.get("reasoning"):
                self._reasoning(delta["reasoning"])
            if delta.get("content"):
                self._text(delta["content"])
            if delta.get("tool_calls"):
                self._reasoning_end()
                for call in delta["tool_calls"]:
                    self.tracker.process_delta(call)
            return self.out
        reasoning_content = delta.get("reasoning_content")
        reasoning = reasoning_content if reasoning_content is not None else delta.get("reasoning")
        if reasoning:
            self._reasoning(reasoning)
        for part in _compatible_content(delta.get("content")):
            if part["type"] == "reasoning":
                self._reasoning(part["text"])
            else:
                self._text(part["text"])
        refusal = _refusal(delta.get("refusal"))
        if refusal:
            self.has_refusal = True
            self._text(refusal)
        if delta.get("tool_calls"):
            self._reasoning_end()
            for call in delta["tool_calls"]:
                self._forward(call)
        return self.out

    def close(self) -> list[JsonObject]:
        self.out = []
        self.tracker.emit = self.out.append
        groq = self.context.flavor == "groq"
        if self.active_reasoning:
            self.out.append({"type": "reasoning-end", "id": "reasoning-0"})
        if self.active_text:
            self.out.append({"type": "text-end", "id": "txt-0"})
        if not groq:
            for index, pending in self.pending.items():
                self.tracker.process_delta(
                    {"index": index, "id": pending["id"], "function": {"arguments": pending["arguments"]}}
                )
            self.pending.clear()
        self.tracker.flush()
        if groq:
            self.out.append({"type": "finish", "finishReason": self.finish, "usage": groq_usage(self.usage)})
            return self.out
        if self.raw_finish is not None:
            self.finish = {"unified": compatible_finish(self.raw_finish, self.has_refusal), "raw": self.raw_finish}
        if self.finish is None:
            self.finish = {"unified": "error", "raw": None}
            self.out.append({"type": "error", "error": "Response stream ended without a finish reason."})
        key = self.context.key
        metadata: JsonObject = {key: {}}
        details = (shape(self.usage, COMPATIBLE_USAGE) or {}).get("completion_tokens_details") or {}
        if details.get("accepted_prediction_tokens") is not None:
            metadata[key]["acceptedPredictionTokens"] = details["accepted_prediction_tokens"]
        if details.get("rejected_prediction_tokens") is not None:
            metadata[key]["rejectedPredictionTokens"] = details["rejected_prediction_tokens"]
        self.out.append(
            {
                "type": "finish",
                "finishReason": self.finish,
                "usage": compatible_usage(self.usage),
                "providerMetadata": metadata,
            }
        )
        return self.out
