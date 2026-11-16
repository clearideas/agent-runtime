"""
A minimal MCP Streamable HTTP endpoint on 127.0.0.1, for demos and tests
(``lib/mcp-server.ts``). It answers initialize, tools/list, and tools/call
with plain JSON-RPC, which is all an MCP client needs to discover and call
tools. Real deployments use an MCP server SDK; the runtime's client is the
same either way.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from . import js
from .host_kit import stringify
from .local_server import start_local_server

JsonObject = dict[str, Any]


@dataclass
class DemoMcpTool:
    name: str
    description: str
    input_schema: JsonObject
    call: Callable[[JsonObject], Any | Awaitable[Any]]


@dataclass
class DemoMcpServer:
    url: str
    close: Callable[[], Awaitable[None]]
    #: Every tools/call received, in order.
    calls: list[JsonObject] = field(default_factory=list)


async def start_mcp_server(name: str, tools: list[DemoMcpTool]) -> DemoMcpServer:
    calls: list[JsonObject] = []
    json_headers = {"content-type": "application/json"}

    async def handle(method: str, path: str, body: bytes) -> tuple[int, dict[str, str], bytes]:
        if method != "POST":
            return 405, {}, b""
        try:
            message = js.parse(body.decode("utf-8") or "{}")
        except ValueError:
            return 400, {}, b""

        def reply(result: Any) -> tuple[int, dict[str, str], bytes]:
            return 200, json_headers, stringify({"jsonrpc": "2.0", "id": message.get("id"), "result": result}).encode()

        rpc = message.get("method") or ""
        params = message.get("params") or {}
        if rpc == "initialize":
            return reply(
                {
                    "protocolVersion": params.get("protocolVersion") or "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": name, "version": "1.0.0"},
                }
            )
        if rpc.startswith("notifications/"):
            return 202, {}, b""
        if rpc == "tools/list":
            return reply(
                {
                    "tools": [
                        {"name": tool.name, "description": tool.description, "inputSchema": tool.input_schema}
                        for tool in tools
                    ]
                }
            )
        if rpc == "tools/call":
            tool_name = str(params.get("name") or "")
            arguments = params.get("arguments") or {}
            tool = next((entry for entry in tools if entry.name == tool_name), None)
            calls.append({"name": tool_name, "input": arguments})
            if tool is None:
                return reply({"isError": True, "content": [{"type": "text", "text": f"Unknown tool {tool_name}"}]})
            output = tool.call(arguments)
            if inspect.isawaitable(output):
                output = await output
            return reply({"content": [{"type": "text", "text": stringify(output)}], "structuredContent": output})
        return 404, {}, b""

    server = await start_local_server(handle)
    return DemoMcpServer(url=f"{server.url}/mcp", close=server.close, calls=calls)
