"""Port of ``packages/step-prompt/src/context.test.ts``."""

from __future__ import annotations

import re

import pytest

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime._js.errors import Error, TypeError_
from clearideas_agent_runtime.steps.prompt.context.errors import (
    is_context_overflow_error,
    is_invalid_output_error,
    is_retryable_model_error,
)
from clearideas_agent_runtime.steps.prompt.context.measure import TokenEstimator, json_bytes, json_text_bytes
from clearideas_agent_runtime.steps.prompt.context.prune import (
    clip_tool_result_part,
    prune_json,
    prune_text,
    stub_tool_result_part,
)
from clearideas_agent_runtime.steps.prompt.context.summarize import (
    ChunkedSummarizer,
    SummarizeInput,
    split_into_chunks,
)
from clearideas_agent_runtime.steps.prompt.context.template import (
    compile_template,
    render_template,
    render_template_outline,
)
from clearideas_agent_runtime.steps.prompt.context.transcript import (
    compacted_view,
    derive_rounds,
    marker_metadata,
    split_retained,
    tool_rounds_since_compaction,
)

AT = "2026-07-22T00:00:00.000Z"


def assistant_call(id_: str, name: str = "lookup") -> dict:
    return {
        "id": id_,
        "type": "message",
        "role": "assistant",
        "content": [{"type": "tool-call", "call": {"id": f"call-{id_}", "name": name, "input": {}}}],
        "createdAt": AT,
    }


def tool_result(id_: str, call_id: str, output: str = "x") -> dict:
    return {
        "id": id_,
        "type": "tool-result",
        "role": "tool",
        "content": [{"type": "tool-result", "result": {"callId": call_id, "name": "lookup", "output": output}}],
        "createdAt": AT,
    }


class TestPruning:
    def test_keeps_beginning_and_end_within_budget(self) -> None:
        text = f"BEGIN {'a' * 10_000} END"
        pruned = prune_text(text, 1_000, "doc")
        assert json_text_bytes(pruned) <= 1_000
        assert pruned.startswith("BEGIN")
        assert pruned.endswith("END")
        assert "omitted" in pruned
        assert "of doc" in pruned
        assert prune_text("short", 1_000) == "short"

    def test_never_splits_multibyte_characters(self) -> None:
        pruned = prune_text("😀" * 2_000, 500)
        assert json_text_bytes(pruned) <= 500
        assert not re.search("[\ud800-\udfff]", pruned)

    def test_keeps_json_valid(self) -> None:
        value = {
            "title": "Report",
            "rows": [{"index": index, "note": "n"} for index in range(500)],
            "body": "b" * 20_000,
        }
        pruned = prune_json(value, 4_000)
        parsed = js_json.parse(pruned)
        assert json_bytes(parsed) <= 4_000
        assert parsed["title"] == "Report"
        assert len(parsed["rows"]) < 500

    def test_stubs_and_clips_tool_results(self) -> None:
        part = {
            "type": "tool-result",
            "result": {
                "callId": "call-1",
                "name": "read",
                "output": "z" * 5_000,
                "artifacts": [{"id": "a", "name": "chart.png", "mediaType": "image/png"}],
            },
        }
        stub = stub_tool_result_part(part)
        assert stub["result"]["callId"] == "call-1"
        assert stub["result"]["name"] == "read"
        assert stub["result"]["output"]["agentRuntime"] == "omitted"
        assert stub["result"]["output"]["omittedArtifacts"] == ["chart.png"]
        assert json_bytes(stub) < 1_000
        clipped = clip_tool_result_part(part, 1_000)
        assert clipped["result"]["callId"] == "call-1"
        assert "artifacts" not in clipped["result"]
        assert json_bytes(clipped) < 1_600


def test_templates_compile_literals_and_slots_case_insensitively() -> None:
    template = compile_template(
        "prompt",
        "Review {{ Doc.Body }} for {{ audience }}.",
        {"doc": {"body": "the contract"}, "audience": "legal"},
    )
    assert render_template(template) == "Review the contract for legal."
    assert render_template_outline(template) == "Review {{ Doc.Body }} for {{ audience }}."
    slot = next(segment.slot for segment in template.segments if segment.slot is not None)
    assert (slot.path, slot.value, slot.text) == ("Doc.Body", "the contract", "the contract")


TRANSCRIPT = [
    assistant_call("a1"),
    tool_result("t1", "call-a1", "first"),
    assistant_call("a2"),
    tool_result("t2", "call-a2", "second"),
    assistant_call("a3"),
    tool_result("t3", "call-a3", "third"),
]


class TestTranscriptView:
    def test_derives_whole_rounds_and_retains_newest(self) -> None:
        rounds = derive_rounds(TRANSCRIPT)
        assert [[item["id"] for item in round_.items] for round_ in rounds] == [
            ["a1", "t1"],
            ["a2", "t2"],
            ["a3", "t3"],
        ]
        prefix, retained = split_retained(rounds, 2)
        assert len(prefix) == 1
        assert len(retained) == 2
        assert split_retained(rounds, 0)[1] == []
        assert tool_rounds_since_compaction(rounds) == 3

    def test_hides_superseded_places_summaries_substitutes_rewrites(self) -> None:
        summary = {
            "id": "s1",
            "type": "message",
            "role": "user",
            "content": [{"type": "text", "text": "summary"}],
            "createdAt": AT,
            "metadata": marker_metadata(
                {
                    "kind": "summary",
                    "sequence": 1,
                    "strategy": "summarize",
                    "reason": "input-size",
                    "replaces": ["a1", "t1"],
                    "anchor": "a2",
                }
            ),
        }
        rewrite = {
            "id": "r1",
            "type": "message",
            "content": [],
            "createdAt": AT,
            "metadata": marker_metadata(
                {
                    "kind": "rewrite",
                    "sequence": 2,
                    "strategy": "prune",
                    "reason": "tool-result-size",
                    "rewrites": {
                        "t3": [
                            {
                                "type": "tool-result",
                                "result": {"callId": "call-a3", "name": "lookup", "output": "short"},
                            }
                        ]
                    },
                }
            ),
        }
        view = compacted_view([*TRANSCRIPT, summary, rewrite])
        assert [item["id"] for item in view] == ["s1", "a2", "t2", "a3", "t3"]
        assert view[-1]["content"][0]["result"]["output"] == "short"
        rounds = derive_rounds(view)
        assert rounds[0].kind == "marker"
        assert tool_rounds_since_compaction(rounds) == 2


class TestChunkedSummarizer:
    async def test_splits_condenses_and_combines(self) -> None:
        calls: list[str] = []

        async def call(input: dict) -> str:
            calls.append(input["user"])
            return f"summary {len(calls)}"

        summarizer = ChunkedSummarizer(call=call, chunk_bytes=2_000, max_calls=20, variables={})
        text = "\n\n".join(f"Section {index}: {'word ' * 150}" for index in range(10))
        summary = await summarizer.summarize(
            SummarizeInput(
                text=text, target_bytes=600, kind="input", label="the variable doc", task="Answer the question."
            )
        )
        assert len(calls) > 1
        assert "(part 1 of" in calls[0]
        assert "Answer the question." in calls[0]
        assert "summary" in summary
        for entry in calls:
            assert len(entry) < 3_000

    async def test_stops_at_call_limit_and_rejects_empty(self) -> None:
        async def ok(_: dict) -> str:
            return "ok"

        limited = ChunkedSummarizer(call=ok, chunk_bytes=1_000, max_calls=2, variables={})
        with pytest.raises(Exception, match="summarizer calls"):
            await limited.summarize(
                SummarizeInput(text="x " * 5_000, target_bytes=300, kind="input", label="doc", task="")
            )

        async def blank(_: dict) -> str:
            return "  "

        empty = ChunkedSummarizer(call=blank, chunk_bytes=10_000, max_calls=5, variables={})
        with pytest.raises(Exception, match="returned nothing"):
            await empty.summarize(SummarizeInput(text="hello", target_bytes=300, kind="input", label="doc", task=""))

    async def test_templates_custom_prompts(self) -> None:
        seen: dict = {}

        async def call(input: dict) -> str:
            seen.update(input)
            return "done"

        summarizer = ChunkedSummarizer(
            call=call,
            chunk_bytes=10_000,
            max_calls=5,
            system_prompt="Notes for {{ topic }}.",
            prompt="Summarize {{ context.label }} in {{ context.targetWords }} words.",
            variables={"topic": "pricing"},
        )
        await summarizer.summarize(
            SummarizeInput(text="material", target_bytes=600, kind="transcript", label="3 rounds", task="t")
        )
        assert seen["system"] == "Notes for pricing."
        assert "Summarize 3 rounds in 100 words." in seen["user"]
        assert "<material>\nmaterial\n</material>" in seen["user"]

    def test_splits_at_paragraph_and_line_boundaries(self) -> None:
        chunks = split_into_chunks(f"{'a' * 900}\n\n{'b' * 900}", 1_000)
        assert len(chunks) == 2
        assert len(split_into_chunks("c" * 2_500, 1_000)) == 3


def api_error(status_code: int, message: str, **extra: object) -> Error:
    error = Error(message)
    error.statusCode = status_code  # type: ignore[attr-defined]
    for key, value in extra.items():
        setattr(error, key, value)
    return error


class TestErrorClassification:
    def test_recognizes_context_overflows_but_not_rate_limits(self) -> None:
        assert is_context_overflow_error(
            api_error(
                400,
                "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
            )
        )
        assert is_context_overflow_error(api_error(400, "prompt is too long: 210000 tokens > 200000 maximum"))
        assert is_context_overflow_error(
            api_error(400, "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).")
        )
        assert not is_context_overflow_error(api_error(429, "Request too large for gpt-x on tokens per min (TPM)"))
        wrapped = Error("Failed after 3 attempts")
        wrapped.lastError = api_error(413, "Request too large")  # type: ignore[attr-defined]
        assert is_context_overflow_error(wrapped)

    def test_retries_transient_failures_only(self) -> None:
        assert is_retryable_model_error(api_error(429, "rate limited"))
        assert is_retryable_model_error(api_error(503, "unavailable"))
        retryable = Error("x")
        retryable.isRetryable = True  # type: ignore[attr-defined]
        assert is_retryable_model_error(retryable)
        assert is_retryable_model_error(TypeError_("fetch failed"))
        assert is_retryable_model_error(ConnectionResetError("reset"))
        assert not is_retryable_model_error(api_error(401, "bad key"))
        assert not is_retryable_model_error(Error("boom"))
        assert not is_retryable_model_error(api_error(400, "maximum context length exceeded"))

    def test_recognizes_invalid_structured_output(self) -> None:
        error = Error("No object generated")
        error.name = "AI_NoObjectGeneratedError"
        assert is_invalid_output_error(error)
        assert not is_invalid_output_error(Error("other"))
        assert is_invalid_output_error({"code": "MODEL_OUTPUT_INVALID"})


def test_token_estimator_calibrates() -> None:
    estimator = TokenEstimator()
    assert estimator.tokens(4_000) == 1_000
    estimator.observe(6_000, 1_000)
    assert estimator.calibrated
    assert estimator.tokens(6_000) == 1_000
    assert estimator.bytes(100) == 600
    estimator.observe(100, 0)
    assert estimator.bytes_per_token == 6
