"""Port of packages/store-sqlite/src/index.test.ts."""

from __future__ import annotations

import os
import stat

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core import AgentRuntime
from clearideas_agent_runtime.core.testing import SequenceIdGenerator
from clearideas_agent_runtime.stores.sqlite import SqliteRunStore

from ..core.helpers import executor
from .test_store_local import _interrupted_lifecycle

MANIFEST = {
    "schemaVersion": "1.0",
    "id": "manifest-1",
    "variables": [{"key": "count", "type": "number", "value": 0}],
    "steps": [{"id": "one", "type": "prompt", "prompt": "one"}],
}


def run_record(run_id, **extra):
    return {
        "runId": run_id,
        "manifest": MANIFEST,
        "status": "running",
        "state": {"count": 0},
        "createdAt": "2026-07-22T00:00:00.000Z",
        "updatedAt": "2026-07-22T00:00:00.000Z",
        **extra,
    }


def checkpoint(run_id, sequence, **extra):
    return {
        "id": f"checkpoint-{sequence}",
        "runId": run_id,
        "sequence": sequence,
        "manifestHash": "hash",
        "contractVersion": "1.0",
        "runtimeVersion": "0.1.0",
        "cursor": {"stepIndex": sequence},
        "state": {"count": sequence},
        "stepResults": [],
        "transcript": [],
        "artifacts": [],
        "createdAt": f"2026-07-22T00:00:0{sequence}.000Z",
        **extra,
    }


@pytest.fixture
def filename(tmp_path):
    return str(tmp_path / "runs.sqlite")


async def test_persists_runs_and_monotonically_sequenced_checkpoints_across_instances(filename):
    first = SqliteRunStore(filename)
    await first.create_run(run_record("run-1"))
    await first.save_checkpoint(checkpoint("run-1", 1))
    await first.save_checkpoint(checkpoint("run-1", 2))
    await first.save_checkpoint(checkpoint("run-1", 2))
    with pytest.raises(Error, match="expected 3"):
        await first.save_checkpoint(checkpoint("run-1", 4))
    first.close()
    second = SqliteRunStore(filename)
    assert (await second.load_run("run-1"))["runId"] == "run-1"
    latest = await second.load_latest_checkpoint("run-1")
    assert (latest["id"], latest["sequence"], latest["state"]) == ("checkpoint-2", 2, {"count": 2})
    second.close()
    assert stat.S_IMODE(os.stat(filename).st_mode) == 0o600


async def test_deletes_finished_runs_with_their_checkpoints_never_a_running_run(filename):
    store = SqliteRunStore(filename)
    await store.create_run(run_record("run-1"))
    await store.save_checkpoint(checkpoint("run-1", 1))
    with pytest.raises(Error, match="Cannot delete running run run-1"):
        await store.delete_run("run-1")
    await store.fail_run("run-1", {"code": "FAILED", "message": "failed"}, "2026-07-22T00:01:00.000Z", 1)
    assert await store.delete_run("run-1") is True
    assert await store.load_run("run-1") is None
    assert await store.load_latest_checkpoint("run-1") is None
    assert await store.delete_run("run-1") is False
    await store.create_run(run_record("run-1"))
    await store.save_checkpoint(checkpoint("run-1", 1))
    store.close()


async def test_supports_core_failure_recovery_without_replaying_a_committed_step(filename):
    store = SqliteRunStore(filename)
    two_steps = {
        **MANIFEST,
        "steps": [
            {"id": "first", "type": "prompt", "prompt": "first"},
            {"id": "second", "type": "prompt", "prompt": "second"},
        ],
    }
    calls = []
    fail_second = True

    def run_step(context):
        nonlocal fail_second
        calls.append(context.step["id"])
        if context.step["id"] == "second" and fail_second:
            fail_second = False
            raise Error("temporary failure")
        count = int(context.variables.get("count") or 0) + 1
        return {"output": count, "statePatch": {"set": {"count": count}}}

    def runner():
        return AgentRuntime(
            run_store=store, step_executors=[executor("prompt", run_step)], id_generator=SequenceIdGenerator()
        )

    with pytest.raises(Error, match="temporary failure"):
        await runner().run(run_id="run-recover", manifest=two_steps)
    result = await runner().run(run_id="run-recover", resume=True)
    assert calls == ["first", "second", "second"]
    assert result["variables"]["count"] == 2
    store.close()


async def test_rejects_duplicate_runs_and_conflicting_checkpoint_identities(filename):
    store = SqliteRunStore(filename)
    await store.create_run(run_record("run-conflict"))
    with pytest.raises(Error, match="already exists"):
        await store.create_run(run_record("run-conflict"))
    await store.save_checkpoint(checkpoint("run-conflict", 1))
    with pytest.raises(Error, match="conflicts"):
        await store.save_checkpoint({**checkpoint("run-conflict", 1), "state": {"count": 99}})
    store.close()


async def test_fences_checkpoint_and_terminal_mutations_from_a_superseded_attempt(filename):
    store = SqliteRunStore(filename)
    await store.create_run(run_record("run-fenced", attempt=1))
    await store.save_checkpoint(checkpoint("run-fenced", 1, attempt=1))
    with pytest.raises(Error, match="still owned by a running attempt"):
        await store.resume_run("run-fenced", "2026-07-22T00:01:00.000Z")
    assert await store.resume_run("run-fenced", "2026-07-22T00:01:00.000Z", {"allowRunningTakeover": True}) == 2
    with pytest.raises(Error, match="owned by another attempt"):
        await store.save_checkpoint(checkpoint("run-fenced", 2, attempt=1))
    stale = {**run_record("run-fenced"), "attempt": 1, "status": "completed", "transcript": [], "artifacts": []}
    with pytest.raises(Error, match="owned by another attempt"):
        await store.complete_run(stale)
    with pytest.raises(Error, match="owned by another attempt"):
        await store.fail_run("run-fenced", {"code": "STALE", "message": "stale"}, "2026-07-22T00:02:00.000Z", 1)
    with pytest.raises(Error, match="owned by another attempt"):
        await store.cancel_run("run-fenced", "2026-07-22T00:02:00.000Z", 1)
    await store.save_checkpoint(checkpoint("run-fenced", 2, attempt=2))
    await store.cancel_run("run-fenced", "2026-07-22T00:03:00.000Z", 2)
    with pytest.raises(Error, match="Cannot checkpoint cancelled run"):
        await store.save_checkpoint(checkpoint("run-fenced", 3, attempt=2))
    store.close()


async def test_records_an_interrupted_run_that_can_be_resumed_or_cancelled(filename):
    store = SqliteRunStore(filename)
    try:
        await _interrupted_lifecycle(store)
    finally:
        store.close()
