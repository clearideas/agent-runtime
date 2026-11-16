"""A completed checkpoint can seed a new run at its next step."""

from __future__ import annotations

from clearideas_agent_runtime.core import AgentRuntime
from clearideas_agent_runtime.core.testing import MemoryRunStore

from .helpers import executor


async def test_seed_restarts_after_the_selected_boundary():
    store = MemoryRunStore()
    visited = []

    def execute(context):
        visited.append((context.run_id, context.step["id"]))
        return {"output": context.step["id"], "statePatch": {"set": {context.step["id"]: True}}}

    runner = AgentRuntime(run_store=store, step_executors=[executor("prompt", execute)])
    manifest = {
        "schemaVersion": "1.0",
        "steps": [{"id": key, "type": "prompt", "prompt": key} for key in ("a", "b", "c")],
    }
    await runner.run(run_id="source", manifest=manifest)
    seed = next(item for item in store.checkpoints["source"] if item.get("boundary", {}).get("stepPath") == "b")
    result = await runner.run(run_id="restart", manifest=manifest, seed=seed)
    assert visited == [("source", "a"), ("source", "b"), ("source", "c"), ("restart", "c")]
    assert [item["stepId"] for item in result["stepResults"]] == ["a", "b", "c"]
    assert result["state"]["a"] is True and result["state"]["b"] is True
    assert store.checkpoints["restart"][0]["metadata"]["seededFrom"]["stepPath"] == "b"
