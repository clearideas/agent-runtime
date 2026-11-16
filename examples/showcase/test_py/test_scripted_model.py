"""The scripted model (lib/scripted_model.py), as test/scripted-model.test.ts checks lib/scripted-model.ts."""

from __future__ import annotations

import asyncio

import pytest
from clearideas_agent_runtime import AbortController

from lib.scripted_model import ScriptedModelAdapter


def user(text: str) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}]}


async def test_stops_with_a_clear_error_when_the_sandbox_could_not_run_a_command() -> None:
    model = ScriptedModelAdapter(lambda request: {"output": "unreachable"}, pace=0)
    with pytest.raises(RuntimeError, match=r"The sandbox could not run repo__list_files \(sandbox_command_failed\)"):
        await model.generate(
            {
                "model": "scripted",
                "messages": [
                    user("Go."),
                    {
                        "role": "tool",
                        "content": [
                            {
                                "type": "tool-result",
                                "result": {
                                    "callId": "c1",
                                    "name": "repo__list_files",
                                    "error": {"code": "sandbox_command_failed", "message": "helper exited 1"},
                                },
                            }
                        ],
                    },
                ],
            }
        )


async def test_streams_narration_then_calls_a_tool_with_usage_reported() -> None:
    model = ScriptedModelAdapter(
        lambda request: {"say": "Looking around.", "call": {"name": "repo__list_files", "input": {}}}, pace=0
    )
    deltas: list[str] = []
    completed = None
    async for event in model.stream({"model": "scripted", "messages": [user("Go.")]}):
        if event["type"] == "text-delta":
            deltas.append(event["delta"])
        if event["type"] == "completed":
            completed = event["result"]
    assert "".join(deltas) == "Looking around."
    assert completed is not None
    assert len(completed["toolCalls"]) == 1
    assert completed["transcript"][0]["usage"]["totalTokens"] > 0
    assert completed["transcript"][0]["type"] == "tool-call"


async def test_structured_output_is_narrated_as_javascript_json() -> None:
    model = ScriptedModelAdapter(lambda request: {"output": {"a": 1, "b": [True, None]}}, pace=0)
    deltas = [
        event["delta"]
        async for event in model.stream({"model": "scripted", "messages": [user("Go.")]})
        if event["type"] == "text-delta"
    ]
    # JSON.stringify(value, null, 2), streamed word by word.
    assert "".join(deltas) == '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}'


async def test_narration_splits_on_javascript_whitespace() -> None:
    # JavaScript's \\s includes U+FEFF; Python's does not.
    model = ScriptedModelAdapter(lambda request: {"say": "a\ufeffb c", "output": "done"}, pace=0)
    deltas = [
        event["delta"]
        async for event in model.stream({"model": "scripted", "messages": [user("Go.")]})
        if event["type"] == "text-delta"
    ]
    assert deltas == ["a\ufeff", "b ", "c"]


async def test_an_empty_narration_still_streams_one_empty_delta() -> None:
    # As in TypeScript: "".match(...) is null, so the one chunk is "".
    model = ScriptedModelAdapter(lambda request: {"say": "", "output": "done"}, pace=0)
    deltas = [
        event["delta"]
        async for event in model.stream({"model": "scripted", "messages": [user("Go.")]})
        if event["type"] == "text-delta"
    ]
    assert deltas == [""]


async def test_paced_narration_stops_when_the_request_is_cancelled() -> None:
    controller = AbortController()
    request = {"model": "scripted", "messages": [user("Go.")], "signal": controller.signal}
    quick = ScriptedModelAdapter(lambda request: {"output": " ".join(["word"] * 30)}, pace=0.001)
    await quick.generate(request)

    pending = asyncio.ensure_future(ScriptedModelAdapter(lambda request: {"output": "never"}, pace=1).generate(request))
    await asyncio.sleep(0.01)
    controller.abort(RuntimeError("browser disconnected"))
    with pytest.raises(RuntimeError, match="browser disconnected"):
        await pending
    with pytest.raises(RuntimeError, match="browser disconnected"):
        await quick.generate(request)
