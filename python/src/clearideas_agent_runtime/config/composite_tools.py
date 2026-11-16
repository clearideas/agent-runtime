"""Tool routing across adapters (``packages/runtime/src/composite-tools.ts``)."""

from __future__ import annotations

import inspect
from collections.abc import Iterable
from typing import Any

from .._js.errors import Error

JsonObject = dict[str, Any]


class CompositeToolAdapter:
    """Routes discovery and execution across adapters; tool names must be unique."""

    def __init__(self, adapters: Iterable[Any]) -> None:
        self.adapters = list(adapters)
        self._routes: dict[str, Any] = {}

    async def list_tools(self) -> list[JsonObject]:
        routes: dict[str, Any] = {}
        tools: list[JsonObject] = []
        for adapter in self.adapters:
            for tool in await adapter.list_tools():
                if tool["name"] in routes:
                    raise Error(
                        f"Tool name collision across adapters: {tool['name']}. Use distinct connection and workspace aliases."
                    )
                routes[tool["name"]] = adapter
                tools.append(tool)
        self._routes = routes
        return tools

    def is_tool_excluded(self, name: str) -> bool:
        return name not in self._routes and any(
            getattr(adapter, "is_tool_excluded", None) is not None and adapter.is_tool_excluded(name) is True
            for adapter in self.adapters
        )

    def unavailable_tool_reason(self, name: str) -> str | None:
        if name in self._routes:
            return None
        for adapter in self.adapters:
            reason_of = getattr(adapter, "unavailable_tool_reason", None)
            reason = reason_of(name) if reason_of is not None else None
            if reason is not None:
                return reason
        return None

    async def execute_tool(self, call: JsonObject, context: Any) -> JsonObject:
        if not self._routes:
            await self.list_tools()
        adapter = self._routes.get(call["name"])
        if adapter is None:
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {"code": "tool_not_allowed", "message": f'Tool "{call["name"]}" is not available.'},
            }
        return await adapter.execute_tool(call, context)

    async def close(self) -> None:
        """Close every adapter that exposes ``close``."""
        for adapter in self.adapters:
            close = getattr(adapter, "close", None)
            if callable(close):
                result = close()
                if inspect.isawaitable(result):
                    await result
