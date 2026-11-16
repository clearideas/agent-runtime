"""Port of ``packages/step-prompt/src/resilience.test.ts``."""

from __future__ import annotations

import copy
import itertools
import re
from dataclasses import dataclass, field
from typing import Any

import pytest

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core.runtime import StepExecutionContext
from clearideas_agent_runtime.steps.prompt import PromptStepExecutor
from clearideas_agent_runtime.steps.prompt.context.measure import json_bytes
from clearideas_agent_runtime.steps.prompt.context.summarize import DEFAULT_SUMMARIZER_SYSTEM_PROMPT
from clearideas_agent_runtime.steps.prompt.context.transcript import compacted_view, context_marker

from .support import AT, Adapter, request_copy

_sequence = itertools.count(1)


def next_id() -> str:
    return f"item-{next(_sequence)}"


def assistant(text: str | None = None, calls: list[dict] | None = None, usage: dict | None = None) -> dict:
    calls = calls or []
    result: dict = {} if text is None else {"output": text}
    item: dict = {
        "id": next_id(),
        "type": "message",
        "role": "assistant",
        "content": ([{"type": "text", "text": text}] if text else [])
        + [{"type": "tool-call", "call": c} for c in calls],
        "createdAt": AT,
    }
    if usage is not None:
        item["usage"] = usage
    result.update({"toolCalls": calls, "finishReason": "tool-calls" if calls else "stop", "transcript": [item]})
    return result


def call(name: str, input: dict | None = None) -> dict:
    return {"id": f"call-{next(_sequence)}", "name": name, "input": input or {}}


def is_summarizer_request(request: dict) -> bool:
    return any(
        message["role"] == "system"
        and any(
            part["type"] == "text" and part["text"] == DEFAULT_SUMMARIZER_SYSTEM_PROMPT for part in message["content"]
        )
        for message in request["messages"]
    )


def request_text(request: dict) -> str:
    return js_json.stringify(request["messages"])


@dataclass
class Harness:
    requests: list[dict] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    checkpoints: list[dict] = field(default_factory=list)


@dataclass
class Outcome:
    result: dict
    requests: list[dict]
    events: list[dict]
    checkpoints: list[dict]


def generator(fn):
    """A model adapter from a generate function (sync or async)."""

    async def generate(request: dict) -> dict:
        return fn(request)

    return Adapter(generate=generate)


async def execute(
    *,
    step: dict,
    model: Any,
    tools: Any = None,
    variables: dict | None = None,
    limits: dict | None = None,
    policies: dict | None = None,
    token_budget: Any = None,
    resume: dict | None = None,
    harness: Harness | None = None,
    summarizer: Any = None,
) -> Outcome:
    harness = harness or Harness()

    async def generate(request: dict) -> dict:
        harness.requests.append(request_copy(request))
        return await model.generate(request)

    recording = Adapter(generate=generate)
    if getattr(model, "describe_model", None) is not None:
        recording.describe_model = model.describe_model  # type: ignore[attr-defined]
    manifest: dict = {"schemaVersion": "1.0", "steps": [step]}
    if limits:
        manifest["limits"] = limits

    async def checkpoint(value: dict) -> None:
        harness.checkpoints.append(copy.deepcopy(value))

    async def emit(type: str, data: dict | None = None) -> dict:
        harness.events.append({"type": type, **({"data": data} if data is not None else {})})
        return {"id": type, "runId": "run", "sequence": 1, "timestamp": AT, "type": type}

    resume_value = None
    if resume is not None:
        resume_value = {"cursor": {"stepIndex": 0, "stepId": step["id"]}}
        if resume.get("continuation") is not None:
            resume_value["continuation"] = resume["continuation"]
        resume_value["transcript"] = resume.get("transcript") or []

    async def no_sleep(_delay: float, _signal: object = None) -> None:
        return None

    result = await PromptStepExecutor(sleep=no_sleep).execute(
        StepExecutionContext(
            run_id="run",
            manifest=manifest,
            step=step,
            step_index=0,
            variables=variables or {},
            model=recording,
            tools=tools,
            policies=policies,
            token_budget=token_budget,
            summarizer=summarizer,
            resume=resume_value,
            checkpoint=checkpoint,
            emit=emit,
        )
    )
    return Outcome(result, harness.requests, harness.events, harness.checkpoints)


def reader_tools(size: int, executed: list[dict] | None = None, **extra: Any) -> Adapter:
    async def list_tools() -> list[dict]:
        return [
            {"name": "docs__read", "inputSchema": {"type": "object"}},
            {"name": "docs__write", "inputSchema": {"type": "object"}},
        ]

    async def execute_tool(tool_call: dict, _context: object) -> dict:
        if executed is not None:
            executed.append(tool_call)
        path = tool_call["input"].get("path")
        return {
            "callId": tool_call["id"],
            "name": tool_call["name"],
            "output": f"{path if path is not None else 'file'}: {'data ' * (size // 5)}",
        }

    return Adapter(list_tools=list_tools, execute_tool=execute_tool, **extra)


def reduced_events(events: list[dict]) -> list[dict]:
    return [event for event in events if event["type"] == "context.reduced"]


def has_event(events: list[dict], **data: Any) -> bool:
    return any(all((event.get("data") or {}).get(key) == value for key, value in data.items()) for event in events)


# ─── Opening prompt reduction ───────────────────────────────────────────────

BIG_STEP = {
    "id": "analyze",
    "type": "prompt",
    "model": {"provider": "test", "model": "m"},
    "systemPrompt": "You review contracts.",
    "prompt": "Check this contract:\n{{ contract }}\nAgainst policy: {{ policy }}",
}
BIG_VARIABLES = {
    "contract": f"CONTRACT START {'clause ' * 30_000} CONTRACT END",
    "policy": f"POLICY {'rule ' * 2_000}",
}


def answer(text: str) -> Adapter:
    return generator(lambda _request: assistant(text))


class TestOpeningPromptReduction:
    async def test_prunes_interpolated_variables_by_default(self) -> None:
        outcome = await execute(
            step=BIG_STEP, variables=BIG_VARIABLES, limits={"maxInputBytes": 20_000}, model=answer("ok")
        )
        assert outcome.result["output"] == "ok"
        assert len(outcome.requests) == 1
        sent = outcome.requests[0]
        assert json_bytes(sent["messages"]) <= 20_000
        text = request_text(sent)
        for expected in ("Check this contract:", "CONTRACT START", "CONTRACT END", "omitted"):
            assert expected in text
        assert has_event(reduced_events(outcome.events), scope="input", strategy="prune", variable="contract")

    async def test_keeps_kept_variables_and_caps_max_bytes(self) -> None:
        outcome = await execute(
            step=BIG_STEP,
            variables=BIG_VARIABLES,
            limits={"maxInputBytes": 30_000},
            policies={"context": {"variables": {"policy": {"keep": True}, "contract": {"maxBytes": 2_000}}}},
            model=answer("ok"),
        )
        text = request_text(outcome.requests[0])
        assert BIG_VARIABLES["policy"] in text
        assert len(text) < len(BIG_VARIABLES["policy"]) + 4_000

    async def test_summarizes_oversized_variables_in_chunks(self) -> None:
        def respond(request: dict) -> dict:
            if is_summarizer_request(request):
                return assistant(
                    "Key clause: payment in 30 days.",
                    usage={"inputTokens": 100, "outputTokens": 10, "totalTokens": 110},
                )
            return assistant("reviewed")

        outcome = await execute(
            step=BIG_STEP,
            variables=BIG_VARIABLES,
            limits={"maxInputBytes": 20_000},
            policies={"context": {"strategy": "summarize"}},
            model=generator(respond),
        )
        assert outcome.result["output"] == "reviewed"
        summarizer_requests = [request for request in outcome.requests if is_summarizer_request(request)]
        assert len(summarizer_requests) > 2
        for request in summarizer_requests:
            assert json_bytes(request["messages"]) <= 20_000
            assert "Check this contract:" in request_text(request)
        main = outcome.requests[-1]
        assert "payment in 30 days" in request_text(main)
        assert "CONTRACT END" not in request_text(main)
        started = [
            event
            for event in outcome.events
            if event["type"] == "model.started" and (event.get("data") or {}).get("purpose") == "summarize"
        ]
        assert len(started) == len(summarizer_requests)
        usage = [item["usage"].get("totalTokens") or 0 for item in outcome.result["transcript"] if item.get("usage")]
        assert sum(usage) == 110 * len(summarizer_requests)

    async def test_falls_back_to_pruning_unless_summarize(self) -> None:
        def respond(request: dict) -> dict:
            if is_summarizer_request(request):
                raise Error("summarizer down")
            return assistant("ok")

        outcome = await execute(
            step=BIG_STEP,
            variables=BIG_VARIABLES,
            limits={"maxInputBytes": 20_000},
            policies={"context": {"strategy": "summarize-or-prune"}},
            model=generator(respond),
        )
        assert outcome.result["output"] == "ok"
        assert has_event(outcome.events, code="CONTEXT_SUMMARY_FAILED")
        with pytest.raises(Exception, match='context strategy "summarize"'):
            await execute(
                step=BIG_STEP,
                variables=BIG_VARIABLES,
                limits={"maxInputBytes": 20_000},
                policies={"context": {"strategy": "summarize"}},
                model=generator(respond),
            )

    async def test_fails_when_strategy_is_fail(self) -> None:
        with pytest.raises(Error, match="exceeding the 20000-byte input limit"):
            await execute(
                step=BIG_STEP,
                variables=BIG_VARIABLES,
                limits={"maxInputBytes": 20_000},
                policies={"context": {"strategy": "fail"}},
                model=answer("ok"),
            )


# ─── Tool-loop compaction ───────────────────────────────────────────────────

RESEARCH_STEP = {
    "id": "research",
    "type": "prompt",
    "model": {"provider": "test", "model": "m"},
    "prompt": "Read every file and report.",
    "tools": ["docs__read"],
}


def reader(turns: int = 10) -> Adapter:
    """Reads ``turns`` files, one per model turn, then answers."""
    reads = 0

    def respond(request: dict) -> dict:
        nonlocal reads
        if is_summarizer_request(request):
            return assistant("Read files so far; all contain data.")
        if reads >= turns:
            return assistant("report complete")
        reads += 1
        return assistant(calls=[call("docs__read", {"path": f"file-{reads}.txt"})])

    return generator(respond)


class TestToolLoopCompaction:
    async def test_prunes_older_rounds_keeping_full_transcript(self) -> None:
        executed: list[dict] = []
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(6_000, executed),
            limits={"maxInputBytes": 24_000, "maxToolCallsPerIteration": 30},
            model=reader(),
        )
        assert outcome.result["output"] == "report complete"
        assert len(executed) == 10
        for request in outcome.requests:
            assert json_bytes(request["messages"]) <= 24_000
        assert len(reduced_events(outcome.events)) > 0
        tool_results = [item for item in outcome.result["transcript"] if item.get("role") == "tool"]
        assert len(tool_results) == len(executed)
        assert all("data data" in js_json.stringify(item["content"]) for item in tool_results)

    @pytest.mark.parametrize("strategy", ["prune", "summarize", "summarize-or-prune"])
    async def test_forty_turn_loop_stays_under_limit(self, strategy: str) -> None:
        executed: list[dict] = []
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(5_000, executed),
            limits={"maxInputBytes": 20_000, "maxToolCallsPerIteration": 100},
            policies={"context": {"strategy": strategy}},
            model=reader(40),
        )
        assert outcome.result["output"] == "report complete"
        assert len(executed) == 40
        for request in outcome.requests:
            assert json_bytes(request["messages"]) <= 20_000

    @pytest.mark.parametrize("strategy", ["prune", "summarize-or-prune"])
    async def test_newest_tool_result_always_reaches_model_in_full(self, strategy: str) -> None:
        step = {**RESEARCH_STEP, "prompt": "Context: {{ background }}\nRead every file and report."}
        outcome = await execute(
            step=step,
            variables={"background": "b" * 14_000},
            tools=reader_tools(5_000),
            limits={"maxInputBytes": 30_000, "maxToolCallsPerIteration": 50},
            policies={"context": {"strategy": strategy, "variables": {"background": {"keep": True}}}},
            model=reader(12),
        )
        assert outcome.result["output"] == "report complete"
        for request in outcome.requests:
            if is_summarizer_request(request):
                continue
            assert json_bytes(request["messages"]) <= 30_000
            tool_messages = [message for message in request["messages"] if message["role"] == "tool"]
            if not tool_messages:
                continue
            part = tool_messages[-1]["content"][0]
            assert part["type"] == "tool-result"
            assert re.match(r"^file-\d+\.txt: (data ){900}", part["result"]["output"])

    @pytest.mark.parametrize("strategy", ["prune", "summarize-or-prune"])
    async def test_lower_reduce_to_reduces_less_often_and_deeper(self, strategy: str) -> None:
        async def run(reduce_to: float) -> tuple[int, int]:
            base = reader(30)

            async def generate(request: dict) -> dict:
                if not is_summarizer_request(request):
                    return await base.generate(request)
                match = re.search(r"about (\d+) words", request_text(request))
                words = int(match.group(1)) if match else 100
                return assistant(" ".join(["note"] * words))

            outcome = await execute(
                step=RESEARCH_STEP,
                tools=reader_tools(5_000),
                limits={"maxInputBytes": 40_000, "maxToolCallsPerIteration": 50},
                policies={"context": {"strategy": strategy, "reduceTo": reduce_to}},
                model=Adapter(generate=generate),
            )
            assert outcome.result["output"] == "report complete"
            events = reduced_events(outcome.events)
            compactions = len({event["data"]["bytesBefore"] for event in events})
            return compactions, min(event["data"]["bytesAfter"] for event in events)

        deep = await run(0.25)
        shallow = await run(0.6)
        assert deep[0] < shallow[0]
        assert deep[1] <= 10_000

    async def test_removal_note_lists_removed_calls(self) -> None:
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(5_000),
            limits={"maxInputBytes": 30_000, "maxToolCallsPerIteration": 50},
            policies={"context": {"strategy": "prune"}},
            model=reader(12),
        )
        noted = [text for text in map(request_text, outcome.requests) if "Calls already made" in text]
        assert noted
        assert "docs__read(file-1.txt)" in noted[-1]

    async def test_keeps_fewer_rounds_than_retain_when_needed(self) -> None:
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(5_000),
            limits={"maxInputBytes": 40_000, "maxToolCallsPerIteration": 50},
            policies={"context": {"strategy": "summarize", "reduceTo": 0.25, "retain": {"recentToolRounds": 3}}},
            model=reader(12),
        )
        summaries = [event for event in reduced_events(outcome.events) if event["data"].get("strategy") == "summarize"]
        assert summaries
        for event in summaries:
            assert event["data"]["retainedRounds"] == 1
            assert event["data"]["bytesAfter"] <= 10_000

    async def test_uses_opening_share_and_tool_result_share(self) -> None:
        step = {**RESEARCH_STEP, "prompt": "Context: {{ background }}\nRead every file and report."}
        outcome = await execute(
            step=step,
            variables={"background": "b" * 30_000},
            tools=reader_tools(20_000),
            limits={"maxInputBytes": 50_000, "maxToolCallsPerIteration": 50},
            policies={"context": {"openingShare": 0.2, "toolResultShare": 0.1}},
            model=reader(1),
        )
        assert json_bytes(outcome.requests[0]["messages"]) <= 10_000
        capped = next(event for event in reduced_events(outcome.events) if event["data"].get("scope") == "tool-result")
        assert capped["data"]["bytesAfter"] <= 5_000

    async def test_summarizes_then_resumes_without_summarizing_again(self) -> None:
        harness = Harness()
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(6_000),
            limits={"maxInputBytes": 24_000, "maxToolCallsPerIteration": 30},
            policies={"context": {"strategy": "summarize"}},
            model=reader(),
            harness=harness,
        )
        assert outcome.result["output"] == "report complete"
        summaries = [
            item for item in outcome.result["transcript"] if (context_marker(item) or {}).get("kind") == "summary"
        ]
        assert summaries
        main = [request for request in harness.requests if not is_summarizer_request(request)]
        assert "Summary of earlier work" in request_text(main[-1])
        after = next(
            checkpoint
            for checkpoint in harness.checkpoints
            if checkpoint["continuation"].get("phase") == "ready"
            and any((context_marker(item) or {}).get("kind") == "summary" for item in checkpoint["transcript"])
        )
        resumed = Harness()
        await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(6_000),
            limits={"maxInputBytes": 24_000, "maxToolCallsPerIteration": 30},
            policies={"context": {"strategy": "summarize"}},
            model=reader(),
            resume=after,
            harness=resumed,
        )
        first = resumed.requests[0]
        assert not is_summarizer_request(first)
        assert "Summary of earlier work" in request_text(first)
        assert len(compacted_view(after["transcript"])) > 0

    async def test_compacts_on_tool_round_trigger(self) -> None:
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(100),
            policies={
                "context": {"strategy": "summarize", "trigger": {"toolRounds": 3}, "retain": {"recentToolRounds": 1}}
            },
            model=reader(6),
        )
        assert outcome.result["output"] == "report complete"
        assert has_event(reduced_events(outcome.events), reason="tool-rounds", strategy="summarize")

    async def test_caps_single_oversized_tool_result(self) -> None:
        outcome = await execute(
            step=RESEARCH_STEP, tools=reader_tools(200_000), limits={"maxInputBytes": 50_000}, model=reader(1)
        )
        assert outcome.result["output"] == "report complete"
        assert json_bytes(outcome.requests[-1]["messages"]) <= 50_000
        assert has_event(reduced_events(outcome.events), scope="tool-result")

    async def test_uses_described_input_window_as_trigger(self) -> None:
        base = reader()
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(6_000),
            model=Adapter(generate=base.generate, describe_model=lambda _model: {"maxInputTokens": 8_000}),
        )
        assert outcome.result["output"] == "report complete"
        for request in outcome.requests:
            assert json_bytes(request["messages"]) <= 25_600 + 8_000
        assert any(context_marker(item) is not None for item in outcome.result["transcript"])

    async def test_recovers_from_provider_context_overflow(self) -> None:
        base = reader()
        overflowed = 0

        async def generate(request: dict) -> dict:
            nonlocal overflowed
            if json_bytes(request["messages"]) > 30_000:
                overflowed += 1
                error = Error(
                    "This model's maximum context length is 8192 tokens. Please reduce the length of the messages."
                )
                error.statusCode = 400  # type: ignore[attr-defined]
                raise error
            return await base.generate(request)

        outcome = await execute(step=RESEARCH_STEP, tools=reader_tools(6_000), model=Adapter(generate=generate))
        assert outcome.result["output"] == "report complete"
        assert overflowed > 0
        assert any(
            event["type"] == "model.retry" and event["data"]["reason"] == "context-overflow" for event in outcome.events
        )


# ─── Model and output recovery ──────────────────────────────────────────────

SIMPLE_STEP = {"id": "answer", "type": "prompt", "model": {"provider": "test", "model": "m"}, "prompt": "Answer."}


def status_error(message: str, status: int) -> Error:
    error = Error(message)
    error.statusCode = status  # type: ignore[attr-defined]
    return error


class TestModelAndOutputRecovery:
    async def test_retries_retryable_errors(self) -> None:
        attempts = 0

        def respond(_: dict) -> dict:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise status_error("rate limited", 429)
            return assistant("ok")

        outcome = await execute(step=SIMPLE_STEP, model=generator(respond))
        assert outcome.result["output"] == "ok"
        assert len([event for event in outcome.events if event["type"] == "model.retry"]) == 2

    async def test_does_not_retry_non_retryable(self) -> None:
        attempts = 0

        def respond(_: dict) -> dict:
            nonlocal attempts
            attempts += 1
            raise status_error("bad key", 401)

        with pytest.raises(Error, match="bad key"):
            await execute(step=SIMPLE_STEP, model=generator(respond))
        assert attempts == 1

    async def test_repairs_invalid_structured_output_once(self) -> None:
        attempts = 0

        def respond(_: dict) -> dict:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                error = Error("No object generated: bad JSON")
                error.name = "AI_NoObjectGeneratedError"
                raise error
            return {**assistant("{}"), "output": {"ok": True}}

        outcome = await execute(step={**SIMPLE_STEP, "outputSchema": {"type": "object"}}, model=generator(respond))
        assert outcome.result["output"] == {"ok": True}
        assert "could not be used" in request_text(outcome.requests[1])

    async def test_reasks_for_empty_required_answer(self) -> None:
        attempts = 0

        def respond(_: dict) -> dict:
            nonlocal attempts
            attempts += 1
            return assistant("" if attempts == 1 else "now")

        outcome = await execute(
            step={**SIMPLE_STEP, "completionPolicy": {"requireOutput": True}}, model=generator(respond)
        )
        assert outcome.result["output"] == "now"

    async def test_retries_truncated_answer_with_larger_budget(self) -> None:
        budgets: list[Any] = []

        def respond(request: dict) -> dict:
            budgets.append(request.get("maxOutputTokens"))
            if len(budgets) == 1:
                return {**assistant("partial"), "finishReason": "length"}
            return assistant("complete")

        outcome = await execute(step={**SIMPLE_STEP, "maxOutputTokens": 100}, model=generator(respond))
        assert outcome.result["output"] == "complete"
        assert budgets == [100, 200]
        assert "partial" in js_json.stringify(outcome.result["transcript"])

    async def test_estimates_usage_for_budgeted_provider_without_usage(self) -> None:
        class Budget:
            max_total_tokens = 1_000_000
            consumed_tokens = 0

            def consume(self, usage: dict) -> dict:
                self.consumed_tokens += usage.get("totalTokens") or 0
                return {"maxTotalTokens": 1_000_000, "consumedTokens": self.consumed_tokens}

        budget = Budget()
        outcome = await execute(step=SIMPLE_STEP, token_budget=budget, model=answer("ok"))
        assert outcome.result["output"] == "ok"
        assert budget.consumed_tokens > 0
        assert has_event(outcome.events, code="USAGE_ESTIMATED")


# ─── Tool-call safeguards ───────────────────────────────────────────────────

TOOL_STEP = {
    "id": "tools",
    "type": "prompt",
    "model": {"provider": "test", "model": "m"},
    "prompt": "Use tools.",
    "tools": ["docs__read"],
}


class TestToolCallSafeguards:
    async def test_never_runs_invalid_or_out_of_scope_calls(self) -> None:
        executed: list[dict] = []
        turn = 0
        invalid = {**call("docs__read"), "metadata": {"agentRuntime": {"invalid": True, "error": "bad input"}}}
        out_of_scope = call("docs__write", {"path": "x"})

        def respond(_: dict) -> dict:
            nonlocal turn
            turn += 1
            if turn > 1:
                return assistant("done")
            response = assistant(calls=[invalid, out_of_scope])
            response["transcript"].append(
                {
                    "id": next_id(),
                    "type": "tool-result",
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool-result",
                            "result": {
                                "callId": invalid["id"],
                                "name": invalid["name"],
                                "error": {"code": "tool_error", "message": "bad input"},
                            },
                        }
                    ],
                    "createdAt": AT,
                }
            )
            return response

        outcome = await execute(step=TOOL_STEP, tools=reader_tools(10, executed), model=generator(respond))
        assert outcome.result["output"] == "done"
        assert executed == []
        results = [
            part["result"]
            for item in outcome.result["transcript"]
            for part in item["content"]
            if part["type"] == "tool-result"
        ]
        assert len([entry for entry in results if entry["callId"] == invalid["id"]]) == 1
        rejected = next(entry for entry in results if entry["callId"] == out_of_scope["id"])
        assert rejected["error"]["code"] == "tool_not_allowed"

    async def test_asks_for_final_answer_at_tool_call_limit(self) -> None:
        def respond(request: dict) -> dict:
            if request.get("toolChoice") == "none":
                return assistant("final from gathered data")
            return assistant(calls=[call("docs__read")])

        outcome = await execute(
            step=TOOL_STEP, tools=reader_tools(10), limits={"maxToolCallsPerIteration": 2}, model=generator(respond)
        )
        assert outcome.result["output"] == "final from gathered data"
        assert outcome.requests[-1]["toolChoice"] == "none"
        assert "limit of 2 tool calls" in request_text(outcome.requests[-1])
        assert has_event(outcome.events, code="TOOL_CALL_LIMIT_REACHED")

    async def test_runs_without_unavailable_optional_tools(self) -> None:
        def reason(name: str) -> str | None:
            return 'Connection "tickets" is unavailable: connect ECONNREFUSED' if name == "tickets__create" else None

        outcome = await execute(
            step={**TOOL_STEP, "tools": ["docs__read", "tickets__create"]},
            tools=reader_tools(10, unavailable_tool_reason=reason),
            model=answer("answered"),
        )
        assert outcome.result["output"] == "answered"
        assert [tool["name"] for tool in outcome.requests[0]["tools"]] == ["docs__read"]
        assert "tickets__create" in request_text(outcome.requests[0])
        assert "ECONNREFUSED" in request_text(outcome.requests[0])
        assert has_event(outcome.events, code="TOOLS_UNAVAILABLE", tools=["tickets__create"])


async def test_opening_prompt_reductions_are_reused_on_resume() -> None:
    step = {
        "id": "tooling",
        "type": "prompt",
        "model": {"provider": "test", "model": "m"},
        "prompt": "Use {{ doc }}",
        "tools": ["docs__read"],
    }
    variables = {"doc": "d" * 100_000}
    summarizer_calls = 0

    def respond(request: dict) -> dict:
        nonlocal summarizer_calls
        if is_summarizer_request(request):
            summarizer_calls += 1
            return assistant("doc summary")
        return assistant("ok")

    model = generator(respond)
    first = await execute(
        step=step,
        variables=variables,
        tools=reader_tools(10),
        limits={"maxInputBytes": 30_000},
        policies={"context": {"strategy": "summarize"}},
        model=model,
    )
    calls_after_first = summarizer_calls
    assert calls_after_first > 0
    marker = next(item for item in first.result["transcript"] if (context_marker(item) or {}).get("kind") == "input")
    assert "role" not in marker
    ready = next(
        checkpoint
        for checkpoint in first.checkpoints
        if checkpoint["continuation"].get("phase") == "ready"
        and any((context_marker(item) or {}).get("kind") == "input" for item in checkpoint["transcript"])
    )
    resumed = await execute(
        step=step,
        variables=variables,
        tools=reader_tools(10),
        limits={"maxInputBytes": 30_000},
        policies={"context": {"strategy": "summarize"}},
        model=model,
        resume=ready,
    )
    assert summarizer_calls == calls_after_first
    assert "doc summary" in request_text(resumed.requests[0])


# ─── Summarizer control ─────────────────────────────────────────────────────


def material(request: dict) -> str:
    match = re.search(r"<material>\n([\s\S]*?)\n</material>", request_text(request))
    return match.group(1) if match else ""


def words_asked(request: dict) -> int:
    match = re.search(r"about (\d+) words", request_text(request))
    return int(match.group(1)) if match else 0


def summarizing_model(turns: int) -> Adapter:
    reads = 0

    def respond(request: dict) -> dict:
        nonlocal reads
        if is_summarizer_request(request):
            return assistant(" ".join(["note"] * max(1, words_asked(request))))
        if reads >= turns:
            return assistant("report complete")
        reads += 1
        return assistant(calls=[call("docs__read", {"path": f"file-{reads}.txt"})])

    return generator(respond)


class TestSummarizerControl:
    async def test_bounds_transcript_summaries(self) -> None:
        async def run(summarizer: dict) -> list[int]:
            outcome = await execute(
                step=RESEARCH_STEP,
                tools=reader_tools(5_000),
                limits={"maxInputBytes": 60_000, "maxToolCallsPerIteration": 50},
                policies={"context": {"strategy": "summarize", "reduceTo": 0.5, "summarizer": summarizer}},
                model=summarizing_model(14),
            )
            return [event["data"].get("summaryTargetBytes") for event in reduced_events(outcome.events)]

        capped = await run({"maxSummaryBytes": 1_200})
        assert capped
        assert all(target <= 1_200 for target in capped)
        generous = await run({"summaryShare": 0.5, "maxSummaryBytes": 50_000})
        assert max(generous) > max(capped)

    async def test_splits_by_chunk_bytes_and_honors_per_kind_prompts(self) -> None:
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(5_000),
            limits={"maxInputBytes": 40_000, "maxToolCallsPerIteration": 50},
            policies={
                "context": {
                    "strategy": "summarize",
                    "summarizer": {
                        "chunkBytes": 8_000,
                        "prompts": {
                            "transcript": "TRANSCRIPT NOTES for {{ context.label }}, {{ context.targetWords }} words."
                        },
                    },
                }
            },
            model=summarizing_model(12),
        )
        requests = [request for request in outcome.requests if is_summarizer_request(request)]
        assert len(requests) > 2
        for request in requests:
            assert json_bytes(material(request)) - 2 <= 8_000
            assert "TRANSCRIPT NOTES for" in request_text(request)
        compaction = next(
            event for event in reduced_events(outcome.events) if event["data"].get("strategy") == "summarize"
        )
        assert compaction["data"]["summarizerCalls"] > 1

    async def test_stops_at_max_calls(self) -> None:
        limited = {"strategy": "summarize-or-prune", "summarizer": {"maxCalls": 1, "chunkBytes": 4_000}}
        outcome = await execute(
            step=RESEARCH_STEP,
            tools=reader_tools(5_000),
            limits={"maxInputBytes": 40_000, "maxToolCallsPerIteration": 50},
            policies={"context": limited},
            model=summarizing_model(12),
        )
        assert outcome.result["output"] == "report complete"
        started = [
            event
            for event in outcome.events
            if event["type"] == "model.started" and (event.get("data") or {}).get("purpose") == "summarize"
        ]
        assert len(started) == 1
        assert has_event(outcome.events, code="CONTEXT_SUMMARY_FAILED")
        with pytest.raises(Exception, match="summarizer calls"):
            await execute(
                step=RESEARCH_STEP,
                tools=reader_tools(5_000),
                limits={"maxInputBytes": 40_000, "maxToolCallsPerIteration": 50},
                policies={"context": {**limited, "strategy": "summarize"}},
                model=summarizing_model(12),
            )

    async def test_host_summarizer_observes_changes_or_replaces(self) -> None:
        seen: list[dict] = []

        async def wrap(request: dict, next_: Any) -> dict:
            seen.append(copy.deepcopy({**{k: v for k, v in request.items() if k != "signal"}, "text": ""}))
            return await next_(
                {
                    **request,
                    "targetBytes": request["targetBytes"] // 2,
                    "settings": {**request["settings"], "prompt": "HOST PROMPT {{ context.kind }}"},
                }
            )

        step = {**RESEARCH_STEP, "prompt": "Use {{ doc }}. Read every file and report."}
        harness = Harness()
        await execute(
            step=step,
            variables={"doc": "d" * 40_000},
            tools=reader_tools(5_000),
            limits={"maxInputBytes": 40_000, "maxToolCallsPerIteration": 50},
            policies={"context": {"strategy": "summarize", "summarizer": {"maxSummaryBytes": 3_000}}},
            summarizer=Adapter(summarize=wrap),
            model=summarizing_model(8),
            harness=harness,
        )
        kinds = [request["kind"] for request in seen]
        assert "input" in kinds and "transcript" in kinds
        assert seen[0]["stepId"] == "research"
        assert seen[0]["label"] == "the variable doc"
        assert seen[0]["settings"]["maxSummaryBytes"] == 3_000
        requests = [request for request in harness.requests if is_summarizer_request(request)]
        assert requests
        for request in requests:
            assert "HOST PROMPT" in request_text(request)

        model_summaries = 0

        async def replace(request: dict, _next: Any) -> dict:
            return {
                "text": f"host summary of {request['label']}",
                "usage": {"inputTokens": 7, "outputTokens": 3, "totalTokens": 10},
            }

        inner = summarizing_model(8)

        async def generate(request: dict) -> dict:
            nonlocal model_summaries
            if is_summarizer_request(request):
                model_summaries += 1
            return await inner.generate(request)

        replaced = await execute(
            step=step,
            variables={"doc": "d" * 40_000},
            tools=reader_tools(5_000),
            limits={"maxInputBytes": 40_000, "maxToolCallsPerIteration": 50},
            policies={"context": {"strategy": "summarize"}},
            summarizer=Adapter(summarize=replace),
            model=Adapter(generate=generate),
        )
        assert model_summaries == 0
        assert "host summary of the variable doc" in request_text(replaced.requests[0])
        assert any(
            event["type"] == "model.usage" and event["data"].get("source") == "host" for event in replaced.events
        )

    async def test_uses_overflow_retries(self) -> None:
        calls = 0

        def respond(_: dict) -> dict:
            nonlocal calls
            calls += 1
            raise status_error("prompt is too long: 9000 tokens", 400)

        step = {key: value for key, value in RESEARCH_STEP.items() if key != "tools"}
        with pytest.raises(Error, match="prompt is too long"):
            await execute(step=step, policies={"context": {"overflowRetries": 0}}, model=generator(respond))
        assert calls == 1
