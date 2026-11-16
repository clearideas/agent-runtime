"""
Mirror tool inputs and outputs to an observer (``lib/observed-tools.ts``).

Agent Runtime's `model.tool.*` events deliberately carry only tool names and
call IDs, so event logs never leak payloads. A host that wants to *show*
payloads (as this showcase does) wraps its ToolAdapter. Apply your own
redaction and retention policy before doing this in production.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from clearideas_agent_runtime import ToolExecutionContext

from . import js

JsonObject = dict[str, Any]

MAX_MIRRORED_CHARACTERS = 6000


@dataclass
class ObservedToolCall:
    step_id: str
    call: JsonObject
    result: JsonObject


def truncate_for_display(value: Any) -> Any:
    """Keep mirrored payloads small; the durable transcript retains the full result."""
    if value is None:
        return None
    text = js.stringify(value)
    if js.length(text) <= MAX_MIRRORED_CHARACTERS:
        return value
    return {"truncated": True, "preview": js.slice(text, 0, MAX_MIRRORED_CHARACTERS)}


class ObservedToolAdapter:
    def __init__(self, inner: Any, observe: Callable[[ObservedToolCall], None]) -> None:
        self._inner = inner
        self._observe = observe

    async def list_tools(self) -> list[JsonObject]:
        return await self._inner.list_tools()

    def is_tool_excluded(self, name: str) -> bool:
        """
        Forward every optional ToolAdapter method too. This one lets a prompt
        step continue when host policy removed a tool it names (for example an
        MCP tool whose pinned digest no longer matches).
        """
        excluded = getattr(self._inner, "is_tool_excluded", None)
        return excluded is not None and excluded(name) is True

    async def execute_tool(self, call: JsonObject, context: ToolExecutionContext) -> JsonObject:
        result = await self._inner.execute_tool(call, context)
        self._observe(ObservedToolCall(step_id=context.step_id, call=call, result=result))
        return result
