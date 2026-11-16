"""A small HTTP server on 127.0.0.1 for demo stand-ins (MCP servers, canaries)."""

from __future__ import annotations

import asyncio
import contextlib
import socket
from collections.abc import Awaitable, Callable, Generator
from dataclasses import dataclass
from typing import Any

import uvicorn

#: ``(method, path, body) -> (status, headers, body)``
Handler = Callable[[str, str, bytes], Awaitable[tuple[int, dict[str, str], bytes]]]


class _Server(uvicorn.Server):
    # The showcase server owns the process's signal handling.
    @contextlib.contextmanager
    def capture_signals(self) -> Generator[None, None, None]:
        yield


@dataclass
class LocalServer:
    url: str
    close: Callable[[], Awaitable[None]]


async def start_local_server(handle: Handler) -> LocalServer:
    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            return
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        status, headers, content = await handle(scope["method"], scope["path"], body)
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(key.encode(), value.encode()) for key, value in headers.items()],
            }
        )
        await send({"type": "http.response.body", "body": content})

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(64)
    sock.setblocking(False)
    server = _Server(uvicorn.Config(app, log_level="warning", access_log=False, lifespan="off"))
    task = asyncio.ensure_future(server.serve(sockets=[sock]))
    while not server.started:
        if task.done():
            task.result()
        await asyncio.sleep(0.005)
    port = sock.getsockname()[1]

    async def close() -> None:
        server.should_exit = True
        server.force_exit = True
        with contextlib.suppress(BaseException):
            await task

    return LocalServer(url=f"http://127.0.0.1:{port}", close=close)
