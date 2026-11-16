"""
A small real-provider check used by ``npm run doctor:python -- --live``
(``lib/live-check.ts``).

A plain text reply only proves the key works. The demos also need the model
to call tools and to return structured output, so this runs a two-step agent
that does both and reports each capability separately. It makes three short
model calls.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from clearideas_agent_runtime import create_agent_runtime, define_agent, parse_agent_runtime_config

from . import js
from .host_kit import stringify

CODE = "AR-0600-OK"


@dataclass
class LiveCheckResult:
    ok: bool
    #: One line per capability, for the doctor's report: ``{"ok", "text"}``.
    lines: list[dict[str, Any]] = field(default_factory=list)
    total_tokens: int | None = None
    #: The error message when a call failed outright.
    error: str | None = None


async def check_live_model(*, provider: str, model: str, model_adapter: Any = None) -> LiveCheckResult:
    """``model_adapter`` is for tests only: it replaces the provider model."""
    manifest = define_agent(
        {
            "schemaVersion": "1.0",
            "model": {"ref": "default"},
            "steps": [
                {
                    "id": "tool",
                    "type": "prompt",
                    "prompt": "Call the lookup_code tool once. Then reply with the code it returned and nothing else.",
                    "tools": ["lookup_code"],
                    "outputVariable": "reply",
                },
                {
                    "id": "structured",
                    "type": "prompt",
                    "prompt": "Text: {{ reply }}\n\nExtract the code from the text.",
                    "outputSchema": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["code"],
                        "properties": {"code": {"type": "string"}},
                    },
                    "outputVariable": "extracted",
                    "includeInFinalOutput": True,
                },
            ],
        }
    )
    config = parse_agent_runtime_config(
        {"version": "1.0", "models": {"default": {"provider": provider, "model": model}}}
    )
    tool_calls = 0

    class LookupTool:
        async def list_tools(self) -> list[dict[str, Any]]:
            return [
                {
                    "name": "lookup_code",
                    "description": "Returns the connection-check code.",
                    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
                }
            ]

        async def execute_tool(self, call: dict[str, Any], context: Any) -> dict[str, Any]:
            nonlocal tool_calls
            tool_calls += 1
            return {"callId": call["id"], "name": call["name"], "output": {"code": CODE}}

    runtime = create_agent_runtime(manifest=manifest, config=config, model=model_adapter, tools=LookupTool())
    try:
        result = await runtime.run({})
    except Exception as error:
        return LiveCheckResult(ok=False, error=str(error))
    state = result.get("state") or {}
    reply = str(state.get("reply") if state.get("reply") is not None else "")
    extracted = state.get("extracted")
    code = extracted.get("code") if isinstance(extracted, dict) else None
    lines = [
        {
            "ok": tool_calls > 0 and CODE in reply,
            "text": f"tool calls: called lookup_code and replied “{js.slice(js.trim(reply), 0, 40)}”"
            if tool_calls > 0
            else "tool calls: the model answered without calling the tool",
        },
        {
            "ok": isinstance(code, str) and CODE in code,
            "text": f"structured output: {js.slice(stringify(extracted), 0, 60)}",
        },
    ]
    usage = result.get("usage") or {}
    return LiveCheckResult(
        ok=all(line["ok"] for line in lines), lines=lines, total_tokens=usage.get("totalTokens") or None
    )
