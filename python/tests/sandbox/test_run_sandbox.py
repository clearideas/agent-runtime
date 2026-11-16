"""Port of ``packages/sandbox/src/run-sandbox.test.ts`` (host-process provider, real helper)."""

from __future__ import annotations

import shutil

import pytest

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime.sandbox import ProviderRunSandbox
from clearideas_agent_runtime.sandbox.testing import HostProcessTestProvider

from .support import MemoryArtifacts, MemoryStore, open_session, resolved

pytestmark = pytest.mark.skipif(shutil.which("python3") is None, reason="the helper needs python3")


def request(step: str, kind: str, name: str, alias: str | None = None, **arguments: object) -> dict:
    value: dict = {"stepId": step, "kind": kind, "name": name, "arguments": arguments}
    if alias is not None:
        value["alias"] = alias
    return value


async def test_normalizes_tool_paths_before_helper_execution_and_sync_back() -> None:
    store = MemoryStore("read_write", {"reports/Q3-draft.md": "draft\n", "_package/__init__.py": "init\n"})
    session, _ = await open_session(
        ProviderRunSandbox(
            provider=HostProcessTestProvider(),
            image="test",
            commands={"show": {"argv": ["cat", "{file}"], "inputs": ["**/*.py"]}},
        ),
        [resolved("notes", store)],
    )
    try:
        for path in [None, "", ".", "/", "\\"]:
            listed = await session.execute(
                request("list", "builtin", "list_files", "notes", **({} if path is None else {"path": path}))
            )
            paths = [file["path"] for file in listed["output"]["files"]]
            assert "reports/Q3-draft.md" in paths and "_package/__init__.py" in paths
        write = await session.execute(
            request("write", "builtin", "write_file", "notes", path=".\\reports\\Q3-draft.md", content="published\n")
        )
        assert any(change["path"] == "reports/Q3-draft.md" for change in write["record"]["filesChanged"])
        assert store.text("reports/Q3-draft.md") == "published\n"
        read = await session.execute(request("read", "builtin", "read_file", "notes", path="/reports//./Q3-draft.md/"))
        assert read["output"]["content"] == "published"
        command = await session.execute(request("show", "command", "show", "notes", file=".\\_package\\__init__.py"))
        assert command["output"]["exitCode"] == 0 and command["output"]["stdout"] == "init\n"
        with pytest.raises(Exception) as raised:
            await session.execute(request("unsafe", "builtin", "read_file", "notes", path=".\\..\\outside.md"))
        assert raised.value.code == "workspace_path_invalid"  # type: ignore[attr-defined]
        await session.execute(request("delete", "builtin", "delete_file", "notes", path="reports\\.\\Q3-draft.md"))
        assert "reports/Q3-draft.md" not in store.files
    finally:
        await session.close("completed")


async def test_stages_mounts_serves_helper_operations_syncs_and_reports() -> None:
    provider = HostProcessTestProvider()
    artifacts = MemoryArtifacts()
    code = MemoryStore(
        "read",
        {"README.md": "# Title\nhello world\n", "src/app.py": "print('x')\n", "logo.png": "\u0089PNG\u0000\u0001"},
    )
    notes = MemoryStore("read_write", {"old.md": "old\n"})
    authorized: list[str] = []
    run_sandbox = ProviderRunSandbox(
        provider=provider,
        image="test",
        limits={"maxCommandsPerRun": 20},
        authorize_command=lambda hook, _context: authorized.append(hook["record"]["name"]),
    )
    session, events = await open_session(
        run_sandbox, [resolved("code", code), resolved("notes", notes)], artifacts=artifacts
    )
    assert [event["type"] for event in events] == ["sandbox.opened"]
    mounts = events[0]["data"]["mounts"]
    assert [(mount["alias"], mount["mode"], mount["fileCount"], mount["attached"]) for mount in mounts] == [
        ("code", "read", 3, False),
        ("notes", "read_write", 1, False),
    ]
    listed = await session.execute(
        {**request("survey", "builtin", "list_files", "code", glob="**/*.py"), "toolCallId": "call-1"}
    )
    assert listed["output"]["truncated"] is False
    assert [(file["path"], file["mediaType"], file["size"]) for file in listed["output"]["files"]] == [
        ("src/app.py", "text/x-python", 11)
    ]
    record = listed["record"]
    assert (
        record["id"],
        record["kind"],
        record["alias"],
        record["workspace"],
        record["toolCallId"],
        record["exitCode"],
    ) == (
        "cmd-1-1",
        "builtin",
        "code",
        "code-ref",
        "call-1",
        0,
    )
    assert record["budget"]["commandsUsed"] == 1 and record["budget"]["commandsLimit"] == 20
    assert record["argv"][2] == "list"
    assert authorized == ["list_files"]
    read = await session.execute(request("survey", "builtin", "read_file", "code", path="README.md", startLine=2))
    assert (
        read["output"]["content"],
        read["output"]["startLine"],
        read["output"]["totalLines"],
        read["output"]["encoding"],
    ) == (
        "hello world",
        2,
        2,
        "utf-8",
    )
    search = await session.execute(request("survey", "builtin", "search_files", "code", query="HELLO"))
    assert search["output"] == {
        "matches": [{"path": "README.md", "line": 2, "text": "hello world"}],
        "truncated": False,
    }
    binary = await session.execute(request("survey", "builtin", "read_file", "code", path="logo.png"))
    assert binary["output"] == {
        "path": "logo.png",
        "size": 7,
        "mediaType": "image/png",
        "encoding": "binary",
        "artifactId": "artifact-1",
    }
    assert binary["artifacts"] == [{"id": "artifact-1", "name": "logo.png", "mediaType": "image/png"}]
    assert artifacts.items[0]["metadata"]["commandId"] == "cmd-1-4"
    write = await session.execute(
        request("draft", "builtin", "write_file", "notes", path="draft/review.md", content="# Review\n")
    )
    assert write["output"]["path"] == "draft/review.md" and write["output"]["size"] == 9
    change = write["record"]["filesChanged"][0]
    assert (change["alias"], change["path"], change["action"], change["size"]) == (
        "notes",
        "draft/review.md",
        "created",
        9,
    )
    assert notes.text("draft/review.md") == "# Review\n"
    removed = await session.execute(request("draft", "builtin", "delete_file", "notes", path="old.md"))
    assert removed["output"] == {"path": "old.md", "deleted": True}
    assert removed["record"]["filesChanged"] == [{"alias": "notes", "path": "old.md", "action": "deleted"}]
    await session.close("completed")
    assert len(provider.terminated) == 1
    types = [event["type"] for event in events]
    assert types.count("sandbox.command.started") == 6 and types.count("sandbox.command.completed") == 6
    assert types[-1] == "sandbox.closed"
    assert events[-1]["data"]["finalSync"] == {"filesChanged": 0, "ignored": 0}
    started = next(event for event in events if event["type"] == "sandbox.command.started")
    assert started["stepId"] == "survey" and started["data"]["commandId"] == "cmd-1-1"
    assert session.budget()["commandsUsed"] == 6


async def test_maps_failures_to_tool_error_codes_and_never_syncs_read_only_mounts() -> None:
    code = MemoryStore("read", {"a.md": "x\n"})
    session, _ = await open_session(
        ProviderRunSandbox(provider=HostProcessTestProvider(), image="test", shell={"enabled": True}),
        [resolved("code", code)],
    )

    async def fails(value: dict, expected: str) -> None:
        with pytest.raises(Exception) as raised:
            await session.execute(value)
        assert getattr(raised.value, "code", None) == expected, raised.value

    await fails(request("s", "builtin", "read_file", "code", path="missing.md"), "workspace_path_invalid")
    await fails(request("s", "builtin", "read_file", "code", path="../x"), "workspace_path_invalid")
    await fails(request("s", "builtin", "write_file", "code", path="a.md", content="y"), "tool_not_allowed")
    await fails(request("s", "builtin", "list_files", "other"), "tool_not_allowed")
    shell = await session.execute(
        request("s", "shell", "shell", "code", command="echo hacked > a.md; echo extra > extra.md; echo done")
    )
    assert shell["output"]["exitCode"] == 0 and shell["output"]["stdout"] == "done\n"
    assert shell["record"]["filesChanged"] == []
    assert code.text("a.md") == "x\n" and code.writes == []
    await session.close("failed")


async def test_enforces_timeouts_output_ceilings_budgets_and_authorization() -> None:
    notes = MemoryStore("read_write")

    def authorize(hook: dict, _context: dict) -> None:
        if any("forbidden" in argument for argument in hook["record"]["argv"]):
            raise Exception("denied by host")

    session, events = await open_session(
        ProviderRunSandbox(
            provider=HostProcessTestProvider(),
            image="test",
            shell={"enabled": True, "timeoutMs": 500},
            limits={"maxStdoutBytes": 16, "maxCommandsPerRun": 3},
            authorize_command=authorize,
        ),
        [resolved("notes", notes)],
    )
    with pytest.raises(Exception) as raised:
        await session.execute(request("s", "shell", "shell", "notes", command="echo forbidden"))
    assert raised.value.code == "tool_not_authorized" and str(raised.value) == "denied by host"  # type: ignore[attr-defined]
    assert not any(event["type"] == "sandbox.command.started" for event in events)
    big = await session.execute(
        request("s", "shell", "shell", "notes", command="printf '%s' 0123456789abcdef0123456789")
    )
    assert big["output"]["stdout"] == "0123456789abcdef" and big["output"]["truncated"] is True
    assert big["record"]["stdoutBytes"] == 16 and big["record"]["stdoutTruncated"] is True
    with pytest.raises(Exception) as raised:
        await session.execute(request("s", "shell", "shell", "notes", command="sleep 5"))
    assert raised.value.code == "sandbox_command_timeout"  # type: ignore[attr-defined]
    completed = [event for event in events if event["type"] == "sandbox.command.completed"]
    assert completed[-1]["data"]["timedOut"] is True and completed[-1]["data"]["name"] == "shell"
    await session.execute(request("s", "shell", "shell", "notes", command="true"))
    with pytest.raises(Exception) as raised:
        await session.execute(request("s", "shell", "shell", "notes", command="true"))
    assert raised.value.code == "sandbox_budget_exhausted"  # type: ignore[attr-defined]
    await session.close("cancelled")


async def test_runs_code_steps_with_variables_outputs_and_mounts() -> None:
    artifacts = MemoryArtifacts()
    code = MemoryStore("read", {"data.txt": "42\n"})
    session, _ = await open_session(
        ProviderRunSandbox(provider=HostProcessTestProvider(), image="test", allowed_environment=["SAFE"]),
        [resolved("code", code)],
        artifacts=artifacts,
    )
    source = "\n".join(
        [
            "import json, os",
            "mounts = json.load(open(os.environ['AGENT_WORKSPACES_FILE']))['mounts']",
            "value = open(mounts['code']['path'] + '/data.txt').read().strip()",
            "variables = json.load(open(os.environ['AGENT_VARIABLES_FILE']))",
            "print(json.dumps({'value': int(value) * variables['factor'], 'safe': os.environ.get('SAFE'), 'secret': os.environ.get('SECRET')}))",
            "open(os.environ['AGENT_OUTPUT_DIRECTORY'] + '/report.txt', 'w').write('done')",
        ]
    )
    result = await session.execute(
        request(
            "compute",
            "code",
            "compute",
            language="python",
            code=source,
            variables={"factor": 2},
            environment={"SAFE": "yes", "SECRET": "no"},
        )
    )
    assert result["stderr"] == ""
    assert js_json.parse(result["output"]) == {"value": 84, "safe": "yes", "secret": None}
    assert (result["record"]["kind"], result["record"]["name"], result["record"]["exitCode"]) == ("code", "compute", 0)
    assert result["artifacts"] == [{"id": "artifact-1", "name": "report.txt", "mediaType": "text/plain"}]
    await session.close("completed")


async def test_reports_rejected_files_and_resumes_budgets() -> None:
    notes = MemoryStore("read_write")
    notes.fail_writes = True
    session, _ = await open_session(
        ProviderRunSandbox(provider=HostProcessTestProvider(), image="test", shell={"enabled": True}),
        [resolved("notes", notes)],
        budget={"commandsUsed": 5, "sandboxSecondsUsed": 1.5},
        attempt=2,
    )
    result = await session.execute(
        request("s", "shell", "shell", "notes", command="echo hi > new.md; mkdir -p d; echo x > 'd/bad name.md'")
    )
    assert result["record"]["id"] == "cmd-2-1"
    assert result["record"]["budget"]["commandsUsed"] == 6
    assert result["record"]["filesChanged"] == []
    ignored = result["record"]["ignoredPaths"]
    assert {"alias": "notes", "path": "d/bad name.md", "reason": "path"} in ignored
    assert any(entry["path"] == "new.md" and "store rejected" in entry["reason"] for entry in ignored)
    await session.close("suspended")


async def test_fails_validation_for_oversized_workspaces_and_unreadable_helpers() -> None:
    provider = HostProcessTestProvider()
    big = MemoryStore("read", {"a.txt": "x" * 100})
    with pytest.raises(Exception, match="staging limit"):
        await ProviderRunSandbox(provider=provider, image="test", limits={"maxTotalStagedBytes": 50}).validate(
            {"runId": "r", "attempt": 1, "workspaces": [resolved("big", big)]}
        )
    with pytest.raises(Exception, match="helper is not readable"):
        await ProviderRunSandbox(provider=provider, image="test", helper_source="/nonexistent/agent-fs.py").validate(
            {"runId": "r", "attempt": 1, "workspaces": []}
        )
    assert provider.specs == []


async def test_describes_tools_per_binding_without_opening() -> None:
    run_sandbox = ProviderRunSandbox(
        provider=HostProcessTestProvider(), image="test", commands={"lint": {"program": "eslint"}}
    )
    tools = await run_sandbox.tools(resolved("code", MemoryStore("read"), ["read_file", "lint"]))
    assert [tool["name"] for tool in tools] == ["read_file", "lint"]
    assert run_sandbox.policy["limits"]["maxCommandsPerRun"] == 200


def test_bundled_helper_is_identical_to_the_typescript_asset() -> None:
    from pathlib import Path

    from clearideas_agent_runtime.sandbox import bundled_helper_path

    repository = Path(__file__).resolve().parents[3]
    assert Path(bundled_helper_path()).read_bytes() == (repository / "packages/sandbox/assets/agent-fs.py").read_bytes()
