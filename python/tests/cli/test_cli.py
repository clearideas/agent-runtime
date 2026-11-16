"""Port of the ``packages/cli/src/index.test.ts`` cases for the ported commands."""

from __future__ import annotations

import json

from clearideas_agent_runtime.cli import CliIo, run_cli
from clearideas_agent_runtime.stores.local import FileRunStore

AGENT = """schemaVersion: '1.0'
model:
  provider: test
  model: local
variables:
  - key: audience
    type: string
    requiresOverride: true
steps:
  - id: answer
    type: prompt
    prompt: Write for {{ audience }}.
    includeInFinalOutput: true
"""

RUN = """schemaVersion: '1.0'
agent:
  ref: release.agent.yaml
runId: release-run-1
variables:
  - key: audience
    value: partners
"""

RUNTIME = """
class _Model:
    async def generate(self, request):
        return {"output": "done", "transcript": []}


def create_runtime(context):
    return {"model": _Model()}
"""


class Capture:
    def __init__(self) -> None:
        self.out: list[str] = []
        self.err: list[str] = []
        self.io = CliIo(stdout=self.out.append, stderr=self.err.append)


async def test_prints_usage_and_rejects_unknown_commands() -> None:
    capture = Capture()
    assert await run_cli(["help"], capture.io) == 0
    assert "run-manifest <run.json|run.yaml>" in "".join(capture.out)
    assert await run_cli(["nope"], capture.io) == 2


async def test_runs_a_validated_agent_run_manifest_that_references_an_agent_manifest(tmp_path) -> None:
    (tmp_path / "release.agent.yaml").write_text(AGENT)
    (tmp_path / "release.run.yaml").write_text(RUN)
    (tmp_path / "runtime.py").write_text(RUNTIME)
    capture = Capture()
    store = tmp_path / "release-state"
    code = await run_cli(
        [
            "run-manifest",
            str(tmp_path / "release.run.yaml"),
            "--store",
            str(store),
            "--events",
            "none",
            "--runtime-module",
            str(tmp_path / "runtime.py"),
        ],
        capture.io,
    )
    assert code == 0, capture.err
    assert json.loads("".join(capture.out)) == {
        "runId": "release-run-1",
        "status": "completed",
        "stepCount": 1,
        "artifactCount": 0,
    }
    record = await FileRunStore(str(store)).load_run("release-run-1")
    assert record["status"] == "completed"
    assert record["output"] == "done"


async def test_rejects_run_options_that_an_agent_run_manifest_declares(tmp_path) -> None:
    (tmp_path / "release.run.yaml").write_text(RUN)
    capture = Capture()
    code = await run_cli(["run-manifest", str(tmp_path / "release.run.yaml"), "--run-id", "x"], capture.io)
    assert code == 1
    assert "".join(capture.err).startswith("Error: --variables, --run-id, --max-total-tokens, and --limits cannot be combined")
    capture = Capture()
    code = await run_cli(["run-manifest", str(tmp_path / "release.run.yaml"), "--messages", "m.json"], capture.io)
    assert code == 1
    assert "--messages cannot be combined with an agent run manifest" in "".join(capture.err)
