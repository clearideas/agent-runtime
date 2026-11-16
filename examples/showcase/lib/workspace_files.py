"""
Host-side helpers for demo workspaces: seed a directory from a fixture and
describe it for the browser, including files the agent can never see
(``lib/workspace-files.ts``).

Visibility is decided by the same LocalDirectoryWorkspace store Agent Runtime
uses, so "hidden" in the UI means "never staged into the sandbox".
"""

from __future__ import annotations

import os
import re
import shutil
from typing import Any

from clearideas_agent_runtime import LocalDirectoryWorkspace

from . import js

MAX_TEXT_BYTES = 64 * 1024
_ADDRESSABLE = re.compile(r"^[A-Za-z0-9_]")


def seed_workspace(fixture: str, target: str) -> None:
    """Replace ``target`` with a fresh copy of ``fixture``."""
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copytree(fixture, target, symlinks=True)


def _walk(root: str, relative: str = "") -> list[str]:
    try:
        entries = list(os.scandir(os.path.join(root, relative)))
    except OSError:
        return []
    files: list[str] = []
    for entry in entries:
        child = f"{relative}/{entry.name}" if relative else entry.name
        if entry.is_dir(follow_symlinks=False):
            files.extend(_walk(root, child))
        else:
            files.append(child)
    return sorted(files, key=js.code_unit_key)


def _read_bytes(file: str) -> bytes | None:
    try:
        with open(file, "rb") as handle:
            return handle.read()
    except OSError:
        return None


def _read_text(file: str) -> str | None:
    try:
        info = os.lstat(file)
    except OSError:
        return None
    if not os.path.isfile(file) or os.path.islink(file) or info.st_size > MAX_TEXT_BYTES:
        return None
    data = _read_bytes(file)
    if data is None or b"\0" in data:
        return None
    return data.decode("utf-8", errors="replace")


async def describe_workspace(
    *,
    root: str,
    fixture: str,
    include: list[str] | None = None,
    exclude: list[str] | None = None,
    max_file_bytes: int | None = None,
) -> list[dict[str, Any]]:
    """Every file under ``root``: size, visibility to the sandbox, text, and change status."""
    store = LocalDirectoryWorkspace(root=root, mode="read", include=include, exclude=exclude)
    try:
        visible = {entry["path"] for entry in await store.entries()}
    except Exception:
        visible = set()
    files: list[dict[str, Any]] = []
    for relative in _walk(root):
        absolute = os.path.join(root, relative)
        info = os.lstat(absolute)
        is_file = os.path.isfile(absolute) and not os.path.islink(absolute)
        content = _read_text(absolute)
        baseline = _read_text(os.path.join(fixture, relative))
        original = _read_bytes(os.path.join(fixture, relative))
        current = _read_bytes(absolute) if is_file else None
        too_large = bool(max_file_bytes) and info.st_size > (max_file_bytes or 0)
        is_visible = relative in visible and not too_large
        if os.path.islink(absolute):
            hidden_reason = "symbolic links are never followed"
        elif any(not _ADDRESSABLE.match(segment) for segment in relative.split("/")):
            hidden_reason = "dot-files are never addressable"
        elif too_large:
            hidden_reason = "larger than the host's file size limit"
        else:
            hidden_reason = "outside the host's include/exclude globs"
        entry: dict[str, Any] = {"path": relative, "size": info.st_size, "visible": is_visible}
        if not is_visible:
            entry["hiddenReason"] = hidden_reason
        if content is not None:
            entry["content"] = content
        if baseline is not None and baseline != content:
            entry["baseline"] = baseline
        # Only files the agent can see can have been changed by it.
        if not is_visible:
            entry["status"] = "unchanged"
        elif original is None:
            entry["status"] = "created"
        elif current is not None and original == current:
            entry["status"] = "unchanged"
        else:
            entry["status"] = "modified"
        files.append(entry)
    return files
