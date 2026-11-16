"""pydantic-ai model adapter (the Python counterpart of ``@clearideas/agent-runtime-model-ai-sdk``).

Keeps pydantic-ai message and provider types behind the neutral
``ModelAdapter`` port. Each call is one model turn through pydantic-ai's direct
API (``model_request`` / ``model_request_stream``). Tool definitions are
advertised without execution; Agent Runtime owns ordered tool execution.

The adapter reproduces the AI SDK adapter's contract:

- messages, media, tools, ``toolChoice``, structured output, and
  ``maxOutputTokens`` map to the provider request;
- AI SDK ``providerOptions`` translate to pydantic-ai model settings
  (``provider_options``); replay metadata (OpenAI item ids and encrypted
  reasoning, Anthropic signatures, Gemini thought signatures) is stored in
  ``providerOptions`` on transcript parts with the AI SDK's keys, so
  checkpoints resume in either runtime;
- unknown tool names and unparsable tool input are marked
  ``metadata.agentRuntime.invalid`` and answered with a tool error, like the
  AI SDK;
- an unparsable structured answer raises ``NoObjectGeneratedError`` (name
  ``AI_NoObjectGeneratedError``), which prompt steps repair.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import re
import sys
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any

from .._js import json as js_json
from .._js import time as js_time
from .._js.abort import AbortSignal
from .._js.errors import Error
from .ai_sdk import core as ai_sdk_core
from .ai_sdk import errors as ai_sdk_errors
from .ai_sdk import results as ai_sdk_results
from .ai_sdk.capture import Exchange, capturing
from .provider_options import (
    REQUEST_BODY_SETTING,
    TranslatedOptions,
    anthropic_cache_control,
    cache_ttl,
    deep_merge,
    translate_provider_options,
)
from .responses_input import ITEMS_KEY, is_openai_reasoning_model, openai_assistant_items, xai_assistant_items

JsonObject = dict[str, Any]

try:  # pragma: no cover - exercised when the providers extra is installed
    from pydantic_ai import direct as _direct
    from pydantic_ai import messages as _m
    from pydantic_ai.models import Model, ModelRequestParameters
    from pydantic_ai.output import OutputObjectDefinition
    from pydantic_ai.tools import ToolDefinition
except ImportError as _error:  # pragma: no cover
    raise ImportError(
        "The pydantic-ai model adapter needs the providers extra: pip install 'clearideas-agent-runtime[providers]'"
    ) from _error


@dataclass(frozen=True)
class ParsedModelKey:
    provider: str
    model_id: str


def parse_model_key(value: str, default_provider: str | None = None) -> ParsedModelKey:
    normalized = value.strip()
    separator = normalized.find("/")
    if 0 < separator < len(normalized) - 1:
        return ParsedModelKey(normalized[:separator], normalized[separator + 1 :])
    if default_provider and normalized:
        return ParsedModelKey(default_provider, normalized)
    raise Error(f'Model "{value}" must use provider/model format or configure a default provider')


@dataclass
class ResolvedModel:
    """A pydantic-ai model plus the AI SDK driver whose ``providerOptions`` apply to it.

    ``name`` is the configured provider name (an OpenAI-compatible provider
    reads ``providerOptions[name]``).
    """

    model: Model
    driver: str
    name: str | None = None


ModelResolver = Callable[[str], "Model | ResolvedModel"]
ProviderModelFactory = Callable[[str], "Model | ResolvedModel"]


def create_provider_registry_model_resolver(
    providers: Mapping[str, ProviderModelFactory], default_provider: str | None = None
) -> ModelResolver:
    """Creates a resolver from provider factories keyed by provider name."""

    def resolve(model: str) -> Model | ResolvedModel:
        parsed = parse_model_key(model, default_provider)
        factory = providers.get(parsed.provider)
        if factory is None:
            raise Error(f'No model provider factory is registered for "{parsed.provider}"')
        return factory(parsed.model_id)

    return resolve


class NoObjectGeneratedError(Error):
    """The final answer did not parse as the requested JSON object (AI SDK ``NoObjectGeneratedError``)."""

    name = "AI_NoObjectGeneratedError"

    def __init__(self, message: str, text: str | None = None) -> None:
        super().__init__(message)
        self.text = text


def _driver_of(model: Model) -> str:
    """The driver of a bare pydantic-ai model, for tests and custom resolvers."""
    driver = getattr(model, "ai_sdk_driver", None)
    if isinstance(driver, str):
        return driver
    kind = type(model).__name__
    if kind.startswith("Anthropic"):
        return "anthropic"
    if kind.startswith("Google") or kind.startswith("Gemini"):
        return "google"
    if kind.startswith("Groq"):
        return "groq"
    if kind.startswith("Cohere"):
        return "cohere"
    if kind == "OpenAIChatModel":
        return "openai-compatible"
    return "openai"


def _resolved(value: Model | ResolvedModel) -> ResolvedModel:
    return value if isinstance(value, ResolvedModel) else ResolvedModel(value, _driver_of(value))


# ─── Replay metadata ────────────────────────────────────────────────────────


def _options_key(resolved: ResolvedModel) -> str:
    if resolved.driver == "openai-compatible":
        return resolved.name or "openaiCompatible"
    return resolved.driver


def _part_options(part: JsonObject, key: str) -> JsonObject:
    options = part.get("providerOptions")
    value = options.get(key) if isinstance(options, dict) else None
    return value if isinstance(value, dict) else {}


def _replay_options(key: str, values: JsonObject) -> JsonObject:
    present = {name: value for name, value in values.items() if value is not None}
    return {"providerOptions": {key: present}} if present else {}


# ─── Request mapping ────────────────────────────────────────────────────────


def _parts_as_text(parts: list[JsonObject]) -> str:
    texts = []
    for part in parts:
        if part["type"] == "text":
            texts.append(part["text"])
        elif part["type"] == "json":
            texts.append(js_json.stringify(part["value"]))
        elif part["type"] == "reasoning":
            texts.append(part.get("text") or "")
    return "\n".join(text for text in texts if text)


def _media_type(part: JsonObject) -> str | None:
    value = part.get("mediaType")
    if value is None:
        value = (part.get("artifact") or {}).get("mediaType")
    return value


_DATA_URL = re.compile(r"^data:([^,;]*)(?:;[^,]*)?;base64,(.*)$", re.DOTALL)


def _file_url(url: str, media_type: str | None, image: bool = False) -> Any:
    if image or (media_type or "").startswith("image/"):
        return _m.ImageUrl(url=url, media_type=media_type) if media_type else _m.ImageUrl(url=url)
    if (media_type or "").startswith("audio/"):
        return _m.AudioUrl(url=url, media_type=media_type)
    if (media_type or "").startswith("video/"):
        return _m.VideoUrl(url=url, media_type=media_type)
    return _m.DocumentUrl(url=url, media_type=media_type) if media_type else _m.DocumentUrl(url=url)


def _media_content(part: JsonObject, vendor_metadata: JsonObject | None = None) -> Any:
    media_type = _media_type(part)
    if part.get("data") is not None:
        if media_type is None:
            raise Error(f"{part['type']} content requires a media type")
        return _m.BinaryContent(
            data=base64.b64decode(part["data"]), media_type=media_type, vendor_metadata=vendor_metadata
        )
    uri = part.get("url") or (part.get("artifact") or {}).get("uri")
    if uri is None:
        raise Error(f"{part['type']} content requires resolvable data or a URL")
    inline = _DATA_URL.match(uri)
    if inline:
        return _m.BinaryContent(
            data=base64.b64decode(inline.group(2)),
            media_type=media_type or inline.group(1) or "application/octet-stream",
            vendor_metadata=vendor_metadata,
        )
    if part["type"] == "file" and media_type is None:
        raise Error("file content requires a media type")
    content = _file_url(uri, media_type, image=part["type"] == "image")
    if vendor_metadata:
        content.vendor_metadata = vendor_metadata
    return content


def _media_metadata(part: JsonObject, driver: str) -> JsonObject | None:
    """Provider-specific media fields the adapters read from ``vendor_metadata``."""
    if driver == "cohere":
        # @ai-sdk/cohere: `providerOptions.cohere.detail` on images, the file name as a document title.
        metadata: JsonObject = {}
        detail = _part_options(part, "cohere").get("detail")
        if detail:
            metadata["detail"] = detail
        name = part.get("name") or (part.get("artifact") or {}).get("name")
        if part["type"] == "file" and name:
            metadata["filename"] = name
        return metadata or None
    detail = _part_options(part, "openai").get("imageDetail")
    return {"detail": detail} if detail else None


def _user_content(message: JsonObject, driver: str = "") -> list[Any]:
    content: list[Any] = []
    for part in message["content"]:
        kind = part["type"]
        if kind == "text":
            # The AI SDK drops empty text parts from user messages.
            if part["text"]:
                content.append(part["text"])
        elif kind == "json":
            content.append(js_json.stringify(part["value"]))
        elif kind in ("image", "file"):
            content.append(_media_content(part, _media_metadata(part, driver)))
        else:
            raise Error(f"User messages cannot contain {kind} content")
        cache = anthropic_cache_control(part.get("providerOptions"))
        if cache is not None:
            content.append(_m.CachePoint(ttl=cache_ttl(cache) or "5m"))  # pyright: ignore[reportArgumentType]
    cache = anthropic_cache_control(message.get("providerOptions"))
    if cache is not None and (not content or not isinstance(content[-1], _m.CachePoint)):
        content.append(_m.CachePoint(ttl=cache_ttl(cache) or "5m"))  # pyright: ignore[reportArgumentType]
    return content


def _tool_return_content(result: JsonObject) -> Any:
    artifacts = result.get("artifacts") or []
    if artifacts:
        value: list[Any] = []
        if "output" in result:
            output = result["output"]
            value.append(output if isinstance(output, str) else js_json.stringify(output))
        for artifact in artifacts:
            if artifact.get("uri") is None:
                raise Error(f"Historical tool artifact {artifact['id']} requires a URI")
            value.append(
                _media_content({"type": "file", "url": artifact["uri"], "mediaType": artifact.get("mediaType")})
            )
        return value
    if result.get("error") is not None:
        return {"error": {"code": result["error"]["code"], "message": result["error"]["message"]}}
    output = result.get("output")
    return output


def _tool_return(part: JsonObject, native: bool = False, driver: str = "") -> Any:
    result = part["result"]
    kind = _m.NativeToolReturnPart if native else _m.ToolReturnPart
    content = _tool_return_content(result)
    if not native and not result.get("artifacts"):
        # The AI SDK adapter sends every result (errors too) as JSON output `result.output ?? null`.
        # Providers send JSON output as `JSON.stringify(value)`, except Gemini, which receives
        # `{name, content: value}` as the function response.
        content = {"name": result["name"], "content": content} if driver == "google" else js_json.stringify(content)
    return kind(
        tool_name=result["name"],
        content=content,
        tool_call_id=result["callId"],
        outcome="success",
    )


#: Drivers whose API takes one assistant message with a text field (Chat Completions style).
_CHAT_DRIVERS = ("groq", "cohere", "openai-compatible")


def _chat_assistant_parts(parts: list[Any]) -> list[Any]:
    """One thinking part and one text part, each the concatenation of the message's parts.

    The AI SDK Chat Completions-style providers build an assistant message as
    ``text += part.text`` (and ``reasoning += part.text``); tool calls keep their order.
    """
    thinking = "".join(part.content for part in parts if isinstance(part, _m.ThinkingPart))
    texts = [part for part in parts if isinstance(part, _m.TextPart)]
    merged: list[Any] = [_m.ThinkingPart(content=thinking)] if thinking else []
    if texts:
        merged.append(_m.TextPart(content="".join(part.content for part in texts)))
    merged.extend(part for part in parts if not isinstance(part, _m.ThinkingPart | _m.TextPart))
    return merged


def _anthropic_assistant_parts(parts: list[Any], last: bool) -> list[Any]:
    """``@ai-sdk/anthropic``: empty text dropped, tool uses moved after the text of their
    thinking-delimited segment, and the final text of a trailing assistant turn trimmed."""
    parts = [part for part in parts if not (isinstance(part, _m.TextPart) and part.content == "")]
    ordered: list[Any] = []
    segment: list[Any] = []

    def flush() -> None:
        ordered.extend(part for part in segment if not isinstance(part, _m.ToolCallPart))
        ordered.extend(part for part in segment if isinstance(part, _m.ToolCallPart))
        segment.clear()

    for part in parts:
        if isinstance(part, _m.ThinkingPart):
            flush()
            ordered.append(part)
        else:
            segment.append(part)
    flush()
    if last and parts and isinstance(parts[-1], _m.TextPart):
        index = ordered.index(parts[-1])
        ordered[index] = replace(parts[-1], content=parts[-1].content.strip())
    return ordered


def _assistant_parts(
    message: JsonObject, resolved: ResolvedModel, options: TranslatedOptions, last: bool = False
) -> list[Any]:
    parts = _assistant_part_list(message, resolved, options)
    if resolved.driver in _CHAT_DRIVERS:
        return _chat_assistant_parts(parts)
    if resolved.driver == "anthropic":
        return _anthropic_assistant_parts(parts, last)
    return parts


def _assistant_part_list(message: JsonObject, resolved: ResolvedModel, options: TranslatedOptions) -> list[Any]:
    key = _options_key(resolved)
    system = resolved.model.system
    parts: list[Any] = []
    for part in message["content"]:
        kind = part["type"]
        replay = _part_options(part, key)
        if kind == "text":
            # The AI SDK drops empty assistant text parts that carry no provider options.
            if not part["text"] and part.get("providerOptions") is None:
                continue
            parts.append(_m.TextPart(content=part["text"], **_text_replay(replay, resolved, system)))
        elif kind == "json":
            parts.append(_m.TextPart(content=js_json.stringify(part["value"])))
        elif kind == "reasoning":
            if not options.send_reasoning:
                continue
            thinking = _thinking_part(part.get("text") or "", replay, resolved, system)
            if thinking is not None:
                parts.append(thinking)
        elif kind == "tool-call":
            call = part["call"]
            tool_kind = _m.NativeToolCallPart if call.get("providerExecuted") else _m.ToolCallPart
            parts.append(
                tool_kind(
                    tool_name=call["name"],
                    args=call["input"],
                    tool_call_id=call["id"],
                    **_text_replay(replay, resolved, system),
                )
            )
        elif kind == "tool-result":
            parts.append(_tool_return(part, native=True))
        elif kind in ("image", "file"):
            content = _media_content(part)
            if not isinstance(content, _m.BinaryContent):
                raise Error("Assistant media must be inline data")
            parts.append(_m.FilePart(content=content))
        else:
            raise Error("Unsupported assistant content")
    return parts


def _responses_items(message: JsonObject, resolved: ResolvedModel, options: TranslatedOptions) -> JsonObject | None:
    """Responses API drivers: the assistant turn as the AI SDK's input items (see ``responses_input``)."""
    if resolved.driver == "xai":
        return {ITEMS_KEY: xai_assistant_items(message)}
    if resolved.driver == "openai":
        settings = options.settings
        items = openai_assistant_items(
            message,
            key=_options_key(resolved),
            store=settings.get("openai_store") is not False,
            is_reasoning_model=is_openai_reasoning_model(resolved.model.model_name),
            has_conversation=settings.get("openai_conversation_id") is not None,
            has_previous_response_id=settings.get("openai_previous_response_id") is not None,
        )
        return {ITEMS_KEY: items}
    return None


def _text_replay(replay: JsonObject, resolved: ResolvedModel, system: str) -> JsonObject:
    fields: JsonObject = {}
    if resolved.driver in ("openai", "xai") and replay.get("itemId"):
        fields["id"] = replay["itemId"]
        fields["provider_name"] = system
    if resolved.driver == "google" and replay.get("thoughtSignature"):
        fields["provider_details"] = {"thought_signature": replay["thoughtSignature"]}
        fields["provider_name"] = system
    return fields


def _thinking_part(text: str, replay: JsonObject, resolved: ResolvedModel, system: str) -> Any:
    if resolved.driver == "anthropic":
        if replay.get("redactedData"):
            return _m.ThinkingPart(
                content="", id="redacted_thinking", signature=replay["redactedData"], provider_name=system
            )
        if replay.get("signature"):
            return _m.ThinkingPart(content=text, signature=replay["signature"], provider_name=system)
    if resolved.driver in ("openai", "xai") and (replay.get("itemId") or replay.get("reasoningEncryptedContent")):
        return _m.ThinkingPart(
            content=text,
            id=replay.get("itemId"),
            signature=replay.get("reasoningEncryptedContent"),
            provider_name=system,
        )
    if resolved.driver == "google" and replay.get("thoughtSignature"):
        return _m.ThinkingPart(
            content=text,
            provider_details={"thought_signature": replay["thoughtSignature"]},
            provider_name=system,
        )
    if resolved.driver in ("openai", "xai", "anthropic", "cohere"):
        # These AI SDK providers skip reasoning they cannot replay (no item id, encrypted
        # content, or signature); Cohere never sends reasoning back.
        return None
    return _m.ThinkingPart(content=text)


@dataclass
class CallOptions:
    """Everything one pydantic-ai request needs (inspectable by tests)."""

    model: Model
    messages: list[Any]
    model_settings: JsonObject
    parameters: ModelRequestParameters
    resolved: ResolvedModel
    output_mode: str | None = None
    signal: AbortSignal | None = None
    options: TranslatedOptions | None = None


def _merge_requests(messages: list[Any]) -> list[Any]:
    """Consecutive request messages become one request, as pydantic-ai builds them."""
    merged: list[Any] = []
    for message in messages:
        if merged and isinstance(message, _m.ModelRequest) and isinstance(merged[-1], _m.ModelRequest):
            merged[-1] = _m.ModelRequest(parts=[*merged[-1].parts, *message.parts])
        else:
            merged.append(message)
    return merged


def _structured_mode(resolved: ResolvedModel, options: TranslatedOptions) -> str:
    """How a JSON-schema answer is requested, matching the AI SDK provider for the driver.

    ``native``: the provider's JSON-schema response format. ``json-object``: the
    provider's JSON mode without a schema (the AI SDK's OpenAI-compatible
    provider without ``supportsStructuredOutputs``). ``prompted``: JSON mode
    plus schema instructions. ``tool``: an output tool (providers without a
    JSON response format).
    """
    profile = resolved.model.profile or {}
    if options.structured_outputs is False:
        # `structuredOutputs: false`: the AI SDK providers ask for JSON without a schema and
        # without adding instructions to the prompt.
        return "json-object"
    if profile.get("supports_json_schema_output", False):
        return "native"
    if resolved.driver == "openai-compatible":
        return "json-object"
    if profile.get("supports_json_object_output", False):
        return "prompted"
    return "tool"


OUTPUT_TOOL_NAME = "json"


def to_call_options(request: JsonObject, value: Model | ResolvedModel, max_retries: int | None = 2) -> CallOptions:
    resolved = _resolved(value)
    options = translate_provider_options(resolved.driver, request.get("providerOptions"), resolved.name)
    settings = options.model_settings()
    messages: list[Any] = []
    system_texts: list[str] = []
    for message in request["messages"]:
        if message["role"] != "system":
            continue
        text = _parts_as_text(message["content"])
        if text:
            system_texts.append(text)
        cache = anthropic_cache_control(message.get("providerOptions"))
        if cache is None:
            cache = next(
                (
                    anthropic_cache_control(part.get("providerOptions"))
                    for part in message["content"]
                    if anthropic_cache_control(part.get("providerOptions")) is not None
                ),
                None,
            )
        if cache is not None and resolved.driver == "anthropic":
            settings.setdefault("anthropic_cache_instructions", cache_ttl(cache) or True)
    first_request_parts: list[Any] = [_m.SystemPromptPart(content="\n\n".join(system_texts))] if system_texts else []
    for message in request["messages"]:
        role = message["role"]
        if role == "system":
            continue
        if role == "tool":
            parts = []
            for part in message["content"]:
                if part["type"] != "tool-result":
                    raise Error(f"Tool messages cannot contain {part['type']} content")
                parts.append(_tool_return(part, driver=resolved.driver))
            messages.append(_m.ModelRequest(parts=parts))
        elif role == "assistant":
            last = message is request["messages"][-1]
            messages.append(
                _m.ModelResponse(
                    parts=_assistant_parts(message, resolved, options, last),
                    provider_details=_responses_items(message, resolved, options),
                )
            )
        else:
            messages.append(_m.ModelRequest(parts=[_m.UserPromptPart(content=_user_content(message, resolved.driver))]))
    if first_request_parts:
        if messages and isinstance(messages[0], _m.ModelRequest):
            messages[0] = _m.ModelRequest(parts=[*first_request_parts, *messages[0].parts])
        else:
            messages.insert(0, _m.ModelRequest(parts=first_request_parts))
    messages = _merge_requests(messages)

    tools = [
        ToolDefinition(
            name=tool["name"],
            parameters_json_schema=tool.get("inputSchema") or {"type": "object", "properties": {}},
            description=tool.get("description"),
            metadata=tool.get("metadata"),
            # The AI SDK advertises function tools as non-strict unless asked.
            strict=False,
        )
        for tool in request.get("tools") or []
    ]
    parameters = ModelRequestParameters(function_tools=tools)
    if tools and request.get("toolChoice") is not None:
        settings["tool_choice"] = request["toolChoice"]
    output_mode: str | None = None
    if request.get("outputSchema") is not None:
        output_mode = _structured_mode(resolved, options)
        schema = request["outputSchema"]
        definition = OutputObjectDefinition(
            json_schema=schema,
            name="response",
            strict=True if options.strict_json_schema is None else options.strict_json_schema,
        )
        if output_mode == "tool":
            if resolved.driver == "anthropic":
                # @ai-sdk/anthropic's JSON response tool disables parallel tool use.
                settings["parallel_tool_calls"] = False
            parameters = replace(
                parameters,
                output_mode="tool",
                output_tools=[
                    ToolDefinition(
                        name=OUTPUT_TOOL_NAME,
                        parameters_json_schema=schema,
                        description="Respond with a JSON object.",
                        kind="output",
                    )
                ],
                allow_text_output=False,
            )
        elif output_mode == "json-object":
            if resolved.driver == "google":
                body = deep_merge(
                    settings.get(REQUEST_BODY_SETTING) or {},
                    {"generationConfig": {"responseMimeType": "application/json"}},
                )
                settings[REQUEST_BODY_SETTING] = body
            else:
                settings["extra_body"] = {
                    **(settings.get("extra_body") or {}),
                    "response_format": {"type": "json_object"},
                }
        else:
            parameters = replace(parameters, output_mode=output_mode, output_object=definition)
    if request.get("maxOutputTokens") is not None:
        settings["max_tokens"] = request["maxOutputTokens"]
    thinking = settings.get("anthropic_thinking")
    if resolved.driver == "anthropic" and isinstance(thinking, dict) and thinking.get("type") == "enabled":
        # Like the AI SDK: the thinking budget (1024 by default) is added to the output budget.
        budget = thinking.setdefault("budget_tokens", 1024)
        if "max_tokens" in settings:
            settings["max_tokens"] = settings["max_tokens"] + budget
    if max_retries is not None:
        settings.setdefault("max_retries", max_retries)
    return CallOptions(
        model=resolved.model,
        messages=messages,
        model_settings=settings,
        parameters=parameters,
        resolved=resolved,
        output_mode=output_mode,
        signal=request.get("signal"),
        options=options,
    )


# ─── Response mapping ───────────────────────────────────────────────────────

_FINISH_REASONS = {
    "stop": "stop",
    "length": "length",
    "content_filter": "content-filter",
    "tool_call": "tool-calls",
    "error": "error",
}


def _usage(response: Any) -> JsonObject | None:
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    input_tokens = usage.input_tokens or 0
    output_tokens = usage.output_tokens or 0
    mapped: JsonObject = {"inputTokens": input_tokens, "outputTokens": output_tokens}
    reasoning = getattr(usage, "output_reasoning_tokens", 0) or (getattr(usage, "details", None) or {}).get(
        "reasoning_tokens", 0
    )
    if reasoning:
        mapped["reasoningTokens"] = reasoning
    if usage.cache_read_tokens:
        mapped["cachedInputTokens"] = usage.cache_read_tokens
    if usage.cache_write_tokens:
        mapped["cacheWriteTokens"] = usage.cache_write_tokens
    mapped["totalTokens"] = input_tokens + output_tokens
    if not input_tokens and not output_tokens and len(mapped) == 3:
        return None
    return mapped


def _jsonable(value: Any) -> Any:
    """Provider metadata as JSON: datetimes as ISO strings, bytes as base64, objects as dictionaries."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return js_json.normalize(value)
    if isinstance(value, datetime):
        return js_time.to_iso(value)
    if isinstance(value, (bytes, bytearray)):
        return _bytes_base64(bytes(value))
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items() if item is not None}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(item) for item in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return _jsonable(dump(mode="json"))
    return str(value)


def _bytes_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _json_input(args: Any) -> tuple[JsonObject, str | None]:
    """Tool-call input as a JSON object, and a parse error message (AI SDK ``InvalidToolInputError``)."""
    if args is None or args == "":
        return {}, None
    if isinstance(args, str):
        try:
            value = js_json.parse(args)
        except ValueError as error:
            return {"value": args}, str(error)
    else:
        value = js_json.to_json_value(args)
    if isinstance(value, dict):
        return value, None
    return {"value": value}, None


class _ResponseMapper:
    def __init__(self, call: CallOptions, request: JsonObject) -> None:
        self.call = call
        self.request = request
        self.key = _options_key(call.resolved)
        self.available = [tool.name for tool in call.parameters.function_tools]

    def _replay(self, part: Any) -> JsonObject:
        driver = self.call.resolved.driver
        if driver in ("openai", "xai"):
            values: JsonObject = {"itemId": getattr(part, "id", None)}
            if isinstance(part, _m.ThinkingPart):
                values["reasoningEncryptedContent"] = part.signature
            return _replay_options(self.key, values)
        if driver == "anthropic" and isinstance(part, _m.ThinkingPart):
            if part.id == "redacted_thinking":
                return _replay_options(self.key, {"redactedData": part.signature})
            return _replay_options(self.key, {"signature": part.signature})
        if driver == "google":
            details = getattr(part, "provider_details", None) or {}
            return _replay_options(self.key, {"thoughtSignature": details.get("thought_signature")})
        return {}


def _build_result(
    call: CallOptions,
    request: JsonObject,
    response: Any,
    now: Callable[[], datetime],
    generate_id: Callable[[], str],
) -> tuple[JsonObject, list[JsonObject]]:
    """A neutral ``ModelResult`` and the tool calls it contains, from a pydantic-ai ``ModelResponse``."""
    mapper = _ResponseMapper(call, request)
    content: list[JsonObject] = []
    tool_calls: list[JsonObject] = []
    invalid_results: list[JsonObject] = []
    native_results: list[JsonObject] = []
    texts: list[str] = []
    structured: Any = None
    structured_set = False
    for part in response.parts:
        if isinstance(part, _m.TextPart):
            texts.append(part.content)
            content.append({"type": "text", "text": part.content, **mapper._replay(part)})
        elif isinstance(part, _m.ThinkingPart):
            reasoning: JsonObject = {"type": "reasoning"}
            if part.content or part.id != "redacted_thinking":
                reasoning["text"] = part.content
            content.append({**reasoning, **mapper._replay(part)})
        elif isinstance(part, _m.NativeToolCallPart):
            input_value, _ = _json_input(part.args)
            tool_call = {
                "id": part.tool_call_id,
                "name": part.tool_name,
                "input": input_value,
                "providerExecuted": True,
            }
            content.append({"type": "tool-call", "call": tool_call, **mapper._replay(part)})
            tool_calls.append(tool_call)
        elif isinstance(part, _m.ToolCallPart):
            input_value, parse_error = _json_input(part.args)
            if (
                call.output_mode == "tool"
                and part.tool_name == OUTPUT_TOOL_NAME
                and OUTPUT_TOOL_NAME not in mapper.available
            ):
                structured = input_value if parse_error is None else None
                structured_set = True
                text = part.args if isinstance(part.args, str) else js_json.stringify(input_value)
                texts.append(text)
                content.append({"type": "text", "text": text})
                if parse_error is not None:
                    raise NoObjectGeneratedError("No object generated: could not parse the response.", text)
                continue
            tool_call: JsonObject = {"id": part.tool_call_id, "name": part.tool_name, "input": input_value}
            error: str | None = None
            if part.tool_name not in mapper.available:
                error = (
                    f"Model tried to call unavailable tool '{part.tool_name}'. "
                    f"Available tools: {', '.join(mapper.available)}."
                )
            elif parse_error is not None:
                error = f"Invalid input for tool {part.tool_name}: JSON parsing failed: Text: {part.args}.\nError message: {parse_error}"
            if error is not None:
                tool_call["metadata"] = {"agentRuntime": {"invalid": True, "error": error}}
                invalid_results.append(
                    {
                        "type": "tool-result",
                        "result": {
                            "callId": part.tool_call_id,
                            "name": part.tool_name,
                            "error": {"code": "tool_error", "message": error},
                        },
                    }
                )
            content.append({"type": "tool-call", "call": tool_call, **mapper._replay(part)})
            tool_calls.append(tool_call)
        elif isinstance(part, _m.NativeToolReturnPart):
            value = part.content
            native_results.append(
                {
                    "type": "tool-result",
                    "result": {
                        "callId": part.tool_call_id,
                        "name": part.tool_name,
                        "output": _jsonable(value),
                    },
                }
            )
        elif isinstance(part, _m.FilePart):
            file: JsonObject = {
                "type": "file",
                "data": _bytes_base64(part.content.data),
                "mediaType": part.content.media_type,
            }
            content.append(file)
    created_at = js_time.to_iso(now())
    transcript: list[JsonObject] = [
        {
            "id": generate_id(),
            "type": "message",
            "role": "assistant",
            "content": [*content, *native_results],
            "createdAt": created_at,
            "model": request["model"],
        }
    ]
    if invalid_results:
        transcript.append(
            {
                "id": generate_id(),
                "type": "tool-result",
                "role": "tool",
                "content": invalid_results,
                "createdAt": js_time.to_iso(now()),
                "model": request["model"],
            }
        )
    usage = _usage(response)
    if usage is not None:
        transcript[0]["usage"] = usage
    text = "".join(texts)
    output: Any = text
    # A turn that calls tools is not the step's final answer, so only the
    # final turn's structured output is parsed.
    if request.get("outputSchema") is not None and not tool_calls:
        if structured_set:
            output = structured
        else:
            try:
                output = js_json.parse(text)
            except ValueError as error:  # pyright: ignore[reportAssignmentType]
                raise NoObjectGeneratedError("No object generated: could not parse the response.", text) from error  # pyright: ignore[reportGeneralTypeIssues]
    result: JsonObject = {"output": output, "transcript": transcript, "toolCalls": tool_calls}
    finish = _FINISH_REASONS.get(response.finish_reason) if response.finish_reason else None
    calls_function = any(not tool_call.get("providerExecuted") for tool_call in tool_calls)
    if (finish is None and response.finish_reason is None) or (finish == "stop" and calls_function):
        # Like the AI SDK (OpenAI Responses reports "completed" for a tool-call turn).
        finish = "tool-calls" if calls_function else "stop"
    if finish is not None:
        result["finishReason"] = finish
    metadata: JsonObject = {}
    if getattr(response, "provider_response_id", None):
        metadata["responseId"] = response.provider_response_id
    for name, value in (getattr(response, "provider_details", None) or {}).items():
        metadata[name] = _jsonable(value)
    if metadata:
        result["providerMetadata"] = {mapper.key: metadata}
    return result, tool_calls


RequestFunction = Callable[..., Awaitable[Any]]
StreamFunction = Callable[..., Any]


async def _default_request(call: CallOptions) -> Any:
    return await _direct.model_request(
        call.model,
        call.messages,
        model_settings=call.model_settings,  # type: ignore[arg-type]
        model_request_parameters=call.parameters,
    )


def _default_stream(call: CallOptions) -> Any:
    return _direct.model_request_stream(
        call.model,
        call.messages,
        model_settings=call.model_settings,  # type: ignore[arg-type]
        model_request_parameters=call.parameters,
    )


async def _with_signal(awaitable: Awaitable[Any], signal: AbortSignal | None) -> Any:
    if signal is None:
        return await awaitable
    if signal.aborted:
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        raise _abort_error(signal)
    task = asyncio.ensure_future(awaitable)
    waiter = asyncio.ensure_future(signal.wait())
    try:
        done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    except BaseException:
        task.cancel()
        waiter.cancel()
        raise
    if task in done:
        waiter.cancel()
        return task.result()
    task.cancel()
    with contextlib.suppress(BaseException):
        await task
    raise _abort_error(signal)


def _abort_error(signal: AbortSignal) -> BaseException:
    reason = signal.reason
    return reason if isinstance(reason, BaseException) else Error("Model request was aborted")


def _call_info(call: CallOptions, request: JsonObject) -> ai_sdk_results.CallInfo:
    return ai_sdk_results.CallInfo(
        driver=call.resolved.driver,
        request=request,
        key=_options_key(call.resolved),
        settings=call.model_settings,
        output_mode=call.output_mode,
        provider_name=call.resolved.name,
    )


class PydanticAIModelAdapter:
    """``ModelAdapter`` over pydantic-ai's model layer."""

    def __init__(
        self,
        *,
        resolve_model: ModelResolver,
        request: Callable[[CallOptions], Awaitable[Any]] | None = None,
        stream_request: Callable[[CallOptions], Any] | None = None,
        now: Callable[[], datetime] | None = None,
        generate_transcript_id: Callable[[], str] | None = None,
        max_retries: int | None = 2,
    ) -> None:
        self._resolve_model = resolve_model
        self._request = request or _default_request
        self._stream_request = stream_request or _default_stream
        self._now = now or js_time.now
        self._generate_id = generate_transcript_id or (lambda: str(uuid.uuid4()))
        self._max_retries = max_retries

    def call_options(self, request: JsonObject) -> CallOptions:
        # Provider SDKs do not retry; the adapter retries the way the AI SDK does (``_retrying``).
        return to_call_options(request, self._resolve_model(request["model"]), 0)

    async def _retrying(self, call: CallOptions, attempt: Callable[[], Awaitable[Any]]) -> Any:
        """``attempt`` with AI SDK errors and retries (``maxRetries``, default 2)."""
        signal = call.signal

        async def once() -> Any:
            with capturing() as capture:
                try:
                    return await attempt(), capture
                except Exception as error:
                    converted = ai_sdk_errors.to_ai_sdk_error(call.resolved.driver, capture, error)
                    if converted is error:
                        raise
                    raise converted from error

        return await ai_sdk_errors.retry(
            once,
            max_retries=self._max_retries or 0,
            is_abort=lambda error: signal is not None and signal.aborted,
            sleep=lambda seconds: _with_signal(asyncio.sleep(seconds), signal),
        )

    def _iso_now(self) -> str:
        return js_time.to_iso(self._now())

    def _sdk_result(self, call: CallOptions, request: JsonObject, exchange: Exchange | None) -> JsonObject | None:
        """The AI SDK's result for a captured provider response (``None``: use pydantic-ai's)."""
        if call.resolved.driver not in ai_sdk_results.DRIVERS or exchange is None or not exchange.complete:
            return None
        info = _call_info(call, request)
        try:
            if exchange.is_event_stream:
                state = ai_sdk_results.StreamState(info)
                state.drain(exchange)
                state.close()
                step = state.accumulator.step()
            else:
                step = ai_sdk_results.generate_result(info, exchange)
        except ai_sdk_core.StructuredOutputError as error:
            raise NoObjectGeneratedError(str(error), error.text) from error
        return ai_sdk_core.build_model_result(request, step, self._iso_now, self._generate_id)

    async def generate(self, request: JsonObject) -> JsonObject:
        call = self.call_options(request)
        response, capture = await self._retrying(call, lambda: _with_signal(self._request(call), call.signal))
        result = self._sdk_result(call, request, capture.successful())
        if result is not None:
            return result
        result, _ = _build_result(call, request, response, self._now, self._generate_id)
        return result

    async def stream(self, request: JsonObject) -> AsyncIterator[JsonObject]:
        call = self.call_options(request)
        if (
            call.resolved.driver == "anthropic"
            and (call.parameters.function_tools or call.parameters.output_tools)
            and (call.options is None or call.options.tool_streaming)
        ):
            # Like the AI SDK's `toolStreaming` default for streamed Anthropic requests.
            call.model_settings.setdefault("anthropic_eager_input_streaming", True)
        signal = call.signal
        if signal is not None and signal.aborted:
            raise _abort_error(signal)
        driver = call.resolved.driver
        state = ai_sdk_results.StreamState(_call_info(call, request)) if driver in ai_sdk_results.DRIVERS else None

        # The request is sent when the stream opens; its response is recorded from then on.
        async def open_stream() -> tuple[Any, Any]:
            manager = self._stream_request(call)
            return manager, await manager.__aenter__()

        (manager, streamed), capture = await self._retrying(call, open_stream)
        failed = True
        try:
            exchange = capture.successful()
            if exchange is None or not exchange.is_event_stream:
                state = None
            iterator = streamed.__aiter__()
            thinking_indexes: set[int] = set()
            while True:
                try:
                    event = await _with_signal(iterator.__anext__(), signal)
                except StopAsyncIteration:
                    break
                if state is not None and exchange is not None:
                    for sdk_event in state.drain(exchange):
                        yield sdk_event
                else:
                    for delta in _stream_deltas(event, thinking_indexes):
                        yield delta
            response = streamed.get()
            failed = False
        finally:
            if failed:
                await manager.__aexit__(*sys.exc_info())
            else:
                await manager.__aexit__(None, None, None)
        if state is not None and exchange is not None:
            for sdk_event in state.drain(exchange):
                yield sdk_event
            for sdk_event in state.close():
                yield sdk_event
            try:
                step = state.accumulator.step()
            except ai_sdk_core.StructuredOutputError as error:
                raise NoObjectGeneratedError(str(error), error.text) from error
            yield {
                "type": "completed",
                "result": ai_sdk_core.build_model_result(request, step, self._iso_now, self._generate_id),
            }
            return
        result, tool_calls = _build_result(call, request, response, self._now, self._generate_id)
        for tool_call in tool_calls:
            yield {"type": "tool-call", "call": tool_call}
        yield {"type": "completed", "result": result}


def _stream_deltas(event: Any, thinking_indexes: set[int]) -> list[JsonObject]:
    if isinstance(event, _m.PartStartEvent):
        part = event.part
        if isinstance(part, _m.TextPart) and part.content:
            return [{"type": "text-delta", "delta": part.content}]
        if isinstance(part, _m.ThinkingPart):
            thinking_indexes.add(event.index)
            if part.content:
                return [{"type": "reasoning-delta", "delta": part.content}]
        return []
    if isinstance(event, _m.PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, _m.TextPartDelta) and delta.content_delta:
            return [{"type": "text-delta", "delta": delta.content_delta}]
        if isinstance(delta, _m.ThinkingPartDelta) and delta.content_delta:
            return [{"type": "reasoning-delta", "delta": delta.content_delta}]
    return []


__all__ = [
    "CallOptions",
    "ModelResolver",
    "NoObjectGeneratedError",
    "ParsedModelKey",
    "ProviderModelFactory",
    "PydanticAIModelAdapter",
    "ResolvedModel",
    "create_provider_registry_model_resolver",
    "parse_model_key",
    "to_call_options",
]
