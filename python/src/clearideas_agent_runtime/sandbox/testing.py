"""TEST-ONLY sandbox provider (``packages/sandbox/src/testing/host-process-provider.ts``).

Runs commands as ordinary host processes inside a temporary directory,
rewriting ``/workspace`` paths in arguments, environment, and the
runtime-owned workspace index to that directory. It provides no isolation
whatsoever and exists so the run sandbox can be exercised end to end
(including the real helper script) on hosts without bubblewrap or Docker.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import secrets
import shutil
import stat
import string
import tempfile
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, ClassVar

from .._js import json as js_json
from .._js import time as js_time
from .._js.abort import AbortSignal
from .._js.errors import Error
from .contracts import assert_sandbox_path
from .policy import SANDBOX_WORKSPACES_FILE

JsonObject = dict[str, Any]
_WORKSPACE = re.compile(r"/workspace(?=/|$)")


def _mkdtemp(prefix: str) -> str:
    """``fs.mkdtemp``: the prefix plus six random characters, as Node names it.

    Commands run in this directory, so its path appears in their output (for
    example in Python tracebacks); the same length keeps that output the same
    size as the TypeScript provider's.
    """
    alphabet = string.ascii_letters + string.digits
    while True:
        path = prefix + "".join(secrets.choice(alphabet) for _ in range(6))
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            continue
        return path


class HostProcessTestProvider:
    name = "host-process-test"
    capabilities: ClassVar[dict[str, bool]] = {"readOnlyAttachments": False}

    def __init__(self) -> None:
        self.roots: dict[str, str] = {}
        self.commands: list[JsonObject] = []
        self.specs: list[JsonObject] = []
        self.terminated: list[str] = []

    async def create(self, spec: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        self.specs.append(spec)
        root = _mkdtemp(os.path.join(tempfile.gettempdir(), "agent-runtime-hostproc-"))
        handle_id = f"host-{uuid.uuid4()}"
        self.roots[handle_id] = root
        return {
            "id": handle_id,
            "provider": self.name,
            "createdAt": js_time.to_iso(js_time.now()),
            "providerData": {"root": root},
        }

    def translate(self, handle: JsonObject, sandbox_path: str) -> str:
        root = self.roots.get(handle["id"])
        if root is None:
            raise Error("Unknown sandbox handle.")
        normalized = assert_sandbox_path(sandbox_path)
        return os.path.join(root, *[segment for segment in normalized[len("/workspace") :].split("/") if segment])

    async def put_files(self, handle: JsonObject, files: list[JsonObject], signal: AbortSignal | None = None) -> None:
        for file in files:
            target = Path(self.translate(handle, file["path"]))
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                target.chmod(0o600)
            content = file["content"]
            if file["path"] == SANDBOX_WORKSPACES_FILE:
                index = js_json.parse(content if isinstance(content, str) else bytes(content).decode("utf-8"))
                for mount in index["mounts"].values():
                    mount["path"] = self.translate(handle, mount["path"])
                index["output"] = self.translate(handle, index["output"])
                content = js_json.stringify(index)
            target.write_bytes(content.encode("utf-8") if isinstance(content, str) else bytes(content))
            target.chmod(file.get("mode") if file.get("mode") is not None else 0o600)  # pyright: ignore[reportArgumentType]

    async def execute(
        self, handle: JsonObject, command: JsonObject, signal: AbortSignal | None = None
    ) -> AsyncIterator[JsonObject]:
        self.commands.append(command)
        root = self.roots[handle["id"]]

        def rewrite(value: str) -> str:
            return _WORKSPACE.sub(lambda _match: root, value)

        environment = {"PATH": os.environ.get("PATH", "")}
        for key, value in js_json.js_entries(command.get("environment") or {}):
            environment[key] = rewrite(value)
        try:
            process = await asyncio.create_subprocess_exec(
                rewrite(command["command"]),
                *[rewrite(argument) for argument in command.get("args") or []],
                cwd=rewrite(command.get("cwd") or "/workspace"),
                env=environment,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            yield {"type": "stderr", "data": str(error)}
            yield {"type": "exit", "exitCode": 127}
            return
        queue: asyncio.Queue[JsonObject | None] = asyncio.Queue()

        async def pump(stream: asyncio.StreamReader, kind: str) -> None:
            decoder = _Utf8Decoder()
            while True:
                chunk = await stream.read(65536)
                if not chunk:
                    tail = decoder.finish()
                    if tail:
                        await queue.put({"type": kind, "data": tail})
                    return
                text = decoder.decode(chunk)
                if text:
                    await queue.put({"type": kind, "data": text})

        killed = False

        def kill() -> None:
            nonlocal killed
            killed = True
            with contextlib.suppress(ProcessLookupError):
                process.kill()

        remove = signal.add_listener(kill) if signal is not None else None
        timer = (
            asyncio.get_running_loop().call_later(command["timeoutMs"] / 1000, kill)
            if command.get("timeoutMs")
            else None
        )
        readers = [
            asyncio.ensure_future(pump(process.stdout, "stdout")),  # type: ignore[arg-type]
            asyncio.ensure_future(pump(process.stderr, "stderr")),  # type: ignore[arg-type]
        ]

        async def finish() -> None:
            await asyncio.gather(*readers)
            code = await process.wait()
            event: JsonObject = {"type": "exit", "exitCode": 137 if code < 0 else code}
            if code < 0:
                event["signal"] = "SIGKILL" if killed or code == -9 else f"SIG{-code}"
            await queue.put(event)
            await queue.put(None)

        waiter = asyncio.ensure_future(finish())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        finally:
            if timer is not None:
                timer.cancel()
            if remove is not None:
                remove()
            if not waiter.done():
                kill()
                with contextlib.suppress(BaseException):
                    await waiter

    async def list_files(
        self, handle: JsonObject, directory: str, signal: AbortSignal | None = None
    ) -> list[JsonObject]:
        files: list[JsonObject] = []
        pending = [assert_sandbox_path(directory)]
        while pending:
            current = pending.pop(0)
            try:
                entries = sorted(os.scandir(self.translate(handle, current)), key=lambda entry: entry.name)
            except OSError:
                continue
            for entry in entries:
                if entry.is_symlink():
                    continue
                sandbox_path = f"{current}/{entry.name}"
                if entry.is_dir(follow_symlinks=False):
                    pending.append(sandbox_path)
                elif entry.is_file(follow_symlinks=False):
                    files.append({"path": sandbox_path, "size": entry.stat(follow_symlinks=False).st_size})
        return files

    async def read_file(self, handle: JsonObject, path: str, signal: AbortSignal | None = None) -> bytes:
        return Path(self.translate(handle, path)).read_bytes()

    async def terminate(self, handle: JsonObject) -> None:
        self.terminated.append(handle["id"])
        root = self.roots.pop(handle["id"], None)
        if root:
            for directory, _subdirectories, _files in os.walk(root):
                with contextlib.suppress(OSError):
                    os.chmod(directory, stat.S_IRWXU)
            shutil.rmtree(root, ignore_errors=True)


class _Utf8Decoder:
    """Incremental UTF-8 decoding (Node's ``setEncoding("utf8")``)."""

    def __init__(self) -> None:
        import codecs

        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def decode(self, chunk: bytes) -> str:
        return self._decoder.decode(chunk)

    def finish(self) -> str:
        return self._decoder.decode(b"", final=True)
