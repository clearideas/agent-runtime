"""The Python and TypeScript command lines: same documents, shared stores."""

from __future__ import annotations

import shutil
import subprocess
import sys

import pytest

from clearideas_agent_runtime._js import json as js_json

from .conftest import REPOSITORY
from .mock_provider import MockProvider

CLI = REPOSITORY / "packages" / "cli" / "dist" / "bin.js"


@pytest.fixture(autouse=True)
def _built_cli(oracle) -> None:
    """The oracle fixture requires Node.js and the built packages; the CLI must be built too."""
    assert CLI.exists(), "the TypeScript CLI is not built (npm run build)"


def typescript(*args: str, cwd: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [shutil.which("node"), str(CLI), *args], capture_output=True, text=True, cwd=cwd, env=env, check=False
    )  # type: ignore[list-item]


def python(*args: str, cwd: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "clearideas_agent_runtime.cli", *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
        check=False,
    )


def test_validate_and_config_documents_match(tmp_path, oracle) -> None:
    (tmp_path / "agent.yaml").write_text(
        "schemaVersion: '1.0'\nid: demo\nname: Demo\nmodel: {provider: openai, model: gpt-test}\nsteps:\n  - {id: a, type: prompt, prompt: Hi}\n"
    )
    (tmp_path / "config.yaml").write_text(
        "version: '1.0'\nproviders:\n  local: {driver: openai-compatible, baseURL: 'http://localhost:1/v1'}\nsandbox: {driver: bubblewrap}\n"
    )
    (tmp_path / "bad.yaml").write_text("schemaVersion: '1.0'\nsteps: []\n")
    for args in (
        ["validate", "agent.yaml"],
        ["config", "validate", "config.yaml"],
        ["validate", "bad.yaml"],
        ["validate", "agent.yaml", "--nope", "x"],
    ):
        expected = typescript(*args, cwd=str(tmp_path))
        actual = python(*args, cwd=str(tmp_path))
        assert (actual.returncode, actual.stdout) == (expected.returncode, expected.stdout), args
        if expected.returncode:
            assert actual.stderr.splitlines()[0] == expected.stderr.splitlines()[0], args


def test_a_run_started_by_one_cli_is_inspected_and_resumed_by_the_other(tmp_path, oracle) -> None:
    with MockProvider() as mock:
        mock.replies["cli"] = {"kind": "text", "text": "answer"}
        (tmp_path / "agent-runtime.config.json").write_text(
            js_json.stringify(
                {
                    "version": "1.0",
                    "providers": {
                        "local": {
                            "driver": "openai-compatible",
                            "baseURL": mock.url + "/v1",
                            "headers": {"x-case": {"env": "CASE"}},
                        }
                    },
                }
            )
        )
        (tmp_path / "agent.json").write_text(
            js_json.stringify(
                {
                    "schemaVersion": "1.0",
                    "model": {"provider": "local", "model": "llama3"},
                    "steps": [
                        {"id": "first", "type": "prompt", "prompt": "One", "outputVariable": "one"},
                        {"id": "second", "type": "prompt", "prompt": "Two {{ one }}", "includeInFinalOutput": True},
                    ],
                }
            )
        )
        import os

        env = {**os.environ, "CASE": "cli"}
        started = typescript("run", "agent.json", "--run-id", "shared", "--format", "json", cwd=str(tmp_path), env=env)
        assert started.returncode == 0, started.stderr
        inspected_ts = typescript("inspect", "shared", cwd=str(tmp_path), env=env)
        inspected_py = python("inspect", "shared", cwd=str(tmp_path), env=env)
        assert js_json.parse(inspected_py.stdout)["run"] == js_json.parse(inspected_ts.stdout)["run"]
        again = python("run", "agent.json", "--run-id", "py-run", "--format", "json", cwd=str(tmp_path), env=env)
        assert again.returncode == 0, again.stderr
        summary = js_json.parse(again.stdout)
        assert summary == {"runId": "py-run", "status": "completed", "stepCount": 2, "artifactCount": 0}
        read_back = typescript("inspect", "py-run", cwd=str(tmp_path), env=env)
        assert js_json.parse(read_back.stdout)["run"]["status"] == "completed"


def test_an_agent_run_manifest_runs_identically_in_both_clis(tmp_path, oracle) -> None:
    import os

    with MockProvider() as mock:
        mock.replies["run-manifest"] = {"kind": "text", "text": "done"}
        (tmp_path / "agent-runtime.config.json").write_text(
            js_json.stringify(
                {
                    "version": "1.0",
                    "providers": {
                        "local": {
                            "driver": "openai-compatible",
                            "baseURL": mock.url + "/v1",
                            "headers": {"x-case": {"env": "CASE"}},
                        }
                    },
                }
            )
        )
        (tmp_path / "release.agent.yaml").write_text(
            "\n".join(
                [
                    "schemaVersion: '1.0'",
                    "model:",
                    "  provider: local",
                    "  model: llama3",
                    "variables:",
                    "  - key: audience",
                    "    type: string",
                    "    requiresOverride: true",
                    "steps:",
                    "  - id: answer",
                    "    type: prompt",
                    "    prompt: Write for {{ audience }}.",
                    "    includeInFinalOutput: true",
                ]
            )
        )
        for run_id in ("ts-run", "py-run"):
            (tmp_path / f"{run_id}.run.yaml").write_text(
                "\n".join(
                    [
                        "schemaVersion: '1.0'",
                        "agent:",
                        "  ref: release.agent.yaml",
                        f"runId: {run_id}",
                        "variables:",
                        "  - key: audience",
                        "    value: partners",
                    ]
                )
            )
        env = {**os.environ, "CASE": "run-manifest"}
        common = ("--events", "none", "--artifacts", "none", "--format", "json")
        ts = typescript("run-manifest", "ts-run.run.yaml", *common, cwd=str(tmp_path), env=env)
        assert ts.returncode == 0, ts.stderr
        py = python("run-manifest", "py-run.run.yaml", *common, cwd=str(tmp_path), env=env)
        assert py.returncode == 0, py.stderr
        assert {**js_json.parse(py.stdout), "runId": "ts-run"} == js_json.parse(ts.stdout)
        records = {
            run_id: js_json.parse(python("inspect", run_id, cwd=str(tmp_path), env=env).stdout)["run"]
            for run_id in ("ts-run", "py-run")
        }
        for field in ("manifest", "manifestHash", "variables", "status", "output"):
            assert records["py-run"].get(field) == records["ts-run"].get(field), field
        rejected = python("run-manifest", "py-run.run.yaml", "--run-id", "x", cwd=str(tmp_path), env=env)
        assert rejected.returncode == 1
        assert (
            rejected.stderr
            == typescript("run-manifest", "py-run.run.yaml", "--run-id", "x", cwd=str(tmp_path), env=env).stderr
        )
