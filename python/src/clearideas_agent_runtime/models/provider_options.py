"""AI SDK ``providerOptions`` → pydantic-ai model settings.

Manifests and configuration profiles carry AI SDK ``providerOptions`` keyed by
provider (``{openai: {reasoningEffort: "low"}}``). The TypeScript adapter
forwards them to the AI SDK provider, which reads only its own key. This module
does the same for pydantic-ai: it reads the key of the resolved driver and
translates each documented option to a ``ModelSettings`` field. An option
outside the table is an error that names it; it is never dropped silently.
Options under other providers' keys are ignored, as the AI SDK ignores them.

The supported-options matrix is ``SUPPORTED_OPTIONS``.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .._js import json as js_json
from .._js.errors import Error

JsonObject = dict[str, Any]

DRIVERS = ("openai", "anthropic", "google", "xai", "groq", "cohere", "openai-compatible")


@dataclass
class TranslatedOptions:
    """Model settings plus adapter switches derived from provider options."""

    settings: JsonObject = field(default_factory=dict)
    extra_body: JsonObject = field(default_factory=dict)
    #: ``strictJsonSchema``: structured-output schema strictness.
    strict_json_schema: bool | None = None
    #: ``structuredOutputs: false``: ask for JSON by prompt instead of a schema.
    structured_outputs: bool | None = None
    #: Anthropic ``sendReasoning: false``: omit reasoning from replayed history.
    send_reasoning: bool = True
    #: Anthropic ``toolStreaming`` (default on): stream tool input eagerly when streaming.
    tool_streaming: bool = True
    #: Request-body fields deep-merged by the provider model (Gemini's ``http_options.extra_body``).
    request_body: JsonObject = field(default_factory=dict)

    def model_settings(self) -> JsonObject:
        settings = dict(self.settings)
        if self.extra_body:
            settings["extra_body"] = {**(settings.get("extra_body") or {}), **self.extra_body}
        if self.request_body:
            settings[REQUEST_BODY_SETTING] = self.request_body
        return settings


#: The model-settings key that carries ``TranslatedOptions.request_body`` to the provider model.
REQUEST_BODY_SETTING = "clearideas_request_body"
#: The model-settings key for the Responses ``include`` option (merged by ``ResponsesChatModel``).
INCLUDE_SETTING = "clearideas_include"


def deep_merge(target: JsonObject, update: JsonObject) -> JsonObject:
    merged = dict(target)
    for key, value in update.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _snake_keys(value: Any) -> Any:
    if isinstance(value, dict):
        return {_snake(key): _snake_keys(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_snake_keys(item) for item in value]
    return value


Handler = Callable[[Any, TranslatedOptions], None]


def _setting(name: str, convert: Callable[[Any], Any] = lambda value: value) -> Handler:
    def handle(value: Any, out: TranslatedOptions) -> None:
        if value is not None:
            out.settings[name] = convert(value)

    return handle


def _body(name: str, snake_values: bool = False) -> Handler:
    def handle(value: Any, out: TranslatedOptions) -> None:
        if value is not None:
            out.extra_body[name] = _snake_keys(value) if snake_values else value

    return handle


def _strict(value: Any, out: TranslatedOptions) -> None:
    if value is not None:
        out.strict_json_schema = bool(value)


def _structured(value: Any, out: TranslatedOptions) -> None:
    if value is not None:
        out.structured_outputs = bool(value)


def _logprobs(value: Any, out: TranslatedOptions) -> None:
    """OpenAI Responses: ``top_logprobs`` (20 for ``true``); ``ResponsesChatModel`` adds the
    ``include`` entry. Sent in the body directly: pydantic-ai drops it for reasoning models,
    the AI SDK sends it for every model."""
    if value is None or value is False:
        return
    out.extra_body["top_logprobs"] = 20 if value is True else value


def _xai_logprobs(value: Any, out: TranslatedOptions) -> None:
    if value is True:
        out.extra_body["logprobs"] = True


def _xai_top_logprobs(value: Any, out: TranslatedOptions) -> None:
    if value is not None:
        out.extra_body["logprobs"] = True
        out.extra_body["top_logprobs"] = value


def _anthropic_thinking(value: Any, out: TranslatedOptions) -> None:
    if value is None:
        return
    thinking: JsonObject = {"type": value.get("type", "enabled")}
    if value.get("budgetTokens") is not None:
        thinking["budget_tokens"] = value["budgetTokens"]
    out.settings["anthropic_thinking"] = thinking


def _anthropic_cache(value: Any, out: TranslatedOptions) -> None:
    # Sent as given, like the AI SDK (pydantic-ai's `anthropic_cache` always adds a TTL).
    if value is not None:
        out.extra_body["cache_control"] = value


def _anthropic_send_reasoning(value: Any, out: TranslatedOptions) -> None:
    if value is not None:
        out.send_reasoning = bool(value)


def _anthropic_metadata(value: Any, out: TranslatedOptions) -> None:
    if value is not None:
        out.settings["anthropic_metadata"] = {"user_id": value["userId"]} if value.get("userId") else {}


def _google_body(*path: str) -> Handler:
    """A Gemini option sent as given at ``path`` in the request body, as the AI SDK does.

    (The google-genai SDK would otherwise upper-case enum values such as ``thinkingLevel``,
    and pydantic-ai drops tools and system instructions when ``cachedContent`` is set.)
    """

    def handle(value: Any, out: TranslatedOptions) -> None:
        if value is None:
            return
        update: JsonObject = {path[-1]: value}
        for key in reversed(path[:-1]):
            update = {key: update}
        out.request_body = deep_merge(out.request_body, update)

    return handle


#: Cohere's ``thinking`` request field (read by ``CohereChatModel``).
COHERE_THINKING_SETTING = "cohere_thinking"


def _cohere_thinking(value: Any, out: TranslatedOptions) -> None:
    if value is None:
        return
    thinking: JsonObject = {"type": value.get("type") or "enabled"}
    if value.get("tokenBudget") is not None:
        thinking["token_budget"] = value["tokenBudget"]
    out.settings[COHERE_THINKING_SETTING] = thinking


_OPENAI: dict[str, Handler] = {
    "reasoningEffort": _setting("openai_reasoning_effort"),
    "reasoningSummary": _setting("openai_reasoning_summary"),
    "reasoningMode": _setting("openai_reasoning_mode"),
    "reasoningContext": _setting("openai_reasoning_context"),
    "serviceTier": _setting("openai_service_tier"),
    "parallelToolCalls": _setting("parallel_tool_calls"),
    "user": _setting("openai_user"),
    "store": _setting("openai_store"),
    "textVerbosity": _setting("openai_text_verbosity"),
    "promptCacheKey": _setting("openai_prompt_cache_key"),
    "promptCacheRetention": _setting("openai_prompt_cache_retention"),
    "truncation": _setting("openai_truncation"),
    "previousResponseId": _setting("openai_previous_response_id"),
    "conversation": _setting("openai_conversation_id"),
    "logprobs": _logprobs,
    "metadata": _body("metadata"),
    "maxToolCalls": _body("max_tool_calls"),
    "safetyIdentifier": _body("safety_identifier"),
    "include": _setting(INCLUDE_SETTING),
    "strictJsonSchema": _strict,
}

_ANTHROPIC: dict[str, Handler] = {
    "thinking": _anthropic_thinking,
    "disableParallelToolUse": lambda value, out: (
        out.settings.__setitem__("parallel_tool_calls", not value) if value is not None else None
    ),
    "effort": _setting("anthropic_effort"),
    "serviceTier": _setting("anthropic_service_tier"),
    # Sent for every model, as the AI SDK does (pydantic-ai drops it for models without fast mode).
    "speed": _body("speed"),
    "container": _setting("anthropic_container"),
    "metadata": _anthropic_metadata,
    "cacheControl": _anthropic_cache,
    "sendReasoning": _anthropic_send_reasoning,
    "anthropicBeta": _setting("anthropic_betas"),
    "toolStreaming": lambda value, out: setattr(out, "tool_streaming", bool(value)) if value is not None else None,
}

_GOOGLE: dict[str, Handler] = {
    "thinkingConfig": _google_body("generationConfig", "thinkingConfig"),
    "safetySettings": _setting("google_safety_settings"),
    "cachedContent": _google_body("cachedContent"),
    "labels": _setting("google_labels"),
    "structuredOutputs": _structured,
}

_GROQ: dict[str, Handler] = {
    "reasoningFormat": _setting("groq_reasoning_format"),
    "reasoningEffort": _setting("groq_reasoning_effort"),
    "parallelToolCalls": _setting("parallel_tool_calls"),
    "user": _body("user"),
    "serviceTier": _body("service_tier"),
    "structuredOutputs": _structured,
    "strictJsonSchema": _strict,
}

_XAI: dict[str, Handler] = {
    "reasoningEffort": _setting("openai_reasoning_effort"),
    "reasoningSummary": _setting("openai_reasoning_summary"),
    "parallelToolCalls": _setting("parallel_tool_calls"),
    "user": _setting("openai_user"),
    "store": _setting("openai_store"),
    "previousResponseId": _setting("openai_previous_response_id"),
    "promptCacheKey": _setting("openai_prompt_cache_key"),
    "serviceTier": _setting("openai_service_tier"),
    "include": _setting(INCLUDE_SETTING),
    "logprobs": _xai_logprobs,
    "topLogprobs": _xai_top_logprobs,
    "maxTurns": _body("max_turns"),
    "minP": _body("min_p"),
    "safetyIdentifier": _body("safety_identifier"),
}

_COHERE: dict[str, Handler] = {"thinking": _cohere_thinking}

_COMPATIBLE: dict[str, Handler] = {
    "user": _setting("openai_user"),
    "reasoningEffort": _setting("openai_reasoning_effort"),
    "textVerbosity": _body("verbosity"),
    "strictJsonSchema": _strict,
}

_TABLES: dict[str, dict[str, Handler]] = {
    "openai": _OPENAI,
    "anthropic": _ANTHROPIC,
    "google": _GOOGLE,
    "groq": _GROQ,
    "xai": _XAI,
    "cohere": _COHERE,
    "openai-compatible": _COMPATIBLE,
}

#: Supported ``providerOptions`` keys per driver.
SUPPORTED_OPTIONS: dict[str, tuple[str, ...]] = {driver: tuple(table) for driver, table in _TABLES.items()}


def _camel(name: str) -> str:
    return re.sub(r"[-_\s]+(.)", lambda match: match.group(1).upper(), name)


def options_keys(driver: str, name: str | None = None) -> list[str]:
    """The ``providerOptions`` keys the AI SDK provider for ``driver`` reads, in merge order."""
    if driver == "openai-compatible":
        keys = ["openai-compatible", "openaiCompatible"]
        if name:
            keys += [name, _camel(name)]
        return list(dict.fromkeys(keys))
    return [driver]


def translate_provider_options(
    driver: str, provider_options: JsonObject | None, name: str | None = None
) -> TranslatedOptions:
    out = TranslatedOptions()
    if not provider_options:
        return out
    table = _TABLES.get(driver)
    if table is None:
        raise Error(f'Unknown model driver "{driver}".')
    merged: JsonObject = {}
    for key in options_keys(driver, name):
        value = provider_options.get(key)
        if isinstance(value, dict):
            merged.update(value)
    if (
        driver == "openai"
        and merged.get("reasoningEffort") not in (None, "none")
        and merged.get("reasoningSummary") is None
    ):
        # The AI SDK asks reasoning models for detailed summaries when an effort is set.
        merged = {**merged, "reasoningSummary": "detailed"}
    for option, value in js_json.js_entries(merged):
        handler = table.get(option)
        if handler is not None:
            handler(value, out)
        elif driver == "openai-compatible":
            # The AI SDK spreads unknown compatible options into the request body.
            out.extra_body[option] = value
        else:
            supported = ", ".join(table)
            raise Error(
                f'Provider option "{driver}.{option}" is not supported by the Python runtime. Supported {driver} options: {supported}.'
            )
    return out


def cache_ttl(value: Any) -> str | None:
    """An Anthropic ``cacheControl`` value's TTL (``"5m"``/``"1h"``), or ``None`` for the default."""
    if isinstance(value, dict) and value.get("ttl") in ("5m", "1h"):
        return value["ttl"]
    return None


def anthropic_cache_control(options: Any) -> Any:
    """The ``cacheControl`` of a message or part's ``providerOptions.anthropic`` (or ``None``)."""
    if not isinstance(options, dict):
        return None
    anthropic = options.get("anthropic")
    if not isinstance(anthropic, dict):
        return None
    return anthropic.get("cacheControl", anthropic.get("cache_control"))
