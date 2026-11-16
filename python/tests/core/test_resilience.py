"""Port of packages/core/src/resilience.test.ts."""

from __future__ import annotations

import re

import pytest

from clearideas_agent_runtime._js.abort import AbortController
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core import (
    AgentRuntime,
    AgentRuntimeError,
    RunCancelledError,
    RunInterruptedError,
    RunSuspendedError,
    create_run_pause_request,
    merge_execution_policies,
    suspension_kind,
)
from clearideas_agent_runtime.core.testing import CollectingEventSink, MemoryRunStore, SequenceIdGenerator

from .helpers import executor


def manifest(steps, **extra):
    return {"schemaVersion": "1.0", "steps": steps, **extra}


def prompt(step_id, **extra):
    return {"id": step_id, "type": "prompt", "prompt": step_id, **extra}


def runtime(executors, **extra):
    store = MemoryRunStore()
    events = CollectingEventSink()
    agent_runtime = AgentRuntime(
        run_store=store, event_sinks=[events], id_generator=SequenceIdGenerator(), step_executors=executors, **extra
    )
    return agent_runtime, store, events


class TestStepOnErrorPolicy:
    async def test_records_a_failed_step_as_its_output_and_continues_when_on_error_is_continue(self):
        def run_step(context):
            if context.step["id"] == "flaky":
                raise Error("upstream is down")
            return {"output": f"ran {context.step['id']}"}

        agent_runtime, _, events = runtime([executor("prompt", run_step)])
        result = await agent_runtime.run(
            manifest=manifest(
                [prompt("flaky", outputVariable="flakyResult", policies={"onError": "continue"}), prompt("after")]
            )
        )
        assert result["state"]["flakyResult"] == {
            "error": {"code": "AGENT_EXECUTION_FAILED", "message": "upstream is down"}
        }
        assert [entry["stepId"] for entry in result["stepResults"]] == ["flaky", "after"]
        assert result["stepResults"][0]["metadata"]["failed"] is True
        assert result["stepResults"][0]["metadata"]["handled"] is True
        failed = next(
            event for event in events.events if event["type"] == "step.failed" and event.get("stepId") == "flaky"
        )
        assert failed["data"]["handled"] is True

    async def test_uses_the_manifest_default_and_lets_a_step_override_it(self):
        def failing(context):
            raise Error("nope")

        tolerant, _, _ = runtime([executor("prompt", failing)])
        result = await tolerant.run(manifest=manifest([prompt("a")], policies={"onError": "continue"}))
        assert [entry["stepId"] for entry in result["stepResults"]] == ["a"]
        strict, _, _ = runtime([executor("prompt", failing)])
        with pytest.raises(Error, match="nope"):
            await strict.run(
                manifest=manifest([prompt("a", policies={"onError": "fail"})], policies={"onError": "continue"})
            )

    async def test_never_continues_past_a_cancellation_or_suspension(self):
        def cancelled(context):
            raise RunCancelledError("rejected")

        agent_runtime, store, _ = runtime([executor("prompt", cancelled)])
        with pytest.raises(RunCancelledError, match="rejected"):
            await agent_runtime.run(
                run_id="cancelled", manifest=manifest([prompt("a", policies={"onError": "continue"})])
            )
        assert store.runs["cancelled"]["status"] == "cancelled"


class TestEndingARunEarly:
    async def test_completes_the_run_after_a_step_returns_end_run(self):
        ran = []

        def run_step(context):
            ran.append(context.step["id"])
            return (
                {"output": "stopped here", "endRun": True}
                if context.step["id"] == "stop"
                else {"output": context.step["id"]}
            )

        agent_runtime, _, events = runtime([executor("prompt", run_step)])
        result = await agent_runtime.run(manifest=manifest([prompt("first"), prompt("stop"), prompt("never")]))
        assert ran == ["first", "stop"]
        assert result["output"] == "stopped here"
        assert any(
            event["type"] == "diagnostic" and (event.get("data") or {}).get("code") == "RUN_ENDED_BY_STEP"
            for event in events.events
        )


class TestPreflight:
    async def test_reports_every_configuration_gap_before_the_run_is_created(self):
        executed = 0

        def run_step(context):
            nonlocal executed
            executed += 1
            return {}

        class Conditions:
            def evaluate(self, expression, variables):
                return True

            def validate(self, expression):
                if "===" in expression:
                    raise Error("bad token")

        class Tools:
            async def list_tools(self):
                return [{"name": "docs__read", "inputSchema": {}}]

            async def execute_tool(self, call, context):
                return {"callId": "x", "name": "x"}

            def unavailable_tool_reason(self, name):
                return "down" if name == "tickets__create" else None

        agent_runtime, store, _ = runtime(
            [
                executor(
                    "prompt",
                    run_step,
                    preflight=lambda step, context: (
                        ["needs-more needs a widget."] if step["id"] == "needs-more" else []
                    ),
                )
            ],
            condition_evaluator=Conditions(),
            tools=Tools(),
        )
        with pytest.raises(AgentRuntimeError) as raised:
            await agent_runtime.run(
                run_id="preflight",
                manifest=manifest(
                    [
                        prompt("ok", tools=["docs__read", "tickets__create"]),
                        prompt("typo", tools=["docs__raed"]),
                        prompt("bad-when", when="status === "),
                        prompt("needs-more"),
                        {"id": "hook", "type": "webhook", "url": "https://example.test/hook"},
                    ]
                ),
            )
        message = str(raised.value)
        assert raised.value.code == "MANIFEST_PREFLIGHT_FAILED"
        assert re.search(r"names unknown tools: docs__raed", message)
        assert re.search(r"bad-when has an invalid when expression", message)
        assert re.search(r"needs-more needs a widget", message)
        assert re.search(r"no webhook step executor is registered", message)
        assert executed == 0
        assert "preflight" not in store.runs

    async def test_checks_a_manifest_without_creating_a_run_through_preflight(self):
        executed = 0

        def run_step(context):
            nonlocal executed
            executed += 1
            return {}

        agent_runtime, store, _ = runtime([executor("prompt", run_step)])
        assert await agent_runtime.preflight(manifest([prompt("ok")])) is None
        with pytest.raises(AgentRuntimeError) as raised:
            await agent_runtime.preflight(
                manifest([prompt("ok"), {"id": "hook", "type": "webhook", "url": "https://example.test/hook"}])
            )
        assert raised.value.code == "MANIFEST_PREFLIGHT_FAILED"
        with pytest.raises(Error, match="Agent manifest is invalid"):
            await agent_runtime.preflight({"schemaVersion": "1.0"})
        assert executed == 0
        assert len(store.runs) == 0

    async def test_requires_a_condition_evaluator_when_conditions_are_used(self):
        agent_runtime, _, _ = runtime([executor("prompt", lambda context: {})])
        with pytest.raises(Error, match="use conditions, but no ConditionEvaluator"):
            await agent_runtime.run(manifest=manifest([prompt("a", when="x")]))


TWO_STEPS = manifest([prompt("first"), prompt("second")])


def aborting_on(step_id, controller, reason):
    def run_step(context):
        if context.step["id"] == step_id:
            controller.abort(reason)
            if context.signal is not None and context.signal.aborted:
                raise context.signal.reason
        return {"output": context.step["id"]}

    return executor("prompt", run_step)


class TestInterruptionPauseAndCancellation:
    async def test_records_an_interrupted_run_as_resumable_and_resumes_it(self):
        controller = AbortController()
        interrupt = True

        def run_step(context):
            nonlocal interrupt
            if context.step["id"] == "second" and interrupt:
                interrupt = False
                controller.abort(RunInterruptedError("execution-timeout"))
                raise context.signal.reason
            return {"output": context.step["id"]}

        agent_runtime, store, events = runtime([executor("prompt", run_step)])
        with pytest.raises(RunInterruptedError) as raised:
            await agent_runtime.run(run_id="interrupted", manifest=TWO_STEPS, signal=controller.signal)
        assert raised.value.code == "RUN_INTERRUPTED"
        assert store.runs["interrupted"]["status"] == "failed"
        assert store.failures["interrupted"]["error"]["code"] == "RUN_INTERRUPTED"
        assert store.failures["interrupted"]["error"]["retryable"] is True
        assert (
            next(event for event in events.events if event["type"] == "run.interrupted")["data"]["reason"]
            == "execution-timeout"
        )
        resumed = await agent_runtime.run(run_id="interrupted", manifest=TWO_STEPS, resume=True)
        assert [entry["stepId"] for entry in resumed["stepResults"]] == ["first", "second"]

    async def test_uses_interrupt_run_when_the_store_supports_it(self):
        controller = AbortController()
        timeout = Error("Execution timed out.")
        timeout.code = "EXECUTION_TIMEOUT"
        timeout.interruption = "execution-timeout"
        agent_runtime, store, _ = runtime([aborting_on("first", controller, timeout)])
        interrupted = []

        async def interrupt_run(run_id, error, interrupted_at, attempt):
            interrupted.append(run_id)
            store.runs[run_id] = {**store.runs[run_id], "status": "interrupted"}

        store.interrupt_run = interrupt_run
        with pytest.raises(Error, match=r"Execution timed out\."):
            await agent_runtime.run(run_id="engine-timeout", manifest=TWO_STEPS, signal=controller.signal)
        assert interrupted == ["engine-timeout"]
        assert store.runs["engine-timeout"]["status"] == "interrupted"

    async def test_suspends_a_paused_run_instead_of_cancelling_it(self):
        controller = AbortController()
        agent_runtime, store, events = runtime(
            [aborting_on("second", controller, create_run_pause_request({"by": "user"}))]
        )
        with pytest.raises(RunSuspendedError) as raised:
            await agent_runtime.run(run_id="paused", manifest=TWO_STEPS, signal=controller.signal)
        assert raised.value.reason == "paused"
        assert store.runs["paused"]["status"] == "suspended"
        data = next(event for event in events.events if event["type"] == "run.suspended")["data"]
        assert (data["reason"], data["kind"]) == ("paused", "paused")

    async def test_still_cancels_on_any_other_abort_reason(self):
        controller = AbortController()
        agent_runtime, store, _ = runtime([aborting_on("second", controller, Error("user stopped it"))])
        with pytest.raises(Error, match="user stopped it"):
            await agent_runtime.run(run_id="stopped", manifest=TWO_STEPS, signal=controller.signal)
        assert store.runs["stopped"]["status"] == "cancelled"

    def test_classifies_suspension_reasons(self):
        assert suspension_kind("approval") == "awaiting-input"
        assert suspension_kind("sub-run") == "awaiting-child"
        assert suspension_kind("token-budget") == "awaiting-budget"
        assert suspension_kind("paused") == "paused"
        assert suspension_kind("custom") == "other"


class TestPolicyLayering:
    def test_merges_host_manifest_and_step_policies_field_by_field(self):
        host = {
            "context": {"strategy": "prune", "trigger": {"contextRatio": 0.7}, "variables": {"doc": {"keep": True}}},
            "modelRetry": {"maxAttempts": 5},
            "onFailure": "pause",
        }
        manifest_policies = {
            "context": {"strategy": "summarize-or-prune", "summarizer": {"model": {"ref": "fast"}}},
            "onError": "continue",
        }
        step_policies = {
            "onFailure": "fail",
            "context": {
                "trigger": {"toolRounds": 4},
                "variables": {"doc": {"maxBytes": 100}},
                "reduceTo": 0.2,
                "openingShare": 0.3,
                "toolResultShare": 0.25,
            },
            "modelRetry": {"initialDelayMs": 10},
        }
        assert merge_execution_policies(host, manifest_policies, step_policies) == {
            "context": {
                "strategy": "summarize-or-prune",
                "summarizer": {"model": {"ref": "fast"}},
                "trigger": {"contextRatio": 0.7, "toolRounds": 4},
                "variables": {"doc": {"keep": True, "maxBytes": 100}},
                "reduceTo": 0.2,
                "openingShare": 0.3,
                "toolResultShare": 0.25,
            },
            "modelRetry": {"maxAttempts": 5, "initialDelayMs": 10},
            "onError": "continue",
            "onFailure": "fail",
        }

    async def test_passes_resolved_policies_to_the_executor(self):
        seen = {}

        def run_step(context):
            seen.update(context.policies)
            return {}

        agent_runtime, _, _ = runtime(
            [executor("prompt", run_step)], policies={"toolCallLimit": "fail", "context": {"strategy": "fail"}}
        )
        await agent_runtime.run(
            manifest=manifest(
                [prompt("a", policies={"context": {"strategy": "prune"}})], policies={"toolCallLimit": "finalize"}
            )
        )
        assert seen == {"toolCallLimit": "finalize", "context": {"strategy": "prune"}}

    async def test_applies_host_enforced_policies_after_the_manifest_and_step_and_passes_the_host_summarizer(self):
        seen = {}

        class HostSummarizer:
            async def summarize(self, request, next):
                return {"text": "summary"}

        host_summarizer = HostSummarizer()

        def run_step(context):
            seen["policies"] = context.policies
            seen["summarizer"] = context.summarizer
            return {}

        agent_runtime, _, _ = runtime(
            [executor("prompt", run_step)],
            policies={"context": {"reduceTo": 0.3}},
            enforced_policies={"context": {"summarizer": {"maxSummaryBytes": 2000, "maxCalls": 8}}},
            summarizer=host_summarizer,
        )
        await agent_runtime.run(
            manifest=manifest(
                [prompt("a", policies={"context": {"summarizer": {"maxSummaryBytes": 100_000, "chunkBytes": 20_000}}})],
                policies={"context": {"reduceTo": 0.2}},
            )
        )
        assert seen["policies"]["context"] == {
            "reduceTo": 0.2,
            "summarizer": {"maxSummaryBytes": 2000, "chunkBytes": 20000, "maxCalls": 8},
        }
        assert seen["summarizer"] is host_summarizer
