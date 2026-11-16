"""Workspace stores (``store-local``: workspace-common, workspace.memory, workspace.directory)."""

from __future__ import annotations

import os
import re
import stat
from collections.abc import Callable
from datetime import datetime
from typing import Any

from ..._js import strings as js_strings
from ..._js import time as js_time
from ..._js.abort import AbortSignal
from ..._js.errors import Error
from ...core.ports import assert_workspace_path, is_safe_workspace_path
from .files import write_atomically

JsonObject = dict[str, Any]
MAXIMUM_GLOB_LENGTH = 512
DEFAULT_WORKSPACE_MAX_FILES = 5_000
DEFAULT_WORKSPACE_MAX_FILE_BYTES = 1_048_576
DEFAULT_WORKSPACE_MAX_TOTAL_BYTES = 100 * 1_048_576
DEFAULT_MAX_SCAN_ENTRIES = 200_000


# JavaScript `.` (without the s flag): any character except line terminators.
_ANY = "[^\\n\\r\\u2028\\u2029]"


def compile_glob(pattern: str) -> re.Pattern[str]:
    """``**`` spans segments, ``*`` stays within one, ``?`` is one character; anchored."""
    if not js_strings.trim(pattern) or js_strings.length(pattern) > MAXIMUM_GLOB_LENGTH:
        raise Error(f"Invalid workspace glob: {pattern}")
    source = ""
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "*":
            if pattern[index + 1 : index + 2] == "*":
                followed_by_slash = pattern[index + 2 : index + 3] == "/"
                source += f"(?:{_ANY}*/)?" if followed_by_slash else f"{_ANY}*"
                index += 3 if followed_by_slash else 2
                continue
            source += "[^/]*"
            index += 1
            continue
        if character == "?":
            source += "[^/]"
            index += 1
            continue
        source += re.escape(character)
        index += 1
    return re.compile(f"^{source}\\Z")


class WorkspacePathFilter:
    def __init__(self, include: list[str] | None = None, exclude: list[str] | None = None) -> None:
        self._include = [compile_glob(pattern) for pattern in include or []]
        self._exclude = [compile_glob(pattern) for pattern in exclude or []]

    @property
    def is_unfiltered(self) -> bool:
        return not self._include and not self._exclude

    def is_visible(self, relative_path: str) -> bool:
        if any(pattern.search(relative_path) for pattern in self._exclude):
            return False
        return not self._include or any(pattern.search(relative_path) for pattern in self._include)

    def is_directory_excluded(self, relative_directory: str) -> bool:
        probe = f"{relative_directory}/"
        return any(pattern.search(probe) for pattern in self._exclude)


def positive_integer(value: int | None, fallback: int, label: str) -> int:
    if value is None:
        return fallback
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > 2**53 - 1:
        raise Error(f"{label} must be a positive safe integer.")
    return value


def throw_if_aborted(signal: AbortSignal | None) -> None:
    if signal is None or not signal.aborted:
        return
    reason = signal.reason
    raise reason if isinstance(reason, BaseException) else Error("Workspace operation was aborted")


def _limits(max_files: int | None, max_file_bytes: int | None, max_total_bytes: int | None) -> JsonObject:
    return {
        "maxFiles": positive_integer(max_files, DEFAULT_WORKSPACE_MAX_FILES, "Workspace maxFiles"),
        "maxFileBytes": positive_integer(max_file_bytes, DEFAULT_WORKSPACE_MAX_FILE_BYTES, "Workspace maxFileBytes"),
        "maxTotalBytes": positive_integer(
            max_total_bytes, DEFAULT_WORKSPACE_MAX_TOTAL_BYTES, "Workspace maxTotalBytes"
        ),
    }


class MemoryWorkspace:
    """An in-memory workspace for tests, examples, and ephemeral embedding hosts."""

    def __init__(
        self,
        *,
        mode: str = "read",
        files: dict[str, bytes | str] | None = None,
        include: list[str] | None = None,
        exclude: list[str] | None = None,
        max_files: int | None = None,
        max_file_bytes: int | None = None,
        max_total_bytes: int | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.mode = mode
        self._filter = WorkspacePathFilter(include, exclude)
        self.limits = _limits(max_files, max_file_bytes, max_total_bytes)
        self._now = now or js_time.now
        self._files: dict[str, JsonObject] = {}
        for relative_path, content in (files or {}).items():
            self._store(assert_workspace_path(relative_path), content)

    @property
    def paths(self) -> list[str]:
        return sorted(self._files, key=js_strings.code_unit_key)

    def text(self, relative_path: str) -> str | None:
        stored = self._files.get(relative_path)
        return stored["data"].decode("utf-8", "replace") if stored else None

    async def entries(self, signal: AbortSignal | None = None) -> list[JsonObject]:
        throw_if_aborted(signal)
        return [self._entry(path, self._files[path]) for path in self.paths if self._filter.is_visible(path)]

    async def read(self, relative_path: str, signal: AbortSignal | None = None) -> bytes:
        throw_if_aborted(signal)
        target = self._visible_path(relative_path)
        stored = self._files.get(target)
        if stored is None:
            raise Error(f"Workspace file is not available: {relative_path}")
        if len(stored["data"]) > self.limits["maxFileBytes"]:
            raise Error(f"Workspace file {relative_path} exceeds the {self.limits['maxFileBytes']}-byte limit.")
        return bytes(stored["data"])

    async def write(self, relative_path: str, data: bytes, signal: AbortSignal | None = None) -> JsonObject:
        self._assert_writable()
        throw_if_aborted(signal)
        target = self._visible_path(relative_path)
        if len(data) > self.limits["maxFileBytes"]:
            raise Error(
                f"Workspace write to {relative_path} is {len(data)} bytes, exceeding the {self.limits['maxFileBytes']}-byte limit."
            )
        if target not in self._files and len(self._files) >= self.limits["maxFiles"]:
            raise Error(f"Workspace cannot hold more than {self.limits['maxFiles']} files.")
        return self._entry(target, self._store(target, data))

    async def delete(self, relative_path: str, signal: AbortSignal | None = None) -> None:
        self._assert_writable()
        throw_if_aborted(signal)
        target = self._visible_path(relative_path)
        if self._files.pop(target, None) is None:
            raise Error(f"Workspace file is not available: {relative_path}")

    def _assert_writable(self) -> None:
        if self.mode != "read_write":
            raise Error("Workspace is read-only.")

    def _visible_path(self, relative_path: str) -> str:
        normalized = assert_workspace_path(relative_path)
        if not self._filter.is_visible(normalized):
            raise Error(f"Workspace file is not available: {relative_path}")
        return normalized

    def _store(self, relative_path: str, content: bytes | str) -> JsonObject:
        stored = {
            "data": content.encode("utf-8", "surrogatepass") if isinstance(content, str) else bytes(content),
            "modifiedAt": js_time.to_iso(self._now()),
        }
        self._files[relative_path] = stored
        return stored

    @staticmethod
    def _entry(relative_path: str, stored: JsonObject) -> JsonObject:
        return {"path": relative_path, "size": len(stored["data"]), "modifiedAt": stored["modifiedAt"]}


def _mtime_iso(stats: os.stat_result) -> str:
    return js_time.iso_from_ms(stats.st_mtime_ns // 1_000_000)


class LocalDirectoryWorkspace:
    """A workspace backed by a host directory (confined, no symlinks, hidden entries unaddressable)."""

    def __init__(
        self,
        *,
        root: str,
        attach: str = "never",
        mode: str = "read",
        include: list[str] | None = None,
        exclude: list[str] | None = None,
        max_files: int | None = None,
        max_file_bytes: int | None = None,
        max_total_bytes: int | None = None,
        max_scan_entries: int | None = None,
    ) -> None:
        if not js_strings.trim(root):
            raise Error("LocalDirectoryWorkspace requires a root directory.")
        self._root = os.path.abspath(root)
        self.mode = mode
        self._filter = WorkspacePathFilter(include, exclude)
        self.limits = _limits(max_files, max_file_bytes, max_total_bytes)
        self._max_scan_entries = positive_integer(
            max_scan_entries, DEFAULT_MAX_SCAN_ENTRIES, "Workspace maxScanEntries"
        )
        if attach == "auto" and self._filter.is_unfiltered:
            self.attachable = {"kind": "local-directory", "root": self._root}

    @property
    def root(self) -> str:
        return self._root

    async def entries(self, signal: AbortSignal | None = None) -> list[JsonObject]:
        entries: list[JsonObject] = []
        pending = [""]
        visited = 0
        while pending:
            throw_if_aborted(signal)
            directory = pending.pop(0)
            try:
                children = list(os.scandir(self._absolute(directory)))
            except FileNotFoundError:
                if directory == "":
                    return []
                raise
            children.sort(key=lambda child: js_strings.code_unit_key(child.name))
            for child in children:
                visited += 1
                if visited > self._max_scan_entries:
                    raise Error(f"Workspace enumeration exceeded {self._max_scan_entries} directory entries.")
                relative = f"{directory}/{child.name}" if directory else child.name
                if not is_safe_workspace_path(relative):
                    continue
                if child.is_symlink():
                    continue
                if child.is_dir(follow_symlinks=False):
                    if not self._filter.is_directory_excluded(relative):
                        pending.append(relative)
                    continue
                if not child.is_file(follow_symlinks=False) or not self._filter.is_visible(relative):
                    continue
                stats = os.lstat(self._absolute(relative))
                if not stat.S_ISREG(stats.st_mode):
                    continue
                entries.append({"path": relative, "size": stats.st_size, "modifiedAt": _mtime_iso(stats)})
                if len(entries) > self.limits["maxFiles"]:
                    raise Error(f"Workspace contains more than {self.limits['maxFiles']} visible files.")
        entries.sort(key=lambda entry: js_strings.code_unit_key(entry["path"]))
        return entries

    async def read(self, relative_path: str, signal: AbortSignal | None = None) -> bytes:
        throw_if_aborted(signal)
        entry = self._stat_visible_file(relative_path)
        if entry["size"] > self.limits["maxFileBytes"]:
            raise Error(
                f"Workspace file {relative_path} is {entry['size']} bytes, exceeding the {self.limits['maxFileBytes']}-byte limit."
            )
        with open(self._absolute(entry["path"]), "rb") as handle:
            data = handle.read()
        if len(data) > self.limits["maxFileBytes"]:
            raise Error(f"Workspace file {relative_path} exceeds the {self.limits['maxFileBytes']}-byte limit.")
        return data

    async def write(self, relative_path: str, data: bytes, signal: AbortSignal | None = None) -> JsonObject:
        self._assert_writable()
        throw_if_aborted(signal)
        target = self._visible_path(relative_path)
        if len(data) > self.limits["maxFileBytes"]:
            raise Error(
                f"Workspace write to {relative_path} is {len(data)} bytes, exceeding the {self.limits['maxFileBytes']}-byte limit."
            )
        self._assert_no_symbolic_links(target)
        absolute = self._absolute(target)
        try:
            existing = os.lstat(absolute)
        except FileNotFoundError:
            existing = None
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            raise Error(f"Workspace path {relative_path} is not a regular file.")
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        await write_atomically(absolute, data, stat.S_IMODE(existing.st_mode) if existing is not None else 0o600)
        written = os.lstat(absolute)
        return {"path": target, "size": written.st_size, "modifiedAt": _mtime_iso(written)}

    async def delete(self, relative_path: str, signal: AbortSignal | None = None) -> None:
        self._assert_writable()
        throw_if_aborted(signal)
        entry = self._stat_visible_file(relative_path)
        os.unlink(self._absolute(entry["path"]))

    def _assert_writable(self) -> None:
        if self.mode != "read_write":
            raise Error("Workspace is read-only.")

    def _visible_path(self, relative_path: str) -> str:
        normalized = assert_workspace_path(relative_path)
        if not self._filter.is_visible(normalized):
            raise Error(f"Workspace file is not available: {relative_path}")
        return normalized

    def _absolute(self, relative_path: str) -> str:
        absolute = os.path.abspath(os.path.join(self._root, *relative_path.split("/"))) if relative_path else self._root
        if absolute != self._root and not absolute.startswith(f"{self._root}{os.sep}"):
            raise Error(f"Workspace path escapes the root: {relative_path}")
        return absolute

    def _assert_no_symbolic_links(self, relative_path: str) -> None:
        current = self._root
        for segment in relative_path.split("/"):
            current = os.path.join(current, segment)
            try:
                stats = os.lstat(current)
            except FileNotFoundError:
                return
            if stat.S_ISLNK(stats.st_mode):
                raise Error(f"Workspace path {relative_path} crosses a symbolic link.")

    def _stat_visible_file(self, relative_path: str) -> JsonObject:
        target = self._visible_path(relative_path)
        self._assert_no_symbolic_links(target)
        try:
            stats = os.lstat(self._absolute(target))
        except FileNotFoundError:
            stats = None
        if stats is None or not stat.S_ISREG(stats.st_mode):
            raise Error(f"Workspace file is not available: {relative_path}")
        return {"path": target, "size": stats.st_size, "modifiedAt": _mtime_iso(stats)}
