"""``@ai-sdk/google`` Gemini API results (``GoogleLanguageModel``).

Ports ``convertGenerateContentResponse`` and ``doStream`` for text, thought,
and function-call parts (complete calls; Gemini's streamed partial arguments
are not requested by the runtime).
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any

from ..._js import json as js_json
from .core import JsonObject, null_usage
from .shape import arr, loose, obj, shape

_TOKEN_DETAILS = arr(loose("modality", "tokenCount"))
#: ``usageSchema$1`` (``z.object(...).loose()``).
USAGE = loose(
    "cachedContentTokenCount",
    "thoughtsTokenCount",
    "promptTokenCount",
    "candidatesTokenCount",
    "toolUsePromptTokenCount",
    "totalTokenCount",
    "trafficType",
    "serviceTier",
    ("promptTokensDetails", _TOKEN_DETAILS),
    ("cacheTokensDetails", _TOKEN_DETAILS),
    ("candidatesTokensDetails", _TOKEN_DETAILS),
    ("toolUsePromptTokensDetails", _TOKEN_DETAILS),
)
SAFETY_RATINGS = arr(obj("category", "probability", "probabilityScore", "severity", "severityScore", "blocked"))
PROMPT_FEEDBACK = obj("blockReason", ("safetyRatings", SAFETY_RATINGS))
URL_CONTEXT = obj(("urlMetadata", arr(obj("retrievedUrl", "urlRetrievalStatus"))))

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def generate_id() -> str:
    """``generateId`` (provider-utils): 16 random alphanumerics."""
    return "".join(random.choice(_ALPHABET) for _ in range(16))


def convert_usage(usage: JsonObject | None) -> JsonObject:
    """``convertGoogleUsage``."""
    if usage is None:
        return null_usage()
    prompt = usage.get("promptTokenCount") or 0
    candidates = usage.get("candidatesTokenCount") or 0
    tool_use = usage.get("toolUsePromptTokenCount") or 0
    cached = usage.get("cachedContentTokenCount") or 0
    thoughts = usage.get("thoughtsTokenCount") or 0
    inputs = prompt + tool_use
    return {
        "inputTokens": {"total": inputs, "noCache": inputs - cached, "cacheRead": cached, "cacheWrite": None},
        "outputTokens": {"total": candidates + thoughts, "text": candidates, "reasoning": thoughts},
        "raw": usage,
    }


def finish_reason(reason: Any, has_tool_calls: bool) -> str:
    """``mapGoogleFinishReason``."""
    if reason == "STOP":
        return "tool-calls" if has_tool_calls else "stop"
    if reason in ("MAX_TOKENS", "CONTINUATION"):
        return "length"
    if reason in ("IMAGE_SAFETY", "RECITATION", "SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"):
        return "content-filter"
    if reason == "MALFORMED_FUNCTION_CALL":
        return "error"
    return "other"


def _confirmed_block(reason: Any) -> bool:
    return reason not in (None, "", "BLOCK_REASON_UNSPECIFIED", "BLOCKED_REASON_UNSPECIFIED")


def _signature(part: JsonObject, key: str) -> JsonObject | None:
    return {key: {"thoughtSignature": part["thoughtSignature"]}} if part.get("thoughtSignature") else None


def _args(call: JsonObject) -> str:
    value = call.get("args")
    if isinstance(value, str):
        return value
    return js_json.stringify(value if value is not None else {})


@dataclass
class GenerateResult:
    content: list[JsonObject]
    finish_reason: JsonObject
    usage: JsonObject
    provider_metadata: JsonObject


def generate(response: JsonObject, key: str = "google") -> GenerateResult:
    candidates = response.get("candidates") or []
    candidate = candidates[0] if candidates else None
    feedback = response.get("promptFeedback")
    block = (feedback or {}).get("blockReason")
    confirmed = block if _confirmed_block(block) else None
    blocked = (candidate or {}).get("finishReason") is None and confirmed is not None
    raw_reason = (candidate or {}).get("finishReason")
    raw_reason = raw_reason if raw_reason is not None else confirmed
    content: list[JsonObject] = []
    parts = ((candidate or {}).get("content") or {}).get("parts") or []
    usage = shape(response.get("usageMetadata"), USAGE)
    for part in parts:
        if "text" in part and part.get("text") is not None:
            signature = _signature(part, key)
            if part["text"] == "":
                if signature is not None and content:
                    content[-1]["providerMetadata"] = signature
            else:
                item: JsonObject = {
                    "type": "reasoning" if part.get("thought") is True else "text",
                    "text": part["text"],
                }
                item["providerMetadata"] = signature
                content.append(item)
        elif "functionCall" in part and (part.get("functionCall") or {}).get("name") is not None:
            call = part["functionCall"]
            content.append(
                {
                    "type": "tool-call",
                    "toolCallId": call.get("id") or generate_id(),
                    "toolName": call["name"],
                    "input": js_json.stringify(call.get("args") if call.get("args") is not None else {}),
                    "providerMetadata": _signature(part, key),
                }
            )
        elif "inlineData" in part:
            data = part["inlineData"]
            content.append(
                {
                    "type": "reasoning-file" if part.get("thought") is True else "file",
                    "file": {"base64": data.get("data"), "mediaType": data.get("mimeType")},
                    "providerMetadata": _signature(part, key),
                }
            )
    has_calls = any(item["type"] == "tool-call" and not item.get("providerExecuted") for item in content)
    metadata: JsonObject = {
        "promptFeedback": shape(feedback, PROMPT_FEEDBACK),
        "groundingMetadata": (candidate or {}).get("groundingMetadata"),
        "urlContextMetadata": shape((candidate or {}).get("urlContextMetadata"), URL_CONTEXT),
        "safetyRatings": shape((candidate or {}).get("safetyRatings"), SAFETY_RATINGS),
        "usageMetadata": usage,
        "finishMessage": (candidate or {}).get("finishMessage"),
        "serviceTier": (usage or {}).get("serviceTier"),
    }
    if (candidate or {}).get("continuationToken") is not None:
        metadata["continuationToken"] = candidate["continuationToken"]
    return GenerateResult(
        content=content,
        finish_reason={
            "unified": "content-filter" if blocked else finish_reason(raw_reason, has_calls),
            "raw": raw_reason,
        },
        usage=convert_usage(usage),
        provider_metadata={key: metadata},
    )


class StreamParser:
    """``doStream``'s transform (one request; continuation requests are not made)."""

    def __init__(self, key: str = "google") -> None:
        self.key = key
        self.finish: JsonObject = {"unified": "interrupted", "raw": None}
        self.usage: JsonObject | None = None
        self.prompt_feedback: Any = None
        self.grounding: Any = None
        self.url_context: Any = None
        self.safety: Any = None
        self.finish_message: Any = None
        self.continuation: Any = None
        self.confirmed_block: Any = None
        self.has_tool_calls = False
        self.metadata_sent = False
        self.text_block: str | None = None
        self.reasoning_block: str | None = None
        self.counter = 0

    def _block_id(self) -> str:
        value = str(self.counter)
        self.counter += 1
        return value

    def _end_blocks(self, out: list[JsonObject]) -> None:
        if self.text_block is not None:
            out.append({"type": "text-end", "id": self.text_block})
            self.text_block = None
        if self.reasoning_block is not None:
            out.append({"type": "reasoning-end", "id": self.reasoning_block})
            self.reasoning_block = None

    def feed(self, value: JsonObject) -> list[JsonObject]:
        out: list[JsonObject] = []
        if value.get("error") is not None:
            self.finish = {"unified": "error", "raw": None}
            out.append({"type": "error", "error": (value["error"] or {}).get("message")})
            return out
        if not self.metadata_sent and value.get("responseId") is not None:
            self.metadata_sent = True
            out.append({"type": "response-metadata", "id": value["responseId"]})
        if value.get("usageMetadata") is not None:
            self.usage = shape(value["usageMetadata"], USAGE)
        feedback = value.get("promptFeedback")
        if feedback is not None and self.confirmed_block is None:
            self.prompt_feedback = shape(feedback, PROMPT_FEEDBACK)
            if _confirmed_block(feedback.get("blockReason")):
                self.confirmed_block = feedback["blockReason"]
                self.finish = {"unified": "content-filter", "raw": self.confirmed_block}
        candidates = value.get("candidates") or []
        candidate = candidates[0] if candidates else None
        if candidate is not None:
            if candidate.get("groundingMetadata") is not None:
                self.grounding = candidate["groundingMetadata"]
            if candidate.get("urlContextMetadata") is not None:
                self.url_context = shape(candidate["urlContextMetadata"], URL_CONTEXT)
            if candidate.get("safetyRatings") is not None:
                self.safety = shape(candidate["safetyRatings"], SAFETY_RATINGS)
            if candidate.get("finishMessage") is not None:
                self.finish_message = candidate["finishMessage"]
            if candidate.get("continuationToken") is not None:
                self.continuation = candidate["continuationToken"]
        if self.confirmed_block is not None or candidate is None:
            return out
        for part in (candidate.get("content") or {}).get("parts") or []:
            if "text" in part and part.get("text") is not None:
                self._text(part, out)
            elif "inlineData" in part:
                self._end_blocks(out)
                data = part["inlineData"]
                out.append(
                    {
                        "type": "reasoning-file" if part.get("thought") is True else "file",
                        "file": {"base64": data.get("data"), "mediaType": data.get("mimeType")},
                        "providerMetadata": _signature(part, self.key),
                    }
                )
            elif "functionCall" in part:
                self._call(part, out)
        if candidate.get("finishReason") is not None:
            self.finish = {
                "unified": finish_reason(candidate["finishReason"], self.has_tool_calls),
                "raw": candidate["finishReason"],
            }
        return out

    def _text(self, part: JsonObject, out: list[JsonObject]) -> None:
        signature = _signature(part, self.key)
        text = part["text"]
        if text == "":
            if signature is None:
                return
            if self.text_block is not None:
                out.append({"type": "text-delta", "id": self.text_block, "delta": "", "providerMetadata": signature})
                return
            if self.reasoning_block is not None:
                out.append({"type": "reasoning-end", "id": self.reasoning_block})
                self.reasoning_block = None
            block = self._block_id()
            kind = "reasoning" if part.get("thought") is True else "text"
            out.append({"type": f"{kind}-start", "id": block, "providerMetadata": signature})
            out.append({"type": f"{kind}-delta", "id": block, "delta": "", "providerMetadata": signature})
            out.append({"type": f"{kind}-end", "id": block})
            return
        if part.get("thought") is True:
            if self.text_block is not None:
                out.append({"type": "text-end", "id": self.text_block})
                self.text_block = None
            if self.reasoning_block is None:
                self.reasoning_block = self._block_id()
                out.append({"type": "reasoning-start", "id": self.reasoning_block, "providerMetadata": signature})
            out.append(
                {"type": "reasoning-delta", "id": self.reasoning_block, "delta": text, "providerMetadata": signature}
            )
            return
        if self.reasoning_block is not None:
            out.append({"type": "reasoning-end", "id": self.reasoning_block})
            self.reasoning_block = None
        if self.text_block is None:
            self.text_block = self._block_id()
            out.append({"type": "text-start", "id": self.text_block, "providerMetadata": signature})
        out.append({"type": "text-delta", "id": self.text_block, "delta": text, "providerMetadata": signature})

    def _call(self, part: JsonObject, out: list[JsonObject]) -> None:
        call = part.get("functionCall") or {}
        meta = _signature(part, self.key)
        complete = call.get("name") is not None and call.get("args") is not None and call.get("partialArgs") is None
        no_args = (
            call.get("name") is not None
            and call.get("args") is None
            and call.get("partialArgs") is None
            and call.get("willContinue") is not True
        )
        streaming = call.get("partialArgs") is not None or (
            call.get("name") is not None and call.get("willContinue") is True
        )
        if streaming or not (complete or no_args):
            return
        self._end_blocks(out)
        call_id = call.get("id") or generate_id()
        name = call["name"]
        start = {"type": "tool-input-start", "id": call_id, "toolName": name, "providerMetadata": meta}
        if complete:
            arguments = _args(call)
            out.append(start)
            out.append({"type": "tool-input-delta", "id": call_id, "delta": arguments, "providerMetadata": meta})
            out.append({"type": "tool-input-end", "id": call_id, "providerMetadata": meta})
            out.append(
                {
                    "type": "tool-call",
                    "toolCallId": call_id,
                    "toolName": name,
                    "input": arguments,
                    "providerMetadata": meta,
                }
            )
        else:
            out.append(start)
            out.append({"type": "tool-input-end", "id": call_id, "providerMetadata": meta})
            out.append(
                {"type": "tool-call", "toolCallId": call_id, "toolName": name, "input": "{}", "providerMetadata": meta}
            )
        self.has_tool_calls = True

    def close(self) -> list[JsonObject]:
        out: list[JsonObject] = []
        if self.text_block is not None:
            out.append({"type": "text-end", "id": self.text_block})
        if self.reasoning_block is not None:
            out.append({"type": "reasoning-end", "id": self.reasoning_block})
        metadata: JsonObject = {
            "promptFeedback": self.prompt_feedback,
            "groundingMetadata": self.grounding,
            "urlContextMetadata": self.url_context,
            "safetyRatings": self.safety,
            "usageMetadata": self.usage,
            "finishMessage": self.finish_message,
            "serviceTier": (self.usage or {}).get("serviceTier"),
        }
        if self.continuation is not None and self.finish.get("raw") in ("MAX_TOKENS", "CONTINUATION"):
            metadata["continuationToken"] = self.continuation
        out.append(
            {
                "type": "finish",
                "finishReason": self.finish,
                "usage": convert_usage(self.usage),
                "providerMetadata": {self.key: metadata},
            }
        )
        return out
