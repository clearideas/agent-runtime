"""``ModelResult``s from captured provider responses, per driver."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from . import anthropic, chat_completions, cohere_chat, google, openai_responses, xai_responses
from .capture import Exchange
from .core import JsonObject, StepResult, StreamAccumulator, generate_step

#: Drivers whose responses are interpreted here (others use the pydantic-ai response).
DRIVERS = ("openai", "xai", "anthropic", "google", "groq", "openai-compatible", "cohere")


@dataclass
class CallInfo:
    """What the response ports need to know about the request."""

    driver: str
    request: JsonObject
    key: str
    settings: JsonObject
    output_mode: str | None = None
    provider_name: str | None = None

    @property
    def tools(self) -> list[str] | None:
        tools = self.request.get("tools") or []
        return [tool["name"] for tool in tools] if tools else None

    def openai_context(self) -> openai_responses.Context:
        options = ((self.request.get("providerOptions") or {}).get(self.key)) or {}
        return openai_responses.Context(
            key=self.key,
            store=self.settings.get("openai_store") is True,
            logprobs=bool(options.get("logprobs")),
            json_response=self.request.get("outputSchema") is not None,
        )

    def anthropic_context(self) -> anthropic.Context:
        return anthropic.Context(json_tool=self.output_mode == "tool")

    def chat_context(self) -> chat_completions.Context:
        if self.driver == "groq":
            return chat_completions.Context(flavor="groq")
        name = self.provider_name or "openaiCompatible"
        return chat_completions.Context(
            flavor="openai-compatible",
            key=chat_completions.metadata_key(name, self.request.get("providerOptions")),
        )


def generate_result(info: CallInfo, exchange: Exchange) -> StepResult:
    body = exchange.json()
    structured_text: str | None = None
    if info.driver == "openai":
        result: Any = openai_responses.generate(body, info.openai_context())
        structured_text = result.structured_output_text
    elif info.driver == "xai":
        result = xai_responses.generate(body)
    elif info.driver == "anthropic":
        result = anthropic.generate(body, info.anthropic_context())
    elif info.driver == "google":
        result = google.generate(body, info.key)
    elif info.driver in ("groq", "openai-compatible"):
        result = chat_completions.generate(body, info.chat_context())
    elif info.driver == "cohere":
        result = cohere_chat.generate(body)
    else:
        raise KeyError(info.driver)
    return generate_step(
        info.request,
        result.content,
        result.finish_reason,
        result.usage,
        result.provider_metadata,
        info.tools,
        structured_text,
    )


class StreamState:
    """Provider events → AI SDK stream parts → runtime ``ModelEvent``s."""

    def __init__(self, info: CallInfo) -> None:
        self.accumulator = StreamAccumulator(info.request, info.tools)
        parser: Any
        if info.driver == "openai":
            parser = openai_responses.StreamParser(info.openai_context())
        elif info.driver == "xai":
            parser = xai_responses.StreamParser()
        elif info.driver == "anthropic":
            parser = anthropic.StreamParser(info.anthropic_context())
        elif info.driver == "google":
            parser = google.StreamParser(info.key)
        elif info.driver in ("groq", "openai-compatible"):
            parser = chat_completions.StreamParser(info.chat_context())
        elif info.driver == "cohere":
            parser = cohere_chat.StreamParser()
        else:
            raise KeyError(info.driver)
        self._feed: Callable[[JsonObject], list[JsonObject]] = parser.feed
        self._close: Callable[[], list[JsonObject]] = parser.close
        self.consumed = 0

    def drain(self, exchange: Exchange) -> list[JsonObject]:
        events: list[JsonObject] = []
        while self.consumed < len(exchange.events):
            event = exchange.events[self.consumed]
            self.consumed += 1
            if event.data == "[DONE]":
                continue
            for part in self._feed(event.json()):
                events.extend(self.accumulator.process(part))
        return events

    def close(self) -> list[JsonObject]:
        events: list[JsonObject] = []
        for part in self._close():
            events.extend(self.accumulator.process(part))
        return events
