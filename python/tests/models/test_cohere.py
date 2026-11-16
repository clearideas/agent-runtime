"""``CohereChatModel``: the ``@ai-sdk/cohere`` request shape over pydantic-ai's Cohere model.

The provider-wire interop test compares whole requests with the TypeScript
runtime; these cases cover what a local mock cannot (downloaded documents)
and the response side of structured output and streaming.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from cohere import AsyncClientV2
from pydantic_ai.providers.cohere import CohereProvider

from clearideas_agent_runtime.models import cohere as cohere_module
from clearideas_agent_runtime.models.cohere import CohereChatModel
from clearideas_agent_runtime.models.pydantic_ai import PydanticAIModelAdapter, ResolvedModel

REPLY = {
    "id": "r1",
    "finish_reason": "COMPLETE",
    "message": {"role": "assistant", "content": [{"type": "text", "text": '{"status":"ok"}'}]},
    "usage": {
        "billed_units": {"input_tokens": 3, "output_tokens": 2},
        "tokens": {"input_tokens": 3, "output_tokens": 2},
    },
}


class Recorder:
    def __init__(self) -> None:
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        return httpx.Response(200, json=REPLY)


def adapter(recorder: Recorder) -> PydanticAIModelAdapter:
    client = AsyncClientV2(
        api_key="test",
        base_url="https://cohere.test",
        httpx_client=httpx.AsyncClient(transport=httpx.MockTransport(recorder)),
    )
    model = CohereChatModel("command-a-03-2025", provider=CohereProvider(cohere_client=client))
    return PydanticAIModelAdapter(resolve_model=lambda _key: ResolvedModel(model, "cohere", None))


async def test_sends_a_json_schema_response_format_and_parses_the_answer() -> None:
    recorder = Recorder()
    schema = {"type": "object", "properties": {"status": {"type": "string"}}, "required": ["status"]}
    result = await adapter(recorder).generate(
        {
            "model": "cohere/command-a-03-2025",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "Status?"}]}],
            "outputSchema": schema,
        }
    )
    assert result["output"] == {"status": "ok"}
    assert recorder.bodies[0]["response_format"] == {"type": "json_object", "json_schema": schema}
    assert "tools" not in recorder.bodies[0]


async def test_downloads_document_urls_as_utf8_text_with_their_names(monkeypatch: pytest.MonkeyPatch) -> None:
    downloaded: list[str] = []

    async def download_item(item: Any, data_format: str = "bytes") -> dict[str, Any]:
        downloaded.append(item.url)
        return {"data": b"\xef\xbb\xbfnotes \xff", "data_type": "text/plain"}

    monkeypatch.setattr(cohere_module, "download_item", download_item)
    recorder = Recorder()
    await adapter(recorder).generate(
        {
            "model": "cohere/command-a-03-2025",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Summarize"},
                        {
                            "type": "file",
                            "url": "https://example.com/notes.txt",
                            "mediaType": "text/plain",
                            "name": "n",
                        },
                    ],
                }
            ],
        }
    )
    assert downloaded == ["https://example.com/notes.txt"]
    body = recorder.bodies[0]
    assert body["documents"] == [{"data": {"text": "77u/bm90ZXMg/w==", "title": "n"}}]
    assert body["messages"] == [{"role": "user", "content": "Summarize"}]


async def test_concurrent_requests_keep_their_own_request_fields() -> None:
    import asyncio

    recorder = Recorder()
    runtime = adapter(recorder)
    schema = {"type": "object", "properties": {"status": {"type": "string"}}}
    await asyncio.gather(
        runtime.generate(
            {
                "model": "cohere/command-a-03-2025",
                "messages": [{"role": "user", "content": [{"type": "text", "text": "A"}]}],
                "outputSchema": schema,
            }
        ),
        runtime.generate(
            {
                "model": "cohere/command-a-03-2025",
                "messages": [{"role": "user", "content": [{"type": "text", "text": "B"}]}],
            }
        ),
    )
    by_prompt = {body["messages"][0]["content"]: body for body in recorder.bodies}
    assert "response_format" in by_prompt["A"]
    assert "response_format" not in by_prompt["B"]
