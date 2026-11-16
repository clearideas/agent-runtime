"""Port of packages/step-loop/src/index.test.ts."""

from __future__ import annotations

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime._js.json import stringify
from clearideas_agent_runtime.conditions import JexlConditionEvaluator
from clearideas_agent_runtime.core import AgentRuntime, RunSuspendedError
from clearideas_agent_runtime.core.testing import MemoryRunStore, SequenceIdGenerator
from clearideas_agent_runtime.steps.loop import LoopStepExecutor

from ..core.helpers import executor


def prompt(step_id, output_variable):
    return {"id": step_id, "type": "prompt", "prompt": step_id, "outputVariable": output_variable}


def variable_type(value):
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    return "string"


def manifest(loop, variables):
    return {
        "schemaVersion": "1.0",
        "variables": [{"key": key, "type": variable_type(value), "value": value} for key, value in variables.items()],
        "steps": [loop],
    }


def create_runner(store, child):
    return AgentRuntime(
        run_store=store,
        step_executors=[LoopStepExecutor(), child],
        condition_evaluator=JexlConditionEvaluator(),
        id_generator=SequenceIdGenerator(),
    )


async def test_iterates_over_the_history_and_never_stores_the_messages_view():
    store = MemoryRunStore()
    seen = []

    def child(context):
        seen.append({"item": context.variables.get("turn"), "count": context.variables["messages"]["count"]})
        return {"output": "ok", "statePatch": {"set": {"last": "ok"}}}

    chat = {
        "schemaVersion": "1.0",
        "messages": {},
        "steps": [
            {
                "id": "turns",
                "type": "loop",
                "history": {"last": 2},
                "loop": {
                    "source": "messages.all",
                    "itemVariable": "turn",
                    "condition": 'turn.role == "user" && messages.count == 2',
                },
                "steps": [{"id": "inspect", "type": "prompt", "prompt": "x", "history": "all"}],
            }
        ],
    }
    result = await create_runner(store, executor("prompt", child)).run(
        manifest=chat,
        run_id="loop-messages",
        messages=[
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "three"},
        ],
    )
    assert seen == [
        {"item": {"role": "user", "content": [{"type": "text", "text": "three"}], "turn": 2, "position": 3}, "count": 3}
    ]
    assert '"count"' not in stringify(result["state"])
    for checkpoint in store.checkpoints["loop-messages"]:
        assert '"lastUser"' not in stringify(checkpoint["state"])


async def test_filters_collection_items_while_retaining_source_indices():
    visited = []

    def child(context):
        candidate = context.variables["candidate"]
        index = str(context.variables["candidateIndex"])
        visited.append({"name": candidate["name"], "index": index})
        output = f"{index}:{candidate['name']}"
        return {"output": output, "statePatch": {"set": {"candidateResult": output}}}

    loop = {
        "id": "candidates-loop",
        "type": "loop",
        "outputVariable": "processed",
        "loop": {
            "source": "candidates",
            "itemVariable": "candidate",
            "indexVariable": "candidateIndex",
            "condition": "candidate.enabled == true",
            "outputMode": "array",
        },
        "steps": [prompt("process", "candidateResult")],
    }
    result = await create_runner(MemoryRunStore(), executor("prompt", child)).run(
        run_id="collection-loop",
        manifest=manifest(
            loop,
            {
                "candidates": [
                    {"name": "alpha", "enabled": True},
                    {"name": "beta", "enabled": False},
                    {"name": "gamma", "enabled": True},
                ]
            },
        ),
    )
    assert visited == [{"name": "alpha", "index": "0"}, {"name": "gamma", "index": "2"}]
    assert result["output"] == ["0:alpha", "2:gamma"]
    assert result["variables"]["processed"] == ["0:alpha", "2:gamma"]


async def test_carries_previous_iteration_state_and_stops_when_a_goal_is_met():
    loop = {
        "id": "goal-loop",
        "type": "loop",
        "outputVariable": "acceptedScore",
        "loop": {
            "maxIterations": 5,
            "goal": "{{review.score}} >= {{targetScore}}",
            "resultVariable": "review.score",
            "outputMode": "final",
        },
        "steps": [prompt("draft", "draft"), prompt("review", "review")],
    }
    previous_scores = []

    def child(context):
        memory = context.variables["loop"]
        if context.step["id"] == "draft":
            previous_scores.append(
                (((memory.get("previous") or {}).get("variables") or {}).get("review") or {}).get("score")
            )
            output = f"draft-{memory['iteration']}"
            return {"output": output, "statePatch": {"set": {"draft": output}}}
        output = {"score": memory["iteration"], "draft": str(context.variables["draft"])}
        return {"output": output, "statePatch": {"set": {"review": output}}}

    result = await create_runner(MemoryRunStore(), executor("prompt", child)).run(
        run_id="goal-loop", manifest=manifest(loop, {"targetScore": "3"})
    )
    assert previous_scores == [None, 1, 2]
    assert result["output"] == 3
    assert result["variables"]["acceptedScore"] == 3
    assert result["variables"]["review"] == {"score": 3, "draft": "draft-3"}
    assert {key: result["variables"]["loop"][key] for key in ("outputs", "goalMet", "goalMetAtIteration")} == {
        "outputs": [1, 2, 3],
        "goalMet": True,
        "goalMetAtIteration": 3,
    }


async def test_replaces_a_result_variable_with_each_final_child_output_when_no_child_writes_it():
    loop = {
        "id": "accumulator-loop",
        "type": "loop",
        "loop": {"maxIterations": 10, "goal": "{{number}} > 5", "resultVariable": "result", "outputMode": "final"},
        "steps": [prompt("increment", "number")],
    }

    def child(context):
        output = int(context.variables.get("result") or 0) + 1
        return {"output": output, "statePatch": {"set": {"number": output}}}

    result = await create_runner(MemoryRunStore(), executor("prompt", child)).run(
        run_id="accumulator-loop", manifest=manifest(loop, {})
    )
    assert result["output"] == 6
    assert result["variables"]["number"] == 6
    assert result["variables"]["result"] == 6
    assert {key: result["variables"]["loop"][key] for key in ("outputs", "goalMet", "goalMetAtIteration")} == {
        "outputs": [1, 2, 3, 4, 5, 6],
        "goalMet": True,
        "goalMetAtIteration": 6,
    }


async def test_resumes_at_the_next_child_without_replaying_the_committed_child():
    loop = {
        "id": "resume-loop",
        "type": "loop",
        "outputVariable": "processed",
        "loop": {"source": "items", "itemVariable": "item", "indexVariable": "itemIndex", "outputMode": "array"},
        "steps": [prompt("draft", "draft"), prompt("finalize", "finalItem")],
    }
    calls = []
    fail_finalize = True

    def child(context):
        nonlocal fail_finalize
        calls.append(context.step["id"])
        item = context.variables["item"]
        if context.step["id"] == "draft":
            output = f"{item['name']}-draft"
            return {
                "output": output,
                "statePatch": {"set": {"draft": output}},
                "transcript": [
                    {
                        "id": "draft-message",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": output}],
                        "createdAt": "2026-07-22T12:00:00.000Z",
                    }
                ],
                "artifacts": [{"id": "draft-artifact", "name": "draft.txt", "mediaType": "text/plain"}],
            }
        if fail_finalize:
            fail_finalize = False
            raise Error("temporary child failure")
        output = f"{context.variables['draft']}-final"
        return {
            "output": output,
            "statePatch": {"set": {"finalItem": output}},
            "transcript": [
                {
                    "id": "final-message",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": output}],
                    "createdAt": "2026-07-22T12:00:01.000Z",
                }
            ],
            "artifacts": [{"id": "final-artifact", "name": "final.txt", "mediaType": "text/plain"}],
        }

    store = MemoryRunStore()
    with pytest.raises(Error, match="temporary child failure"):
        await create_runner(store, executor("prompt", child)).run(
            run_id="resume-loop", manifest=manifest(loop, {"items": [{"name": "alpha"}]})
        )
    assert calls == ["draft", "finalize"]
    cursor = store.checkpoints["resume-loop"][-1]["cursor"]
    assert (cursor["stepPath"], cursor["childIndex"]) == ("resume-loop/finalize", 1)
    result = await create_runner(store, executor("prompt", child)).run(run_id="resume-loop", resume=True)
    assert calls == ["draft", "finalize", "finalize"]
    assert result["output"] == ["alpha-draft-final"]
    assert result["variables"]["processed"] == ["alpha-draft-final"]
    assert [item["id"] for item in result["stepResults"][0]["transcript"]] == ["draft-message", "final-message"]
    assert [item["id"] for item in result["stepResults"][0]["artifacts"]] == ["draft-artifact", "final-artifact"]
    assert [item["id"] for item in result["transcript"]] == ["draft-message", "final-message"]
    assert [item["id"] for item in result["artifacts"]] == ["draft-artifact", "final-artifact"]


async def test_resumes_a_child_from_its_framed_checkpoint():
    store = MemoryRunStore()
    calls = []

    async def child(context):
        calls.append(context.resume)
        if context.resume is None:
            await context.checkpoint(
                {"state": {**context.variables, "draft": "saved"}, "continuation": {"phase": "drafted"}}
            )
            raise Error("temporary child failure")
        assert context.resume["continuation"] == {"phase": "drafted"}
        assert context.variables["draft"] == "saved"
        return {"output": "done", "statePatch": {"set": {"finished": True}}}

    loop = {
        "id": "items-loop",
        "type": "loop",
        "loop": {"maxIterations": 1, "outputMode": "array"},
        "steps": [prompt("work", "result")],
    }
    runner = create_runner(store, executor("prompt", child))
    with pytest.raises(RunSuspendedError):
        await runner.run(run_id="framed-child", manifest=manifest(loop, {}))
    saved = await store.load_latest_checkpoint("framed-child")
    assert saved["continuation"]["child"]["continuation"] == {"phase": "drafted"}
    assert saved["continuation"]["child"]["state"]["draft"] == "saved"
    result = await runner.run(run_id="framed-child", resume=True)
    assert result["stepResults"][0]["output"] == "done"
    assert len(calls) == 2
    assert any(
        checkpoint.get("boundary", {}).get("executionKey") == "items-loop[0]/work"
        for checkpoint in store.checkpoints["framed-child"]
    )


async def test_loop_iteration_limit_resumes_with_a_higher_grant():
    seen = []
    store = MemoryRunStore()
    loop = {
        "id": "each",
        "type": "loop",
        "loop": {"source": "items", "itemVariable": "item"},
        "steps": [prompt("work", "result")],
    }

    def child(context):
        seen.append(context.variables["item"])
        return {"output": context.variables["item"]}

    runner = create_runner(store, executor("prompt", child))
    with pytest.raises(RunSuspendedError) as blocked:
        await runner.run(
            run_id="capped-loop",
            manifest={**manifest(loop, {"items": ["a", "b", "c"]}), "limits": {"maxLoopIterations": 2}},
        )
    assert blocked.value.details["limit"] == "maxLoopIterations"
    assert seen == ["a", "b"]
    result = await runner.run(run_id="capped-loop", resume=True, limits={"maxLoopIterations": 3})
    assert seen == ["a", "b", "c"]
    assert result["stepResults"][0]["output"] == ["a", "b", "c"]


async def test_ends_the_loop_and_the_run_when_a_child_returns_end_run():
    ran = []

    def child(context):
        ran.append(f"{context.step['id']}:{context.variables['item']}")
        return (
            {"output": "stop", "endRun": True}
            if context.variables["item"] == "b"
            else {"output": str(context.variables["item"])}
        )

    loop = {
        "id": "each",
        "type": "loop",
        "loop": {"source": "items"},
        "steps": [prompt("work", "result"), prompt("after", "later")],
    }
    result = await create_runner(MemoryRunStore(), executor("prompt", child)).run(
        manifest={**manifest(loop, {"items": ["a", "b", "c"]}), "steps": [loop, prompt("final", "finalValue")]}
    )
    assert ran == ["work:a", "after:a", "work:b"]
    assert [entry["stepId"] for entry in result["stepResults"]] == ["each"]


async def test_continues_past_a_failed_child_whose_on_error_is_continue():
    def child(context):
        if context.variables["item"] == "b":
            raise Error("item b is broken")
        return {"output": f"ok {context.variables['item']}"}

    loop = {
        "id": "each",
        "type": "loop",
        "loop": {"source": "items"},
        "steps": [{**prompt("work", "result"), "policies": {"onError": "continue"}}],
    }
    result = await create_runner(MemoryRunStore(), executor("prompt", child)).run(
        manifest=manifest(loop, {"items": ["a", "b", "c"]})
    )
    assert result["output"] == [
        "ok a",
        {"error": {"code": "AGENT_EXECUTION_FAILED", "message": "item b is broken"}},
        "ok c",
    ]
