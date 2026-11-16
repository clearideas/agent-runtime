"""OpenAI and xAI Responses with the reasoning fields of the AI SDK providers.

``@ai-sdk/openai`` sends ``reasoning: {effort, summary, mode, context}`` (each
when set) for reasoning models only, detected from the model id.
``@ai-sdk/xai`` sends ``reasoning: {effort}`` only. pydantic-ai gates ``mode``
and ``context`` on its model profiles and adds a default ``context``;
``ResponsesChatModel`` builds the object the way the AI SDK does, builds
``include`` the same way, and sends assistant turns as the input items
``responses_input`` prepares.
"""

from __future__ import annotations

from typing import Any

from openai import omit
from pydantic_ai import messages as _m
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.openai import OpenAIResponsesModel

from .provider_options import INCLUDE_SETTING
from .responses_input import ITEMS_KEY, is_openai_reasoning_model


class ResponsesChatModel(OpenAIResponsesModel):
    """``OpenAIResponsesModel`` with AI SDK ``reasoning`` request fields for ``driver``."""

    def __init__(self, model_name: str, *, driver: str = "openai", **kwargs: Any) -> None:
        super().__init__(model_name, **kwargs)
        self.ai_sdk_driver = driver

    def _translate_thinking(  # pyright: ignore[reportIncompatibleMethodOverride]
        self, model_settings: Any, model_request_parameters: ModelRequestParameters
    ) -> Any:
        settings = model_settings or {}
        effort = settings.get("openai_reasoning_effort")
        if self.ai_sdk_driver == "xai":
            return {"effort": effort} if effort is not None else omit
        if not is_openai_reasoning_model(self.model_name):
            return omit
        reasoning: dict[str, Any] = {}
        for field, setting in (
            ("effort", "openai_reasoning_effort"),
            ("summary", "openai_reasoning_summary"),
            ("mode", "openai_reasoning_mode"),
            ("context", "openai_reasoning_context"),
        ):
            if settings.get(setting) is not None:
                reasoning[field] = settings[setting]
        return reasoning or omit

    def _build_include(self, model_settings: Any, *, is_retrieve: bool = False) -> list[Any]:  # pyright: ignore[reportIncompatibleMethodOverride]
        """``include`` as the AI SDK provider builds it (pydantic-ai always asks for encrypted reasoning)."""
        settings = model_settings or {}
        include: list[Any] = list(settings.get(INCLUDE_SETTING) or [])

        def add(key: str) -> None:
            if key not in include:
                include.append(key)

        store_disabled = settings.get("openai_store") is False
        if self.ai_sdk_driver == "xai":
            if store_disabled and not is_retrieve:
                add("reasoning.encrypted_content")
            return include
        if (settings.get("extra_body") or {}).get("top_logprobs"):
            add("message.output_text.logprobs")
        if store_disabled and is_openai_reasoning_model(self.model_name) and not is_retrieve:
            add("reasoning.encrypted_content")
        return include

    async def _map_messages(  # pyright: ignore[reportIncompatibleMethodOverride]
        self,
        messages: list[_m.ModelMessage],
        model_settings: Any,
        model_request_parameters: ModelRequestParameters,
        **kwargs: Any,
    ) -> tuple[Any, list[Any]]:
        """Requests map as pydantic-ai maps them; assistant turns use the AI SDK items the adapter prepared."""
        if not any(
            isinstance(message, _m.ModelResponse) and ITEMS_KEY in (message.provider_details or {})
            for message in messages
        ):
            return await super()._map_messages(messages, model_settings, model_request_parameters, **kwargs)
        instructions: Any = omit
        items: list[Any] = []
        pending: list[_m.ModelMessage] = []

        async def flush() -> None:
            nonlocal instructions
            if not pending:
                return
            segment_instructions, segment = await super(ResponsesChatModel, self)._map_messages(
                list(pending), model_settings, model_request_parameters, **kwargs
            )
            if instructions is omit:
                instructions = segment_instructions
            items.extend(segment)
            pending.clear()

        for message in messages:
            details = message.provider_details if isinstance(message, _m.ModelResponse) else None
            if details and ITEMS_KEY in details:
                await flush()
                items.extend(details[ITEMS_KEY])
            else:
                pending.append(message)
        await flush()
        return instructions, items
