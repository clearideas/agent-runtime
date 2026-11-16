"""Port of ``packages/model-ai-sdk/src/model-adapter.test.ts`` to the pydantic-ai adapter.

pydantic-ai's ``FunctionModel`` stands in for a provider: it receives the
pydantic-ai messages and request parameters the adapter builds and returns a
``ModelResponse``.
"""

from __future__ import annotations

import asyncio
import base64
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic_ai import messages as m
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.models.function import AgentInfo, DeltaThinkingPart, DeltaToolCall, FunctionModel
from pydantic_ai.usage import RequestUsage

from clearideas_agent_runtime._js.abort import AbortController
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.models.provider_options import translate_provider_options
from clearideas_agent_runtime.models.pydantic_ai import (
    NoObjectGeneratedError,
    PydanticAIModelAdapter,
    ResolvedModel,
    create_provider_registry_model_resolver,
    parse_model_key,
)
from clearideas_agent_runtime.steps.prompt.context.errors import (
    is_context_overflow_error,
    is_invalid_output_error,
    is_retryable_model_error,
)

NOW = datetime(2026, 7, 22, 12, 0, tzinfo=UTC)


class Recorder:
    def __init__(self, response: m.ModelResponse | None = None) -> None:
        self.response = response or m.ModelResponse(parts=[m.TextPart("done")])
        self.messages: list[Any] = []
        self.info: AgentInfo | None = None

    def __call__(self, messages: list[Any], info: AgentInfo) -> m.ModelResponse:
        self.messages = messages
        self.info = info
        return self.response


def adapter(
    model: Any, driver: str = "openai", name: str | None = None, ids: list[str] | None = None
) -> PydanticAIModelAdapter:
    sequence = iter(ids or [f"message_{index}" for index in range(1, 10)])
    return PydanticAIModelAdapter(
        resolve_model=lambda _key: ResolvedModel(model, driver, name),
        now=lambda: NOW,
        generate_transcript_id=lambda: next(sequence),
    )


def request(**overrides: Any) -> dict:
    return {
        "model": "openai/gpt-test",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}],
        **overrides,
    }


def test_parses_model_keys_and_resolves_through_a_registry() -> None:
    assert parse_model_key("openai/gpt-test").model_id == "gpt-test"
    assert parse_model_key("gpt-test", "local").provider == "local"
    with pytest.raises(Error, match="provider/model format"):
        parse_model_key("gpt-test")
    resolver = create_provider_registry_model_resolver({"openai": lambda model_id: f"model:{model_id}"})  # type: ignore[dict-item]
    assert resolver("openai/gpt-test") == "model:gpt-test"
    with pytest.raises(Error, match="No model provider factory"):
        resolver("anthropic/claude-test")


async def test_maps_messages_tools_structured_output_usage_and_metadata() -> None:
    recorder = Recorder(
        m.ModelResponse(
            parts=[
                m.ThinkingPart("checked the facts"),
                m.ToolCallPart("lookup", {"term": "Example Corp"}, tool_call_id="call_1"),
            ],
            usage=RequestUsage(
                input_tokens=10, output_tokens=7, cache_read_tokens=4, cache_write_tokens=2, output_reasoning_tokens=3
            ),
            finish_reason="tool_call",
            provider_response_id="response_1",
        )
    )
    result = await adapter(FunctionModel(recorder)).generate(
        request(
            messages=[
                {"role": "system", "content": [{"type": "text", "text": "Be concise."}]},
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "Use this"}, {"type": "json", "value": {"id": 1}}],
                },
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool-call",
                            "call": {"id": "prior_call", "name": "lookup", "input": {"term": "prior"}},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool-result",
                            "result": {"callId": "prior_call", "name": "lookup", "output": {"found": True}},
                        }
                    ],
                },
            ],
            tools=[
                {
                    "name": "lookup",
                    "description": "Look something up.",
                    "inputSchema": {"type": "object", "properties": {"term": {"type": "string"}}, "required": ["term"]},
                }
            ],
            outputSchema={"type": "object", "properties": {"answer": {"type": "number"}}, "required": ["answer"]},
            providerOptions={"openai": {"reasoningEffort": "low"}},
            maxOutputTokens=256,
        )
    )
    first, response, tool = recorder.messages
    assert isinstance(first.parts[0], m.SystemPromptPart) and first.parts[0].content == "Be concise."
    assert first.parts[1].content == ["Use this", '{"id":1}']
    assert isinstance(response.parts[0], m.ToolCallPart)
    assert (response.parts[0].tool_name, response.parts[0].args, response.parts[0].tool_call_id) == (
        "lookup",
        {"term": "prior"},
        "prior_call",
    )
    assert isinstance(tool.parts[0], m.ToolReturnPart) and tool.parts[0].content == '{"found":true}'
    assert recorder.info is not None
    assert [tool.name for tool in recorder.info.function_tools] == ["lookup"]
    parameters = recorder.info.model_request_parameters
    assert parameters.output_mode == "native" and parameters.output_object is not None
    assert parameters.output_object.json_schema["required"] == ["answer"]
    settings = recorder.info.model_settings or {}
    assert settings["openai_reasoning_effort"] == "low"
    assert settings["max_tokens"] == 256
    assert result == {
        "output": "",
        "transcript": [
            {
                "id": "message_1",
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "text": "checked the facts"},
                    {
                        "type": "tool-call",
                        "call": {"id": "call_1", "name": "lookup", "input": {"term": "Example Corp"}},
                    },
                ],
                "createdAt": "2026-07-22T12:00:00.000Z",
                "model": "openai/gpt-test",
                "usage": {
                    "inputTokens": 10,
                    "outputTokens": 7,
                    "reasoningTokens": 3,
                    "cachedInputTokens": 4,
                    "cacheWriteTokens": 2,
                    "totalTokens": 17,
                },
            }
        ],
        "toolCalls": [{"id": "call_1", "name": "lookup", "input": {"term": "Example Corp"}}],
        "finishReason": "tool-calls",
        "providerMetadata": {"openai": {"responseId": "response_1"}},
    }


async def test_forwards_media_and_round_trips_replay_metadata() -> None:
    recorder = Recorder(
        m.ModelResponse(
            parts=[
                m.ThinkingPart("checking", id="rs_1", signature="encrypted", provider_name="openai"),
                m.TextPart("answer", id="msg_1", provider_name="openai"),
                m.ToolCallPart("lookup", '{"id": 2}', tool_call_id="new-call", id="fc_1", provider_name="openai"),
            ]
        )
    )
    result = await adapter(FunctionModel(recorder)).generate(
        request(
            tools=[{"name": "lookup", "inputSchema": {"type": "object"}}],
            messages=[
                {"role": "system", "content": [{"type": "text", "text": "Use the history."}]},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "data": "AQID",
                            "mediaType": "image/png",
                            "providerOptions": {"openai": {"imageDetail": "high"}},
                        },
                        {"type": "file", "url": "https://example.test/report.pdf", "mediaType": "application/pdf"},
                        {"type": "image", "url": "https://example.test/photo.png"},
                    ],
                },
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "reasoning",
                            "text": "earlier",
                            "providerOptions": {"openai": {"itemId": "rs_0", "reasoningEncryptedContent": "sealed"}},
                        },
                        {"type": "text", "text": "calling", "providerOptions": {"openai": {"itemId": "msg_0"}}},
                        {
                            "type": "tool-call",
                            "call": {"id": "old-call", "name": "lookup", "input": {"id": 1}},
                            "providerOptions": {"openai": {"itemId": "fc_0"}},
                        },
                    ],
                },
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool-result",
                            "result": {
                                "callId": "old-call",
                                "name": "lookup",
                                "output": {"found": True},
                                "artifacts": [
                                    {
                                        "id": "artifact-1",
                                        "name": "result.png",
                                        "mediaType": "image/png",
                                        "uri": "data:image/png;base64,AQID",
                                    }
                                ],
                            },
                        }
                    ],
                },
            ],
        )
    )
    user = recorder.messages[0].parts[1].content
    assert (
        isinstance(user[0], m.BinaryContent)
        and user[0].data == b"\x01\x02\x03"
        and user[0].vendor_metadata == {"detail": "high"}
    )
    assert isinstance(user[1], m.DocumentUrl) and user[1].url == "https://example.test/report.pdf"
    assert isinstance(user[2], m.ImageUrl)
    thinking, text, call = recorder.messages[1].parts
    assert (thinking.id, thinking.signature, thinking.provider_name) == ("rs_0", "sealed", "function")
    assert (text.id, call.id) == ("msg_0", "fc_0")
    returned = recorder.messages[2].parts[0]
    assert returned.content[0] == '{"found":true}'
    assert isinstance(returned.content[1], m.BinaryContent) and returned.content[1].media_type == "image/png"
    assert result["transcript"][0]["content"] == [
        {
            "type": "reasoning",
            "text": "checking",
            "providerOptions": {"openai": {"itemId": "rs_1", "reasoningEncryptedContent": "encrypted"}},
        },
        {"type": "text", "text": "answer", "providerOptions": {"openai": {"itemId": "msg_1"}}},
        {
            "type": "tool-call",
            "call": {"id": "new-call", "name": "lookup", "input": {"id": 2}},
            "providerOptions": {"openai": {"itemId": "fc_1"}},
        },
    ]


async def test_anthropic_replay_and_cache_control() -> None:
    recorder = Recorder(
        m.ModelResponse(
            parts=[
                m.ThinkingPart("thought", signature="sig-1", provider_name="anthropic"),
                m.ThinkingPart("", id="redacted_thinking", signature="opaque", provider_name="anthropic"),
                m.TextPart("ok"),
            ]
        )
    )
    result = await adapter(FunctionModel(recorder), driver="anthropic").generate(
        request(
            model="anthropic/claude",
            messages=[
                {
                    "role": "system",
                    "content": [{"type": "text", "text": "Rules."}],
                    "providerOptions": {"anthropic": {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}},
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Q",
                            "providerOptions": {"anthropic": {"cacheControl": {"type": "ephemeral"}}},
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "reasoning",
                            "text": "prior",
                            "providerOptions": {"anthropic": {"signature": "sig-0"}},
                        },
                        {"type": "text", "text": "A"},
                    ],
                },
                {"role": "user", "content": [{"type": "text", "text": "Next"}]},
            ],
            providerOptions={
                "anthropic": {"thinking": {"type": "enabled", "budgetTokens": 1024}},
                "openai": {"ignored": True},
            },
        )
    )
    settings = recorder.info.model_settings or {}  # type: ignore[union-attr]
    assert settings["anthropic_thinking"] == {"type": "enabled", "budget_tokens": 1024}
    assert settings["anthropic_cache_instructions"] == "1h"
    user_content = recorder.messages[0].parts[1].content
    assert user_content[0] == "Q" and isinstance(user_content[1], m.CachePoint)
    thinking = recorder.messages[1].parts[0]
    assert (thinking.signature, thinking.provider_name) == ("sig-0", "function")
    assert result["transcript"][0]["content"][:2] == [
        {"type": "reasoning", "text": "thought", "providerOptions": {"anthropic": {"signature": "sig-1"}}},
        {"type": "reasoning", "providerOptions": {"anthropic": {"redactedData": "opaque"}}},
    ]


async def test_structured_output_is_parsed_or_raises_no_object_generated() -> None:
    schema = {"type": "object", "properties": {"answer": {"type": "number"}}}
    result = await adapter(FunctionModel(Recorder(m.ModelResponse(parts=[m.TextPart('{"answer":42}')])))).generate(
        request(outputSchema=schema)
    )
    assert result["output"] == {"answer": 42}
    with pytest.raises(NoObjectGeneratedError) as raised:
        await adapter(FunctionModel(Recorder(m.ModelResponse(parts=[m.TextPart("not json")])))).generate(
            request(outputSchema=schema)
        )
    assert is_invalid_output_error(raised.value)


async def test_marks_invalid_tool_calls_and_answers_them() -> None:
    recorder = Recorder(
        m.ModelResponse(
            parts=[
                m.ToolCallPart("missing", {}, tool_call_id="c1"),
                m.ToolCallPart("lookup", "{not json", tool_call_id="c2"),
                m.ToolCallPart("lookup", '{"q": 1}', tool_call_id="c3"),
            ]
        )
    )
    result = await adapter(FunctionModel(recorder)).generate(
        request(tools=[{"name": "lookup", "inputSchema": {"type": "object"}}])
    )
    calls = result["toolCalls"]
    assert (
        calls[0]["metadata"]["agentRuntime"]["error"]
        == "Model tried to call unavailable tool 'missing'. Available tools: lookup."
    )
    assert calls[1]["metadata"]["agentRuntime"]["invalid"] is True
    assert "metadata" not in calls[2]
    tool_item = result["transcript"][1]
    assert tool_item["role"] == "tool" and tool_item["type"] == "tool-result"
    assert [part["result"]["callId"] for part in tool_item["content"]] == ["c1", "c2"]


async def test_streams_deltas_then_one_completed_result() -> None:
    async def stream(_messages: list[Any], _info: AgentInfo):
        yield {0: DeltaThinkingPart(content="Think ")}
        yield "Hello"
        yield " world"
        yield {1: DeltaToolCall(name="lookup", json_args='{"id": 7}', tool_call_id="call_1")}

    events = [
        event
        async for event in adapter(FunctionModel(stream_function=stream)).stream(
            request(tools=[{"name": "lookup", "inputSchema": {"type": "object"}}])
        )
    ]
    kinds = [event["type"] for event in events]
    assert kinds.count("reasoning-delta") == 1
    assert "".join(event["delta"] for event in events if event["type"] == "text-delta") == "Hello world"
    assert events[-2] == {"type": "tool-call", "call": {"id": "call_1", "name": "lookup", "input": {"id": 7}}}
    completed = events[-1]["result"]
    assert completed["output"] == "Hello world"
    assert [part["type"] for part in completed["transcript"][0]["content"]] == ["reasoning", "text", "tool-call"]


async def test_abort_cancels_an_inflight_request() -> None:
    controller = AbortController()
    started = asyncio.Event()

    async def slow(_messages: list[Any], _info: AgentInfo) -> m.ModelResponse:
        started.set()
        await asyncio.sleep(10)
        return m.ModelResponse(parts=[m.TextPart("late")])

    task = asyncio.ensure_future(adapter(FunctionModel(slow)).generate(request(signal=controller.signal)))
    await started.wait()
    controller.abort(Error("cancelled"))
    with pytest.raises(Error, match="cancelled"):
        await asyncio.wait_for(task, 2)


async def test_provider_errors_keep_their_classification() -> None:
    def failing(_messages: list[Any], _info: AgentInfo) -> m.ModelResponse:
        raise ModelHTTPError(
            status_code=400,
            model_name="m",
            body={"error": {"message": "This model's maximum context length is 8192 tokens."}},
        )

    with pytest.raises(ModelHTTPError) as raised:
        await adapter(FunctionModel(failing)).generate(request())
    assert is_context_overflow_error(raised.value)

    def limited(_messages: list[Any], _info: AgentInfo) -> m.ModelResponse:
        raise ModelHTTPError(status_code=429, model_name="m", body="rate limited")

    with pytest.raises(ModelHTTPError) as raised:
        await adapter(FunctionModel(limited)).generate(request())
    assert is_retryable_model_error(raised.value)


def test_provider_options_translation_table() -> None:
    translated = translate_provider_options(
        "openai", {"openai": {"reasoningEffort": "low", "metadata": {"a": "b"}}, "anthropic": {"x": 1}}
    )
    # Like the AI SDK, an effort asks reasoning models for detailed summaries.
    assert translated.model_settings() == {
        "openai_reasoning_effort": "low",
        "openai_reasoning_summary": "detailed",
        "extra_body": {"metadata": {"a": "b"}},
    }
    with pytest.raises(Error, match=r'Provider option "openai\.unknownThing" is not supported'):
        translate_provider_options("openai", {"openai": {"unknownThing": 1}})
    compatible = translate_provider_options(
        "openai-compatible", {"openaiCompatible": {"user": "u"}, "local-llm": {"top_k": 5}}, name="local-llm"
    )
    assert compatible.model_settings() == {"openai_user": "u", "extra_body": {"top_k": 5}}
    google = translate_provider_options(
        "google", {"google": {"thinkingConfig": {"thinkingBudget": 0, "includeThoughts": False}}}
    )
    # Sent as given in the request body, as the AI SDK does (see GoogleChatModel).
    assert google.model_settings() == {
        "clearideas_request_body": {
            "generationConfig": {"thinkingConfig": {"thinkingBudget": 0, "includeThoughts": False}}
        }
    }


def test_media_data_urls_become_inline_bytes() -> None:
    call = adapter(FunctionModel(Recorder())).call_options(
        request(
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "file",
                            "url": f"data:application/pdf;base64,{base64.b64encode(b'%PDF').decode()}",
                            "mediaType": "application/pdf",
                        }
                    ],
                }
            ]
        )
    )
    content = call.messages[0].parts[0].content[0]
    assert isinstance(content, m.BinaryContent) and content.data == b"%PDF"


async def test_output_tool_mode_returns_the_structured_answer() -> None:
    schema = {"type": "object", "properties": {"status": {"type": "string"}}}
    # A model without a JSON response format is asked through an output tool.
    recorder = Recorder(m.ModelResponse(parts=[m.ToolCallPart("json", {"status": "ok"}, tool_call_id="o1")]))
    model = FunctionModel(
        recorder, profile={"supports_json_schema_output": False, "supports_json_object_output": False}
    )
    result = await adapter(model, driver="anthropic").generate(request(outputSchema=schema))
    assert recorder.info is not None and recorder.info.model_request_parameters.output_mode == "tool"
    assert result["output"] == {"status": "ok"}
    assert result["toolCalls"] == []
    assert result["transcript"][0]["content"] == [{"type": "text", "text": '{"status":"ok"}'}]


async def test_a_silent_tool_call_turn_with_a_schema_has_empty_output() -> None:
    recorder = Recorder(m.ModelResponse(parts=[m.ToolCallPart("lookup", {"q": 1}, tool_call_id="c1")]))
    result = await adapter(FunctionModel(recorder)).generate(
        request(tools=[{"name": "lookup", "inputSchema": {"type": "object"}}], outputSchema={"type": "object"})
    )
    assert result["output"] == ""
    assert result["finishReason"] == "tool-calls"
    assert len(result["toolCalls"]) == 1
