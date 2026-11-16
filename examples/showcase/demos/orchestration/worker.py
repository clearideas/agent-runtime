"""
The remote worker: a separate process that runs agents it is sent (Python
edition of worker.ts).

A real deployment runs this on other compute (a container, Modal, a job
queue). The protocol is the same: receive a versioned WorkerInvocation, run
it, and post every event and the final result to a callback URL.

  POST /executions              {executionId, invocation, callbackUrl,
                                 callbackToken, pace}
  POST /executions/:id/cancel
"""

from __future__ import annotations

import asyncio
import hmac
import os
import re
import socket
import sys
from pathlib import Path
from typing import Any

# The worker runs as its own program; make the showcase's modules importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import httpx
import uvicorn
from clearideas_agent_runtime import (
    EXECUTION_PROTOCOL_VERSION,
    AbortController,
    parse_worker_invocation,
)

from lib import js
from lib.host_kit import stringify
from lib.loader import load_demo_module

create_launch_runtime = load_demo_module("orchestration", "runtime").create_launch_runtime

worker_token = os.environ.get("SHOWCASE_WORKER_TOKEN", "")
data_directory = os.environ.get("SHOWCASE_WORKER_DATA", ".data/worker")
if len(worker_token) < 32:
    raise SystemExit("SHOWCASE_WORKER_TOKEN is required.")

active: dict[str, AbortController] = {}
running: set[asyncio.Task[None]] = set()


def authorized(headers: dict[str, str]) -> bool:
    supplied = headers.get("authorization", "").removeprefix("Bearer ")
    return hmac.compare_digest(supplied.encode(), worker_token.encode())


async def execute(body: dict[str, Any]) -> None:
    """Run one invocation and report back, one message at a time, in order."""
    execution_id = str(body["executionId"])
    invocation = parse_worker_invocation(body["invocation"])
    callback_url = str(body["callbackUrl"])
    callback_token = str(body["callbackToken"])
    client = httpx.AsyncClient()

    async def send(message: dict[str, Any]) -> None:
        response = await client.post(
            callback_url,
            headers={"authorization": f"Bearer {callback_token}", "content-type": "application/json"},
            content=stringify(message).encode(),
        )
        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError(f"Callback returned HTTP {response.status_code}.")

    controller = AbortController()
    active[execution_id] = controller
    runtime = create_launch_runtime(
        mode="live" if body.get("mode") == "live" else "scripted",
        pace=float(body.get("pace", 1)),
        store_directory=os.path.join(data_directory, execution_id),
        on_event=lambda event: send({"protocolVersion": EXECUTION_PROTOCOL_VERSION, "type": "event", "event": event}),
    )
    try:
        request = invocation["request"]
        result = await runtime.run(
            manifest=request["manifest"],
            **({"run_id": request["runId"]} if request.get("runId") else {}),
            **({"variables": request["variables"]} if request.get("variables") else {}),
            **({"execution": request["execution"]} if request.get("execution") else {}),
            signal=controller.signal,
        )
        await send({"protocolVersion": EXECUTION_PROTOCOL_VERSION, "type": "result", "result": result})
    except Exception as error:
        try:
            await send(
                {
                    "protocolVersion": EXECUTION_PROTOCOL_VERSION,
                    "type": "error",
                    "error": {
                        "code": "EXECUTION_CANCELLED" if controller.signal.aborted else "WORKER_EXECUTION_FAILED",
                        "message": str(error),
                        "retryable": False,
                    },
                }
            )
        except Exception:
            pass
    finally:
        active.pop(execution_id, None)
        await client.aclose()


def reply(status: int, body: Any) -> tuple[int, bytes]:
    return status, stringify(body).encode()


async def route(method: str, path: str, headers: dict[str, str], read: Any) -> tuple[int, bytes]:
    try:
        if method != "POST" or not authorized(headers):
            return reply(401, {"error": "Unauthorized."})
        if path == "/executions":
            body = js.parse((await read()).decode("utf-8"))
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", str(body.get("executionId"))):
                return reply(400, {"error": "Invalid execution ID."})
            task = asyncio.ensure_future(execute(body))
            running.add(task)
            task.add_done_callback(running.discard)
            return reply(202, {"executionId": body["executionId"], "pid": os.getpid()})
        cancel = re.fullmatch(r"/executions/([A-Za-z0-9_-]+)/cancel", path)
        if cancel:
            controller = active.get(cancel[1])
            if controller is not None:
                controller.abort(RuntimeError("Cancelled by the host."))
            return reply(202, {})
        return reply(404, {"error": "Not found."})
    except Exception as error:
        return reply(400, {"error": str(error)})


async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
    if scope["type"] != "http":
        return

    async def read() -> bytes:
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                return body

    headers = {key.decode().lower(): value.decode() for key, value in scope["headers"]}
    status, content = await route(scope["method"], scope["path"], headers, read)
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": content})


async def main() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(64)
    sock.setblocking(False)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, lifespan="off"))
    task = asyncio.ensure_future(server.serve(sockets=[sock]))
    while not server.started:
        if task.done():
            task.result()
        await asyncio.sleep(0.01)
    # The host waits for this line to learn the worker's address.
    print(f"worker listening http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
    # The host keeps this process's stdin open; end with the host, however it exits.
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    async def watch_host() -> None:
        while await reader.read(4096):
            pass
        server.should_exit = True

    watcher = asyncio.ensure_future(watch_host())
    await task
    watcher.cancel()


if __name__ == "__main__":
    asyncio.run(main())
