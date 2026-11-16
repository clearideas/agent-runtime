"""MCP tools over streamable HTTP: both runtimes list and call the same server's
tools and must produce identical tool definitions and tool results.

A tool result is what the model receives and what transcripts keep, so it
must be the server's reply as sent: members the server omitted (such as
``isError``) must not appear, and members it sent (``_meta``, annotations,
unknown fields) must be kept.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from clearideas_agent_runtime import (
    ToolExecutionContext,
    ValueResolutionContext,
    create_configured_tool_adapter,
    parse_agent_runtime_config,
)

SCHEMA = {"type": "object", "properties": {"q": {"type": "string"}}, "additionalProperties": False}
TOOLS: list[dict[str, Any]] = [
    {"name": "structured", "description": "Structured output.", "inputSchema": SCHEMA},
    {
        "name": "plain",
        "title": "Plain text",
        "description": "Text with annotations.",
        "inputSchema": {"type": "object"},
        "annotations": {"readOnlyHint": True},
    },
    {"name": "extra", "description": "Unknown members.", "inputSchema": SCHEMA},
    {"name": "fails", "description": "Reports an error.", "inputSchema": SCHEMA},
    {"name": "explicit", "description": "Sends isError: false.", "inputSchema": SCHEMA},
    {"name": "echo", "description": "Returns the request's parameters.", "inputSchema": SCHEMA},
]
REPLIES: dict[str, dict[str, Any]] = {
    "structured": {
        "content": [{"type": "text", "text": '{"a":1}'}],
        "structuredContent": {"a": 1, "nested": {"b": [1, 2.5, None]}},
    },
    "plain": {"content": [{"type": "text", "text": "hello", "annotations": {"audience": ["user"]}}]},
    "extra": {"content": [{"type": "text", "text": "x"}], "_meta": {"trace": "t-1"}, "custom": True},
    "fails": {"content": [{"type": "text", "text": "nope"}], "isError": True},
    "explicit": {"content": [], "isError": False},
}


#: JSON-RPC requests and notifications received, in order: ``(method, params)``.
METHODS: list[tuple[str, Any]] = []


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _reply(self, status: int, body: Any = None) -> None:
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        if body is not None:
            self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        self._reply(405)

    def do_DELETE(self) -> None:
        self._reply(405)

    def do_POST(self) -> None:
        message = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        method = message.get("method", "")
        METHODS.append((method, message.get("params")))
        if method.startswith("notifications/"):
            self._reply(202)
            return
        if method == "initialize":
            result: Any = {
                "protocolVersion": message["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "interop", "version": "1.0.0"},
            }
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call" and message["params"]["name"] == "echo":
            result = {"content": [], "structuredContent": message["params"]}
        elif method == "tools/call":
            result = REPLIES[message["params"]["name"]]
        else:
            self._reply(404)
            return
        self._reply(200, {"jsonrpc": "2.0", "id": message.get("id"), "result": result})


@pytest.fixture(scope="module")
def server_url() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/mcp"
    server.shutdown()
    server.server_close()
    thread.join()


async def _python_tools(url: str, tools: list[str], calls: list[dict[str, Any]]) -> dict[str, Any]:
    adapter = create_configured_tool_adapter(
        {
            "schemaVersion": "1.0",
            "connections": [{"ref": "svc", "alias": "svc", "mode": "read_write", "tools": tools}],
            "steps": [{"id": "s", "type": "prompt", "prompt": "p"}],
        },
        parse_agent_runtime_config(
            {
                "version": "1.0",
                "connections": {
                    "svc": {
                        "driver": "mcp",
                        "transport": "streamable-http",
                        "url": url,
                        "mode": "read_write",
                        "tools": tools,
                    }
                },
            }
        ),
        ValueResolutionContext(environment={}),
    )
    assert adapter is not None
    listed = await adapter.list_tools()
    results = [
        await adapter.execute_tool(
            {"id": f"call-{index}", "name": f"svc__{call['name']}", "input": call["input"]},
            ToolExecutionContext(
                run_id="run", step_id="step", variables={}, idempotency_key=call.get("idempotencyKey")
            ),
        )
        for index, call in enumerate(calls)
    ]
    return {"listed": listed, "results": results}


async def test_tool_definitions_and_results_match(oracle, server_url: str) -> None:
    names = [tool["name"] for tool in TOOLS]
    calls = [{"name": name, "input": {"q": "x"}} for name in names]
    calls.append({"name": "echo", "input": {"q": "é"}, "idempotencyKey": "run:step:call-9"})
    METHODS.clear()
    [expected] = oracle.values("mcpTools", [{"url": server_url, "tools": names, "calls": calls}])
    typescript_methods = list(METHODS)
    METHODS.clear()
    actual = await _python_tools(server_url, names, calls)
    # The same conversation with the server: the same requests and parameters,
    # and no extra requests either way.
    assert METHODS == typescript_methods
    assert actual["listed"] == expected["listed"]
    assert actual["results"] == expected["results"]
    # The reply as the server sent it.
    assert "isError" not in actual["results"][0]["output"]
    assert actual["results"][2]["output"]["_meta"] == {"trace": "t-1"}
    assert actual["results"][3]["error"]["code"] == "mcp_tool_error"
    # Both send the tool's arguments and the idempotency key the same way.
    assert actual["results"][-1]["output"]["structuredContent"]["_meta"] == {
        "agent-runtime/idempotency-key": "run:step:call-9"
    }
