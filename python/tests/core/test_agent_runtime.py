"""Port of packages/core/src/agent-runtime.test.ts."""

from __future__ import annotations

import asyncio
import copy
import re

import pytest

from clearideas_agent_runtime._js.abort import AbortController
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core import AgentRuntime, RunSuspendedError, default_manifest_hasher
from clearideas_agent_runtime.core.testing import CollectingEventSink, MemoryRunStore, SequenceIdGenerator

from .helpers import executor, future


def manifest(steps):
    return {
        "schemaVersion": "1.0",
        "id": "manifest-1",
        "name": "Deterministic test",
        "variables": [{"key": "count", "type": "number", "value": 0}],
        "steps": steps,
    }


def step(step_id):
    return {"id": step_id, "type": "prompt", "name": step_id, "prompt": step_id}


async def test_uses_a_canonical_sha256_manifest_fingerprint_by_default():
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", default_manifest_hasher.hash(manifest([])))
    assert default_manifest_hasher.hash(manifest([])) == default_manifest_hasher.hash(manifest([]))


async def test_starts_a_run_from_a_validated_agent_run_manifest_that_references_an_agent():
    agent = {
        "schemaVersion": "1.0",
        "id": "release-brief",
        "variables": [{"key": "audience", "type": "string", "requiresOverride": True}],
        "steps": [{"id": "answer", "type": "prompt", "prompt": "Answer for {{ audience }}."}],
    }

    class Source:
        async def load_manifest(self, reference=None):
            assert reference == "agents/release-brief.agent.yaml"
            return agent

    def run_step(context):
        assert context.token_budget.max_total_tokens == 1000
        assert context.token_budget.consumed_tokens == 0
        return {"output": context.variables["audience"]}

    runner = AgentRuntime(
        run_store=MemoryRunStore(), agent_manifest_source=Source(), step_executors=[executor("prompt", run_step)]
    )
    result = await runner.run(
        agent_run_manifest={
            "schemaVersion": "1.0",
            "agent": {"ref": "agents/release-brief.agent.yaml"},
            "runId": "release-run-1",
            "variables": [{"key": "audience", "value": "partners"}],
            "budget": {"maxTotalTokens": 1000},
        }
    )
    assert result["runId"] == "release-run-1"
    assert result["output"] == "partners"
    assert result["state"] == {"audience": "partners"}


async def test_executes_steps_in_order_and_checkpoints_state_before_starting_the_next_step():
    store = MemoryRunStore()
    events = CollectingEventSink()
    observed = []

    def run_step(context):
        observed.append({"stepId": context.step["id"], "count": context.variables.get("count")})
        next_count = int(context.variables.get("count") or 0) + 1
        return {"output": next_count, "statePatch": {"set": {"count": next_count}}}

    runner = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", run_step)],
        event_sinks=[events],
        id_generator=SequenceIdGenerator(),
    )
    result = await runner.run(manifest=manifest([step("first"), step("second")]), run_id="run-1")
    assert observed == [{"stepId": "first", "count": 0}, {"stepId": "second", "count": 1}]
    assert result["variables"] == {"count": 2}
    assert [item["cursor"]["stepIndex"] for item in store.checkpoints["run-1"]] == [0, 1, 2]
    assert [event["sequence"] for event in events.events] == list(range(1, len(events.events) + 1))
    assert [event["type"] for event in events.events] == [
        "run.started",
        "checkpoint.saved",
        "step.started",
        "checkpoint.saved",
        "step.completed",
        "step.started",
        "checkpoint.saved",
        "step.completed",
        "run.completed",
    ]


async def test_runs_independent_steps_concurrently_and_commits_their_outputs_in_manifest_order():
    store = MemoryRunStore()
    events = CollectingEventSink()
    second_started = future()
    first_released = future()

    async def run_step(context):
        assert context.variables == {}
        if context.step["id"] == "first":
            await asyncio.wait_for(asyncio.shield(second_started), 0.5)
            first_released.set_result(None)
        else:
            second_started.set_result(None)
            await first_released
        return {"output": context.step["id"], "statePatch": {"set": {context.step["id"]: context.step["id"]}}}

    runner = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", run_step)],
        event_sinks=[events],
        id_generator=SequenceIdGenerator(),
    )
    result = await runner.run(
        manifest={
            "schemaVersion": "1.0",
            "steps": [{**step("first"), "outputVariable": "first"}, {**step("second"), "outputVariable": "second"}],
        },
        run_id="parallel-run",
        execution={"mode": "parallel", "maxConcurrency": 2},
    )
    assert result["state"] == {"first": "first", "second": "second"}
    assert [item["stepId"] for item in result["stepResults"]] == ["first", "second"]
    assert [item["cursor"]["stepIndex"] for item in store.checkpoints["parallel-run"]] == [0, 2]
    assert [event["sequence"] for event in events.events] == list(range(1, len(events.events) + 1))


async def test_waits_for_producer_outputs_before_executing_a_dependent_step():
    observed = []

    def run_step(context):
        observed.append({"stepId": context.step["id"], "variables": {**context.variables}})
        return {
            "output": context.step["id"],
            "statePatch": {"set": {context.step["outputVariable"]: context.step["id"]}},
        }

    runner = AgentRuntime(run_store=MemoryRunStore(), step_executors=[executor("prompt", run_step)])
    result = await runner.run(
        manifest={
            "schemaVersion": "1.0",
            "steps": [
                {"id": "facts", "type": "prompt", "prompt": "Facts", "outputVariable": "facts"},
                {"id": "audience", "type": "prompt", "prompt": "Audience", "outputVariable": "audienceNotes"},
                {
                    "id": "final",
                    "type": "prompt",
                    "prompt": "{{ facts }} {{ audienceNotes }}",
                    "outputVariable": "final",
                },
            ],
        },
        execution={"mode": "parallel"},
    )
    assert observed[:2] == [{"stepId": "facts", "variables": {}}, {"stepId": "audience", "variables": {}}]
    assert observed[2] == {"stepId": "final", "variables": {"facts": "facts", "audienceNotes": "audience"}}
    assert [item["stepId"] for item in result["stepResults"]] == ["facts", "audience", "final"]


async def test_rejects_undeclared_shared_state_mutation_from_a_parallel_wave():
    runner = AgentRuntime(
        run_store=MemoryRunStore(),
        step_executors=[
            executor(
                "prompt",
                lambda context: {"output": context.step["id"], "statePatch": {"set": {"shared": context.step["id"]}}},
            )
        ],
    )
    with pytest.raises(Error, match="attempted to mutate state outside its outputVariable"):
        await runner.run(
            manifest={
                "schemaVersion": "1.0",
                "steps": [{**step("first"), "outputVariable": "first"}, {**step("second"), "outputVariable": "second"}],
            },
            execution={"mode": "parallel"},
        )


async def test_does_not_execute_a_later_step_when_a_committed_state_checkpoint_fails():
    store = MemoryRunStore()
    count = 0

    async def save_checkpoint(checkpoint):
        nonlocal count
        count += 1
        if count == 2:
            raise Error("checkpoint unavailable")
        store.checkpoints.setdefault(checkpoint["runId"], []).append(copy.deepcopy(checkpoint))

    store.save_checkpoint = save_checkpoint
    executed = []

    def run_step(context):
        executed.append(context.step["id"])
        return {"statePatch": {"set": {"last": context.step["id"]}}}

    runner = AgentRuntime(
        run_store=store, step_executors=[executor("prompt", run_step)], id_generator=SequenceIdGenerator()
    )
    with pytest.raises(Error, match="checkpoint unavailable"):
        await runner.run(manifest=manifest([step("first"), step("second")]), run_id="run-2")
    assert executed == ["first"]
    assert (await store.load_run("run-2"))["status"] == "suspended"


async def test_rejects_overlapping_attempts_for_the_same_run_in_one_agent_runtime_process():
    store = MemoryRunStore()
    blocked = future()
    started = future()

    async def run_step(context):
        started.set_result(None)
        await blocked
        return {"output": "done"}

    runner = AgentRuntime(run_store=store, step_executors=[executor("prompt", run_step)])
    first = asyncio.ensure_future(runner.run(manifest=manifest([step("only")]), run_id="overlap"))
    await started
    with pytest.raises(Error, match="already active in this Agent Runtime process"):
        await runner.run(run_id="overlap", resume=True)
    blocked.set_result(None)
    assert (await first)["output"] == "done"


async def test_rejects_manifests_and_outputs_that_exceed_declared_limits():
    store = MemoryRunStore()
    runner = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", lambda context: {"output": "too large"})],
        id_generator=SequenceIdGenerator(),
    )
    with pytest.raises(Error, match="exceeding its 1-step limit"):
        await runner.run(
            run_id="too-many-steps", manifest={**manifest([step("first"), step("second")]), "limits": {"maxSteps": 1}}
        )
    assert await store.load_run("too-many-steps") is None
    with pytest.raises(Error, match="declares 2 steps, exceeding its 1-step limit"):
        await runner.run(
            run_id="too-many-nested-steps",
            manifest={
                **manifest([{"id": "outer", "type": "loop", "loop": {"maxIterations": 1}, "steps": [step("nested")]}]),
                "limits": {"maxSteps": 1},
            },
        )
    assert await store.load_run("too-many-nested-steps") is None
    with pytest.raises(Error, match="exceeding the 4-byte output limit"):
        await runner.run(
            run_id="output-too-large", manifest={**manifest([step("only")]), "limits": {"maxOutputBytes": 4}}
        )
    assert (await store.load_run("output-too-large"))["status"] == "suspended"


async def test_validates_runtime_manifests_before_creating_a_run():
    store = MemoryRunStore()
    runner = AgentRuntime(run_store=store, step_executors=[], id_generator=SequenceIdGenerator())
    with pytest.raises(Error, match="Duplicate sibling step id: duplicate"):
        await runner.run(run_id="invalid-manifest", manifest=manifest([step("duplicate"), step("duplicate")]))
    assert await store.load_run("invalid-manifest") is None


async def test_resolves_typed_agent_variables_and_run_overrides():
    store = MemoryRunStore()
    observed = []

    def run_step(context):
        observed.append(copy.deepcopy(context.variables))
        return {}

    runner = AgentRuntime(
        run_store=store, step_executors=[executor("prompt", run_step)], id_generator=SequenceIdGenerator()
    )
    configured = {
        **manifest([step("only")]),
        "variables": [
            {"key": "region", "type": "string", "value": "manifest"},
            {"key": "nested", "type": "object", "value": {"retained": True, "defaulted": 42}},
            {"key": "required", "type": "string", "requiresOverride": True},
        ],
    }
    await runner.run(
        manifest=configured,
        run_id="variable-defaults",
        variables=[{"key": "region", "value": "supplied"}, {"key": "required", "value": "present"}],
    )
    assert observed == [{"region": "supplied", "nested": {"retained": True, "defaulted": 42}, "required": "present"}]
    with pytest.raises(Error, match="Missing required runtime variable overrides: required"):
        await runner.run(manifest=configured, run_id="missing-required")
    assert await store.load_run("missing-required") is None


async def test_rejects_unknown_duplicate_and_incorrectly_typed_run_overrides():
    runner = AgentRuntime(
        run_store=MemoryRunStore(),
        step_executors=[executor("prompt", lambda context: {})],
        id_generator=SequenceIdGenerator(),
    )
    configured = {**manifest([step("only")]), "variables": [{"key": "count", "type": "number", "value": 1}]}
    with pytest.raises(Error, match="Run variable is not declared by the agent: other"):
        await runner.run(manifest=configured, run_id="unknown-variable", variables=[{"key": "other", "value": 1}])
    with pytest.raises(Error, match="Duplicate run variable override: count"):
        await runner.run(
            manifest=configured,
            run_id="duplicate-variable",
            variables=[{"key": "count", "value": 1}, {"key": "count", "value": 2}],
        )
    with pytest.raises(Error, match="Run variable count must be number"):
        await runner.run(
            manifest=configured, run_id="wrong-variable-type", variables=[{"key": "count", "value": "one"}]
        )


async def test_does_not_let_a_non_critical_event_sink_failure_invalidate_execution():
    store = MemoryRunStore()

    class OfflineSink:
        async def emit(self, event):
            raise Error("offline")

    runner = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", lambda context: {"output": "done"})],
        event_sinks=[OfflineSink()],
        id_generator=SequenceIdGenerator(),
    )
    result = await runner.run(manifest=manifest([step("only")]), run_id="run-3")
    assert result["output"] == "done"
    assert "run-3" in store.completed


async def test_persists_cancellation_as_cancellation_rather_than_failure():
    store = MemoryRunStore()
    events = CollectingEventSink()
    controller = AbortController()
    controller.abort(Error("Run was aborted"))
    runner = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", lambda context: {"output": "unused"})],
        event_sinks=[events],
        id_generator=SequenceIdGenerator(),
    )
    with pytest.raises(Error, match="Run was aborted"):
        await runner.run(manifest=manifest([step("only")]), run_id="run-cancelled", signal=controller.signal)
    assert (await store.load_run("run-cancelled"))["status"] == "cancelled"
    assert "run-cancelled" not in store.failures
    assert events.events[-1]["type"] == "run.cancelled"


async def test_cancels_when_a_non_cooperative_executor_resolves_after_abort():
    store = MemoryRunStore()
    controller = AbortController()

    def run_step(context):
        controller.abort(Error("cancel after provider response"))
        return {"output": "must not commit"}

    runner = AgentRuntime(
        run_store=store, step_executors=[executor("prompt", run_step)], id_generator=SequenceIdGenerator()
    )
    with pytest.raises(Error, match="cancel after provider response"):
        await runner.run(manifest=manifest([step("only")]), run_id="non-cooperative-cancel", signal=controller.signal)
    assert (await store.load_run("non-cooperative-cancel"))["status"] == "cancelled"
    assert len(store.checkpoints["non-cooperative-cancel"]) == 1


async def test_does_not_roll_back_durable_completion_when_the_terminal_event_sink_fails():
    store = MemoryRunStore()

    class TerminalSink:
        def emit(self, event):
            if event["type"] == "run.completed":
                raise Error("terminal observer unavailable")

    runner = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", lambda context: {"output": "done"})],
        event_sinks=[TerminalSink()],
        event_sink_failure_policy="fail-run",
        id_generator=SequenceIdGenerator(),
    )
    assert (await runner.run(manifest=manifest([step("only")]), run_id="terminal-event-failure"))["output"] == "done"
    assert (await store.load_run("terminal-event-failure"))["status"] == "completed"


@pytest.mark.parametrize(
    ("name", "change", "message"),
    [
        ("cross-run checkpoint", lambda checkpoint: {**checkpoint, "runId": "another-run"}, "does not belong"),
        ("future attempt", lambda checkpoint: {**checkpoint, "attempt": 2}, "not recoverable"),
        (
            "out-of-bounds cursor",
            lambda checkpoint: {**checkpoint, "cursor": {"stepIndex": 99}},
            "outside the manifest",
        ),
    ],
)
async def test_rejects_a_corrupt_checkpoint_before_reserving_a_new_attempt(name, change, message):
    store = MemoryRunStore()
    configured = manifest([step("only")])
    run_id = "corrupt-resume"
    store.runs[run_id] = {
        "runId": run_id,
        "manifest": configured,
        "status": "failed",
        "attempt": 1,
        "state": {"count": 0},
        "createdAt": "2026-07-22T00:00:00.000Z",
        "updatedAt": "2026-07-22T00:00:01.000Z",
    }
    valid = {
        "id": "checkpoint-1",
        "runId": run_id,
        "sequence": 1,
        "attempt": 1,
        "manifestHash": default_manifest_hasher.hash(configured),
        "contractVersion": "1.0",
        "runtimeVersion": "0.1.0",
        "cursor": {"stepIndex": 0},
        "state": {"count": 0},
        "stepResults": [],
        "transcript": [],
        "artifacts": [],
        "createdAt": "2026-07-22T00:00:00.000Z",
    }
    store.checkpoints[run_id] = [change(valid)]
    runner = AgentRuntime(run_store=store, step_executors=[executor("prompt", lambda context: {})])
    with pytest.raises(Error, match=message):
        await runner.run(run_id=run_id, resume=True)
    assert (await store.load_run(run_id))["attempt"] == 1


async def test_resumes_at_the_latest_committed_cursor_without_replaying_completed_steps():
    store = MemoryRunStore()
    first_events = CollectingEventSink()
    first_attempt = []

    def failing(context):
        first_attempt.append(context.step["id"])
        if context.step["id"] == "second":
            raise Error("temporary failure")
        count = int(context.variables.get("count") or 0) + 1
        return {"output": count, "statePatch": {"set": {"count": count}}}

    first_runner = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", failing)],
        event_sinks=[first_events],
        id_generator=SequenceIdGenerator(),
    )
    agent_manifest = manifest([step("first"), step("second")])
    with pytest.raises(Error, match="temporary failure"):
        await first_runner.run(manifest=agent_manifest, run_id="run-resume")
    assert first_attempt == ["first", "second"]
    assert store.checkpoints["run-resume"][-1]["cursor"]["stepIndex"] == 1

    resumed_attempt = []
    resumed_events = CollectingEventSink()

    def resumed_step(context):
        resumed_attempt.append(context.step["id"])
        count = int(context.variables.get("count") or 0) + 1
        return {"output": count, "statePatch": {"set": {"count": count}}}

    resumed_runner = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", resumed_step)],
        event_sinks=[resumed_events],
        id_generator=SequenceIdGenerator(),
    )
    result = await resumed_runner.run(run_id="run-resume", resume=True)
    assert resumed_attempt == ["second"]
    assert result["variables"] == {"count": 2}
    assert [item["stepId"] for item in result["stepResults"]] == ["first", "second"]
    assert "run-resume" in store.completed
    assert all(event["attempt"] == 1 for event in first_events.events)
    assert all(event["attempt"] == 2 for event in resumed_events.events)
    assert {key: resumed_events.events[0][key] for key in ("type", "attempt", "sequence")} == {
        "type": "run.resumed",
        "attempt": 2,
        "sequence": 1,
    }
    assert store.checkpoints["run-resume"][-1]["attempt"] == 2


async def test_suspends_after_a_committed_continuation_and_resumes_it_on_the_next_attempt():
    store = MemoryRunStore()
    events = CollectingEventSink()

    async def run_step(context):
        if not context.resume:
            await context.checkpoint({"state": {"count": 7}, "continuation": {"phase": "waiting-for-human"}})
            raise RunSuspendedError("human-input", {"stepId": context.step["id"]})
        assert context.resume["continuation"] == {"phase": "waiting-for-human"}
        return {"output": "continued", "statePatch": {"set": {"count": 8}}}

    first = AgentRuntime(
        run_store=store,
        step_executors=[executor("prompt", run_step)],
        event_sinks=[events],
        id_generator=SequenceIdGenerator(),
    )
    with pytest.raises(RunSuspendedError):
        await first.run(manifest=manifest([step("approval")]), run_id="run-suspend")
    record = await store.load_run("run-suspend")
    assert (record["status"], record["attempt"]) == ("suspended", 1)
    assert any(event["type"] == "run.suspended" for event in events.events)
    assert not any(event["type"] == "run.failed" for event in events.events)

    resumed = AgentRuntime(
        run_store=store, step_executors=[executor("prompt", run_step)], id_generator=SequenceIdGenerator()
    )
    result = await resumed.run(run_id="run-suspend", resume=True)
    assert result["output"] == "continued"
    assert result["state"]["count"] == 8
    record = await store.load_run("run-suspend")
    assert (record["status"], record["attempt"]) == ("completed", 2)


async def test_persists_a_cumulative_token_budget_and_requires_a_higher_resume_limit():
    store = MemoryRunStore()
    executions = 0

    async def run_step(context):
        nonlocal executions
        executions += 1
        budget = context.token_budget
        assert budget is not None
        if budget.consumed_tokens >= budget.max_total_tokens:
            raise RunSuspendedError(
                "token-budget", {"maxTotalTokens": budget.max_total_tokens, "consumedTokens": budget.consumed_tokens}
            )
        if not context.resume:
            budget.consume({"totalTokens": 10})
            await context.checkpoint({"state": {"count": 1}, "continuation": {"phase": "after-model"}})
            raise RunSuspendedError("token-budget")
        return {"output": "continued"}

    def runner():
        return AgentRuntime(
            run_store=store, step_executors=[executor("prompt", run_step)], id_generator=SequenceIdGenerator()
        )

    with pytest.raises(RunSuspendedError) as suspended:
        await runner().run(manifest=manifest([step("budgeted")]), run_id="run-budget", budget={"maxTotalTokens": 10})
    assert suspended.value.reason == "token-budget"
    assert store.checkpoints["run-budget"][-1]["budget"] == {"maxTotalTokens": 10, "consumedTokens": 10}
    with pytest.raises(RunSuspendedError) as suspended:
        await runner().run(run_id="run-budget", resume=True)
    assert suspended.value.reason == "token-budget"
    assert executions == 2
    assert (await runner().run(run_id="run-budget", resume=True, budget={"maxTotalTokens": 11}))[
        "output"
    ] == "continued"
    assert executions == 3
    assert store.checkpoints["run-budget"][-1]["budget"] == {"maxTotalTokens": 11, "consumedTokens": 10}


async def test_rejects_resume_when_the_supplied_manifest_differs_from_the_checkpoint():
    store = MemoryRunStore()

    def stop(context):
        if context.step["id"] == "first":
            return {"output": "committed"}
        raise Error("stop after first step")

    runner = AgentRuntime(
        run_store=store, step_executors=[executor("prompt", stop)], id_generator=SequenceIdGenerator()
    )
    with pytest.raises(Error, match="stop after first step"):
        await runner.run(manifest=manifest([step("first"), step("second")]), run_id="run-mismatch")
    with pytest.raises(Error, match="Manifest does not match checkpoint"):
        await runner.run(manifest=manifest([step("changed"), step("second")]), run_id="run-mismatch", resume=True)


async def test_exposes_nested_continuation_checkpoints_to_a_resumed_step():
    store = MemoryRunStore()
    agent_manifest = manifest([{"id": "loop", "type": "loop", "loop": {"maxIterations": 2}, "steps": []}])

    async def run_loop(context):
        if not context.resume:
            await context.checkpoint(
                {
                    "state": {"count": 1},
                    "cursor": {
                        "stepId": context.step["id"],
                        "stepPath": context.step_path,
                        "loopIteration": 1,
                        "childIndex": 0,
                    },
                    "continuation": {"nextIteration": 1},
                }
            )
            raise Error("interrupted inside loop")
        assert context.variables == {"count": 1}
        assert context.resume["cursor"]["loopIteration"] == 1
        assert context.resume["continuation"] == {"nextIteration": 1}
        return {"output": "done", "statePatch": {"set": {"count": 2}}}

    first = AgentRuntime(
        run_store=store, step_executors=[executor("loop", run_loop)], id_generator=SequenceIdGenerator()
    )
    with pytest.raises(Error, match="interrupted inside loop"):
        await first.run(manifest=agent_manifest, run_id="run-nested")
    checkpoint = store.checkpoints["run-nested"][-1]
    assert {key: checkpoint["cursor"][key] for key in ("stepIndex", "stepPath", "loopIteration")} == {
        "stepIndex": 0,
        "stepPath": "loop",
        "loopIteration": 1,
    }
    assert checkpoint["continuation"] == {"nextIteration": 1}
    resumed = AgentRuntime(
        run_store=store, step_executors=[executor("loop", run_loop)], id_generator=SequenceIdGenerator()
    )
    assert (await resumed.run(run_id="run-nested", resume=True))["variables"] == {"count": 2}


async def test_executes_registered_child_steps_with_nested_event_paths():
    store = MemoryRunStore()
    events = CollectingEventSink()
    child = step("child")

    async def parent(context):
        return await context.execute_child(child, context.variables, f"{context.step_path}/{child['id']}")

    runner = AgentRuntime(
        run_store=store,
        step_executors=[
            executor("loop", parent),
            executor(
                "prompt", lambda context: {"output": "child output", "statePatch": {"set": {"childCompleted": True}}}
            ),
        ],
        event_sinks=[events],
        id_generator=SequenceIdGenerator(),
    )
    result = await runner.run(
        manifest=manifest([{"id": "parent", "type": "loop", "loop": {"maxIterations": 1}, "steps": [child]}]),
        run_id="run-child",
    )
    assert result["variables"]["childCompleted"] is True
    assert [
        {"type": event["type"], "stepPath": event["stepPath"]}
        for event in events.events
        if event.get("stepId") == "child"
    ] == [
        {"type": "step.started", "stepPath": "parent/child"},
        {"type": "step.completed", "stepPath": "parent/child"},
    ]


async def test_selects_steps_marked_for_final_output_in_manifest_order():
    runner = AgentRuntime(
        run_store=MemoryRunStore(),
        step_executors=[executor("prompt", lambda context: {"output": context.step["id"]})],
        id_generator=SequenceIdGenerator(),
    )
    result = await runner.run(
        manifest=manifest(
            [
                {**step("first"), "includeInFinalOutput": True},
                step("second"),
                {**step("third"), "includeInFinalOutput": True},
            ]
        ),
        run_id="run-output",
    )
    assert result["output"] == ["first", "third"]
    assert result["state"] == result["variables"]
    assert result["startedAt"]
    assert result["completedAt"]
