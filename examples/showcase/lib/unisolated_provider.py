"""
DEMO FALLBACK ONLY — provides no isolation whatsoever (``lib/unisolated-provider.ts``).

Wraps the sandbox package's test-only HostProcessTestProvider, which runs
commands as ordinary host processes in a temporary directory and rewrites
`/workspace` paths (in argv, environment values, and the workspace index that
code steps read) to that directory. Never use this outside a local demo.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import AsyncIterator
from typing import Any

from clearideas_agent_runtime.sandbox.testing import HostProcessTestProvider


def _is_helper(command: dict[str, Any]) -> bool:
    return any(argument.endswith("/bin/agent-fs") for argument in command.get("args") or [])


class UnisolatedDemoProvider(HostProcessTestProvider):
    def __init__(self, python: str | None = None) -> None:
        """``python``: absolute interpreter path to run instead of ``python3``."""
        super().__init__()
        self._python = python

    def _resolve(self, command: dict[str, Any]) -> dict[str, Any]:
        """
        The base provider runs commands with only PATH set, which breaks
        `python3` shims that need HOME. Run the real interpreter instead. If
        its path contains "/workspace" (which the base provider rewrites),
        keep `python3` and pass HOME through.
        """
        if command.get("command") != "python3" or not self._python:
            return command
        if not re.search(r"/workspace(?=/|$)", self._python):
            return {**command, "command": self._python}
        return {**command, "environment": {**(command.get("environment") or {}), "HOME": os.environ.get("HOME", "")}}

    async def execute(self, handle: Any, command: Any, signal: Any = None) -> AsyncIterator[dict[str, Any]]:
        """
        Agent Runtime reports a failed helper operation (for example a
        workspace snapshot) without the helper's error output. Print it to the
        server console so demo failures on unusual machines can be diagnosed.
        """
        stderr: list[str] = []
        async for event in super().execute(handle, self._resolve(command), signal):
            if event["type"] == "stderr":
                stderr.append(event["data"])
            # Exit codes 2-5 are the helper's documented refusals (usage,
            # path, limit, read-only); anything else means it could not run.
            if event["type"] == "exit" and event["exitCode"] not in (0, 2, 3, 4, 5) and _is_helper(command):
                args = command.get("args") or []
                index = next(i for i, argument in enumerate(args) if argument.endswith("/bin/agent-fs"))
                operation = args[index + 1] if index + 1 < len(args) else None
                output = "".join(stderr).strip() or "(no error output)"
                print(
                    f'[showcase] sandbox helper "{operation}" exited with {event["exitCode"]} ({sys.platform}, {command.get("command")}).\n{output}',
                    file=sys.stderr,
                )
            yield event
