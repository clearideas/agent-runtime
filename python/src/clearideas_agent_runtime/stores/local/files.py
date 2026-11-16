"""File helpers, event sinks, manifest sources, and the file artifact store
(``store-local``: file-retry, path-component, event-sinks, manifest sources,
artifact-store.file)."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import os
import sys
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, TypeVar

from ..._js import json as js_json
from ..._js import strings as js_strings
from ..._js import yaml as js_yaml
from ..._js.errors import Error
from ...contracts import parse_agent_manifest, parse_agent_run_manifest

T = TypeVar("T")
JsonObject = dict[str, Any]

_TRANSIENT_WINDOWS = {errno.EPERM, errno.EACCES, getattr(errno, "EBUSY", 16)}
# ``process.platform``: module state so tests can simulate Windows file locking.
PLATFORM = "win32" if sys.platform.startswith("win") else sys.platform


async def with_file_retry(
    operation: Callable[[], T | Awaitable[T]],
    *,
    platform: str | None = None,
    max_wait_ms: int = 10_000,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> T:
    """Run a file operation, retrying transient Windows sharing errors."""
    platform = platform or PLATFORM
    sleep = sleep or (lambda delay_ms: asyncio.sleep(delay_ms / 1000))
    waited = 0
    delay_ms = 10
    while True:
        try:
            result = operation()
            if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
                result = await result  # type: ignore[assignment]
            return result  # type: ignore[return-value]
        except OSError as error:
            if platform != "win32" or error.errno not in _TRANSIENT_WINDOWS or waited >= max_wait_ms:
                raise
            await sleep(delay_ms)
            waited += delay_ms
            delay_ms = min(delay_ms * 2, 250)


async def rename_with_retry(source: str, target: str, **options: Any) -> None:
    await with_file_retry(lambda: os.replace(source, target), **options)


async def read_text_with_retry(path: str, **options: Any) -> str:
    return await with_file_retry(lambda: Path(path).read_text(encoding="utf-8"), **options)


def safe_path_component(value: str, label: str) -> str:
    """Maps untrusted identifiers to fixed-size, traversal-safe path components."""
    if not js_strings.trim(value):
        raise Error(f"{label} cannot be empty.")
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()


async def write_atomically(path: str, data: bytes | str, mode: int = 0o600) -> None:
    """Write through a same-directory temporary file and an atomic rename."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temporary = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.{uuid.uuid4()}.tmp")
    payload = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    descriptor: int | None = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), mode)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        await rename_with_retry(temporary, path)
    except BaseException:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


async def write_json_atomically(path: str, value: Any) -> None:
    """``JSON.stringify(value, null, 2) + "\\n"``, atomically."""
    await write_atomically(path, f"{js_json.stringify(value, 2)}\n")


_FILE_URL_SAFE = frozenset("!$&'()*+,-.0123456789:;=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz/")


def path_to_file_url(path: str) -> str:
    """``url.pathToFileURL(path).href`` for POSIX paths."""
    resolved = os.path.abspath(path)
    encoded = []
    for char in resolved:
        if char in _FILE_URL_SAFE:
            encoded.append(char)
        else:
            encoded.extend(f"%{byte:02X}" for byte in char.encode("utf-8", "surrogatepass"))
    return "file://" + "".join(encoded)


# ─── Event sinks ────────────────────────────────────────────────────────────


def _serialize_event(event: JsonObject) -> str:
    return f"{js_json.stringify(event)}\n"


class ConsoleEventSink:
    """Emits one JSON event per line to stdout or an injected writer."""

    def __init__(self, write: Callable[[str], Any] | None = None) -> None:
        self._write = write or (lambda line: (sys.stdout.write(line), sys.stdout.flush()))

    def emit(self, event: JsonObject) -> None:
        self._write(_serialize_event(event))


class JsonlEventSink:
    """Appends events in invocation order to a replayable JSONL file."""

    def __init__(self, file_path: str) -> None:
        if not js_strings.trim(file_path):
            raise Error("JsonlEventSink requires a file path.")
        self._path = os.path.abspath(file_path)
        self._lock = asyncio.Lock()

    async def emit(self, event: JsonObject) -> None:
        async with self._lock:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            descriptor = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(descriptor, _serialize_event(event).encode("utf-8", "surrogatepass"))
            finally:
                os.close(descriptor)

    async def flush(self) -> None:
        async with self._lock:
            return


# ─── Manifest sources ───────────────────────────────────────────────────────


def _is_inside(root: str, candidate: str) -> bool:
    relative = os.path.relpath(candidate, root)
    return relative == "." or (
        not relative.startswith(".." + os.sep) and relative != ".." and not os.path.isabs(relative)
    )


def _parse_document(source: str, extension: str) -> Any:
    return js_json.parse(source) if extension == ".json" else js_yaml.parse(source)


class FileAgentManifestSource:
    """Loads and validates JSON or YAML manifests from a constrained directory."""

    def __init__(self, root_directory: str, default_reference: str | None = None) -> None:
        if not js_strings.trim(root_directory):
            raise Error("FileAgentManifestSource requires a root directory.")
        self._root = os.path.abspath(root_directory)
        self._default = default_reference

    async def load_manifest(self, reference: str | None = None) -> JsonObject:
        reference = reference if reference is not None else self._default
        if not reference or not js_strings.trim(reference):
            raise Error("A manifest reference is required.")
        if os.path.isabs(reference):
            raise Error("Manifest references must be relative to the configured root.")
        file_path = os.path.abspath(os.path.join(self._root, reference))
        if not _is_inside(self._root, file_path):
            raise Error("Manifest reference escapes the configured root.")
        extension = os.path.splitext(file_path)[1].lower()
        if extension not in (".json", ".yaml", ".yml"):
            raise Error(f'Unsupported manifest format "{extension or "(none)"}". Use .json, .yaml, or .yml.')
        real_root, real_file = os.path.realpath(self._root), os.path.realpath(file_path)
        if not os.path.exists(real_file):
            raise FileNotFoundError(errno.ENOENT, f"ENOENT: no such file or directory, realpath '{file_path}'")
        if not _is_inside(real_root, real_file):
            raise Error("Manifest reference resolves outside the configured root.")
        source = Path(real_file).read_text(encoding="utf-8")
        return parse_agent_manifest(_parse_document(source, extension))


class FileAgentRunManifestSource:
    """Loads and validates an agent run manifest from a constrained directory."""

    def __init__(self, root_directory: str, default_reference: str | None = None) -> None:
        if not js_strings.trim(root_directory):
            raise Error("FileAgentRunManifestSource requires a root directory.")
        self._root = os.path.abspath(root_directory)
        self._default = default_reference

    async def load_agent_run_manifest(self, reference: str | None = None) -> JsonObject:
        reference = reference if reference is not None else self._default
        if not reference or not js_strings.trim(reference):
            raise Error("An agent run manifest reference is required.")
        if os.path.isabs(reference):
            raise Error("Agent run manifest references must be relative to the configured root.")
        file_path = os.path.abspath(os.path.join(self._root, reference))
        if not _is_inside(self._root, file_path):
            raise Error("Agent run manifest reference escapes the configured root.")
        extension = os.path.splitext(file_path)[1].lower()
        if extension not in (".json", ".yaml", ".yml"):
            raise Error(f'Unsupported agent run manifest format "{extension or "(none)"}". Use .json, .yaml, or .yml.')
        real_root, real_file = os.path.realpath(self._root), os.path.realpath(file_path)
        if not os.path.exists(real_file):
            raise FileNotFoundError(errno.ENOENT, f"ENOENT: no such file or directory, realpath '{file_path}'")
        if not _is_inside(real_root, real_file):
            raise Error("Agent run manifest reference resolves outside the configured root.")
        source = Path(real_file).read_text(encoding="utf-8")
        return parse_agent_run_manifest(_parse_document(source, extension))


# ─── Artifact store ─────────────────────────────────────────────────────────


class FileArtifactStore:
    """Stores artifact bytes and metadata beneath a caller-owned local directory."""

    def __init__(self, root_directory: str) -> None:
        if not js_strings.trim(root_directory):
            raise Error("FileArtifactStore requires a root directory.")
        self._root = os.path.abspath(root_directory)

    async def put(self, input: JsonObject) -> JsonObject:
        if not js_strings.trim(input["name"]):
            raise Error("Artifact name cannot be empty.")
        if not js_strings.trim(input["mediaType"]):
            raise Error("Artifact media type cannot be empty.")
        artifact_id = f"artifact_{uuid.uuid4()}"
        data = input["data"]
        payload = data.encode("utf-8", "surrogatepass") if isinstance(data, str) else bytes(data)
        data_path = self._data_path(artifact_id)
        ref: JsonObject = {
            "id": artifact_id,
            "name": input["name"],
            "mediaType": input["mediaType"],
            "uri": path_to_file_url(data_path),
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        if input.get("metadata"):
            ref["metadata"] = input["metadata"]
        await write_atomically(data_path, payload)
        await write_atomically(self._metadata_path(artifact_id), f"{js_json.stringify({'ref': ref}, 2)}\n")
        return ref

    async def get(self, ref: JsonObject) -> JsonObject:
        stored = js_json.parse(await read_text_with_retry(self._metadata_path(ref["id"])))["ref"]
        if stored["id"] != ref["id"]:
            raise Error(f"Artifact metadata id mismatch: {ref['id']}")
        if stored["name"] != ref["name"] or stored["mediaType"] != ref["mediaType"]:
            raise Error(f"Artifact reference mismatch: {ref['id']}")
        data = Path(self._data_path(ref["id"])).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if (
            (stored.get("sha256") and stored["sha256"] != digest)
            or (ref.get("sha256") and ref["sha256"] != digest)
            or (stored.get("sha256") and ref.get("sha256") and stored["sha256"] != ref["sha256"])
        ):
            raise Error(f"Artifact integrity check failed: {ref['id']}")
        if (
            (stored.get("size") is not None and stored["size"] != len(data))
            or (ref.get("size") is not None and ref["size"] != len(data))
            or (stored.get("size") is not None and ref.get("size") is not None and stored["size"] != ref["size"])
        ):
            raise Error(f"Artifact size check failed: {ref['id']}")
        return {"ref": stored, "data": data}

    def _directory(self, artifact_id: str) -> str:
        return os.path.join(self._root, "artifacts", safe_path_component(artifact_id, "Artifact id"))

    def _data_path(self, artifact_id: str) -> str:
        return os.path.join(self._directory(artifact_id), "data")

    def _metadata_path(self, artifact_id: str) -> str:
        return os.path.join(self._directory(artifact_id), "metadata.json")
