"""Assistant turns as Responses API input items, as ``@ai-sdk/openai`` and ``@ai-sdk/xai`` build them.

Replaying an assistant turn depends on the provider metadata each part carries
(``providerOptions.openai.itemId``, ``reasoningEncryptedContent``, ``phase``) and
on ``store``: with stored responses the AI SDK refers to earlier items by id
(``item_reference``); without, it sends them in full. pydantic-ai follows
different rules, so ``ResponsesChatModel`` sends the items built here for each
assistant turn. These functions port the ``assistant`` branch of
``convertToOpenAIResponsesInput`` and ``convertToXaiResponsesInput`` for the
content a runtime transcript holds: text, JSON, reasoning, tool calls, and
provider-executed tool results.
"""

from __future__ import annotations

import re
from typing import Any

from .._js import json as js_json

JsonObject = dict[str, Any]

#: ``ModelResponse.provider_details`` key holding the prepared input items.
ITEMS_KEY = "clearideas_responses_items"


def is_openai_reasoning_model(model_id: str) -> bool:
    """``@ai-sdk/openai``: o-series models and GPT 5+ models other than ``gpt-N-chat*``."""
    if re.match(r"^o(\d+)(?:-|$)", model_id):
        return True
    match = re.fullmatch(r"gpt-(\d+)(?:\.(\d+))?(?:-(.+))?", model_id, re.DOTALL)
    if match is None:
        return False
    chat = match.group(2) is None and (match.group(3) or "").startswith("chat")
    return int(match.group(1)) >= 5 and not chat


def _options(part: JsonObject, key: str) -> JsonObject:
    options = part.get("providerOptions")
    value = options.get(key) if isinstance(options, dict) else None
    return value if isinstance(value, dict) else {}


def _sendable(message: JsonObject) -> list[JsonObject]:
    """The AI SDK drops empty assistant text without provider options; JSON becomes text."""
    parts: list[JsonObject] = []
    for part in message["content"]:
        if part["type"] == "json":
            part = {"type": "text", "text": js_json.stringify(part["value"]), **_provider_options(part)}
        if part["type"] == "text" and part["text"] == "" and part.get("providerOptions") is None:
            continue
        parts.append(part)
    return parts


def _provider_options(part: JsonObject) -> JsonObject:
    return {"providerOptions": part["providerOptions"]} if part.get("providerOptions") is not None else {}


def _is_denied(result: JsonObject) -> bool:
    output = result.get("output")
    return isinstance(output, dict) and output.get("type") == "execution-denied"


def openai_assistant_items(
    message: JsonObject,
    *,
    key: str = "openai",
    store: bool = True,
    is_reasoning_model: bool = False,
    has_conversation: bool = False,
    has_previous_response_id: bool = False,
) -> list[JsonObject]:
    """``@ai-sdk/openai`` ``convertToOpenAIResponsesInput``, ``assistant`` role."""
    items: list[JsonObject] = []
    reasoning_items: dict[str, JsonObject] = {}
    emitted_text_ids: set[str] = set()
    preceding_reasoning = False
    for part in _sendable(message):
        kind = part["type"]
        options = _options(part, key)
        if kind == "text":
            item_id = options.get("itemId")
            if has_conversation and item_id is not None:
                continue
            if store and item_id is not None and (not is_reasoning_model or preceding_reasoning):
                if item_id not in emitted_text_ids:
                    emitted_text_ids.add(item_id)
                    items.append({"type": "item_reference", "id": item_id})
                continue
            item: JsonObject = {"role": "assistant", "content": part["text"]}
            if options.get("phase") is not None:
                item["phase"] = options["phase"]
            items.append(item)
        elif kind == "tool-call":
            call = part["call"]
            item_id = options.get("itemId")
            if has_conversation and item_id is not None:
                continue
            if call.get("providerExecuted"):
                if store and item_id is not None:
                    items.append({"type": "item_reference", "id": item_id})
                continue
            arguments = call["input"] if isinstance(call["input"], str) else js_json.stringify(call["input"])
            item = {"type": "function_call", "call_id": call["id"], "name": call["name"], "arguments": arguments}
            if options.get("namespace") is not None:
                item["namespace"] = options["namespace"]
            items.append(item)
        elif kind == "tool-result":
            result = part["result"]
            if _is_denied(result) or has_conversation:
                continue
            if store:
                items.append({"type": "item_reference", "id": options.get("itemId") or result["callId"]})
            # Without `store`, the AI SDK does not send results of provider-executed tools.
        elif kind == "reasoning":
            preceding_reasoning = True
            text = part.get("text") or ""
            reasoning_id = options.get("itemId")
            encrypted = options.get("reasoningEncryptedContent")
            if (has_conversation or has_previous_response_id) and reasoning_id is not None:
                continue
            if reasoning_id is not None:
                existing = reasoning_items.get(reasoning_id)
                if store:
                    if existing is None:
                        items.append({"type": "item_reference", "id": reasoning_id})
                        reasoning_items[reasoning_id] = {"type": "reasoning", "id": reasoning_id, "summary": []}
                    continue
                summary = [{"type": "summary_text", "text": text}] if text else []
                if existing is None:
                    item = {"type": "reasoning", "id": reasoning_id}
                    if encrypted is not None:
                        item["encrypted_content"] = encrypted
                    item["summary"] = summary
                    reasoning_items[reasoning_id] = item
                    items.append(item)
                else:
                    existing["summary"].extend(summary)
                    if encrypted is not None:
                        existing["encrypted_content"] = encrypted
            elif encrypted is not None:
                summary = [{"type": "summary_text", "text": text}] if text else []
                items.append({"type": "reasoning", "encrypted_content": encrypted, "summary": summary})
            # Reasoning without an item id or encrypted content is not sent (AI SDK warning).
    return items


def xai_assistant_items(message: JsonObject) -> list[JsonObject]:
    """``@ai-sdk/xai`` ``convertToXaiResponsesInput``, ``assistant`` role."""
    items: list[JsonObject] = []
    for part in _sendable(message):
        kind = part["type"]
        options = _options(part, "xai")
        item_id = options.get("itemId") if isinstance(options.get("itemId"), str) else None
        if kind == "text":
            item: JsonObject = {"role": "assistant", "content": part["text"]}
            if item_id is not None:
                item["id"] = item_id
            items.append(item)
        elif kind == "tool-call":
            call = part["call"]
            if call.get("providerExecuted"):
                continue
            items.append(
                {
                    "type": "function_call",
                    "id": item_id or call["id"],
                    "call_id": call["id"],
                    "name": call["name"],
                    "arguments": js_json.stringify(call["input"]),
                    "status": "completed",
                }
            )
        elif kind == "reasoning":
            encrypted = options.get("reasoningEncryptedContent")
            encrypted = encrypted if isinstance(encrypted, str) else None
            if item_id is None and encrypted is None:
                continue
            text = part.get("text") or ""
            item = {
                "type": "reasoning",
                "id": item_id or "",
                "summary": [{"type": "summary_text", "text": text}] if text else [],
                "status": "completed",
            }
            if encrypted is not None:
                item["encrypted_content"] = encrypted
            items.append(item)
    return items
