"""Provider-wire parity: both adapters send equivalent provider HTTP requests.

For each driver and case, the TypeScript ``AiSdkModelAdapter`` (through the AI
SDK provider the runtime configures) and the Python ``PydanticAIModelAdapter``
(through ``create_model_factory``) call a local mock provider. The recorded
request bodies are compared after a normalization that removes only
documented, semantically neutral differences (``KNOWN_DIFFERENCES``). The
``ModelResult``s (transcripts, usage, provider metadata) and streamed event
sequences must be identical, and failed calls must report the same error after
the same number of attempts.
"""

from __future__ import annotations

import json
import re
import subprocess
from datetime import UTC, datetime
from typing import Any

import pytest

from clearideas_agent_runtime.models.providers import create_model_factory
from clearideas_agent_runtime.models.pydantic_ai import PydanticAIModelAdapter

from .conftest import INTEROP
from .mock_provider import MockProvider
from .wire_cases import DRIVERS, PATHS, requests_for

#: Differences in the JSON bodies that do not change what the provider does.
KNOWN_DIFFERENCES = """
- `stream: false`, `n: 1`, and `stream_options.include_usage`: explicit defaults sent by the Python SDKs.
- Tools without `strict: false` (the default).
- OpenAI Responses: image `detail: "auto"` (the API default).
- Chat Completions: a user message with one text part is sent as a one-part array instead of a string.
- Anthropic: `system` as a string instead of one text block; tool results as one text block with
  `is_error: false`; `stream: true` on a generate call (the Anthropic SDK streams long requests; the result
  is read the same way).
- Gemini: `responseModalities: ["TEXT"]`, `systemInstruction.role`, snake_case field names (the API accepts
  both), the documented placeholder `thoughtSignature` on replayed function calls, and `title` on the
  response schema.
"""


def _camel(key: str) -> str:
    return re.sub(r"_([a-z])", lambda match: match.group(1).upper(), key)


def _camel_keys(value: Any) -> Any:
    if isinstance(value, dict):
        return {_camel(key): _camel_keys(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_camel_keys(item) for item in value]
    return value


def _text_parts_to_string(content: Any) -> Any:
    if (
        isinstance(content, list)
        and len(content) == 1
        and isinstance(content[0], dict)
        and content[0].get("type") == "text"
    ):
        return content[0]["text"]
    return content


def normalize(driver: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
    body = json.loads(json.dumps(body))
    if body.get("stream") is False:
        body.pop("stream")
    if body.get("n") == 1:
        body.pop("n")
    if (body.get("stream_options") or {}) == {"include_usage": True}:
        body.pop("stream_options")
    for tool in body.get("tools") or []:
        if tool.get("strict") is False:
            tool.pop("strict")
    if path.endswith("/responses"):
        for item in body.get("input") or []:
            for part in item.get("content") if isinstance(item.get("content"), list) else []:
                if part.get("type") == "input_image" and part.get("detail") == "auto":
                    part.pop("detail")
    if path.endswith("/chat/completions"):
        for message in body.get("messages") or []:
            if message.get("role") in ("user", "system", "assistant") and "content" in message:
                message["content"] = _text_parts_to_string(message["content"])
    if path.endswith("/messages"):
        body.pop("stream", None)
        if isinstance(body.get("system"), str):
            body["system"] = [{"type": "text", "text": body["system"]}]
        for message in body.get("messages") or []:
            for part in message.get("content") if isinstance(message.get("content"), list) else []:
                if part.get("type") == "tool_result":
                    if part.get("is_error") is False:
                        part.pop("is_error")
                    part["content"] = _text_parts_to_string(part.get("content"))
    if ":generateContent" in path or ":streamGenerateContent" in path:
        body = _camel_keys(body)
        config = body.get("generationConfig") or {}
        if config.get("responseModalities") == ["TEXT"]:
            config.pop("responseModalities")
        (body.get("systemInstruction") or {}).pop("role", None)
        (config.get("responseSchema") or config.get("responseJsonSchema") or {}).pop("title", None)
        for content in body.get("contents") or []:
            for part in content.get("parts") or []:
                if part.get("thoughtSignature") == "c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=":
                    part.pop("thoughtSignature")  # pragma: no cover - kept for replayed calls without a signature
    return body


def run_typescript(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    process = subprocess.run(
        ["node", str(INTEROP / "wire.mjs")],
        input=json.dumps({"cases": cases}),
        capture_output=True,
        text=True,
        cwd=INTEROP,
        timeout=300,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr)
    return json.loads(process.stdout)


def _generated_ids(value: Any, driver: str) -> Any:
    """Gemini returns no tool-call ids; each runtime generates random ones (16 characters)."""
    value = json.loads(json.dumps(value))
    if driver != "google":
        return value

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for key in ("call", "result"):
                if isinstance(node.get(key), dict):
                    for id_key in ("id", "callId"):
                        if isinstance(node[key].get(id_key), str) and len(node[key][id_key]) == 16:
                            node[key][id_key] = "generated"
            if node.get("toolCalls"):
                for call in node["toolCalls"]:
                    if len(call.get("id", "")) == 16:
                        call["id"] = "generated"
            for item in node.values():
                visit(item)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(value)
    return value


def model_output(outcome: dict[str, Any], driver: str) -> Any:
    """The ``ModelResult`` (generate) or the ``ModelEvent`` sequence (stream) a runtime produced."""
    return _generated_ids(outcome["events"] if "events" in outcome else outcome["result"], driver)


CASES = [(driver, name) for driver in DRIVERS for name in requests_for(driver)]
STREAMED = [
    ("openai", "tool-call"),
    ("openai", "text"),
    ("anthropic", "tool-call"),
    ("openai-compatible", "text"),
    ("groq", "tool-call"),
] + [
    (driver, name)
    for driver in DRIVERS
    for name in requests_for(driver)
    if name.startswith(("rich", "invalid", "error-429", "error-400", "empty"))
]


def exchange(cases: list[tuple[str, str]]) -> dict[str, tuple[Any, Any, Any, Any]]:
    """Runs (driver, name[@stream]) cases through both adapters against one mock provider.

    Returns case id → (TypeScript result, Python result, TypeScript requests, Python requests).
    """
    import asyncio

    with MockProvider() as mock:
        entries = []
        for driver, name in cases:
            base_name, _, mode = name.partition("@")
            request, reply = requests_for(driver)[base_name]
            case_id = f"{driver}|{name}"
            mock.replies[case_id] = reply
            entries.append((case_id, driver, request, mode or "generate"))
        typescript = run_typescript(
            [
                {
                    "id": f"ts:{case_id}",
                    "driver": driver,
                    "name": "local",
                    "baseURL": mock.url + PATHS[driver],
                    "request": request,
                    "mode": mode,
                }
                for case_id, driver, request, mode in entries
            ]
        )

        async def python_results() -> list[dict[str, Any]]:
            results = []
            for case_id, driver, request, mode in entries:
                factory = create_model_factory(
                    driver,
                    "local",
                    api_key="test-key",
                    base_url=mock.url + PATHS[driver],
                    headers={"x-case": f"py:{case_id}"},
                )
                adapter = PydanticAIModelAdapter(
                    resolve_model=lambda key, factory=factory: factory(key.split("/", 1)[1]),
                    # The TypeScript driver's clock and transcript ids.
                    now=lambda: datetime(2026, 1, 1, tzinfo=UTC),
                    generate_transcript_id=lambda: "item",
                )
                try:
                    if mode == "stream":
                        events = [event async for event in adapter.stream(request)]
                        results.append({"ok": True, "events": events})
                    else:
                        results.append({"ok": True, "result": await adapter.generate(request)})
                except Exception as error:
                    results.append(
                        {
                            "ok": False,
                            "error": {
                                "name": getattr(error, "name", type(error).__name__),
                                "message": getattr(error, "message", str(error)),
                                "statusCode": getattr(error, "statusCode", None),
                            },
                        }
                    )
            return results

        python = asyncio.run(python_results())
        return {
            case_id: (ts, py, mock.requests.get(f"ts:{case_id}"), mock.requests.get(f"py:{case_id}"))
            for (case_id, *_), ts, py in zip(entries, typescript, python, strict=True)
        }


ALL_CASES = CASES + [(driver, f"{name}@stream") for driver, name in STREAMED]


@pytest.fixture(scope="module")
def wire(oracle):
    return exchange(ALL_CASES)


@pytest.mark.parametrize(("driver", "name"), ALL_CASES)
def test_adapters_send_equivalent_provider_requests(wire, driver, name):
    ts_result, py_result, ts_requests, py_requests = wire[f"{driver}|{name}"]
    if name.startswith("error-"):
        # The same error (name, message, status) after the same number of attempts.
        assert not ts_result["ok"] and not py_result["ok"], (ts_result, py_result)
        ts_error = {key: value for key, value in ts_result["error"].items() if value is not None}
        py_error = {key: value for key, value in py_result["error"].items() if value is not None}
        assert py_error == ts_error
        assert len(py_requests) == len(ts_requests)
        return
    assert ts_result["ok"], ts_result
    assert py_result["ok"], py_result
    assert ts_requests and py_requests and len(ts_requests) == len(py_requests) == 1
    assert ts_requests[0]["path"] == py_requests[0]["path"]
    path = ts_requests[0]["path"]
    expected = normalize(driver, path, ts_requests[0]["body"])
    actual = normalize(driver, path, py_requests[0]["body"])
    assert actual == expected
    # The whole ModelResult (transcript, usage, provider metadata) or every streamed event.
    assert model_output(py_result, driver) == model_output(ts_result, driver)
