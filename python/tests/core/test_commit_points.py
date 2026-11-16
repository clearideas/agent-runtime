"""Durable step boundaries commit workspace changes and retain input versions."""

from __future__ import annotations

import copy

from clearideas_agent_runtime.core import AgentRuntime
from clearideas_agent_runtime.core.testing import CollectingEventSink, MemoryRunStore

from .helpers import executor


class Workspace:
    def __init__(self, mode, commits):
        self.mode = mode
        self.commits = commits

    async def entries(self, signal=None):
        return []

    async def read(self, path, signal=None):
        return b""

    async def version(self, signal=None):
        return "library-v7"

    async def commit(self, point):
        self.commits.append(copy.deepcopy(point))
        return {"token": f"snapshot-{len(self.commits)}"}


class WorkspaceProvider:
    def __init__(self, commits):
        self.commits = commits

    async def resolve_workspace(self, binding, context=None):
        return Workspace("read_write" if binding["ref"] == "notes" else "read", self.commits)


class Sandbox:
    async def tools(self, workspace):
        return []

    async def validate(self, request):
        return None

    async def open(self, request):
        class Session:
            id = "sb"

            def __init__(self):
                self.pending = []

            async def execute(self, command):
                self.pending.extend(command["arguments"]["changes"])
                return {"record": {}, "stdout": "", "stderr": ""}

            def budget(self):
                return {"commandsUsed": 0, "sandboxSecondsUsed": 0}

            def take_changes(self):
                changes, self.pending = self.pending, []
                return {"notes": {"changes": changes, "notPersisted": []}} if changes else {}

            async def close(self, reason):
                return None

        return Session()


async def test_commits_changed_workspace_at_step_boundary_and_retains_input_version():
    commits = []
    runs = MemoryRunStore()
    events = CollectingEventSink()

    async def execute(context):
        if context.step["id"] == "write":
            session = await context.run_sandbox()
            await session.execute(
                {
                    "stepId": "write",
                    "kind": "shell",
                    "name": "shell",
                    "alias": "notes",
                    "arguments": {"changes": [{"path": "a.md", "action": "created"}]},
                }
            )
        return {"output": context.step["id"]}

    runner = AgentRuntime(
        run_store=runs,
        event_sinks=[events],
        workspaces=WorkspaceProvider(commits),
        run_sandbox=Sandbox(),
        step_executors=[executor("prompt", execute)],
    )
    await runner.run(
        run_id="commit",
        manifest={
            "schemaVersion": "1.0",
            "workspaces": [{"ref": "notes", "mode": "read_write"}, {"ref": "library", "mode": "read"}],
            "steps": [{"id": key, "type": "prompt", "prompt": key} for key in ("write", "think")],
        },
    )
    assert len(commits) == 1
    assert commits[0]["changes"] == [{"path": "a.md", "action": "created"}]
    assert commits[0]["executionKey"] == "write"
    boundary = next(item for item in runs.checkpoints["commit"] if item.get("boundary", {}).get("stepPath") == "write")
    assert boundary["workspaces"]["notes"]["token"] == "snapshot-1"
    assert boundary["inputs"]["library"]["token"] == "library-v7"
    assert any(event["type"] == "workspace.committed" for event in events.events)
