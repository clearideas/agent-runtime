"""Shared helpers for porting vitest suites."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from typing import Any


class FnExecutor:
    """A step executor from a function, like ``{ type, execute }`` object literals."""

    def __init__(self, type: str, execute: Callable[[Any], Any], preflight: Callable[..., Any] | None = None) -> None:
        self.type = type
        self._execute = execute
        if preflight is not None:
            self.preflight = preflight

    async def execute(self, context: Any) -> Any:
        result = self._execute(context)
        return await result if inspect.isawaitable(result) else result


def executor(type: str, execute: Callable[[Any], Any], **kwargs: Any) -> FnExecutor:
    return FnExecutor(type, execute, **kwargs)


def future() -> asyncio.Future[Any]:
    return asyncio.get_running_loop().create_future()
