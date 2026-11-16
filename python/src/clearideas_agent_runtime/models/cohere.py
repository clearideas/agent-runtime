"""Cohere v2 chat with the request shape of the AI SDK Cohere provider.

pydantic-ai's ``CohereModel`` sends text-only user turns and requests structured
output through an output tool. ``@ai-sdk/cohere`` (which the TypeScript runtime
uses) sends:

- user turns as one string (text parts joined), or as content parts with
  ``image_url`` entries when the turn has an image;
- non-image files as request ``documents`` (``{data: {text, title}}``);
- structured output as ``response_format: {type: "json_object", json_schema}``;
- ``providerOptions.cohere.thinking`` as ``thinking: {type, token_budget}``;
- an assistant turn as one text string, or only its tool calls when it has
  any; reasoning is not sent back.

``CohereChatModel`` keeps pydantic-ai's request, streaming, and response code
and changes only those mappings. The extra top-level request fields reach the
Cohere SDK call through a context variable read by a thin client wrapper.
"""

from __future__ import annotations

import base64
from collections.abc import Iterable
from contextvars import ContextVar
from typing import Any

from cohere import (
    AssistantChatMessageV2,
    ChatMessageV2,
    ImageUrl,
    ImageUrlContent,
    JsonObjectResponseFormatV2,
    SystemChatMessageV2,
    Thinking,
    UserChatMessageV2,
)
from cohere import TextContent as CohereTextContent
from pydantic_ai import messages as _m
from pydantic_ai.models import ModelRequestParameters, download_item
from pydantic_ai.models.cohere import CohereModel
from pydantic_ai.profiles import ModelProfile, merge_profile

from .provider_options import COHERE_THINKING_SETTING

_REQUEST_EXTRAS: ContextVar[dict[str, Any] | None] = ContextVar("cohere_request_extras", default=None)


class _Client:
    """Adds the per-request fields the AI SDK provider sends to ``chat``/``chat_stream``."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)

    def chat(self, **arguments: Any) -> Any:
        return self._client.chat(**{**arguments, **(_REQUEST_EXTRAS.get() or {})})

    def chat_stream(self, **arguments: Any) -> Any:
        return self._client.chat_stream(**{**arguments, **(_REQUEST_EXTRAS.get() or {})})


def _is_image(content: Any) -> bool:
    return isinstance(content, _m.ImageUrl) or (isinstance(content, _m.BinaryContent) and content.is_image)


def _image_url(content: Any) -> str:
    if isinstance(content, _m.ImageUrl):
        return content.url
    return f"data:{content.media_type};base64,{base64.b64encode(content.data).decode('ascii')}"


async def _document(content: Any) -> dict[str, Any]:
    if isinstance(content, _m.BinaryContent):
        # @ai-sdk/cohere decodes inline file data as UTF-8 text (TextDecoder: BOM removed,
        # invalid bytes replaced).
        text = content.data.decode("utf-8-sig", errors="replace")
    else:
        # The AI SDK downloads file URLs Cohere cannot take (every non-image URL) and decodes
        # the body as UTF-8 text (TextDecoder: BOM removed, invalid bytes replaced).
        downloaded = await download_item(content, data_format="bytes")
        text = downloaded["data"].decode("utf-8-sig", errors="replace")
    data: dict[str, Any] = {"text": text}
    filename = (content.vendor_metadata or {}).get("filename")
    if filename:
        data["title"] = filename
    return {"data": data}


class CohereChatModel(CohereModel):
    """``CohereModel`` with ``@ai-sdk/cohere`` request mapping (images, documents, JSON schema output)."""

    _unsupported_file_inputs = frozenset({"audio", "video"})

    @property
    def client(self) -> Any:  # pyright: ignore[reportIncompatibleVariableOverride]
        return _Client(super().client)

    @property
    def profile(self) -> ModelProfile:  # pyright: ignore[reportIncompatibleVariableOverride]
        return merge_profile(super().profile, ModelProfile(supports_json_schema_output=True))

    async def _chat(  # pyright: ignore[reportIncompatibleMethodOverride]
        self,
        messages: list[_m.ModelMessage],
        model_settings: Any,
        model_request_parameters: ModelRequestParameters,
        *,
        stream: bool = False,
    ) -> Any:
        extras: dict[str, Any] = {}
        thinking = (model_settings or {}).get(COHERE_THINKING_SETTING)
        if thinking is not None:
            # @ai-sdk/cohere: `thinking: {type, token_budget}` from `providerOptions.cohere.thinking`.
            extras["thinking"] = Thinking(**thinking)
        output = model_request_parameters.output_object
        if model_request_parameters.output_mode == "native" and output is not None:
            extras["response_format"] = JsonObjectResponseFormatV2(json_schema=output.json_schema)
        documents = [
            await _document(content)
            for message in messages
            if isinstance(message, _m.ModelRequest)
            for part in message.parts
            if isinstance(part, _m.UserPromptPart) and not isinstance(part.content, str)
            for content in part.content
            if isinstance(content, _m.BinaryContent | _m.DocumentUrl) and not _is_image(content)
        ]
        if documents:
            extras["documents"] = documents
        token = _REQUEST_EXTRAS.set(extras)
        try:
            return await super()._chat(
                messages,
                model_settings,
                model_request_parameters,
                stream=stream,  # pyright: ignore[reportCallIssue, reportArgumentType]
            )
        finally:
            _REQUEST_EXTRAS.reset(token)

    def _map_messages(
        self, messages: list[_m.ModelMessage], model_request_parameters: ModelRequestParameters
    ) -> list[ChatMessageV2]:
        mapped: list[ChatMessageV2] = []
        for message in messages:
            if isinstance(message, _m.ModelRequest):
                mapped.extend(self._map_user_message(message))
                continue
            # @ai-sdk/cohere: `text += part.text`; a turn with tool calls is sent without its text;
            # reasoning is never sent back.
            text = "".join(part.content for part in message.parts if isinstance(part, _m.TextPart))
            calls = [self._map_tool_call(part) for part in message.parts if isinstance(part, _m.ToolCallPart)]
            mapped.append(
                AssistantChatMessageV2(role="assistant", tool_calls=calls)
                if calls
                else AssistantChatMessageV2(role="assistant", content=text)
            )
        if instruction_parts := self._get_instruction_parts(messages, model_request_parameters):
            count = next((i for i, m in enumerate(mapped) if not isinstance(m, SystemChatMessageV2)), len(mapped))
            mapped[count:count] = [SystemChatMessageV2(role="system", content=p.content) for p in instruction_parts]
        return mapped

    @classmethod
    def _map_user_message(cls, message: _m.ModelRequest) -> Iterable[ChatMessageV2]:
        for part in message.parts:
            if not isinstance(part, _m.UserPromptPart) or isinstance(part.content, str):
                yield from super()._map_user_message(_m.ModelRequest(parts=[part]))
                continue
            items = list(part.content)
            if not any(_is_image(item) for item in items):
                yield UserChatMessageV2(role="user", content="".join(_text(item) or "" for item in items))
                continue
            content: list[Any] = []
            for item in items:
                text = _text(item)
                if text:
                    content.append(CohereTextContent(text=text))
                elif isinstance(item, _m.ImageUrl | _m.BinaryContent) and _is_image(item):
                    detail = (item.vendor_metadata or {}).get("detail")
                    url = ImageUrl(url=_image_url(item), **({"detail": detail} if detail else {}))
                    content.append(ImageUrlContent(image_url=url))
            yield UserChatMessageV2(role="user", content=content)


def _text(item: Any) -> str | None:
    if isinstance(item, str):
        return item
    if isinstance(item, _m.TextContent):
        return item.content
    return None
