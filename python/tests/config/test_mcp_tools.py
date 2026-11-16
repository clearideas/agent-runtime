"""Port of ``packages/runtime/src/mcp-tools.test.ts`` and ``mcp-http.test.ts``."""

from __future__ import annotations

import asyncio
import contextlib
import socket
import threading
from typing import Any

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.config import (
    ConfiguredMcpToolAdapter,
    McpToolIntegrityError,
    ValueResolutionContext,
    compute_mcp_tool_digest,
    discover_mcp_connection_tools,
    parse_agent_runtime_config,
)
from clearideas_agent_runtime.core.ports import ToolExecutionContext

try:  # the mcp extra
    from mcp.server.mcpserver import Context, MCPServer
except ImportError:  # pragma: no cover
    Context = MCPServer = None  # type: ignore[assignment,misc]

SEARCH = {
    "name": "search",
    "description": "Search documents",
    "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
    "annotations": {"readOnlyHint": False},
}
DELETE = {
    "name": "delete",
    "description": "Delete a document",
    "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}},
    "annotations": {"readOnlyHint": True, "destructiveHint": True},
}


class FakeMcp:
    """Stands in for the MCP SDK client (the TypeScript suite mocks the same layer)."""

    def __init__(self, pages: list[list[dict]] | None = None) -> None:
        self.pages = pages or [[SEARCH, DELETE]]
        self.requests: list[Any] = []
        self.calls: list[tuple[str, dict, dict | None]] = []
        self.call_results: list[Any] = []
        self.fail_connect: Exception | None = None

    def factory(self, request: Any) -> Any:
        fake = self

        @contextlib.asynccontextmanager
        async def open_session():
            fake.requests.append(request)
            if fake.fail_connect is not None:
                raise fake.fail_connect

            class Session:
                async def list_tools(self, cursor: str | None) -> dict:
                    index = int(cursor) if cursor else 0
                    page: dict = {"tools": fake.pages[index]}
                    if index + 1 < len(fake.pages):
                        page["nextCursor"] = str(index + 1)
                    return page

                async def call_tool(self, name: str, arguments: dict, meta: dict | None) -> dict:
                    fake.calls.append((name, arguments, meta))
                    if fake.call_results:
                        result = fake.call_results.pop(0)
                        if isinstance(result, Exception):
                            raise result
                        return result
                    return {"content": [{"type": "text", "text": "found"}]}

            yield Session()

        return open_session()


def config(**connection: Any) -> dict:
    return parse_agent_runtime_config(
        {
            "version": "1.0",
            "connections": {
                "documents": {
                    "driver": "mcp",
                    "url": "https://mcp.example.com",
                    "tools": ["search", "delete"],
                    "readTools": ["search"],
                    **connection,
                }
            },
        }
    )


def tool_context(**fields: Any) -> ToolExecutionContext:
    return ToolExecutionContext(run_id="run-1", step_id="answer", variables={}, **fields)


async def test_namespaces_enforces_read_mode_resolves_bearer_and_routes() -> None:
    fake = FakeMcp()
    adapter = ConfiguredMcpToolAdapter(
        config(bearerToken={"env": "DOCUMENTS_TOKEN"}, mode="read"),
        [{"ref": "documents", "alias": "docs"}],
        ValueResolutionContext(environment={"DOCUMENTS_TOKEN": "secret-token"}),
        client_factory=fake.factory,
    )
    tools = await adapter.list_tools()
    assert [(tool["name"], tool["description"]) for tool in tools] == [("docs__search", "Search documents")]
    assert fake.requests[0].url == "https://mcp.example.com/"
    assert fake.requests[0].headers == {"Authorization": "Bearer secret-token"}
    result = await adapter.execute_tool(
        {"id": "call-1", "name": "docs__search", "input": {"query": "terms"}},
        tool_context(idempotency_key="tool-key-1"),
    )
    assert result["output"] == {"content": [{"type": "text", "text": "found"}]}
    assert result["metadata"] == {"connection": "documents", "sourceTool": "search"}
    assert fake.calls == [("search", {"query": "terms"}, {"agent-runtime/idempotency-key": "tool-key-1"})]


async def test_write_tools_need_host_and_agent_read_write() -> None:
    adapter = ConfiguredMcpToolAdapter(
        config(mode="read_write"),
        [{"ref": "documents", "alias": "docs", "mode": "read_write"}],
        client_factory=FakeMcp().factory,
    )
    assert [tool["name"] for tool in await adapter.list_tools()] == ["docs__search", "docs__delete"]
    read_only = ConfiguredMcpToolAdapter(
        config(mode="read"),
        [{"ref": "documents", "alias": "docs", "mode": "read_write"}],
        client_factory=FakeMcp().factory,
    )
    with pytest.raises(Error, match="cannot be elevated"):
        await ConfiguredMcpToolAdapter(
            config(mode="read", required=True),
            [{"ref": "documents", "alias": "docs", "mode": "read_write"}],
            client_factory=FakeMcp().factory,
        ).list_tools()
    assert await read_only.list_tools() == []
    assert read_only.unavailable_tool_reason("docs__search") is not None


async def test_oauth_credentials_and_one_retry_after_unauthorized() -> None:
    fake = FakeMcp()
    credentials = iter(
        [
            {"status": "ready", "headers": {"Authorization": "Bearer initial-token"}},
            {"status": "ready", "headers": {"Authorization": "Bearer initial-token"}},
            {"status": "ready", "headers": {"Authorization": "Bearer refreshed-token"}},
        ]
    )
    invalidated: list[dict] = []

    class Credentials:
        async def get_credential(self, request: dict) -> dict:
            return next(credentials)

        async def invalidate_credential(self, request: dict) -> None:
            invalidated.append(request)

    adapter = ConfiguredMcpToolAdapter(
        config(auth={"type": "oauth", "profile": "documents-user"}, mode="read", tools=["search"], required=True),
        [{"ref": "documents", "alias": "docs", "required": True}],
        credential_provider=Credentials(),
        client_factory=fake.factory,
    )
    await adapter.list_tools()
    unauthorized = Error("request failed")
    unauthorized.code = 401  # type: ignore[attr-defined]
    fake.call_results = [unauthorized, {"content": [{"type": "text", "text": "refreshed result"}]}]
    result = await adapter.execute_tool(
        {"id": "call-oauth", "name": "docs__search", "input": {"query": "terms"}}, tool_context()
    )
    assert result["output"] == {"content": [{"type": "text", "text": "refreshed result"}]}
    assert invalidated[0]["connectionRef"] == "documents" and invalidated[0]["credentialProfile"] == "documents-user"
    assert (
        invalidated[0]["forceRefresh"] is True
        and invalidated[0]["reason"] == "unauthorized"
        and invalidated[0]["runId"] == "run-1"
    )
    assert fake.requests[-1].headers == {"Authorization": "Bearer refreshed-token"}
    assert len(fake.calls) == 2


async def test_authorization_hooks_required_authorization_and_pagination() -> None:
    fake = FakeMcp(pages=[[SEARCH], [DELETE]])
    denied: list[str] = []

    def authorize_tool(request: dict, _context: Any) -> None:
        denied.append(request["toolName"])
        raise Error("no")

    adapter = ConfiguredMcpToolAdapter(
        config(mode="read_write"),
        [{"ref": "documents", "alias": "docs"}],
        client_factory=fake.factory,
        authorize_tool=authorize_tool,
    )
    assert [tool["name"] for tool in await adapter.list_tools()] == ["docs__search", "docs__delete"]
    result = await adapter.execute_tool({"id": "c", "name": "docs__search", "input": {}}, tool_context())
    assert result["error"]["code"] == "tool_not_authorized" and denied == ["search"] and fake.calls == []

    class Needs:
        async def get_credential(self, request: dict) -> dict:
            return {"status": "authorization_required", "authorizationUrl": "https://auth.example.com"}

    oauth = ConfiguredMcpToolAdapter(
        config(auth={"type": "oauth"}, mode="read"),
        [{"ref": "documents", "alias": "docs"}],
        credential_provider=Needs(),
        client_factory=fake.factory,
    )
    assert await oauth.list_tools() == []
    assert (
        oauth.unavailable_tool_reason("docs__search")
        == 'Connection "docs" is unavailable: Connection "documents" requires authorization.'
    )


async def test_integrity_pins_fail_exclude_and_discovery_review() -> None:
    search_digest = compute_mcp_tool_digest(SEARCH)
    delete_digest = compute_mcp_tool_digest(DELETE)
    pinned = config(mode="read_write", toolIntegrity={"digests": {"search": search_digest, "delete": delete_digest}})
    assert (
        len(
            await ConfiguredMcpToolAdapter(
                pinned, [{"ref": "documents", "mode": "read_write"}], client_factory=FakeMcp().factory
            ).list_tools()
        )
        == 2
    )
    changed = FakeMcp(pages=[[{**SEARCH, "description": "Changed"}, DELETE]])
    with pytest.raises(McpToolIntegrityError) as raised:
        await ConfiguredMcpToolAdapter(
            pinned, [{"ref": "documents", "mode": "read_write", "required": False}], client_factory=changed.factory
        ).list_tools()
    assert raised.value.reason == "mismatch" and raised.value.expected_digest == search_digest
    unpinned = config(mode="read_write", toolIntegrity={"digests": {"search": search_digest}})
    with pytest.raises(McpToolIntegrityError, match="has no host-approved digest"):
        await ConfiguredMcpToolAdapter(
            unpinned, [{"ref": "documents", "mode": "read_write"}], client_factory=FakeMcp().factory
        ).list_tools()
    excluding = config(mode="read_write", toolIntegrity={"digests": {"search": search_digest}, "onFailure": "exclude"})
    adapter = ConfiguredMcpToolAdapter(
        excluding, [{"ref": "documents", "alias": "docs", "mode": "read_write"}], client_factory=FakeMcp().factory
    )
    assert [tool["name"] for tool in await adapter.list_tools()] == ["docs__search"]
    assert adapter.is_tool_excluded("docs__delete")

    def reject(request: dict) -> None:
        raise Error("not reviewed")

    with pytest.raises(McpToolIntegrityError, match="rejected by the host: not reviewed"):
        await ConfiguredMcpToolAdapter(
            config(mode="read_write"),
            [{"ref": "documents", "mode": "read_write"}],
            client_factory=FakeMcp().factory,
            verify_tool_metadata=reject,
        ).list_tools()
    discovered = await discover_mcp_connection_tools(
        unpinned, "documents", client_factory=FakeMcp(pages=[[SEARCH, DELETE, {"name": "extra"}]]).factory
    )
    assert [(tool["name"], tool["allowed"], tool["integrity"]["status"]) for tool in discovered] == [
        ("search", True, "verified"),
        ("delete", True, "unpinned"),
        ("extra", False, "unpinned"),
    ]


async def test_unreachable_optional_connections_are_unavailable() -> None:
    fake = FakeMcp()
    fake.fail_connect = Error("connect ECONNREFUSED")
    adapter = ConfiguredMcpToolAdapter(
        config(mode="read"), [{"ref": "documents", "alias": "docs"}], client_factory=fake.factory
    )
    assert await adapter.list_tools() == []
    assert adapter.unavailable_tool_reason("docs__search") == 'Connection "docs" is unavailable: connect ECONNREFUSED'
    with pytest.raises(Error, match="ECONNREFUSED"):
        await ConfiguredMcpToolAdapter(
            config(mode="read"), [{"ref": "documents", "required": True}], client_factory=fake.factory
        ).list_tools()


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture
def mcp_server():
    """A real MCP streamable-HTTP server that records authorization and tool metadata."""
    uvicorn = pytest.importorskip("uvicorn")
    if MCPServer is None:
        pytest.skip("the mcp extra is not installed")

    seen: dict[str, Any] = {"headers": [], "meta": []}
    server = MCPServer("documents")

    @server.tool(description="Search documents")
    async def search(query: str, ctx: Context) -> str:
        request = ctx.request_context.request
        seen["headers"].append(request.headers.get("authorization") if request is not None else None)
        meta = ctx.request_context.meta
        seen["meta"].append(meta if isinstance(meta, dict) or meta is None else meta.model_dump(by_alias=True))
        return f"found {query}"

    port = _free_port()
    app = server.streamable_http_app()
    config_ = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    instance = uvicorn.Server(config_)
    thread = threading.Thread(target=instance.run, daemon=True)
    thread.start()
    for _ in range(100):
        if instance.started:
            break
        import time

        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/mcp", seen
    instance.should_exit = True
    thread.join(5)


async def test_discovers_and_calls_tools_over_streamable_http(mcp_server) -> None:
    url, seen = mcp_server
    adapter = ConfiguredMcpToolAdapter(
        parse_agent_runtime_config(
            {
                "version": "1.0",
                "connections": {
                    "documents": {
                        "driver": "mcp",
                        "url": url,
                        "auth": {"type": "bearer", "token": {"env": "TOKEN"}},
                        "tools": ["search"],
                        "readTools": ["search"],
                        "required": True,
                    }
                },
            }
        ),
        [{"ref": "documents", "alias": "docs", "required": True}],
        ValueResolutionContext(environment={"TOKEN": "secret"}),
    )
    tools = await adapter.list_tools()
    assert [tool["name"] for tool in tools] == ["docs__search"]
    assert tools[0]["inputSchema"]["properties"]["query"]["type"] == "string"
    result = await asyncio.wait_for(
        adapter.execute_tool(
            {"id": "c1", "name": "docs__search", "input": {"query": "terms"}}, tool_context(idempotency_key="key-1")
        ),
        20,
    )
    assert result["output"]["content"][0]["text"] == "found terms", result
    assert seen["headers"] == ["Bearer secret"]
    assert any(meta and meta.get("agent-runtime/idempotency-key") == "key-1" for meta in seen["meta"]), seen["meta"]
