"""Gemini with the request fields of the AI SDK Google provider.

``GoogleChatModel`` keeps pydantic-ai's ``GoogleModel`` and adds request-body
fields the adapter translated from AI SDK ``providerOptions`` (``thinkingConfig``
and ``cachedContent`` sent as given) or from the output mode (JSON mode without
a schema: ``responseMimeType: "application/json"``). They are deep-merged into
the request through google-genai's ``http_options.extra_body``.
"""

from __future__ import annotations

from typing import Any

from pydantic_ai import messages as _m
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.google import GoogleModel

from .provider_options import REQUEST_BODY_SETTING, deep_merge


class GoogleChatModel(GoogleModel):
    """``GoogleModel`` plus request-body fields from ``REQUEST_BODY_SETTING``."""

    async def _build_content_and_config(  # pyright: ignore[reportIncompatibleMethodOverride]
        self,
        messages: list[_m.ModelMessage],
        model_settings: Any,
        model_request_parameters: ModelRequestParameters,
    ) -> tuple[list[Any], Any]:
        settings = dict(model_settings or {})
        body = settings.pop(REQUEST_BODY_SETTING, None)
        contents, config = await super()._build_content_and_config(messages, settings, model_request_parameters)  # pyright: ignore[reportArgumentType]
        if body:
            http_options: dict[str, Any] = dict(config.get("http_options") or {})
            http_options["extra_body"] = deep_merge(dict(http_options.get("extra_body") or {}), body)
            config["http_options"] = http_options  # pyright: ignore[reportGeneralTypeIssues]
        return contents, config
