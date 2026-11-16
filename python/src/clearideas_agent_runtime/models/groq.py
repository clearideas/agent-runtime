"""Groq chat with the assistant-message shape of the AI SDK Groq provider.

``@ai-sdk/groq`` sends an assistant turn as ``content`` (the concatenated text,
``""`` when there is none), ``reasoning`` (the concatenated reasoning, when
there is any), and ``tool_calls``. pydantic-ai's ``GroqModel`` wraps reasoning
in ``<think>`` tags inside the content and leaves out empty content.
``GroqChatModel`` changes only that mapping.
"""

from __future__ import annotations

from typing import Any

from pydantic_ai import messages as _m
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.groq import GroqModel


class GroqChatModel(GroqModel):
    """``GroqModel`` with ``@ai-sdk/groq`` assistant messages."""

    async def _map_messages(  # pyright: ignore[reportIncompatibleMethodOverride]
        self, messages: list[_m.ModelMessage], model_request_parameters: ModelRequestParameters
    ) -> list[Any]:
        mapped: list[Any] = []
        for message in messages:
            if isinstance(message, _m.ModelRequest):
                async for item in self._map_user_message(message):
                    mapped.append(item)
                continue
            assistant: dict[str, Any] = {
                "role": "assistant",
                "content": "".join(part.content for part in message.parts if isinstance(part, _m.TextPart)),
            }
            reasoning = "".join(part.content for part in message.parts if isinstance(part, _m.ThinkingPart))
            if reasoning:
                assistant["reasoning"] = reasoning
            calls = [self._map_tool_call(part) for part in message.parts if isinstance(part, _m.ToolCallPart)]
            if calls:
                assistant["tool_calls"] = calls
            mapped.append(assistant)
        if instruction_parts := self._get_instruction_parts(messages, model_request_parameters):
            count = next((i for i, m in enumerate(mapped) if m.get("role") != "system"), len(mapped))
            mapped[count:count] = [{"role": "system", "content": part.content} for part in instruction_parts]
        return mapped
