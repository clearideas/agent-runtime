"""Ports of state.test.ts, execution-plan.test.ts, and diagnostics.test.ts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core import (
    AgentRuntime,
    AgentRuntimeError,
    apply_state_patch,
    build_execution_waves,
    set_variable_at_path,
)
from clearideas_agent_runtime.core.testing import MemoryRunStore

from .helpers import executor

REPOSITORY = Path(__file__).resolve().parents[3]


class TestRunnerVariablePaths:
    def test_applies_dotted_set_and_unset_paths_consistently(self):
        state = apply_state_patch(
            {"client": {"name": "Old", "retained": True}},
            {"set": {"client.name": "New", "client.score": 9}, "unset": ["client.retained"]},
        )
        assert state == {"client": {"name": "New", "score": 9}}

    @pytest.mark.parametrize("path", ["__proto__", "safe.__proto__.polluted", "constructor.prototype.polluted"])
    def test_rejects_prototype_sensitive_path(self, path):
        with pytest.raises(Error, match="Unsafe variable path"):
            set_variable_at_path({}, path, True)


def prompt(step_id, text, output_variable=None):
    return {
        "id": step_id,
        "type": "prompt",
        "prompt": text,
        **({"outputVariable": output_variable} if output_variable else {}),
    }


def waves(manifest, execution):
    return [wave.step_indexes for wave in build_execution_waves(manifest, 0, execution)]


def manifest(steps):
    return {"schemaVersion": "1.0", "steps": steps}


class TestBuildExecutionWaves:
    def test_keeps_sequential_execution_as_the_default(self):
        assert waves(manifest([prompt("one", "One", "one"), prompt("two", "Two", "two")]), None) == [[0], [1]]

    def test_fans_out_independent_prompts_and_joins_before_their_consumer(self):
        assert waves(
            manifest(
                [
                    prompt("facts", "Find facts about {{ topic }}", "facts"),
                    prompt("audience", "Analyze {{ audience }}", "audienceNotes"),
                    prompt("final", "Use {{ facts }} for {{ audienceNotes }}", "final"),
                ]
            ),
            {"mode": "parallel", "maxConcurrency": 4},
        ) == [[0, 1], [2]]

    def test_recognizes_dependencies_in_conditions_and_serializes_duplicate_writes(self):
        conditional = {**prompt("conditional", "Continue", "result"), "when": "score.value >= 0.8"}
        assert waves(
            manifest([prompt("score", "Score", "score"), conditional, prompt("replace", "Replace", "result")]),
            {"mode": "parallel"},
        ) == [[0], [1], [2]]

    def test_recognizes_template_dependencies_inside_complete_message_histories(self):
        consumer = {
            "id": "consumer",
            "type": "prompt",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "Use {{ research.summary }}"}]}],
            "outputVariable": "answer",
        }
        assert waves(
            manifest(
                [prompt("research", "Research", "research"), consumer, prompt("independent", "Independent", "other")]
            ),
            {"mode": "parallel"},
        ) == [[0], [1, 2]]

    def test_uses_stateful_and_tool_enabled_steps_as_barriers(self):
        tool_step = {**prompt("tool", "Call tool", "toolResult"), "tools": ["search"]}
        assert waves(
            manifest(
                [
                    prompt("one", "One", "one"),
                    tool_step,
                    prompt("two", "Two", "two"),
                    {"id": "approval", "type": "approval", "prompt": "Approve"},
                    prompt("three", "Three", "three"),
                ]
            ),
            {"mode": "parallel"},
        ) == [[0], [1], [2], [3], [4]]

    def test_honors_concurrency_limits_and_disables_parallel_projection_state(self):
        steps = [prompt("one", "One", "one"), prompt("two", "Two", "two"), prompt("three", "Three", "three")]
        assert waves(manifest(steps), {"mode": "parallel", "maxConcurrency": 2}) == [[0, 1], [2]]
        projected = {**manifest(steps), "extensions": {"agentRuntime": {"stateProjection": "step-output-state-v1"}}}
        assert waves(projected, {"mode": "parallel"}) == [[0], [1], [2]]


DIAGNOSTICS_MANIFEST = {"schemaVersion": "1.0", "steps": [{"id": "work", "type": "prompt", "prompt": "Work"}]}


class TestDurableDiagnostics:
    async def test_preserves_a_classified_failure_and_recovery_hint(self):
        store = MemoryRunStore()
        error = AgentRuntimeError("Unavailable", "PROVIDER_UNAVAILABLE", True, "Try again later.")

        def fail(context):
            raise error

        runtime = AgentRuntime(run_store=store, step_executors=[executor("prompt", fail)])
        with pytest.raises(AgentRuntimeError) as raised:
            await runtime.run(manifest=DIAGNOSTICS_MANIFEST, run_id="failed")
        assert raised.value is error
        recorded = store.failures["failed"]["error"]
        assert recorded["code"] == "PROVIDER_UNAVAILABLE"
        assert recorded["retryable"] is True
        assert recorded["details"]["suggestedAction"] == "Try again later."

    async def test_writes_the_package_version_and_can_resume_a_checkpoint_from_an_earlier_runtime(self):
        store = MemoryRunStore()
        should_fail = True

        def run_step(context):
            if should_fail:
                raise Error("Interrupted")
            return {"output": "Recovered"}

        runtime = AgentRuntime(run_store=store, step_executors=[executor("prompt", run_step)])
        with pytest.raises(Error, match="Interrupted"):
            await runtime.run(manifest=DIAGNOSTICS_MANIFEST, run_id="version")
        checkpoint = await store.load_latest_checkpoint("version")
        version = json.loads((REPOSITORY / "packages" / "core" / "package.json").read_text())["version"]
        assert checkpoint["runtimeVersion"] == version
        legacy = {**checkpoint, "runtimeVersion": "0.1.0"}

        async def load_latest(run_id):
            return legacy

        store.load_latest_checkpoint = load_latest
        should_fail = False
        assert (await runtime.run(manifest=DIAGNOSTICS_MANIFEST, run_id="version", resume=True))[
            "output"
        ] == "Recovered"
