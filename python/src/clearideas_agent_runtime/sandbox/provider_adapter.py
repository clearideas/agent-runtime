"""A ``SandboxAdapter`` for code steps over a ``SandboxProvider`` (``provider-adapter.ts``)."""

from __future__ import annotations

import hashlib
import posixpath
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.abort import AbortSignal
from .._js.errors import Error
from .contracts import assert_sandbox_path, assert_sandbox_resource_limits

JsonObject = dict[str, Any]


@dataclass
class SandboxRuntimeProfile:
    language: str
    image: str
    extension: str
    command: str
    args: Callable[[str], list[str]]


DEFAULT_PROFILES = [
    SandboxRuntimeProfile(
        language="python", image="python:3.12-slim", extension="py", command="python", args=lambda source: [source]
    )
]

_MEDIA_TYPES = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


def extname(filename: str) -> str:
    """``path.extname``: the extension of the last segment, ignoring a leading dot."""
    base = filename.rsplit("/", 1)[-1]
    index = base.rfind(".")
    return "" if index <= 0 else base[index:]


def media_type_for(filename: str, table: dict[str, str] | None = None) -> str:
    return (table or _MEDIA_TYPES).get(js_strings.lower(extname(filename)), "application/octet-stream")


def _append_bounded(current: str, chunk: str, maximum_bytes: int) -> str:
    combined = f"{current}{chunk}"
    if js_strings.utf8_length(combined) > maximum_bytes:
        raise Error(f"Sandbox output exceeded {maximum_bytes} bytes.")
    return combined


class ProviderSandboxAdapter:
    """Runs each code step in a fresh sandbox from a runtime profile."""

    def __init__(
        self,
        *,
        provider: Any,
        artifacts: Any = None,
        profiles: list[SandboxRuntimeProfile] | None = None,
        allowed_environment: list[str] | None = None,
        maximum_stdout_bytes: int | None = None,
        maximum_stderr_bytes: int | None = None,
        maximum_output_bytes: int | None = None,
        maximum_output_files: int | None = None,
        memory_mb: int | None = None,
        cpu_count: float | None = None,
        process_limit: int | None = None,
    ) -> None:
        self._provider = provider
        self._artifacts = artifacts
        self._profiles = {profile.language: profile for profile in (profiles or DEFAULT_PROFILES)}
        self._allowed = set(allowed_environment or [])
        self._max_stdout = maximum_stdout_bytes if maximum_stdout_bytes is not None else 1_048_576
        self._max_stderr = maximum_stderr_bytes if maximum_stderr_bytes is not None else 1_048_576
        self._max_output_bytes = maximum_output_bytes if maximum_output_bytes is not None else 25 * 1024 * 1024
        self._max_output_files = maximum_output_files if maximum_output_files is not None else 20
        self._memory_mb = memory_mb if memory_mb is not None else 512
        self._cpu_count = cpu_count if cpu_count is not None else 1
        self._process_limit = process_limit if process_limit is not None else 64

    async def execute(self, request: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        profile = self._profiles.get(request["language"])
        if profile is None:
            raise Error(f"No sandbox runtime profile for {request['language']}.")
        timeout_ms = request.get("timeoutMs") if request.get("timeoutMs") is not None else 60_000
        spec: JsonObject = {
            "image": profile.image,
            "workingDirectory": "/workspace",
            "network": "none",
            "limits": {
                "timeoutMs": timeout_ms,
                "memoryMb": self._memory_mb,
                "cpuCount": self._cpu_count,
                "processLimit": self._process_limit,
                "maximumOutputBytes": self._max_output_bytes,
                "maximumOutputFiles": self._max_output_files,
            },
        }
        assert_sandbox_resource_limits(spec["limits"])
        handle = await self._provider.create(spec, signal=signal)
        try:
            source_path = f"/workspace/main.{profile.extension}"
            await self._provider.put_files(
                handle,
                [
                    {"path": source_path, "content": request["code"], "mode": 0o600},
                    {
                        "path": "/workspace/variables.json",
                        "content": js_json.stringify(request.get("variables")),
                        "mode": 0o600,
                    },
                ],
                signal=signal,
            )
            environment = {
                name: value
                for name, value in js_json.js_entries(request.get("environment") or {})
                if name in self._allowed
            }
            environment["AGENT_VARIABLES_FILE"] = "/workspace/variables.json"
            environment["AGENT_OUTPUT_DIRECTORY"] = "/workspace/output"
            command = {
                "command": profile.command,
                "args": profile.args(source_path),
                "cwd": "/workspace",
                "environment": environment,
                "timeoutMs": timeout_ms,
            }
            stdout = ""
            stderr = ""
            exit_code: int | None = None
            async for event in self._provider.execute(handle, command, signal=signal):
                if event["type"] == "stdout":
                    stdout = _append_bounded(stdout, event["data"], self._max_stdout)
                elif event["type"] == "stderr":
                    stderr = _append_bounded(stderr, event["data"], self._max_stderr)
                else:
                    exit_code = event["exitCode"]
            if exit_code is None:
                raise Error("Sandbox process ended without an exit event.")
            files = await self._provider.list_files(handle, "/workspace/output", signal=signal)
            if len(files) > self._max_output_files:
                raise Error(f"Sandbox produced {len(files)} files, exceeding {self._max_output_files}.")
            artifacts: list[JsonObject] = []
            aggregate = 0
            for file in files:
                output_path = assert_sandbox_path(file["path"])
                if not output_path.startswith("/workspace/output/"):
                    raise Error(f"Sandbox output escaped /workspace/output: {output_path}")
                content = await self._provider.read_file(handle, file["path"], signal=signal)
                aggregate += len(content)
                if aggregate > self._max_output_bytes:
                    raise Error(f"Sandbox artifacts exceeded {self._max_output_bytes} bytes.")
                if self._artifacts is not None:
                    filename = posixpath.basename(file["path"])
                    artifacts.append(
                        await self._artifacts.put(
                            {
                                "name": filename,
                                "mediaType": media_type_for(filename),
                                "data": content,
                                "metadata": {
                                    "sandboxProvider": self._provider.name,
                                    "sha256": hashlib.sha256(content).hexdigest(),
                                },
                            }
                        )
                    )
            result: JsonObject = {"exitCode": exit_code, "stdout": stdout, "stderr": stderr}
            if artifacts:
                result["artifacts"] = artifacts
            return result
        finally:
            await self._provider.terminate(handle)
