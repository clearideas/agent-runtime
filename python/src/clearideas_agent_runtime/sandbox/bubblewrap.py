"""Local bubblewrap sandbox provider (``packages/sandbox/src/bubblewrap.ts``).

Separate user, PID, IPC, UTS, cgroup, and network namespaces, read-only binds
of host system directories, a private ``/workspace`` backed by a host
directory the provider owns, and prlimit-enforced memory, CPU, process, and
file-size limits. Requires Linux with unprivileged user namespaces.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import os
import re
import shutil
import stat
import tempfile
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
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

DEFAULT_BUBBLEWRAP_BINDS = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/etc/alternatives",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
]
SANDBOX_ROOT = "/workspace"
_ENVIRONMENT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_ENTRY_NAME = re.compile(r"[A-Za-z0-9._-]+")


@dataclass
class _State:
    host_root: str
    host_workspace: str
    spec: JsonObject
    limits_enforced: bool


class BubblewrapSandboxProvider:
    name = "bubblewrap"
    capabilities: ClassVar[dict[str, bool]] = {"readOnlyAttachments": True}

    def __init__(
        self,
        *,
        binary: str | None = None,
        prlimit_binary: str | None = None,
        binds: list[str] | None = None,
        state_directory: str | None = None,
        environment: dict[str, str] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._binary = binary or "bwrap"
        self._prlimit = prlimit_binary or "prlimit"
        self._binds = list(binds if binds is not None else DEFAULT_BUBBLEWRAP_BINDS)
        self._state_directory = os.path.abspath(state_directory or tempfile.gettempdir())
        self._environment = dict(environment or {})
        self._now = now or js_time.now
        self._sandboxes: dict[str, _State] = {}
        self._bind_arguments: list[str] | None = None
        self._prlimit_available: bool | None = None
        self._probe: asyncio.Future[None] | None = None
        for name in self._environment:
            if not _ENVIRONMENT_NAME.fullmatch(name):
                raise Error(f"Invalid environment name: {name}")

    def _bind_argument_list(self) -> list[str]:
        """Resolve bind arguments once; symbolic links (``/bin`` → ``usr/bin``) are recreated as links."""
        if self._bind_arguments is not None:
            return self._bind_arguments
        args: list[str] = []
        for bind in self._binds:
            if not os.path.isabs(bind):
                raise Error(f"Bind must be absolute: {bind}")
            try:
                info = os.lstat(bind)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode):
                args += ["--symlink", os.readlink(bind), bind]
            else:
                args += ["--ro-bind", bind, bind]
        self._bind_arguments = args
        return args

    async def probe(self, signal: AbortSignal | None = None) -> None:
        """Confirm bubblewrap can create an isolated sandbox on this host."""
        if self._probe is None:

            async def run() -> None:
                binds = self._bind_argument_list()
                _, stderr, code = await collect(
                    self._binary,
                    [
                        "--unshare-all",
                        "--die-with-parent",
                        "--new-session",
                        "--clearenv",
                        "--cap-drop",
                        "ALL",
                        *binds,
                        "--proc",
                        "/proc",
                        "--dev",
                        "/dev",
                        "--tmpfs",
                        "/tmp",
                        "--tmpfs",
                        SANDBOX_ROOT,
                        "--",
                        "/bin/true",
                    ],
                    None,
                    signal,
                    missing_exit_code=127,
                )
                if code != 0:
                    detail = (
                        stderr.decode("utf-8", "replace").strip()
                        or "install bubblewrap and enable unprivileged user namespaces"
                    )
                    raise Error(f"bubblewrap is unavailable (exit {code}): {detail}")
                _, _, prlimit_code = await collect(self._prlimit, ["--version"], missing_exit_code=127)
                self._prlimit_available = prlimit_code == 0

            self._probe = asyncio.ensure_future(run())
        try:
            await self._probe
        except BaseException:
            self._probe = None
            raise

    @property
    def limits_enforced(self) -> bool | None:
        return self._prlimit_available

    async def validate(self, spec: JsonObject, signal: AbortSignal | None = None) -> None:
        if spec["network"] != "none":
            raise Error("Bubblewrap sandbox only permits network: none.")
        assert_sandbox_path(spec["workingDirectory"])
        assert_sandbox_resource_limits(spec["limits"])
        for attachment in spec.get("attachments") or []:
            assert_sandbox_path(attachment["target"])
            if not os.path.isabs(attachment["source"]):
                raise Error(f"Attachment source must be absolute: {attachment['source']}")
        await self.probe(signal)

    async def create(self, spec: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        await self.validate(spec, signal)
        os.makedirs(self._state_directory, exist_ok=True)
        host_root = tempfile.mkdtemp(prefix="agent-runtime-bwrap-", dir=self._state_directory)
        host_workspace = os.path.join(host_root, "workspace")
        os.mkdir(host_workspace, 0o700)
        handle_id = f"bwrap-{uuid.uuid4()}"
        enforced = self._prlimit_available is True
        self._sandboxes[handle_id] = _State(host_root, host_workspace, spec, enforced)
        return {
            "id": handle_id,
            "provider": self.name,
            "createdAt": js_time.to_iso(self._now()),
            "providerData": {"hostRoot": host_root, "limitsEnforced": enforced, **(spec.get("metadata") or {})},
        }

    async def put_files(self, handle: JsonObject, files: list[JsonObject], signal: AbortSignal | None = None) -> None:
        state = self._state(handle)
        for file in files:
            if signal is not None:
                signal.throw_if_aborted()
            mode = file.get("mode") if file.get("mode") is not None else 0o600
            if isinstance(mode, bool) or not isinstance(mode, int) or mode < 0 or mode > 0o777:
                raise Error(f"Invalid sandbox file mode: {to_string(file.get('mode'))}")
            target = self._host_path(state, file["path"], for_write=True)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            temporary = f"{target}.{uuid.uuid4()}.tmp"
            content = file["content"]
            data = content.encode("utf-8") if isinstance(content, str) else bytes(content)
            try:
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(data)
                os.chmod(temporary, mode)
                os.replace(temporary, target)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(temporary)
                raise

    async def execute(
        self, handle: JsonObject, command: JsonObject, signal: AbortSignal | None = None
    ) -> AsyncIterator[JsonObject]:
        state = self._state(handle)
        args = [
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--clearenv",
            "--cap-drop",
            "ALL",
            *self._bind_argument_list(),
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--bind",
            state.host_workspace,
            SANDBOX_ROOT,
        ]
        for attachment in state.spec.get("attachments") or []:
            args += ["--ro-bind", attachment["source"], assert_sandbox_path(attachment["target"])]
        args += ["--chdir", assert_sandbox_path(command.get("cwd") or state.spec["workingDirectory"])]
        environment = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": "/tmp",
            "LANG": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            **self._environment,
            **(command.get("environment") or {}),
        }
        for name, value in js_json.js_entries(environment):
            if not _ENVIRONMENT_NAME.fullmatch(name):
                raise Error(f"Invalid environment name: {name}")
            args += ["--setenv", name, value]
        args.append("--")
        if state.limits_enforced:
            limits = state.spec["limits"]
            timeout = command.get("timeoutMs") if command.get("timeoutMs") is not None else limits["timeoutMs"]
            seconds = max(1, math.ceil(timeout / 1_000))
            memory = limits.get("memoryMb") if limits.get("memoryMb") is not None else 1_024
            processes = limits.get("processLimit") if limits.get("processLimit") is not None else 128
            tmpfs = limits.get("workspaceTmpfsMb") if limits.get("workspaceTmpfsMb") is not None else 1_024
            args += [
                self._prlimit,
                f"--as={memory * 1_048_576}",
                f"--cpu={seconds}",
                f"--nproc={processes}",
                f"--fsize={tmpfs * 1_048_576}",
                "--",
            ]
        args += [command["command"], *(command.get("args") or [])]
        async for event in stream_process(
            self._binary, args, signal=signal, timeout_ms=command.get("timeoutMs"), exit_code_when_signalled=137
        ):
            yield event

    async def list_files(
        self, handle: JsonObject, directory: str, signal: AbortSignal | None = None
    ) -> list[JsonObject]:
        state = self._state(handle)
        normalized = assert_sandbox_path(directory)
        files: list[JsonObject] = []
        pending = [normalized]
        while pending:
            if signal is not None:
                signal.throw_if_aborted()
            current = pending.pop(0)
            host_current = self._translate(state, current)
            try:
                entries = sorted(os.scandir(host_current), key=lambda entry: entry.name)
            except FileNotFoundError:
                continue
            for entry in entries:
                if entry.is_symlink():
                    continue
                if not _ENTRY_NAME.fullmatch(entry.name) or entry.name in (".", ".."):
                    continue
                sandbox_path = f"{current}/{entry.name}"
                if entry.is_dir(follow_symlinks=False):
                    pending.append(sandbox_path)
                elif entry.is_file(follow_symlinks=False):
                    info = os.lstat(os.path.join(host_current, entry.name))
                    if stat.S_ISREG(info.st_mode):
                        files.append({"path": sandbox_path, "size": info.st_size})
        return files

    async def read_file(self, handle: JsonObject, path: str, signal: AbortSignal | None = None) -> bytes:
        if signal is not None:
            signal.throw_if_aborted()
        state = self._state(handle)
        target = self._host_path(state, path, for_write=False)
        if not stat.S_ISREG(os.lstat(target).st_mode):
            raise Error(f"Sandbox path is not a regular file: {path}")
        with open(target, "rb") as stream:
            return stream.read()

    async def terminate(self, handle: JsonObject) -> None:
        state = self._sandboxes.pop(handle["id"], None)
        host_root = state.host_root if state is not None else (handle.get("providerData") or {}).get("hostRoot")
        if not isinstance(host_root, str) or not host_root:
            return
        if host_root != self._state_directory and host_root.startswith(f"{self._state_directory}{os.sep}"):
            shutil.rmtree(host_root, ignore_errors=True)

    def _state(self, handle: JsonObject) -> _State:
        state = self._sandboxes.get(handle["id"])
        if handle.get("provider") != self.name or state is None:
            raise Error("Sandbox handle does not belong to this BubblewrapSandboxProvider.")
        return state

    def _translate(self, state: _State, sandbox_path: str) -> str:
        normalized = assert_sandbox_path(sandbox_path)
        if normalized == SANDBOX_ROOT:
            return state.host_workspace
        return os.path.join(state.host_workspace, *normalized[len(SANDBOX_ROOT) + 1 :].split("/"))

    def _host_path(self, state: _State, sandbox_path: str, *, for_write: bool) -> str:
        """Map a sandbox path to the host, refusing any symbolic-link component."""
        target = self._translate(state, sandbox_path)
        current = state.host_workspace
        relative = os.path.relpath(target, state.host_workspace)
        for segment in [] if relative == "." else relative.split(os.sep):
            current = os.path.join(current, segment)
            try:
                info = os.lstat(current)
            except FileNotFoundError:
                if for_write:
                    return target
                raise Error(f"Sandbox path does not exist: {sandbox_path}") from None
            if stat.S_ISLNK(info.st_mode):
                raise Error(f"Sandbox path crosses a symbolic link: {sandbox_path}")
        return target
