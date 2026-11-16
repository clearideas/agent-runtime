"""Port of packages/core/src/workspaces.test.ts."""

from __future__ import annotations

import pytest

from clearideas_agent_runtime._js.abort import AbortController
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core import (
    AgentRuntime,
    RunSuspendedError,
    assert_workspace_path,
    is_safe_workspace_path,
    resolve_agent_workspaces,
    restrict_workspace,
)
from clearideas_agent_runtime.core.testing import CollectingEventSink, MemoryRunStore

from .helpers import executor


class FakeStore:
    def __init__(self, mode):
        self.mode = mode
        self.limits = {"maxFileBytes": 10}

    async def entries(self, signal=None):
        return []

    async def read(self, path, signal=None):
        return b""

    async def write(self, path, data, signal=None):
        return {"path": path, "size": 0}

    async def delete(self, path, signal=None):
        return None


class Provider:
    def __init__(self, stores):
        self.stores = stores

    async def resolve_workspace(self, binding, context=None):
        return self.stores.get(binding["ref"])


class FakeRunSandbox:
    def __init__(self):
        self.opened = []
        self.closed = []
        self.validated = []
        self.commands = 0
        self.fail_validate = False
        self.fail_close = False

    async def tools(self, workspace):
        return []

    async def validate(self, request):
        self.validated.append(request["runId"])
        if self.fail_validate:
            raise Error("image not allowed")

    async def open(self, request):
        self.opened.append(request)
        self.commands = (request.get("budget") or {}).get("commandsUsed", 0)
        await request["emit"]("sandbox.opened", {"sandboxId": "sb-1"})
        sandbox = self

        class Session:
            id = "sb-1"

            async def execute(self, command):
                sandbox.commands += 1
                await request["emit"]("sandbox.command.completed", {"name": command["name"]}, command["stepId"])
                return {"record": {}, "stdout": "", "stderr": "", "output": {"ran": command["name"]}}

            def budget(self):
                return {"commandsUsed": sandbox.commands, "sandboxSecondsUsed": sandbox.commands * 0.5}

            async def close(self, reason):
                sandbox.closed.append(reason)
                if sandbox.fail_close:
                    raise Error("sync failed")

        return Session()


def test_accepts_relative_posix_paths_with_safe_segments_only():
    for safe in ["src/index.ts", "README.md", "_package/__init__.py", "_"]:
        assert is_safe_workspace_path(safe)
    for unsafe in [
        "",
        "/etc/passwd",
        "../secret",
        "src/../../x",
        "src/./x",
        ".git/config",
        "-option",
        "_package/.hidden",
        "a//b",
        "a/",
        "with space.txt",
        "ünïcode.txt",
        "a\\b",
        "x" * 1025,
        "/".join(["a"] * 65),
    ]:
        assert not is_safe_workspace_path(unsafe), unsafe
    with pytest.raises(Error, match="safe segments"):
        assert_workspace_path("../x")


async def test_narrows_privileges_skips_optional_unknowns_and_rejects_elevation():
    manifest = {
        "schemaVersion": "1.0",
        "workspaces": [
            {"ref": "code", "alias": "src", "mode": "read"},
            {"ref": "docs"},
            {"ref": "scratch", "required": False},
        ],
        "steps": [],
    }
    resolved = await resolve_agent_workspaces(
        manifest, Provider({"code": FakeStore("read_write"), "docs": FakeStore("read_write")})
    )
    assert [[item.alias, item.mode] for item in resolved] == [["src", "read"], ["docs", "read_write"]]
    assert not hasattr(resolved[0].store, "write")
    assert resolved[0].store.limits == {"maxFileBytes": 10}
    assert callable(resolved[1].store.write)

    def single(binding):
        return {"schemaVersion": "1.0", "workspaces": [binding], "steps": []}

    with pytest.raises(Error, match="requires a WorkspaceProvider"):
        await resolve_agent_workspaces(single({"ref": "docs"}), None)
    with pytest.raises(Error, match='Unknown workspace "missing"'):
        await resolve_agent_workspaces(single({"ref": "missing"}), Provider({}))
    with pytest.raises(Error, match="cannot be elevated"):
        await resolve_agent_workspaces(
            single({"ref": "docs", "mode": "read_write"}), Provider({"docs": FakeStore("read")})
        )
    with pytest.raises(Error, match="cannot be elevated"):
        restrict_workspace(FakeStore("read"), "read_write")


def workspace_manifest(steps):
    return {"schemaVersion": "1.0", "workspaces": [{"ref": "docs", "mode": "read"}], "steps": steps}


def runtime(sandbox, run, run_store=None, events=None):
    return AgentRuntime(
        run_store=run_store or MemoryRunStore(),
        event_sinks=[events or CollectingEventSink()],
        workspaces=Provider({"docs": FakeStore("read_write")}),
        run_sandbox=sandbox,
        step_executors=[executor("prompt", run)],
    )


FIRST = [{"id": "first", "type": "prompt", "prompt": "x"}]


async def test_validates_before_creating_the_run_opens_lazily_records_budget_and_closes_on_completion():
    sandbox = FakeRunSandbox()
    run_store = MemoryRunStore()
    events = CollectingEventSink()
    seen = []

    async def run(context):
        seen.append(list(context.workspaces or []))
        session = await context.run_sandbox()
        await session.execute({"stepId": context.step["id"], "kind": "builtin", "name": "list_files", "arguments": {}})
        await context.checkpoint({"state": {**context.variables}})
        return {"output": "done"}

    await runtime(sandbox, run, run_store, events).run(run_id="run-1", manifest=workspace_manifest(FIRST))
    assert sandbox.validated == ["run-1"]
    assert len(sandbox.opened) == 1
    assert (sandbox.opened[0]["workspaces"][0].alias, sandbox.opened[0]["workspaces"][0].mode) == ("docs", "read")
    assert sandbox.closed == ["completed"]
    assert not hasattr(seen[0][0].store, "write")
    types = [event["type"] for event in events.events]
    assert types.index("workspace.bound") > types.index("run.started")
    assert "sandbox.opened" in types and "sandbox.command.completed" in types
    bound = next(event for event in events.events if event["type"] == "workspace.bound")["data"]
    assert (bound["workspace"], bound["alias"], bound["mode"]) == ("docs", "docs", "read")
    assert run_store.checkpoints["run-1"][-1]["metadata"] == {
        "sandboxBudget": {"commandsUsed": 1, "sandboxSecondsUsed": 0.5}
    }


async def test_does_not_open_a_sandbox_for_runs_that_never_use_it_and_fails_validation_before_create_run():
    sandbox = FakeRunSandbox()
    run_store = MemoryRunStore()
    runner = runtime(sandbox, lambda context: {"output": "ok"}, run_store)
    await runner.run(run_id="run-2", manifest=workspace_manifest(FIRST))
    assert sandbox.opened == []
    assert sandbox.closed == []
    sandbox.fail_validate = True
    with pytest.raises(Error, match="image not allowed"):
        await runner.run(run_id="run-3", manifest=workspace_manifest(FIRST))
    assert "run-3" not in run_store.runs


async def test_requires_a_run_sandbox_provider_when_workspaces_or_run_sandbox_code_steps_are_declared():
    runner = AgentRuntime(
        run_store=MemoryRunStore(),
        workspaces=Provider({"docs": FakeStore("read")}),
        step_executors=[executor("prompt", lambda context: {})],
    )
    with pytest.raises(Error, match="require a RunSandboxProvider"):
        await runner.run(run_id="run-4", manifest=workspace_manifest(FIRST))
    with pytest.raises(Error, match="require a RunSandboxProvider"):
        await runner.run(
            run_id="run-5",
            manifest={
                "schemaVersion": "1.0",
                "steps": [{"id": "c", "type": "code", "language": "python", "code": "", "sandbox": "run"}],
            },
        )


async def test_closes_with_failed_cancelled_and_suspended_reasons_and_restores_budget_on_resume():
    sandbox = FakeRunSandbox()
    run_store = MemoryRunStore()
    behaviour = "fail"
    controller = AbortController()

    async def run(context):
        session = await context.run_sandbox()
        await session.execute({"stepId": context.step["id"], "kind": "shell", "name": "shell", "arguments": {}})
        if behaviour == "fail":
            raise Error("boom")
        if behaviour == "cancel":
            controller.abort()
            raise Error("aborted")
        if behaviour == "suspend":
            await context.checkpoint({"state": {**context.variables}})
            raise RunSuspendedError("approval")
        return {"output": "ok"}

    runner = runtime(sandbox, run, run_store)
    with pytest.raises(Error, match="boom"):
        await runner.run(run_id="f", manifest=workspace_manifest(FIRST))
    behaviour = "cancel"
    with pytest.raises(Exception):  # noqa: B017
        await runner.run(run_id="c", manifest=workspace_manifest(FIRST), signal=controller.signal)
    behaviour = "suspend"
    with pytest.raises(RunSuspendedError, match="suspended"):
        await runner.run(run_id="s", manifest=workspace_manifest(FIRST))
    assert sandbox.closed == ["failed", "cancelled", "suspended"]
    assert (await run_store.load_latest_checkpoint("s"))["metadata"] == {
        "sandboxBudget": {"commandsUsed": 1, "sandboxSecondsUsed": 0.5}
    }
    behaviour = "ok"
    await runner.run(run_id="s", resume=True)
    assert sandbox.opened[-1]["budget"] == {"commandsUsed": 1, "sandboxSecondsUsed": 0.5}
    assert sandbox.opened[-1]["attempt"] == 2
    assert sandbox.closed[-1] == "completed"
    assert (await run_store.load_latest_checkpoint("s"))["metadata"] == {
        "sandboxBudget": {"commandsUsed": 2, "sandboxSecondsUsed": 1}
    }


async def test_fails_the_run_when_the_final_sync_back_cannot_complete():
    sandbox = FakeRunSandbox()
    sandbox.fail_close = True
    run_store = MemoryRunStore()

    async def run(context):
        await context.run_sandbox()
        return {"output": "ok"}

    with pytest.raises(Error, match="sync failed"):
        await runtime(sandbox, run, run_store).run(run_id="run-6", manifest=workspace_manifest(FIRST))
    assert (await run_store.load_run("run-6"))["status"] == "failed"
    assert sandbox.closed == ["completed"]
