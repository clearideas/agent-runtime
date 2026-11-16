"""Host ports (``packages/core/src/ports/index.ts``).

Ports are ``Protocol`` classes with snake_case methods. Requests, records, and
results are JSON dictionaries with the camelCase keys of the TypeScript
contracts, so adapters exchange exactly the data the TypeScript runtime does.
Optional TypeScript methods are optional attributes (checked with ``hasattr``).
"""

from __future__ import annotations

import re
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

from .._js import strings as js_strings
from .._js import time as js_time
from .._js.abort import AbortSignal
from .._js.errors import Error

JsonObject = dict[str, Any]


@runtime_checkable
class AgentManifestSource(Protocol):
    async def load_manifest(self, reference: str | None = None) -> JsonObject: ...


RUN_STATUSES = ("created", "running", "suspended", "interrupted", "completed", "failed", "cancelled")


@runtime_checkable
class RunStore(Protocol):
    """Durable run state. ``interrupt_run`` and ``delete_run`` are optional."""

    async def create_run(self, record: JsonObject) -> None: ...
    async def load_run(self, run_id: str) -> JsonObject | None: ...
    async def load_latest_checkpoint(self, run_id: str) -> JsonObject | None: ...
    async def resume_run(self, run_id: str, resumed_at: str, options: JsonObject | None = None) -> int: ...
    async def save_checkpoint(self, checkpoint: JsonObject) -> None: ...
    async def suspend_run(self, run_id: str, suspended_at: str, expected_attempt: int) -> None: ...
    async def complete_run(self, record: JsonObject) -> None: ...
    async def fail_run(self, run_id: str, error: JsonObject, failed_at: str, expected_attempt: int) -> None: ...
    async def cancel_run(self, run_id: str, cancelled_at: str, expected_attempt: int) -> None: ...


@runtime_checkable
class ArtifactStore(Protocol):
    """``put({name, mediaType, data, metadata?})`` and ``get(ref) -> {ref, data}``."""

    async def put(self, input: JsonObject) -> JsonObject: ...
    async def get(self, ref: JsonObject) -> JsonObject: ...


_WORKSPACE_PATH_SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
MAXIMUM_WORKSPACE_PATH_LENGTH = 1024
MAXIMUM_WORKSPACE_PATH_DEPTH = 64


def is_safe_workspace_path(value: str) -> bool:
    if js_strings.length(value) == 0 or js_strings.length(value) > MAXIMUM_WORKSPACE_PATH_LENGTH:
        return False
    segments = value.split("/")
    return len(segments) <= MAXIMUM_WORKSPACE_PATH_DEPTH and all(
        _WORKSPACE_PATH_SEGMENT.fullmatch(segment) for segment in segments
    )


def assert_workspace_path(value: str, label: str = "Workspace path") -> str:
    if not is_safe_workspace_path(value):
        raise Error(f"{label} must be a relative POSIX path with safe segments: {value}")
    return value


class WorkspaceStore(Protocol):
    """A host-owned file collection.

    Attributes: ``mode`` (``read``/``read_write``), optional ``limits``
    (``{maxFiles?, maxFileBytes?, maxTotalBytes?}``) and ``attachable``
    (``{kind: "local-directory", root}``). ``write``/``delete`` exist only on
    writable stores.
    """

    mode: str

    async def entries(self, signal: AbortSignal | None = None) -> list[JsonObject]: ...
    async def read(self, path: str, signal: AbortSignal | None = None) -> bytes: ...


class WorkspaceProvider(Protocol):
    async def resolve_workspace(
        self, binding: JsonObject, context: JsonObject | None = None
    ) -> WorkspaceStore | None: ...


@dataclass
class ResolvedWorkspace:
    """A manifest binding resolved against the host with its effective privileges."""

    binding: JsonObject
    alias: str
    mode: str
    store: Any


class _ReadOnlyWorkspace:
    def __init__(self, store: Any) -> None:
        self._store = store
        self.mode = "read"
        if getattr(store, "limits", None) is not None:
            self.limits = store.limits
        if getattr(store, "attachable", None) is not None:
            self.attachable = store.attachable

    async def entries(self, signal: AbortSignal | None = None) -> list[JsonObject]:
        return await self._store.entries(signal=signal)

    async def read(self, path: str, signal: AbortSignal | None = None) -> bytes:
        return await self._store.read(path, signal=signal)


def restrict_workspace(store: Any, mode: str) -> Any:
    """Narrow a store to the effective mode; a read binding never exposes writes."""
    if store.mode == "read" and mode == "read_write":
        raise Error("A read-only workspace cannot be elevated to read_write.")
    if mode == "read_write":
        return store
    return _ReadOnlyWorkspace(store)


class RunSandboxSession(Protocol):
    id: str

    async def execute(self, request: JsonObject) -> JsonObject: ...
    def budget(self) -> JsonObject: ...
    async def close(self, reason: str) -> None: ...


class RunSandboxProvider(Protocol):
    async def tools(self, workspace: ResolvedWorkspace) -> list[JsonObject]: ...
    async def validate(self, request: JsonObject) -> None: ...
    async def open(self, request: JsonObject) -> RunSandboxSession: ...


class EventSink(Protocol):
    """Event sinks are observers; ``emit`` may be sync or async."""

    def emit(self, event: JsonObject) -> Awaitable[None] | None: ...


class ApprovalAdapter(Protocol):
    async def request_approval(self, request: JsonObject, signal: AbortSignal | None = None) -> JsonObject: ...


class SubRunAdapter(Protocol):
    async def execute(self, request: JsonObject, signal: AbortSignal | None = None) -> JsonObject: ...


@dataclass
class ToolExecutionContext:
    run_id: str
    step_id: str
    variables: JsonObject
    idempotency_key: str | None = None
    workspaces: list[ResolvedWorkspace] | None = None
    run_sandbox: Callable[[], Awaitable[Any]] | None = None
    signal: AbortSignal | None = None


class ConnectionCredentialProvider(Protocol):
    async def get_credential(self, request: JsonObject) -> JsonObject: ...


class ToolAdapter(Protocol):
    """``is_tool_excluded`` and ``unavailable_tool_reason`` are optional."""

    async def list_tools(self) -> list[JsonObject]: ...
    async def execute_tool(self, call: JsonObject, context: ToolExecutionContext) -> JsonObject: ...


class SandboxAdapter(Protocol):
    async def execute(self, request: JsonObject, signal: AbortSignal | None = None) -> JsonObject: ...


class ContextSummarizerAdapter(Protocol):
    async def summarize(
        self, request: JsonObject, next: Callable[[JsonObject], Awaitable[JsonObject]]
    ) -> JsonObject: ...


class ModelAdapter(Protocol):
    """``generate(request) -> ModelResult``; ``stream`` and ``describe_model`` are optional.

    ``stream(request)`` yields ``{"type": "text-delta"|"reasoning-delta"|"tool-call"|"completed", ...}``.
    """

    async def generate(self, request: JsonObject) -> JsonObject: ...


StreamFn = Callable[[JsonObject], AsyncIterator[JsonObject]]


class Clock(Protocol):
    def now(self) -> datetime: ...


class IdGenerator(Protocol):
    def generate_id(self, prefix: str) -> str: ...


class _SystemClock:
    def now(self) -> datetime:
        return js_time.now()


class _CryptoIdGenerator:
    def generate_id(self, prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4()}"


system_clock = _SystemClock()
crypto_id_generator = _CryptoIdGenerator()
