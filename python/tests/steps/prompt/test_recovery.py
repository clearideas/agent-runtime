"""Port of ``packages/step-prompt/src/recovery.test.ts``."""

from __future__ import annotations

import itertools

import pytest

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime._js.abort import AbortController
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core import AgentRuntime, RunSuspendedError
from clearideas_agent_runtime.core.testing import MemoryRunStore
from clearideas_agent_runtime.steps.prompt import PromptStepExecutor
from clearideas_agent_runtime.steps.prompt.context.measure import json_bytes
from clearideas_agent_runtime.steps.prompt.context.summarize import DEFAULT_SUMMARIZER_SYSTEM_PROMPT
from clearideas_agent_runtime.steps.prompt.context.transcript import compacted_view, context_marker

from .support import Adapter, model

AT = "2026-11-08T00:00:00.000Z"
_sequence = itertools.count(1)


def reply(text: str | None, calls: list[dict] | None = None, tokens: int = 10) -> dict:
    calls = calls or []
    content = ([{"type": "text", "text": text}] if text else []) + [
        {"type": "tool-call", "call": call} for call in calls
    ]
    result: dict = {} if text is None else {"output": text}
    result.update(
        {
            "toolCalls": calls,
            "finishReason": "tool-calls" if calls else "stop",
            "transcript": [
                {
                    "id": f"reply-{next(_sequence)}",
                    "type": "message",
                    "role": "assistant",
                    "createdAt": AT,
                    "content": content,
                    "usage": {"inputTokens": tokens, "outputTokens": 0, "totalTokens": tokens},
                }
            ],
        }
    )
    return result


def is_summary(request: dict) -> bool:
    return any(
        message["role"] == "system"
        and any(
            part["type"] == "text" and part["text"] == DEFAULT_SUMMARIZER_SYSTEM_PROMPT for part in message["content"]
        )
        for message in request["messages"]
    )


MODEL_REFERENCE = {"provider": "test", "model": "m"}
TOOL = {"name": "write", "inputSchema": {"type": "object"}}


def write_tools(execute) -> Adapter:
    async def list_tools() -> list[dict]:
        return [TOOL]

    return Adapter(list_tools=list_tools, execute_tool=execute)


async def test_commits_tool_before_paused_reduction() -> None:
    run_store = MemoryRunStore()
    executed: list[str] = []
    counters = {"summaries": 0, "main": 0}

    async def execute_tool(call: dict, _context: object) -> dict:
        executed.append(call["id"])
        return {"callId": call["id"], "name": call["name"], "output": "x" * 10000}

    async def summarize(_request: dict, _next: object) -> dict:
        counters["summaries"] += 1
        if counters["summaries"] == 1:
            raise RunSuspendedError("paused")
        if counters["summaries"] == 2:
            assert executed == ["one"]
        return {"text": "reduced output"}

    async def generate(request: dict) -> dict:
        counters["main"] += 1
        if counters["main"] == 1:
            return reply(None, [{"id": id_, "name": "write", "input": {}} for id_ in ("one", "two")])
        assert "x" * 1000 not in js_json.stringify(request["messages"])
        return reply("done")

    def runtime() -> AgentRuntime:
        return AgentRuntime(
            run_store=run_store,
            model=model(generate),
            tools=write_tools(execute_tool),
            summarizer=Adapter(summarize=summarize),
            step_executors=[PromptStepExecutor()],
        )

    manifest = {
        "schemaVersion": "1.0",
        "model": MODEL_REFERENCE,
        "policies": {"context": {"strategy": "summarize", "maxToolResultBytes": 1000}},
        "steps": [{"id": "s", "type": "prompt", "prompt": "Write once", "tools": ["write"]}],
    }
    with pytest.raises(RunSuspendedError):
        await runtime().run({"runId": "pause", "manifest": manifest})
    checkpoint = await run_store.load_latest_checkpoint("pause")
    assert checkpoint["continuation"]["phase"] == "model-completed"
    assert checkpoint["continuation"]["nextToolIndex"] == 1
    assert checkpoint["continuation"]["toolCallCount"] == 1
    assert len([item for item in checkpoint["activeStepTranscript"] if item.get("role") == "tool"]) == 1
    result = await runtime().run({"runId": "pause", "resume": True})
    assert result["output"] == "done"
    assert executed == ["one", "two"]
    assert len([item for item in result["transcript"] if item.get("role") == "tool"]) == 2
    assert "x" * 10000 in js_json.stringify(result["transcript"])


@pytest.mark.parametrize(
    ("wrap", "multiple", "passes"),
    [(False, False, False), (True, False, False), (False, True, False), (False, False, True)],
)
async def test_retains_chunk_usage_and_reuses_completed_work(wrap: bool, multiple: bool, passes: bool) -> None:
    run_store = MemoryRunStore()
    dispatched: list[str] = []
    counters = {"main": 0}

    async def generate(request: dict) -> dict:
        if not is_summary(request):
            counters["main"] += 1
            return reply("done")
        dispatched.append(js_json.stringify(request["messages"]))
        return reply("p" * 800 if passes and len(dispatched) <= 3 else "summary", [], 100)

    async def passthrough(request: dict, next_: object) -> dict:
        return await next_(request)  # type: ignore[operator]

    def runtime() -> AgentRuntime:
        return AgentRuntime(
            run_store=run_store,
            model=model(generate),
            step_executors=[PromptStepExecutor()],
            summarizer=Adapter(summarize=passthrough) if wrap else None,
        )

    variables = [{"key": "doc", "type": "string", "value": "x" * (2500 if passes else 10000)}]
    if multiple:
        variables.append({"key": "other", "type": "string", "value": "y" * 3000})
    manifest = {
        "schemaVersion": "1.0",
        "model": MODEL_REFERENCE,
        "variables": variables,
        "policies": {
            "context": {
                "strategy": "summarize",
                "summarizer": {"chunkBytes": 1024},
                "variables": {"doc": {"maxBytes": 500}, "other": {"maxBytes": 500}},
            }
        },
        "steps": [{"id": "s", "type": "prompt", "prompt": "{{ doc }} {{ other }}" if multiple else "{{ doc }}"}],
    }
    with pytest.raises(RunSuspendedError) as raised:
        await runtime().run(
            {
                "runId": "chunks",
                "manifest": manifest,
                "budget": {"maxTotalTokens": 1050 if multiple else 350 if passes else 150},
                "signal": AbortController().signal,
            }
        )
    assert raised.value.reason == "token-budget"
    checkpoint = await run_store.load_latest_checkpoint("chunks")
    completed = 11 if multiple else 4 if passes else 2
    assert checkpoint["budget"]["consumedTokens"] == completed * 100
    assert len(dispatched) == completed
    with pytest.raises(RunSuspendedError):
        await runtime().run({"runId": "chunks", "resume": True})
    assert len(dispatched) == completed
    result = await runtime().run({"runId": "chunks", "resume": True, "budget": {"maxTotalTokens": 10000}})
    assert result["output"] == "done"
    assert len(set(dispatched)) == len(dispatched)
    assert counters["main"] == 1
    total = sum((item.get("usage") or {}).get("totalTokens") or 0 for item in result["transcript"])
    assert total == len(dispatched) * 100 + 10
    assert (await run_store.load_latest_checkpoint("chunks"))["budget"]["consumedTokens"] == total
    assert all((context_marker(item) or {}).get("kind") != "usage" for item in compacted_view(result["transcript"]))


@pytest.mark.parametrize("mode", ["trigger", "overflow", "host"])
async def test_stops_main_dispatch_when_compaction_exhausts_budget(mode: str) -> None:
    run_store = MemoryRunStore()
    counters = {"main": 0, "summaries": 0}

    async def generate(request: dict) -> dict:
        if is_summary(request):
            counters["summaries"] += 1
            return reply("Earlier work completed", [], 200)
        counters["main"] += 1
        if counters["main"] == 1:
            return reply(None, [{"id": "write", "name": "write", "input": {}}])
        if mode == "overflow" and counters["main"] == 2:
            error = Error("context window exceeded")
            error.code = "MODEL_CONTEXT_OVERFLOW"  # type: ignore[attr-defined]
            raise error
        return reply("done")

    async def execute_tool(call: dict, _context: object) -> dict:
        return {"callId": call["id"], "name": call["name"], "output": "x" * 4000}

    async def host_summarize(_request: dict, _next: object) -> dict:
        counters["summaries"] += 1
        return {"text": "Earlier work completed", "usage": {"totalTokens": 200}}

    def runtime() -> AgentRuntime:
        return AgentRuntime(
            run_store=run_store,
            model=model(generate),
            tools=write_tools(execute_tool),
            step_executors=[PromptStepExecutor()],
            summarizer=Adapter(summarize=host_summarize) if mode == "host" else None,
        )

    context_policy: dict = {"strategy": "summarize", "retain": {"recentToolRounds": 0}}
    if mode != "overflow":
        context_policy["trigger"] = {"toolRounds": 1}
    manifest = {
        "schemaVersion": "1.0",
        "model": MODEL_REFERENCE,
        "policies": {"context": context_policy},
        "steps": [{"id": "s", "type": "prompt", "prompt": "Write then report", "tools": ["write"]}],
    }
    with pytest.raises(RunSuspendedError) as raised:
        await runtime().run({"runId": "budget", "manifest": manifest, "budget": {"maxTotalTokens": 150}})
    assert raised.value.reason == "token-budget"
    assert counters["main"] == (2 if mode == "overflow" else 1)
    assert counters["summaries"] == 1
    assert (await run_store.load_latest_checkpoint("budget"))["budget"]["consumedTokens"] == 210
    result = await runtime().run({"runId": "budget", "resume": True, "budget": {"maxTotalTokens": 1000}})
    assert result["output"] == "done"
    assert counters["summaries"] == 1


@pytest.mark.parametrize(("material", "limit"), [("x", 2000), ('😀"\\\n', 2000), ("x", 850)])
async def test_fits_complete_summarizer_requests_within_limit(material: str, limit: int) -> None:
    sizes: list[int] = []

    async def generate(request: dict) -> dict:
        sizes.append(json_bytes(request["messages"]))
        return reply("summary" if is_summary(request) else "done")

    runtime = AgentRuntime(run_store=MemoryRunStore(), model=model(generate), step_executors=[PromptStepExecutor()])
    manifest = {
        "schemaVersion": "1.0",
        "model": MODEL_REFERENCE,
        "limits": {"maxInputBytes": limit},
        "variables": [{"key": "doc", "type": "string", "value": material * 10000}],
        "policies": {"context": {"strategy": "summarize", "variables": {"doc": {"maxBytes": 500}}}},
        "steps": [{"id": "s", "type": "prompt", "prompt": "{{ doc }}"}],
    }
    assert (await runtime.run({"manifest": manifest}))["output"] == "done"
    assert len(sizes) > 1
    assert max(sizes) <= limit


@pytest.mark.parametrize("strategy", ["summarize", "summarize-or-prune"])
async def test_handles_fixed_prompts_larger_than_input_limit(strategy: str) -> None:
    dispatched = 0

    async def generate(request: dict) -> dict:
        nonlocal dispatched
        dispatched += 1
        assert json_bytes(request["messages"]) <= 2000
        return reply("done")

    runtime = AgentRuntime(run_store=MemoryRunStore(), step_executors=[PromptStepExecutor()], model=model(generate))
    manifest = {
        "schemaVersion": "1.0",
        "model": MODEL_REFERENCE,
        "limits": {"maxInputBytes": 2000},
        "variables": [{"key": "doc", "type": "string", "value": "x" * 10000}],
        "policies": {
            "context": {
                "strategy": strategy,
                "summarizer": {"systemPrompt": "instructions" * 300},
                "variables": {"doc": {"maxBytes": 500}},
            }
        },
        "steps": [{"id": "s", "type": "prompt", "prompt": "{{ doc }}"}],
    }
    if strategy == "summarize":
        with pytest.raises(Exception, match="fixed prompts exceed"):
            await runtime.run({"manifest": manifest})
        assert dispatched == 0
    else:
        assert (await runtime.run({"manifest": manifest}))["output"] == "done"
        assert dispatched == 1


async def test_retains_summarizer_call_limit_across_resume() -> None:
    run_store = MemoryRunStore()
    summaries = 0

    async def generate(_: dict) -> dict:
        nonlocal summaries
        summaries += 1
        return reply("summary", [], 100)

    def runtime() -> AgentRuntime:
        return AgentRuntime(run_store=run_store, step_executors=[PromptStepExecutor()], model=model(generate))

    manifest = {
        "schemaVersion": "1.0",
        "model": MODEL_REFERENCE,
        "variables": [{"key": "doc", "type": "string", "value": "x" * 10000}],
        "policies": {
            "context": {
                "strategy": "summarize",
                "summarizer": {"chunkBytes": 1024, "maxCalls": 3},
                "variables": {"doc": {"maxBytes": 500}},
            }
        },
        "steps": [{"id": "s", "type": "prompt", "prompt": "{{ doc }}"}],
    }
    with pytest.raises(RunSuspendedError):
        await runtime().run({"runId": "calls", "manifest": manifest, "budget": {"maxTotalTokens": 150}})
    assert summaries == 2
    with pytest.raises(Exception, match="summarizer calls"):
        await runtime().run({"runId": "calls", "resume": True, "budget": {"maxTotalTokens": 10000}})
    assert summaries == 3
    assert (await run_store.load_latest_checkpoint("calls"))["budget"]["consumedTokens"] == 300
    with pytest.raises(Exception, match="summarizer calls"):
        await runtime().run({"runId": "calls", "resume": True})
    assert summaries == 3
