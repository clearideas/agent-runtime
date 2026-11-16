"""
Orchestration — one manifest, two execution engines (Python edition of host.ts).

  agent.yaml   parallel research, a condition, a collection loop, a goal loop
  runtime.py   builds the AgentRuntime (used in this process and the worker)
  worker.py    a separate process that runs invocations it receives over HTTP
  this file    picks an ExecutionEngine and follows its events

The browser code is identical for both engines: ExecutionClient.follow()
yields the same events whether the agent runs here or in the worker.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import os
import re
import secrets
import sys
import uuid
from pathlib import Path
from typing import Any

import httpx
from clearideas_agent_runtime import (
    ExecutionClient,
    ExecutionHandlerContext,
    InMemoryRemoteExecutionControlPlane,
    InProcessExecutionEngine,
    RemoteExecutionEngine,
    parse_worker_message,
)
from starlette.requests import Request
from starlette.responses import Response

from lib import js
from lib.demo import DemoContext, DemoRunRequest, Emit, RequestUrl, ShowcaseDemo
from lib.host_kit import stringify, summarize_result, to_json

from .runtime import create_launch_runtime, manifest

demo_directory = Path(__file__).resolve().parent


# ─── 1. In this process ──────────────────────────────────────────────────────
# InProcessExecutionEngine calls a handler for each submitted request and
# keeps the events, status, and result for ExecutionClient.
def local_engine(context: DemoContext, pace: float, mode: str) -> InProcessExecutionEngine:
    async def handler(request: dict[str, Any], execution: ExecutionHandlerContext) -> dict[str, Any]:
        runtime = create_launch_runtime(
            mode=mode,
            pace=pace,
            store_directory=os.path.join(context.data_directory, "runs"),
            on_event=execution.emit,
            live_model=context.live_model() if context.live_model is not None else None,
        )
        return await runtime.run(
            manifest=request["manifest"],
            run_id=execution.handle["runId"],
            **({"variables": request["variables"]} if request.get("variables") else {}),
            **({"execution": request["execution"]} if request.get("execution") else {}),
            signal=execution.signal,
        )

    return InProcessExecutionEngine(handler)


# ─── 2. In a remote worker ───────────────────────────────────────────────────
# RemoteExecutionEngine = a launcher (starts work somewhere else) + a control
# plane (records the events and result the worker reports back).

worker_token = secrets.token_hex(32)
callback_secret = secrets.token_hex(32)


def callback_token(execution_id: str) -> str:
    return hmac.new(callback_secret.encode(), execution_id.encode(), hashlib.sha256).hexdigest()


control_plane = InMemoryRemoteExecutionControlPlane()
handles: dict[str, dict[str, Any]] = {}
worker: dict[str, Any] | None = None


async def start_worker(context: DemoContext) -> dict[str, Any]:
    """Start the worker process once, and learn its address from stdout."""
    global worker
    if worker is not None and worker["process"].returncode is None:
        return worker
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(demo_directory / "worker.py"),
        env={
            **os.environ,
            "SHOWCASE_WORKER_TOKEN": worker_token,
            "SHOWCASE_WORKER_DATA": os.path.join(context.data_directory, "worker"),
        },
        # The worker exits when this pipe closes, even if this process is killed.
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None
    while True:
        line = (await process.stdout.readline()).decode()
        if not line:
            raise RuntimeError(f"Worker exited with {await process.wait()}.")
        match = re.search(r"worker listening (\S+)", line)
        if match:
            break
    worker = {"process": process, "url": match[1]}
    return worker


class HttpWorkerLauncher:
    name = "http-worker"

    def __init__(self, context: DemoContext, pace: float, mode: str) -> None:
        self._context = context
        self._pace = pace
        self._mode = mode

    async def launch(self, invocation: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        handle = options["handle"]
        url = (await start_worker(self._context))["url"]
        handles[handle["id"]] = handle
        body = {
            "executionId": handle["id"],
            "invocation": {**invocation, "request": {**invocation["request"], "runId": handle["runId"]}},
            "callbackUrl": f"{self._context.server_url()}/internal/worker-callbacks/{handle['id']}",
            "callbackToken": callback_token(handle["id"]),
            "mode": self._mode,
            "pace": self._pace,
        }
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{url}/executions",
                headers={"authorization": f"Bearer {worker_token}", "content-type": "application/json"},
                content=stringify(body).encode(),
            )
        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError(f"Worker returned HTTP {response.status_code}.")
        return {"worker": url, "pid": js.parse(response.text)["pid"]}

    async def cancel(self, handle: dict[str, Any]) -> None:
        if worker is None:
            return
        with contextlib.suppress(Exception):
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{worker['url']}/executions/{handle['id']}/cancel",
                    headers={"authorization": f"Bearer {worker_token}"},
                )


def remote_engine(context: DemoContext, pace: float, mode: str) -> RemoteExecutionEngine:
    return RemoteExecutionEngine(HttpWorkerLauncher(context, pace, mode), control_plane)


class Orchestration(ShowcaseDemo):
    id = "orchestration"
    title = "Orchestration"
    summary = "Steps run in parallel, branch, and loop, locally or in a worker."
    tagline = "A launch-plan agent fans research out in parallel, branches on risk, loops over channels, and refines a headline until it is approved, in this process or in a separate worker process."
    features = ["Parallel graph", "Conditions", "Loops", "Remote workers"]
    sources = [
        {
            "path": "demos/orchestration/agent.yaml",
            "language": "yaml",
            "caption": "The agent: the graph comes from which variables each step reads and writes.",
        },
        {
            "path": "demos/orchestration/host.py",
            "language": "python",
            "caption": "The integration: two execution engines behind one ExecutionClient.",
        },
        {
            "path": "demos/orchestration/worker.py",
            "language": "python",
            "caption": "The remote worker: receives an invocation, runs it, reports events back.",
        },
        {
            "path": "demos/orchestration/runtime.py",
            "language": "python",
            "caption": "The runtime both engines build: prompt and loop executors, conditions.",
        },
        {
            "path": "demos/orchestration/script.py",
            "language": "python",
            "caption": "Scripted mode only: the model's answers.",
        },
    ]

    async def describe(self, context: DemoContext) -> Any:
        return to_json({"manifest": manifest, "needsSandbox": False})

    # ─── 3. Worker callbacks: the worker reports to the control plane ───────
    async def route(self, context: DemoContext, request: Request, url: RequestUrl) -> Response | None:
        match = re.fullmatch(r"/internal/worker-callbacks/([A-Za-z0-9_-]+)", url.pathname)
        if match is None or request.method != "POST":
            return None
        execution_id = match[1]
        supplied = (request.headers.get("authorization") or "").removeprefix("Bearer ")
        handle = handles.get(execution_id)
        if handle is None or not hmac.compare_digest(supplied.encode(), callback_token(execution_id).encode()):
            return Response(status_code=401)
        message = parse_worker_message(js.parse((await request.body()).decode("utf-8")))
        if message["type"] == "event":
            await control_plane.accept_event(handle, message["event"])
        if message["type"] == "result":
            await control_plane.complete(handle, message["result"])
        if message["type"] == "error":
            await control_plane.fail(handle, message["error"])
        return Response(status_code=204)

    async def close(self) -> None:
        global worker
        if worker is not None and worker["process"].returncode is None:
            worker["process"].terminate()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(worker["process"].wait(), 5)
        worker = None

    async def run(self, context: DemoContext, request: DemoRunRequest, emit: Emit, signal: Any) -> None:
        remote = request.options.get("engine") == "remote"
        engine = (
            remote_engine(context, request.pace, request.mode)
            if remote
            else local_engine(context, request.pace, request.mode)
        )
        client = ExecutionClient(engine)

        # ─── 4. Submit and follow: identical for both engines ────────────────
        handle = await client.submit(
            {
                "manifest": manifest,
                "runId": f"launch-{uuid.uuid4()}",
                "variables": [{"key": "regulatedMarket", "value": request.options.get("regulatedMarket") is not False}],
                "execution": {"mode": "sequential"}
                if request.options.get("scheduling") == "sequential"
                else {"mode": "parallel", "maxConcurrency": 4},
            }
        )
        status = await engine.status(handle)
        emit(
            {
                "kind": "accepted",
                "runId": handle["runId"],
                "mode": request.mode,
                "sandbox": context.environment["sandbox"]["kind"],
            }
        )
        provider_data = status["handle"].get("providerData")
        emit(
            {
                "kind": "engine",
                "engine": engine.name,
                **({"providerData": to_json(provider_data)} if provider_data else {}),
            }
        )

        def on_abort() -> None:
            task = asyncio.ensure_future(client.cancel(handle))
            task.add_done_callback(lambda done: done.exception())

        remove = signal.add_listener(on_abort)
        try:
            followed = await client.follow(
                handle, signal=signal, on_event=lambda event: emit({"kind": "event", "event": event})
            )
            if followed.get("result") is None:
                error = followed["status"].get("error") or {}
                raise RuntimeError(error.get("message") or f"Execution {followed['status']['status']}.")
            emit({"kind": "result", "result": summarize_result(followed["result"])})
        finally:
            remove()


demo = Orchestration()
