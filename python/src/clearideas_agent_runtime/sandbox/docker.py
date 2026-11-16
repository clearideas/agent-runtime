"""Docker reference sandbox provider (``packages/sandbox/src/docker.ts``)."""

from __future__ import annotations

import re
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import datetime
from typing import Any, ClassVar

from .._js import json as js_json
from .._js import time as js_time
from .._js.abort import AbortSignal
from .._js.errors import Error
from .._js.ops import to_string
from ._process import collect, stream_process
from .contracts import assert_sandbox_path, assert_sandbox_resource_limits

JsonObject = dict[str, Any]
_LABEL_KEY = re.compile(r"[a-z0-9][a-z0-9._-]*")
_LABEL_VALUE = re.compile(r"[A-Za-z0-9._:-]*")
_CONTAINER_ID = re.compile(r"[a-f0-9]{12,64}")
_ENVIRONMENT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_MAXIMUM_COLLECTED_BYTES = 32 * 1024 * 1024


class DockerSandboxProvider:
    name = "docker"
    capabilities: ClassVar[dict[str, bool]] = {"readOnlyAttachments": True}

    def __init__(
        self, *, allowed_images: list[str], binary: str | None = None, now: Callable[[], datetime] | None = None
    ) -> None:
        if not allowed_images:
            raise Error("Docker sandbox requires allowedImages.")
        self._binary = binary or "docker"
        self._allowed_images = set(allowed_images)
        self._now = now or js_time.now

    async def validate(self, spec: JsonObject, signal: AbortSignal | None = None) -> None:
        if spec["image"] not in self._allowed_images:
            raise Error(f"Docker image is not allowed: {spec['image']}")
        if spec["network"] != "none":
            raise Error("Docker reference sandbox only permits network: none.")
        assert_sandbox_path(spec["workingDirectory"])
        assert_sandbox_resource_limits(spec["limits"])
        for attachment in spec.get("attachments") or []:
            assert_sandbox_path(attachment["target"])
            if not attachment["source"].startswith("/") or ":" in attachment["source"]:
                raise Error(f"Docker attachment source must be an absolute path without colons: {attachment['source']}")
        for key, value in js_json.js_entries(spec.get("metadata") or {}):
            if not _LABEL_KEY.fullmatch(key) or not _LABEL_VALUE.fullmatch(to_string(value)):
                raise Error(f"Docker label is invalid: {key}")

    async def _collect(
        self, args: list[str], input: bytes | str | None = None, signal: AbortSignal | None = None
    ) -> tuple[bytes, bytes, int]:
        return await collect(self._binary, args, input, signal, _MAXIMUM_COLLECTED_BYTES)

    async def create(self, spec: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        await self.validate(spec)
        name = f"agent-runtime-{uuid.uuid4()}"
        limits = spec["limits"]
        workspace_size = limits.get("workspaceTmpfsMb") if limits.get("workspaceTmpfsMb") is not None else 256
        args = [
            "create",
            "--name",
            name,
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "65532:65532",
            "--read-only",
            "--tmpfs",
            f"/workspace:rw,noexec,nosuid,nodev,size={to_string(workspace_size)}m,uid=65532,gid=65532,mode=0700",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700",
            "--workdir",
            spec["workingDirectory"],
            "--memory",
            f"{to_string(limits.get('memoryMb') if limits.get('memoryMb') is not None else 512)}m",
            "--cpus",
            to_string(limits.get("cpuCount") if limits.get("cpuCount") is not None else 1),
            "--pids-limit",
            to_string(limits.get("processLimit") if limits.get("processLimit") is not None else 64),
        ]
        for attachment in spec.get("attachments") or []:
            args += ["--volume", f"{attachment['source']}:{attachment['target']}:ro"]
        for key, value in js_json.js_entries(spec.get("metadata") or {}):
            args += ["--label", f"{key}={to_string(value)}"]
        args += [spec["image"], "sleep", "infinity"]
        stdout, stderr, code = await self._collect(args, None, signal)
        if code != 0:
            raise Error(f"docker create failed: {stderr.decode('utf-8', 'replace').strip()}")
        container_id = stdout.decode("utf-8", "replace").strip()
        if not _CONTAINER_ID.fullmatch(container_id):
            raise Error("docker create returned an invalid container ID.")
        _, stderr, code = await self._collect(["start", container_id], None, signal)
        if code != 0:
            try:
                await self._collect(["rm", "-f", container_id])
            except Exception:
                pass
            raise Error(f"docker start failed: {stderr.decode('utf-8', 'replace').strip()}")
        return {
            "id": name,
            "provider": self.name,
            "createdAt": js_time.to_iso(self._now()),
            "providerData": {"containerId": container_id},
        }

    async def put_files(self, handle: JsonObject, files: list[JsonObject], signal: AbortSignal | None = None) -> None:
        container_id = self._container_id(handle)
        for file in files:
            target = assert_sandbox_path(file["path"])
            parent = target[: target.rfind("/")] or "/workspace"
            mode = file.get("mode") if file.get("mode") is not None else 0o600
            if isinstance(mode, bool) or not isinstance(mode, int) or mode < 0 or mode > 0o777:
                raise Error(f"Invalid sandbox file mode: {to_string(file.get('mode'))}")
            command = f"mkdir -p '{parent}' && cat > '{target}' && chmod {mode:o} '{target}'"
            _, stderr, code = await self._collect(
                ["exec", "-i", container_id, "sh", "-c", command], file["content"], signal
            )
            if code != 0:
                raise Error(f"docker file staging failed: {stderr.decode('utf-8', 'replace').strip()}")

    async def execute(
        self, handle: JsonObject, command: JsonObject, signal: AbortSignal | None = None
    ) -> AsyncIterator[JsonObject]:
        container_id = self._container_id(handle)
        args = ["exec", "-i"]
        if command.get("cwd"):
            args += ["--workdir", assert_sandbox_path(command["cwd"])]
        for name, value in js_json.js_entries(command.get("environment") or {}):
            if not _ENVIRONMENT_NAME.fullmatch(name):
                raise Error(f"Invalid environment name: {name}")
            args += ["--env", f"{name}={value}"]
        args += [container_id, command["command"], *(command.get("args") or [])]
        async for event in stream_process(self._binary, args, signal=signal, timeout_ms=command.get("timeoutMs")):
            yield event

    async def list_files(
        self, handle: JsonObject, directory: str, signal: AbortSignal | None = None
    ) -> list[JsonObject]:
        normalized = assert_sandbox_path(directory)
        stdout, _, code = await self._collect(
            ["exec", self._container_id(handle), "find", normalized, "-type", "f", "-print"], None, signal
        )
        if code != 0:
            return []
        return [
            {"path": assert_sandbox_path(line)}
            for line in re.split(r"\r?\n", stdout.decode("utf-8", "replace"))
            if line
        ]

    async def read_file(self, handle: JsonObject, path: str, signal: AbortSignal | None = None) -> bytes:
        stdout, stderr, code = await self._collect(
            ["exec", self._container_id(handle), "cat", assert_sandbox_path(path)], None, signal
        )
        if code != 0:
            raise Error(f"docker read failed: {stderr.decode('utf-8', 'replace').strip()}")
        return stdout

    async def terminate(self, handle: JsonObject) -> None:
        _, stderr, code = await self._collect(["rm", "-f", self._container_id(handle)])
        text = stderr.decode("utf-8", "replace")
        if code != 0 and "No such container" not in text:
            raise Error(f"docker cleanup failed: {text.strip()}")

    def _container_id(self, handle: JsonObject) -> str:
        container_id = (handle.get("providerData") or {}).get("containerId")
        if handle.get("provider") != self.name or not isinstance(container_id, str):
            raise Error("Sandbox handle does not belong to DockerSandboxProvider.")
        return container_id
