"""Port of ``packages/runtime/src/workspace-tools.test.ts`` (composition through the run sandbox)."""

from __future__ import annotations

import itertools
import shutil

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.config import (
    ComposeRuntimeOptions,
    WorkspaceCompositionOptions,
    compose_runtime,
    parse_agent_runtime_config,
    validate_runtime_configuration,
)
from clearideas_agent_runtime.contracts._zod import ZodError
from clearideas_agent_runtime.core import AgentRuntime
from clearideas_agent_runtime.core.testing import MemoryRunStore
from clearideas_agent_runtime.sandbox.testing import HostProcessTestProvider
from clearideas_agent_runtime.steps.prompt import PromptStepExecutor

pytestmark = pytest.mark.skipif(shutil.which("python3") is None, reason="the helper needs python3")


def workspace_config(root: str, **sandbox: object) -> dict:
    return parse_agent_runtime_config(
        {
            "version": "1.0",
            "workspaces": {
                "repo": {"driver": "local", "root": root, "mode": "read_write"},
                "docs": {"driver": "local", "root": root},
            },
            "sandbox": {
                "driver": "host",
                "shell": {"enabled": True},
                "commands": {"count": {"argv": ["wc", "-l", "{file}"]}},
                **sandbox,
            },
        }
    )


def test_parses_workspace_and_sandbox_sections_and_rejects_invalid_policy(tmp_path) -> None:
    config = workspace_config(str(tmp_path))
    assert config["workspaces"]["docs"] == {"driver": "local", "root": str(tmp_path), "mode": "read", "attach": "never"}
    assert config["sandbox"]["shell"]["enabled"] is True
    with pytest.raises(ZodError, match="Docker sandboxes require an image"):
        parse_agent_runtime_config({"version": "1.0", "sandbox": {"driver": "docker"}})
    with pytest.raises(ZodError, match="references unknown workspace"):
        parse_agent_runtime_config(
            {
                "version": "1.0",
                "sandbox": {"driver": "host", "commands": {"x": {"program": "p", "workspaces": ["nope"]}}},
            }
        )


def test_validates_manifest_bindings_against_the_configuration(tmp_path) -> None:
    config = workspace_config(str(tmp_path))
    manifest = {"schemaVersion": "1.0", "steps": [{"id": "noop", "type": "loop", "steps": []}]}
    with pytest.raises(Error, match='Unknown workspace "missing"'):
        validate_runtime_configuration({**manifest, "workspaces": [{"ref": "missing"}]}, config)
    with pytest.raises(Error, match="cannot be elevated"):
        validate_runtime_configuration({**manifest, "workspaces": [{"ref": "docs", "mode": "read_write"}]}, config)
    with pytest.raises(Error, match="names a tool the host does not expose: deploy"):
        validate_runtime_configuration({**manifest, "workspaces": [{"ref": "repo", "tools": ["deploy"]}]}, config)
    with pytest.raises(Error, match="names write_file, which requires read_write"):
        validate_runtime_configuration({**manifest, "workspaces": [{"ref": "docs", "tools": ["write_file"]}]}, config)
    no_sandbox = parse_agent_runtime_config(
        {"version": "1.0", "workspaces": {"docs": {"driver": "local", "root": str(tmp_path)}}}
    )
    with pytest.raises(Error, match="require a sandbox section"):
        validate_runtime_configuration({**manifest, "workspaces": [{"ref": "docs"}]}, no_sandbox)


async def test_composes_providers_and_runs_workspace_tools_through_the_run_sandbox(tmp_path) -> None:
    (tmp_path / "notes.md").write_text("one\ntwo\n")
    config = workspace_config(str(tmp_path))
    manifest = {
        "schemaVersion": "1.0",
        "model": {"provider": "test", "model": "m"},
        "workspaces": [{"ref": "repo", "alias": "repo"}],
        "steps": [
            {
                "id": "edit",
                "type": "prompt",
                "prompt": "Edit the notes.",
                "tools": ["repo__read_file", "repo__write_file", "repo__count"],
            }
        ],
    }
    composed = compose_runtime(
        manifest,
        config,
        options=ComposeRuntimeOptions(
            model=False, workspace_options=WorkspaceCompositionOptions(sandbox_provider=HostProcessTestProvider())
        ),
    )
    tools = await composed.tools.list_tools()
    assert [tool["name"] for tool in tools] == [
        "repo__list_files",
        "repo__read_file",
        "repo__search_files",
        "repo__write_file",
        "repo__delete_file",
        "repo__count",
        "repo__shell",
    ]
    assert tools[1]["metadata"] == {
        "workspace": "repo",
        "workspaceAlias": "repo",
        "workspaceMode": "read_write",
        "sourceTool": "read_file",
        "kind": "builtin",
        "readOnly": True,
        "destructive": False,
        "sandboxed": True,
    }
    turns = iter(
        [
            [("repo__read_file", {"path": "notes.md"})],
            [
                ("repo__write_file", {"path": "notes.md", "content": "one\ntwo\nthree\n"}),
                ("repo__count", {"file": "notes.md"}),
            ],
            [("repo__read_file", {"path": "../escape"})],
            [],
        ]
    )
    counter = itertools.count(1)

    class Model:
        async def generate(self, request: dict) -> dict:
            calls = [{"id": f"c{next(counter)}", "name": name, "input": arguments} for name, arguments in next(turns)]
            return {
                "output": "" if calls else "done",
                "toolCalls": calls,
                "transcript": [
                    {
                        "id": f"a{next(counter)}",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "tool-call", "call": call} for call in calls]
                        or [{"type": "text", "text": "done"}],
                        "createdAt": "t",
                    }
                ],
            }

    events: list[dict] = []

    class Sink:
        def emit(self, event: dict) -> None:
            events.append(event)

    runtime = AgentRuntime(
        run_store=MemoryRunStore(),
        model=Model(),
        tools=composed.tools,
        workspaces=composed.workspaces,
        run_sandbox=composed.run_sandbox,
        event_sinks=[Sink()],
        step_executors=[PromptStepExecutor()],
    )
    result = await runtime.run({"manifest": manifest})
    assert result["output"] == "done", result
    assert (tmp_path / "notes.md").read_text() == "one\ntwo\nthree\n"
    results = [
        part["result"] for item in result["transcript"] for part in item["content"] if part["type"] == "tool-result"
    ]
    assert results[0]["output"]["content"] == "one\ntwo"
    assert results[0]["metadata"]["command"]["name"] == "read_file"
    assert results[2]["output"]["exitCode"] == 0 and results[2]["output"]["stdout"].strip().startswith("3")
    assert results[3]["error"]["code"] == "workspace_path_invalid"
    types = [event["type"] for event in events]
    assert types.count("sandbox.opened") == 1 and types.count("sandbox.closed") == 1
    assert types.count("sandbox.command.completed") == 3


def test_prefers_host_supplied_providers_and_rejects_bindings_without_a_sandbox(tmp_path) -> None:
    config = parse_agent_runtime_config(
        {"version": "1.0", "workspaces": {"docs": {"driver": "local", "root": str(tmp_path)}}}
    )
    manifest = {
        "schemaVersion": "1.0",
        "workspaces": [{"ref": "docs"}],
        "steps": [{"id": "noop", "type": "loop", "steps": []}],
    }
    with pytest.raises(
        Error, match="require a sandbox section in the runtime configuration or a host-supplied run sandbox"
    ):
        compose_runtime(manifest, config, options=ComposeRuntimeOptions(model=False))
    host_provider = object()
    composed = compose_runtime(
        manifest,
        config,
        options=ComposeRuntimeOptions(
            model=False, workspace_options=WorkspaceCompositionOptions(provider=host_provider, run_sandbox=object())
        ),
    )
    assert composed.workspaces is host_provider
