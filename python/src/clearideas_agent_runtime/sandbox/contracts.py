"""Sandbox provider contracts (``packages/sandbox/src/contracts.ts``).

Specifications, handles, files, and commands are JSON dictionaries with the
TypeScript keys (``SandboxSpec`` = ``{image, workingDirectory, network,
limits, attachments?, metadata?}``). ``SandboxProvider`` methods are
snake_case and take ``signal=``; ``execute`` returns an async iterator of
``{type: "stdout"|"stderr", data}`` and ``{type: "exit", exitCode, signal?}``.
"""

from __future__ import annotations

import math
import re
from collections.abc import AsyncIterator
from typing import Any, Protocol

from .._js.abort import AbortSignal
from .._js.errors import Error

JsonObject = dict[str, Any]


def _is_safe_integer(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return abs(value) <= 2**53 - 1


def _positive_safe_integer(value: Any, label: str, maximum: int | float) -> None:
    if not _is_safe_integer(value) or value <= 0 or value > maximum:
        shown = int(maximum) if isinstance(maximum, float) and maximum.is_integer() else maximum
        raise Error(f"{label} must be a positive safe integer no greater than {shown}.")


def assert_sandbox_resource_limits(limits: JsonObject) -> None:
    """Validates provider-bound limits before untrusted code reaches a sandbox."""
    _positive_safe_integer(limits.get("timeoutMs"), "Sandbox timeoutMs", 86_400_000)
    if limits.get("memoryMb") is not None:
        _positive_safe_integer(limits["memoryMb"], "Sandbox memoryMb", 262_144)
    cpu = limits.get("cpuCount")
    if cpu is not None and (
        isinstance(cpu, bool) or not isinstance(cpu, (int, float)) or not math.isfinite(cpu) or cpu <= 0 or cpu > 1_024
    ):
        raise Error("Sandbox cpuCount must be finite and between 0 and 1024.")
    if limits.get("processLimit") is not None:
        _positive_safe_integer(limits["processLimit"], "Sandbox processLimit", 1_048_576)
    if limits.get("maximumOutputBytes") is not None:
        _positive_safe_integer(limits["maximumOutputBytes"], "Sandbox maximumOutputBytes", 2**53 - 1)
    if limits.get("maximumOutputFiles") is not None:
        _positive_safe_integer(limits["maximumOutputFiles"], "Sandbox maximumOutputFiles", 1_000_000)
    if limits.get("workspaceTmpfsMb") is not None:
        _positive_safe_integer(limits["workspaceTmpfsMb"], "Sandbox workspaceTmpfsMb", 1_048_576)


class SandboxProvider(Protocol):
    """A container or VM provider. ``capabilities`` (``{readOnlyAttachments?}``) and ``validate`` are optional."""

    name: str

    async def create(self, spec: JsonObject, signal: AbortSignal | None = None) -> JsonObject: ...
    async def put_files(
        self, handle: JsonObject, files: list[JsonObject], signal: AbortSignal | None = None
    ) -> None: ...
    def execute(
        self, handle: JsonObject, command: JsonObject, signal: AbortSignal | None = None
    ) -> AsyncIterator[JsonObject]: ...
    async def list_files(
        self, handle: JsonObject, directory: str, signal: AbortSignal | None = None
    ) -> list[JsonObject]: ...
    async def read_file(self, handle: JsonObject, path: str, signal: AbortSignal | None = None) -> bytes: ...
    async def terminate(self, handle: JsonObject) -> None: ...


_SAFE_WORKSPACE_PATH = re.compile(r"^/workspace(?:/[A-Za-z0-9._-]+)*$")


def assert_sandbox_path(value: str) -> str:
    if not _SAFE_WORKSPACE_PATH.fullmatch(value) or "/../" in value or value.endswith("/.."):
        raise Error(f"Sandbox path must be normalized beneath /workspace: {value}")
    return value
