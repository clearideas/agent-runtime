"""Prompt-step context management parity on generated inputs.

Pruning, chunking, fingerprints, error classification, and transcript views
decide what a model sees and what is stored in checkpoints; each must give
byte-identical results in both runtimes, including for astral characters,
escapes, and lone surrogates.
"""

from __future__ import annotations

import random
from typing import Any

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime.steps.prompt.context.errors import (
    error_summary,
    is_context_overflow_error,
    is_invalid_output_error,
    is_retryable_model_error,
)
from clearideas_agent_runtime.steps.prompt.context.measure import head_within_bytes, json_text_bytes, tail_within_bytes
from clearideas_agent_runtime.steps.prompt.context.prune import (
    clip_tool_result_part,
    prune_json,
    prune_text,
    stub_tool_result_part,
)
from clearideas_agent_runtime.steps.prompt.context.summarize import split_into_chunks
from clearideas_agent_runtime.steps.prompt.context.transcript import (
    compacted_view,
    derive_rounds,
    fingerprint,
    marker_metadata,
    render_items_as_text,
)

ALPHABET = [
    "a",
    "b",
    " ",
    "\n",
    "\n\n",
    "é",
    "😀",
    '"',
    "\\",
    "\t",
    "\u0001",
    "\u2028",
    "€",
    "ß",
    "\ud800",
    "\udc00",
    "x" * 20,
]


def text(rng: random.Random, size: int) -> str:
    return "".join(rng.choice(ALPHABET) for _ in range(size))


def json_value(rng: random.Random, depth: int = 0) -> Any:
    kind = rng.randrange(7 if depth < 3 else 4)
    if kind == 0:
        return text(rng, rng.randrange(0, 400))
    if kind == 1:
        return rng.choice([0, 1, -2.5, 1e21, 123456789, None, True, False])
    if kind == 2:
        return "w" * rng.randrange(0, 3000)
    if kind == 3:
        return rng.randrange(-1000, 1000)
    if kind in (4, 5):
        return [json_value(rng, depth + 1) for _ in range(rng.randrange(0, 40))]
    return {
        rng.choice(["a", "b", "10", "2", "é", "key"]) + str(index): json_value(rng, depth + 1)
        for index in range(rng.randrange(0, 8))
    }


def compare(oracle, op: str, inputs: list[Any], python) -> None:
    expected = oracle(op, inputs)
    for index, (value, result) in enumerate(zip(inputs, expected, strict=True)):
        assert result["ok"], (op, value, result)
        actual = python(value)
        assert js_json.stringify(actual) == js_json.stringify(result["value"]), (op, index, value)


def test_prune_text_matches(oracle) -> None:
    rng = random.Random(11)
    inputs = []
    for _ in range(400):
        body = text(rng, rng.randrange(0, 1200))
        inputs.append(
            {"text": body, "maxBytes": rng.randrange(0, 3000), "label": rng.choice([None, "doc", "the variable é"])}
        )
    inputs = [{key: value for key, value in entry.items() if value is not None} for entry in inputs]
    compare(oracle, "pruneText", inputs, lambda entry: prune_text(entry["text"], entry["maxBytes"], entry.get("label")))


def test_head_and_tail_within_bytes_match(oracle) -> None:
    rng = random.Random(12)
    inputs = [{"text": text(rng, rng.randrange(0, 300)), "maxBytes": rng.randrange(-2, 600)} for _ in range(400)]
    compare(
        oracle,
        "withinBytes",
        inputs,
        lambda entry: {
            "head": head_within_bytes(entry["text"], entry["maxBytes"]),
            "tail": tail_within_bytes(entry["text"], entry["maxBytes"]),
            "bytes": json_text_bytes(entry["text"]),
        },
    )


def test_prune_json_matches(oracle) -> None:
    rng = random.Random(13)
    inputs = [{"value": json_value(rng), "maxBytes": rng.randrange(0, 5000)} for _ in range(150)]
    compare(oracle, "pruneJson", inputs, lambda entry: prune_json(entry["value"], entry["maxBytes"]))


def test_tool_result_stubs_and_clips_match(oracle) -> None:
    rng = random.Random(14)
    parts = []
    for index in range(100):
        result: dict[str, Any] = {"callId": f"c{index}", "name": rng.choice(["read", "search"])}
        if rng.random() < 0.25:
            result["error"] = {"code": "tool_error", "message": text(rng, rng.randrange(0, 900))}
        elif rng.random() < 0.8:
            result["output"] = json_value(rng)
        if rng.random() < 0.3:
            result["artifacts"] = [{"id": "a", "name": "chart é.png", "mediaType": "image/png"}]
        if rng.random() < 0.2:
            result["metadata"] = {"cached": True}
        parts.append({"type": "tool-result", "result": result})
    stub_inputs = [{"part": part, "previewBytes": rng.choice([0, 50, 200, 1000])} for part in parts]
    compare(
        oracle, "stubToolResult", stub_inputs, lambda entry: stub_tool_result_part(entry["part"], entry["previewBytes"])
    )
    clip_inputs = [{"part": part, "maxBytes": rng.randrange(0, 3000)} for part in parts]
    compare(
        oracle, "clipToolResult", clip_inputs, lambda entry: clip_tool_result_part(entry["part"], entry["maxBytes"])
    )


def test_split_into_chunks_matches(oracle) -> None:
    rng = random.Random(15)
    inputs = [{"text": text(rng, rng.randrange(0, 2000)), "chunkBytes": rng.randrange(8, 1500)} for _ in range(300)]
    expected = oracle("splitIntoChunks", inputs)
    for entry, result in zip(inputs, expected, strict=True):
        try:
            actual: Any = {"ok": True, "value": split_into_chunks(entry["text"], entry["chunkBytes"])}
        except Exception as error:
            actual = {"ok": False, "message": str(error)}
        if result["ok"]:
            assert js_json.stringify(actual) == js_json.stringify({"ok": True, "value": result["value"]}), entry
        else:
            assert actual == {"ok": False, "message": result["error"]["message"]}, entry


def test_fingerprints_match(oracle) -> None:
    rng = random.Random(16)
    inputs = [text(rng, rng.randrange(0, 500)) for _ in range(300)] + [
        "",
        "😀",
        "\ud800",
        js_json.stringify({"a": [1, "é"]}),
    ]
    compare(oracle, "fingerprint", inputs, fingerprint)


def test_error_classification_matches(oracle) -> None:
    rng = random.Random(17)
    messages = [
        "This model's maximum context length is 8192 tokens.",
        "prompt is too long: 210000 tokens > 200000 maximum",
        "The input token count exceeds the maximum number of tokens allowed",
        "Request too large for gpt-x on tokens per min (TPM)",
        "socket hang up",
        "fetch failed",
        "Connection RESET by peer",
        "terminated",
        "Overloaded",
        "bad key",
        "exceeded: too many input tokens in the context",
        "ExceedING the ſ context",
        "",
    ]

    def error(depth: int = 0) -> dict[str, Any]:
        value: dict[str, Any] = {"message": rng.choice(messages)}
        if rng.random() < 0.5:
            value["statusCode" if rng.random() < 0.5 else "status"] = rng.choice(
                [400, 401, 408, 413, 422, 429, 500, 503, 529, "500"]
            )
        if rng.random() < 0.3:
            value["code"] = rng.choice(["ECONNRESET", "MODEL_CONTEXT_OVERFLOW", "MODEL_OUTPUT_INVALID", "OTHER", 5])
        if rng.random() < 0.2:
            value["name"] = rng.choice(
                ["ModelTimeoutError", "AI_NoObjectGeneratedError", "NoObjectGeneratedError", "APICallError"]
            )
        if rng.random() < 0.2:
            value["isRetryable"] = rng.choice([True, False, "true"])
        if rng.random() < 0.2:
            value["responseBody"] = rng.choice(messages)
        if depth < 2 and rng.random() < 0.3:
            value[rng.choice(["cause", "lastError"])] = error(depth + 1)
        if depth < 2 and rng.random() < 0.15:
            value["errors"] = [error(depth + 1) for _ in range(rng.randrange(0, 3))]
        return value

    inputs: list[Any] = [error() for _ in range(500)] + ["plain string", 42, None]
    compare(
        oracle,
        "classifyError",
        inputs,
        lambda value: {
            "overflow": is_context_overflow_error(value),
            "retryable": is_retryable_model_error(value),
            "invalid": is_invalid_output_error(value),
            "summary": error_summary(value),
        },
    )


def test_compacted_views_match(oracle) -> None:
    rng = random.Random(18)
    transcripts = []
    for _ in range(150):
        items: list[dict[str, Any]] = []
        for index in range(rng.randrange(1, 14)):
            kind = rng.randrange(5)
            item_id = f"i{index}"
            if kind == 0:
                items.append(
                    {
                        "id": item_id,
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {"type": "tool-call", "call": {"id": f"c{index}", "name": "read", "input": {"p": index}}}
                        ],
                        "createdAt": "t",
                    }
                )
            elif kind == 1:
                items.append(
                    {
                        "id": item_id,
                        "type": "tool-result",
                        "role": "tool",
                        "content": [
                            {
                                "type": "tool-result",
                                "result": {"callId": f"c{index - 1}", "name": "read", "output": text(rng, 30)},
                            }
                        ],
                        "createdAt": "t",
                    }
                )
            elif kind == 2:
                items.append(
                    {
                        "id": item_id,
                        "type": "message",
                        "role": rng.choice(["assistant", "user"]),
                        "content": [
                            {"type": "text", "text": text(rng, 20)},
                            {"type": "reasoning", "text": "r"},
                            {"type": "file", "name": "f.pdf", "artifact": {"id": "a"}},
                        ],
                        "createdAt": "t",
                    }
                )
            else:
                earlier = [entry["id"] for entry in items]
                marker: dict[str, Any] = {
                    "kind": rng.choice(["summary", "note", "rewrite", "usage", "input"]),
                    "sequence": index,
                    "strategy": "prune",
                    "reason": "input-size",
                }
                if earlier and rng.random() < 0.6:
                    marker["replaces"] = rng.sample(earlier, rng.randrange(1, len(earlier) + 1))
                if earlier and rng.random() < 0.4:
                    marker["rewrites"] = {rng.choice(earlier): [{"type": "text", "text": "rewritten"}]}
                if rng.random() < 0.5:
                    marker["anchor"] = f"i{rng.randrange(0, 16)}"
                entry: dict[str, Any] = {
                    "id": item_id,
                    "type": "message",
                    "content": [{"type": "text", "text": "marker"}] if rng.random() < 0.7 else [],
                    "createdAt": "t",
                    "metadata": marker_metadata(marker),
                }
                if rng.random() < 0.6:
                    entry["role"] = "user"
                items.append(entry)
        transcripts.append(items)

    def python(transcript: list[dict[str, Any]]) -> dict[str, Any]:
        view = compacted_view(transcript)
        return {
            "view": view,
            "rounds": [
                {"kind": round_.kind, "ids": [item["id"] for item in round_.items]} for round_ in derive_rounds(view)
            ],
            "text": render_items_as_text(view),
        }

    compare(oracle, "compactedView", transcripts, python)
