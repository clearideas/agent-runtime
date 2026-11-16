"""Document artifact generation in a sandbox (``@clearideas/agent-runtime-artifacts``)."""

from __future__ import annotations

import inspect
import posixpath
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ._js import json as js_json
from ._js import strings as js_strings
from ._js.abort import AbortSignal
from ._js.errors import Error
from .sandbox.contracts import assert_sandbox_path, assert_sandbox_resource_limits

JsonObject = dict[str, Any]

_MEDIA_TYPES = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pdf": "application/pdf",
}


@dataclass
class ArtifactRuntimeProfile:
    id: str
    image: str
    language: str
    extension: str
    command: str
    args: Callable[[str], list[str]]


@dataclass
class ArtifactGenerationRequest:
    artifact_type: str
    filename: str
    code: str
    runtime: ArtifactRuntimeProfile
    #: ``{timeoutMs, memoryMb?, cpuCount?, processLimit?, maximumStdoutBytes?, maximumStderrBytes?,
    #: maximumOutputBytes?, maximumOutputFiles?}``
    limits: JsonObject
    #: ``[{filename, content, mediaType?}]``
    inputs: list[JsonObject] = field(default_factory=list)
    #: ``[{path, content, mode?}]``
    runtime_files: list[JsonObject] = field(default_factory=list)
    environment: dict[str, str] = field(default_factory=dict)
    metadata: JsonObject | None = None


def _safe_filename(value: str) -> str:
    trimmed = js_strings.trim(value)
    normalized = posixpath.basename(trimmed)
    if not normalized or normalized in (".", "..") or normalized != trimmed:
        raise Error(f"Artifact filename must not contain a path: {value}")
    return normalized


def _default_media_type(artifact_type: str) -> str:
    return _MEDIA_TYPES.get(artifact_type, "application/octet-stream")


def _append_bounded(current: str, chunk: str, maximum: int) -> str:
    combined = f"{current}{chunk}"
    if js_strings.utf8_length(combined) > maximum:
        raise Error(f"Artifact process output exceeded {maximum} bytes.")
    return combined


class OpenXmlArtifactValidator:
    def validate(self, content: bytes, context: JsonObject) -> JsonObject:
        expected = f".{js_strings.lower(context['artifactType'])}"
        if not js_strings.lower(context["filename"]).endswith(expected):
            return {"valid": False, "message": f"Expected a {expected} output."}
        if len(content) < 4 or content[0] != 0x50 or content[1] != 0x4B:
            return {"valid": False, "message": "OpenXML output is not a ZIP container."}
        return {"valid": True, "mediaType": _default_media_type(context["artifactType"])}


class ArtifactGenerator:
    def __init__(
        self, *, provider: Any, validators: dict[str, Any] | None = None, allowed_environment: list[str] | None = None
    ) -> None:
        self._provider = provider
        self._validators = (
            validators
            if validators is not None
            else {kind: OpenXmlArtifactValidator() for kind in ("xlsx", "docx", "pptx")}
        )
        self._allowed = set(allowed_environment or [])

    async def generate(self, request: ArtifactGenerationRequest, signal: AbortSignal | None = None) -> JsonObject:
        """``{outputs: [{filename, content, bytes, mediaType}], stdout, stderr, exitCode, provider}``."""
        expected = _safe_filename(request.filename)
        limits = request.limits
        maximum_bytes = limits.get("maximumOutputBytes") or 25 * 1024 * 1024
        maximum_files = limits.get("maximumOutputFiles") or 20
        spec_limits: JsonObject = {"timeoutMs": limits["timeoutMs"]}
        for key in ("memoryMb", "cpuCount", "processLimit"):
            if limits.get(key) is not None:
                spec_limits[key] = limits[key]
        spec_limits["maximumOutputBytes"] = maximum_bytes
        spec_limits["maximumOutputFiles"] = maximum_files
        spec: JsonObject = {
            "image": request.runtime.image,
            "workingDirectory": "/workspace",
            "network": "none",
            "limits": spec_limits,
        }
        if request.metadata:
            spec["metadata"] = request.metadata
        assert_sandbox_resource_limits(spec_limits)
        handle = await self._provider.create(spec, signal=signal)
        try:
            source_path = f"/workspace/main.{request.runtime.extension}"
            files = [{"path": source_path, "content": request.code, "mode": 0o600}]
            files += [
                {
                    "path": f"/workspace/input/{_safe_filename(item['filename'])}",
                    "content": item["content"],
                    "mode": 0o600,
                }
                for item in request.inputs
            ]
            for item in request.runtime_files:
                entry = {"path": assert_sandbox_path(item["path"]), "content": item["content"]}
                if item.get("mode") is not None:
                    entry["mode"] = item["mode"]
                files.append(entry)
            await self._provider.put_files(handle, files, signal=signal)
            environment = {
                name: value for name, value in js_json.js_entries(request.environment) if name in self._allowed
            }
            environment.update(
                {
                    "ARTIFACT_INPUT_DIRECTORY": "/workspace/input",
                    "ARTIFACT_OUTPUT_DIRECTORY": "/workspace/output",
                    "ARTIFACT_EXPECTED_FILENAME": expected,
                    "ARTIFACT_TYPE": request.artifact_type,
                }
            )
            stdout = ""
            stderr = ""
            exit_code: int | None = None
            command = {
                "command": request.runtime.command,
                "args": request.runtime.args(source_path),
                "cwd": "/workspace",
                "environment": environment,
                "timeoutMs": limits["timeoutMs"],
            }
            async for event in self._provider.execute(handle, command, signal=signal):
                if event["type"] == "stdout":
                    stdout = _append_bounded(stdout, event["data"], limits.get("maximumStdoutBytes") or 1_048_576)
                elif event["type"] == "stderr":
                    stderr = _append_bounded(stderr, event["data"], limits.get("maximumStderrBytes") or 1_048_576)
                else:
                    exit_code = event["exitCode"]
            if exit_code is None:
                raise Error("Artifact process ended without an exit event.")
            if exit_code != 0:
                raise Error(f"Artifact process exited with {exit_code}: {js_strings.trim(stderr)}")
            listed = await self._provider.list_files(handle, "/workspace/output", signal=signal)
            if not listed:
                raise Error("Artifact process produced no output files.")
            if len(listed) > maximum_files:
                raise Error(f"Artifact process produced {len(listed)} files, exceeding {maximum_files}.")
            validator = self._validators.get(request.artifact_type)
            outputs: list[JsonObject] = []
            total = 0
            for output in listed:
                output_path = assert_sandbox_path(output["path"])
                if not output_path.startswith("/workspace/output/"):
                    raise Error(f"Artifact output escaped /workspace/output: {output_path}")
                filename = _safe_filename(posixpath.basename(output_path))
                content = await self._provider.read_file(handle, output_path, signal=signal)
                total += len(content)
                if total > maximum_bytes:
                    raise Error(f"Artifact output exceeded {maximum_bytes} bytes.")
                validation: JsonObject = {"valid": True}
                if validator is not None:
                    validation = validator.validate(
                        content, {"artifactType": request.artifact_type, "filename": filename}
                    )
                    if inspect.isawaitable(validation):
                        validation = await validation
                if not validation.get("valid"):
                    raise Error(validation.get("message") or f"Artifact validation failed for {filename}.")
                outputs.append(
                    {
                        "filename": expected if len(listed) == 1 else filename,
                        "content": content,
                        "bytes": len(content),
                        "mediaType": validation.get("mediaType") or _default_media_type(request.artifact_type),
                    }
                )
            return {
                "outputs": outputs,
                "stdout": stdout,
                "stderr": stderr,
                "exitCode": exit_code,
                "provider": self._provider.name,
            }
        finally:
            await self._provider.terminate(handle)
