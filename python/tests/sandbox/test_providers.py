"""Bubblewrap, Docker, and provider-adapter behaviour (``bubblewrap.test.ts``, ``docker.test.ts``,
``provider-adapter.test.ts``)."""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import ClassVar

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.sandbox import (
    BubblewrapSandboxProvider,
    DockerSandboxProvider,
    ProviderRunSandbox,
    ProviderSandboxAdapter,
)

from .support import MemoryArtifacts, MemoryStore, open_session, resolved


def _bubblewrap_works() -> bool:
    if shutil.which("bwrap") is None or shutil.which("python3") is None:
        return False
    probe = subprocess.run(
        ["bwrap", "--unshare-all", "--ro-bind", "/", "/", "--", "/bin/true"], capture_output=True, check=False
    )
    return probe.returncode == 0


bubblewrap = pytest.mark.skipif(not _bubblewrap_works(), reason="bubblewrap with user namespaces is unavailable")


def spec(**overrides: object) -> dict:
    return {
        "image": "local",
        "workingDirectory": "/workspace",
        "network": "none",
        "limits": {"timeoutMs": 10_000, "memoryMb": 512, "processLimit": 64},
        **overrides,
    }


@bubblewrap
async def test_bubblewrap_isolates_network_and_filesystem_and_cleans_up(tmp_path) -> None:
    provider = BubblewrapSandboxProvider(state_directory=str(tmp_path / "state"))
    handle = await provider.create(spec())
    try:
        await provider.put_files(handle, [{"path": "/workspace/in/data.txt", "content": "hello", "mode": 0o600}])
        events = [
            event
            async for event in provider.execute(
                handle,
                {
                    "command": "python3",
                    "args": [
                        "-c",
                        "import os,socket;print(open('in/data.txt').read());print(os.path.exists('/home'));socket.create_connection(('1.1.1.1',80),1)",
                    ],
                    "cwd": "/workspace",
                    "timeoutMs": 10_000,
                },
            )
        ]
        stdout = "".join(event["data"] for event in events if event["type"] == "stdout")
        assert stdout.splitlines()[:2] == ["hello", "False"]
        assert events[-1]["type"] == "exit" and events[-1]["exitCode"] != 0
        await provider.put_files(handle, [{"path": "/workspace/out/a.txt", "content": b"\x00\x01"}])
        assert await provider.list_files(handle, "/workspace/out") == [{"path": "/workspace/out/a.txt", "size": 2}]
        assert await provider.read_file(handle, "/workspace/out/a.txt") == b"\x00\x01"
    finally:
        await provider.terminate(handle)
    assert os.listdir(tmp_path / "state") == []


@bubblewrap
async def test_bubblewrap_runs_the_complete_run_sandbox_with_the_bundled_helper(tmp_path) -> None:
    notes = MemoryStore("read_write", {"a.md": "alpha\n"})
    attached = tmp_path / "docs"
    attached.mkdir()
    (attached / "guide.md").write_text("guide text\n")

    class Attachable(MemoryStore):
        attachable: ClassVar[dict] = {"kind": "local-directory", "root": str(attached)}

    docs = Attachable("read", {"guide.md": "guide text\n"})
    session, events = await open_session(
        ProviderRunSandbox(provider=BubblewrapSandboxProvider(state_directory=str(tmp_path / "state")), image="local"),
        [resolved("notes", notes), resolved("docs", docs)],
        artifacts=MemoryArtifacts(),
    )
    try:
        assert events[0]["data"]["mounts"][1]["attached"] is True
        read = await session.execute(
            {"stepId": "s", "kind": "builtin", "name": "read_file", "alias": "docs", "arguments": {"path": "guide.md"}}
        )
        assert read["output"]["content"] == "guide text"
        await session.execute(
            {
                "stepId": "s",
                "kind": "builtin",
                "name": "write_file",
                "alias": "notes",
                "arguments": {"path": "b.md", "content": "beta"},
            }
        )
        assert notes.text("b.md") == "beta"
    finally:
        await session.close("completed")


async def test_bubblewrap_validation_rejects_network_attachments_and_foreign_handles() -> None:
    provider = BubblewrapSandboxProvider(binary="/nonexistent/bwrap")
    with pytest.raises(Error, match="only permits network: none"):
        await provider.validate(spec(network="restricted"))
    with pytest.raises(Error, match="Attachment source must be absolute"):
        await provider.validate(spec(attachments=[{"source": "relative", "target": "/workspace/mounts/a"}]))
    with pytest.raises(Error, match="does not belong"):
        await provider.put_files({"id": "x", "provider": "docker"}, [])
    with pytest.raises(Error, match="bubblewrap is unavailable"):
        await provider.validate(spec())


async def test_docker_validates_images_attachments_and_labels_without_docker(tmp_path) -> None:
    log = tmp_path / "calls.log"
    fake = tmp_path / "docker"
    fake.write_text(f'#!/bin/sh\necho "$@" >> {log}\nif [ "$1" = create ]; then echo 0123456789abcdef; fi\nexit 0\n')
    fake.chmod(0o755)
    provider = DockerSandboxProvider(allowed_images=["python:3.12-slim"], binary=str(fake))
    with pytest.raises(Error, match="not allowed"):
        await provider.validate(spec(image="other"))
    with pytest.raises(Error, match="without colons"):
        await provider.validate(
            spec(image="python:3.12-slim", attachments=[{"source": "/a:b", "target": "/workspace/mounts/a"}])
        )
    with pytest.raises(Error, match="label is invalid"):
        await provider.validate(spec(image="python:3.12-slim", metadata={"Bad": "x"}))
    handle = await provider.create(spec(image="python:3.12-slim", metadata={"agent-runtime.run": "r1"}))
    assert handle["providerData"] == {"containerId": "0123456789abcdef"}
    await provider.terminate(handle)
    calls = log.read_text().strip().split("\n")
    assert (
        calls[0].startswith("create --name agent-runtime-")
        and "--network none" in calls[0]
        and "--label agent-runtime.run=r1" in calls[0]
    )
    assert calls[1] == "start 0123456789abcdef"
    assert calls[-1] == "rm -f 0123456789abcdef"


class _FakeProvider:
    name = "fake"

    def __init__(self, files: list[dict], outputs: dict[str, bytes], exit_code: int = 0) -> None:
        self.files = files
        self.outputs = outputs
        self.exit_code = exit_code
        self.specs: list[dict] = []
        self.staged: list[dict] = []
        self.commands: list[dict] = []
        self.terminated = 0

    async def create(self, value: dict, signal: object = None) -> dict:
        self.specs.append(value)
        return {"id": "h", "provider": self.name, "createdAt": "t"}

    async def put_files(self, handle: dict, files: list[dict], signal: object = None) -> None:
        self.staged.extend(files)

    async def execute(self, handle: dict, command: dict, signal: object = None):
        self.commands.append(command)
        yield {"type": "stdout", "data": "out"}
        yield {"type": "exit", "exitCode": self.exit_code}

    async def list_files(self, handle: dict, directory: str, signal: object = None) -> list[dict]:
        return self.files

    async def read_file(self, handle: dict, path: str, signal: object = None) -> bytes:
        return self.outputs[path]

    async def terminate(self, handle: dict) -> None:
        self.terminated += 1


async def test_provider_adapter_filters_environment_stores_outputs_and_cleans_up() -> None:
    provider = _FakeProvider([{"path": "/workspace/output/report.txt"}], {"/workspace/output/report.txt": b"done"})
    artifacts = MemoryArtifacts()
    adapter = ProviderSandboxAdapter(provider=provider, artifacts=artifacts, allowed_environment=["SAFE"])
    result = await adapter.execute(
        {"language": "python", "code": "print(1)", "variables": {"a": 1}, "environment": {"SAFE": "1", "SECRET": "2"}}
    )
    assert result == {
        "exitCode": 0,
        "stdout": "out",
        "stderr": "",
        "artifacts": [{"id": "artifact-1", "name": "report.txt", "mediaType": "text/plain"}],
    }
    assert provider.specs[0]["limits"]["timeoutMs"] == 60_000 and provider.commands[0]["timeoutMs"] == 60_000
    assert provider.commands[0]["environment"] == {
        "SAFE": "1",
        "AGENT_VARIABLES_FILE": "/workspace/variables.json",
        "AGENT_OUTPUT_DIRECTORY": "/workspace/output",
    }
    assert provider.terminated == 1
    escaping = _FakeProvider([{"path": "/workspace/other/x"}], {})
    with pytest.raises(Error, match="escaped /workspace/output"):
        await ProviderSandboxAdapter(provider=escaping).execute({"language": "python", "code": "", "variables": {}})
    assert escaping.terminated == 1
    with pytest.raises(Error, match="positive safe integer"):
        await ProviderSandboxAdapter(provider=_FakeProvider([], {}), memory_mb=0).execute(
            {"language": "python", "code": "", "variables": {}}
        )


async def test_modal_provider_maps_the_lifecycle_to_a_gateway() -> None:
    from clearideas_agent_runtime.sandbox.modal import ModalSandboxProvider

    calls: list[tuple] = []

    class Gateway:
        async def create(self, value: dict, signal: object = None) -> dict:
            calls.append(("create", value["image"]))
            return {"sandboxId": "sb-1", "metadata": {"region": "us"}}

        async def put_files(self, sandbox_id: str, files: list, signal: object = None) -> None:
            calls.append(("put", sandbox_id, [file["path"] for file in files]))

        async def execute(self, sandbox_id: str, command: dict, signal: object = None):
            yield {"type": "exit", "exitCode": 0}

        async def list_files(self, sandbox_id: str, directory: str, signal: object = None) -> list:
            return [{"path": f"{directory}/a"}]

        async def read_file(self, sandbox_id: str, path: str, signal: object = None) -> bytes:
            return b"x"

        async def terminate(self, sandbox_id: str) -> None:
            calls.append(("terminate", sandbox_id))

    provider = ModalSandboxProvider(Gateway())
    handle = await provider.create(spec(image="img"))
    assert handle["providerData"] == {"sandboxId": "sb-1", "region": "us"}
    await provider.put_files(handle, [{"path": "/workspace/a", "content": "x"}])
    assert [event async for event in provider.execute(handle, {"command": "ls", "cwd": "/workspace"})] == [
        {"type": "exit", "exitCode": 0}
    ]
    assert await provider.list_files(handle, "/workspace/output") == [{"path": "/workspace/output/a"}]
    with pytest.raises(Error, match="normalized beneath /workspace"):
        await provider.read_file(handle, "/etc/passwd")
    with pytest.raises(Error, match="does not belong"):
        await provider.terminate({"id": "x", "provider": "docker", "providerData": {}})
    await provider.terminate(handle)
    assert calls[-1] == ("terminate", "sb-1")
