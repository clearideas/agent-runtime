"""
Showcase HTTP server, Python edition (the counterpart of server.ts).

Everything here is transport wiring: static files, JSON endpoints, and one
NDJSON stream per run. Agent Runtime composition lives in each demo's host.py.
It serves the same browser UI (public/) and the same API as server.ts, with
the demos running on the Python Agent Runtime (clearideas_agent_runtime).

    npm run start:python        # or: uv run --project ../../python python server.py
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import os
import re
import signal
import socket
import sys
import uuid
from collections.abc import AsyncIterator, Callable, Generator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import uvicorn
from clearideas_agent_runtime import RUNTIME_VERSION, AbortController, ValueResolutionContext
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from lib import js
from lib.browser_analytics import resolve_browser_analytics
from lib.catalog import catalog, demos
from lib.demo import DemoContext, DemoRunRequest, RequestUrl, ShowcaseDemo, ShowcaseMessage
from lib.environment import detect_environment, pull_docker_image
from lib.host_kit import stringify
from lib.hosting import create_session_resolver, parse_origin
from lib.node_modules import resolve_package_file

showcase_directory = Path(__file__).resolve().parent
public_directory = showcase_directory / "public"

#: Browser libraries, served from this example's node_modules (npm ci).
vendor: dict[str, tuple[str, str]] = {
    "/vendor/consent-analytics.js": ("@clearideas/consent-analytics/dist/analytics.js", "text/javascript"),
    "/vendor/consent-analytics.css": ("@clearideas/consent-analytics/dist/consent.css", "text/css"),
    "/vendor/marked.js": ("marked/lib/marked.umd.js", "text/javascript"),
    "/vendor/purify.js": ("dompurify/dist/purify.min.js", "text/javascript"),
    "/vendor/highlight.js": ("@highlightjs/cdn-assets/highlight.min.js", "text/javascript"),
}

content_types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".woff2": "font/woff2",
}

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
)
security_headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": CONTENT_SECURITY_POLICY,
}


def send_json(status: int, body: Any) -> Response:
    return Response(
        stringify(body).encode("utf-8"),
        status_code=status,
        headers={**security_headers, "content-type": "application/json; charset=utf-8"},
    )


class RequestError(Exception):
    """A request the server refuses; reported as HTTP 500 like server.ts."""


async def read_json(request: Request, max_bytes: int | None = None) -> dict[str, Any]:
    limit = max_bytes or 262_144
    size = 0
    chunks: list[bytes] = []
    async for chunk in request.stream():
        size += len(chunk)
        # Data Chat posts its conversation history with every message;
        # Document Chat may add an uploaded document and raises its own limit.
        if size > limit:
            raise RequestError("Request body is too large.")
        chunks.append(chunk)
    body = b"".join(chunks)
    if not body:
        return {}
    parsed = js.parse(body.decode("utf-8", errors="replace"))
    if not isinstance(parsed, dict):
        raise RequestError("Request body must be a JSON object.")
    return parsed


def serve_public(pathname: str, collector_origin: str | None, frame_ancestors: list[str]) -> Response | None:
    """Serve files beneath public/ only, by known extension."""
    file = Path(os.path.normpath(os.path.join(public_directory, f".{pathname}")))
    content_type = content_types.get(file.suffix)
    if not str(file).startswith(f"{public_directory}{os.sep}") or not content_type:
        return None
    try:
        content = file.read_bytes()
    except OSError:
        return None
    connect = "connect-src 'self'" + (f" {collector_origin}" if collector_origin else "")
    ancestors = "frame-ancestors " + (" ".join(frame_ancestors) if frame_ancestors else "'none'")
    policy = CONTENT_SECURITY_POLICY.replace("connect-src 'self'", connect).replace("frame-ancestors 'none'", ancestors)
    return Response(
        content,
        headers={**security_headers, "content-type": content_type, "content-security-policy": policy},
    )


def report_failure(demo_id: str, message: ShowcaseMessage) -> None:
    """
    Print failed tool calls and files the host could not save to the server
    console as well, so they are easy to copy into a bug report. Guardrails is
    skipped: refusals are what that demo is about.
    """
    if demo_id == "guardrails" or os.environ.get("SHOWCASE_QUIET"):
        return
    if message["kind"] == "tool-io" and message.get("error"):
        # File contents are long and rarely explain a failure; keep the rest.
        source = message.get("input")
        details = {key: value for key, value in source.items() if key != "content"} if isinstance(source, dict) else {}
        error = message["error"]
        print(
            f"[showcase] {demo_id}: {message['name']} {js.slice(stringify(details), 0, 300)} "
            f"failed with {error['code']}: {error['message']}",
            file=sys.stderr,
        )
    if message["kind"] == "event" and message["event"]["type"] == "sandbox.command.completed":
        ignored = (message["event"].get("data") or {}).get("ignoredPaths") or []
        for item in ignored:
            if item["reason"].startswith("store:"):
                print(
                    f"[showcase] {demo_id}: {item['alias']}/{item['path']} was not saved to the host: {item['reason']}",
                    file=sys.stderr,
                )


def _error_message(error: BaseException) -> str:
    message = getattr(error, "message", None)
    return message if isinstance(message, str) else str(error)


@dataclass
class ShowcaseOptions:
    #: ``{"apiBaseUrl", "siteKey"}``, False to disable, or None for the environment.
    analytics: dict[str, str] | bool | None = None
    host: str | None = None
    port: int | None = None
    data_directory: str | None = None
    #: auto, bubblewrap, docker, or unisolated.
    sandbox: str | None = None
    #: Default pace for runs that do not request one.
    pace: float | None = None
    #: External HTTPS origin when a reverse proxy terminates TLS.
    public_origin: str | None = None
    #: Exact parent origins permitted to embed and check readiness.
    frame_ancestors: list[str] | None = None
    #: Separate demo files, resets, and checkpoints by signed browser session.
    sessions: bool | None = None
    #: Refuse to start unless the configured isolated sandbox is available.
    require_isolation: bool | None = None
    #: Maximum simultaneous runs across all sessions; 0 means no global limit.
    max_active_runs: int | None = None
    #: Tests only: replaces the live provider model for each demo.
    live_model: Callable[[str], Any] | None = None


class _Server(uvicorn.Server):
    # main() handles SIGINT and SIGTERM itself, so that closing the demos
    # (and the orchestration worker process) always runs before exit.
    @contextlib.contextmanager
    def capture_signals(self) -> Generator[None, None, None]:
        yield


@dataclass
class ShowcaseApp:
    environment: dict[str, Any]
    #: Where run stores, artifacts, and demo workspaces are kept.
    data_directory: str
    handler: Any
    host: str
    port: int
    _server: uvicorn.Server | None = None
    _task: asyncio.Task[None] | None = None
    _address: tuple[str, int] | None = None
    _on_listen: list[Callable[[str], None]] = field(default_factory=list)

    async def listen(self) -> tuple[str, int]:
        family = socket.AF_INET6 if ":" in self.host else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.listen(511)
        sock.setblocking(False)
        config = uvicorn.Config(
            self.handler,
            log_level="warning",
            access_log=False,
            lifespan="off",
            timeout_graceful_shutdown=1,
        )
        self._server = _Server(config)
        self._task = asyncio.ensure_future(self._server.serve(sockets=[sock]))
        while not self._server.started:
            if self._task.done():
                self._task.result()
                raise RuntimeError("The showcase server stopped while starting.")
            await asyncio.sleep(0.01)
        address = sock.getsockname()
        self._address = (address[0], address[1])
        # Callbacks come from this machine; wildcard addresses mean loopback.
        reachable = (
            "127.0.0.1" if self.host in ("0.0.0.0", "::") else f"[{self.host}]" if ":" in self.host else self.host
        )
        for callback in self._on_listen:
            callback(f"http://{reachable}:{address[1]}")
        return self._address

    async def serve_forever(self) -> None:
        if self._task is not None:
            await self._task

    def stop(self) -> None:
        """Stop serving; ``serve_forever`` returns once connections close."""
        if self._server is not None:
            self._server.should_exit = True

    async def close(self) -> None:
        await asyncio.gather(*(close() for demo in demos if (close := getattr(demo, "close", None)) is not None))
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            with contextlib.suppress(BaseException):
                await self._task


def _live_test_model(base_url: str, demo_id: str) -> Any:
    """
    Tests only: the configured OpenAI model, with the test suite's stand-in
    endpoint (test/python-live-provider.ts) as its base URL. One model per
    run, as server.ts creates one per run.
    """
    from clearideas_agent_runtime import ComposeRuntimeOptions, compose_runtime, parse_agent_runtime_config

    config = parse_agent_runtime_config(
        {
            "version": "1.0",
            "providers": {
                "openai": {
                    "driver": "openai",
                    "baseURL": f"{base_url.rstrip('/')}/{demo_id}/{uuid.uuid4()}/v1",
                    "apiKey": {"env": "SHOWCASE_TEST_LIVE_KEY"},
                }
            },
            "models": {"default": {"provider": "openai", "model": "gpt-6-luna"}},
        }
    )
    manifest = {
        "schemaVersion": "1.0",
        "model": {"ref": "default"},
        "steps": [{"id": "s", "type": "prompt", "prompt": "p"}],
    }
    return compose_runtime(
        manifest,
        config,
        ValueResolutionContext(environment={"SHOWCASE_TEST_LIVE_KEY": "test"}),
        ComposeRuntimeOptions(tools=False, workspaces=False),
    ).model


async def create_showcase_app(options: ShowcaseOptions | None = None) -> ShowcaseApp:
    options = options or ShowcaseOptions()
    env = os.environ
    analytics = resolve_browser_analytics(options.analytics)
    host = options.host or env.get("SHOWCASE_HOST") or "127.0.0.1"
    port = int(options.port if options.port is not None else env.get("SHOWCASE_PORT") or 4178)
    data_directory = options.data_directory or env.get("SHOWCASE_DATA") or str(showcase_directory / ".data-python")
    preference = options.sandbox or env.get("SHOWCASE_SANDBOX")
    origin_setting = options.public_origin or env.get("SHOWCASE_PUBLIC_ORIGIN")
    public_origin = parse_origin(origin_setting) if origin_setting else None
    frame_ancestors = [
        parse_origin(origin)
        for origin in (
            options.frame_ancestors
            if options.frame_ancestors is not None
            else [entry for entry in env.get("SHOWCASE_FRAME_ANCESTORS", "").split(",") if entry]
        )
    ]
    sessions = options.sessions if options.sessions is not None else env.get("SHOWCASE_SESSIONS") == "1"
    max_active_runs_setting = (
        options.max_active_runs if options.max_active_runs is not None else env.get("SHOWCASE_MAX_ACTIVE_RUNS", "0")
    )
    try:
        max_active_runs = int(str(max_active_runs_setting))
    except ValueError:
        max_active_runs = -1
    if max_active_runs < 0:
        raise ValueError("SHOWCASE_MAX_ACTIVE_RUNS must be a non-negative integer.")
    environment = await detect_environment(
        host=host,
        preference=preference,
        docker_image=env.get("SHOWCASE_DOCKER_IMAGE"),
        live_provider=env.get("SHOWCASE_PROVIDER"),
        live_model=env.get("SHOWCASE_MODEL"),
    )
    require_isolation = (
        options.require_isolation
        if options.require_isolation is not None
        else env.get("SHOWCASE_REQUIRE_ISOLATION") == "1"
    )
    if require_isolation and not environment["sandbox"]["isolated"]:
        raise RuntimeError(f"An isolated sandbox is required. {' '.join(environment['sandbox']['notes'])}")
    # Which runtime serves the demos; the page shows it in the top bar.
    environment["runtime"] = {"language": "python", "version": RUNTIME_VERSION}
    instance_id = str(uuid.uuid4())
    started_at = js.now_iso()
    session_for = create_session_resolver(data_directory) if sessions else None

    # Live normally requires an isolated sandbox because a real model chooses
    # its own commands. A test model replays a demo script, so it may run on
    # any sandbox. SHOWCASE_TEST_LIVE_URL is the test suite's stand-in for an
    # OpenAI endpoint (test/python-live-provider.ts).
    test_live_url = env.get("SHOWCASE_TEST_LIVE_URL")
    live_model: Callable[[str], Any] | None = options.live_model or (
        (lambda demo_id: _live_test_model(test_live_url, demo_id)) if test_live_url else None
    )
    if live_model is not None:
        environment["live"] = {"available": True, "reason": "test model", "provider": "test", "model": "test"}

    server_url = f"http://{host}:{port}"

    def live_model_for(demo: ShowcaseDemo) -> Callable[[], Any] | None:
        factory = live_model
        return (lambda: factory(demo.id)) if factory is not None else None

    def context_for(demo: ShowcaseDemo, session: str | None = None) -> DemoContext:
        return DemoContext(
            environment=environment,
            data_directory=(
                os.path.join(data_directory, "sessions", session, demo.id)
                if session
                else os.path.join(data_directory, demo.id)
            ),
            server_url=lambda: server_url,
            live_model=live_model_for(demo),
        )

    initialized: dict[str, asyncio.Future[None]] = {}

    async def initialize(demo: ShowcaseDemo, context: DemoContext) -> None:
        pending = initialized.get(context.data_directory)
        if pending is None:

            async def create() -> None:
                if not os.path.exists(context.data_directory):
                    os.makedirs(context.data_directory, exist_ok=True)
                    reset = getattr(demo, "reset", None)
                    if reset is not None:
                        await reset(context)

            pending = asyncio.ensure_future(create())
            initialized[context.data_directory] = pending
            pending.add_done_callback(
                lambda task: initialized.pop(context.data_directory, None) if task.exception() else None
            )
        await pending

    if not sessions:
        for demo in demos:
            await initialize(demo, context_for(demo))
    active: set[str] = set()

    async def handle_run(
        demo: ShowcaseDemo, request: Request, context: DemoContext, resume_run_id: str | None = None
    ) -> Response:
        body = await read_json(request, demo.max_request_bytes)
        if context.data_directory in active:
            return send_json(409, {"error": "A run is already in progress for this demo."})
        if max_active_runs and len(active) >= max_active_runs:
            return send_json(429, {"error": "The showcase is busy. Please try again shortly."})
        mode = "live" if body.get("mode") == "live" else "scripted"
        requested = body.get("pace")
        if requested is None:
            requested = options.pace if options.pace is not None else 1
        requested_pace = js.number(requested)
        pace = min(4, max(0, requested_pace)) if math.isfinite(requested_pace) else 1
        demo_options = body.get("options")
        run_request = DemoRunRequest(
            mode=mode, pace=pace, options=demo_options if isinstance(demo_options, dict) else {}
        )
        resume = getattr(demo, "resume", None)
        if resume_run_id and resume is None:
            return send_json(404, {"error": "This demo does not resume runs."})

        controller = AbortController()
        queue: asyncio.Queue[bytes | None] = asyncio.Queue()

        def emit(message: ShowcaseMessage) -> None:
            # Once the browser has gone, failures are just the cancellation.
            if not controller.signal.aborted:
                report_failure(demo.id, message)
            queue.put_nowait(f"{stringify(message)}\n".encode())

        async def execute() -> None:
            try:
                if resume_run_id and resume is not None:
                    await resume(context, resume_run_id, run_request, emit, controller.signal)
                else:
                    await demo.run(context, run_request, emit, controller.signal)
            except Exception as error:
                emit(
                    {
                        "kind": "error",
                        "error": {"message": _error_message(error), "cancelled": controller.signal.aborted},
                    }
                )
            finally:
                active.discard(context.data_directory)
                queue.put_nowait(None)

        active.add(context.data_directory)
        task = asyncio.ensure_future(execute())

        async def stream() -> AsyncIterator[bytes]:
            finished = False
            try:
                while True:
                    line = await queue.get()
                    if line is None:
                        finished = True
                        return
                    yield line
            finally:
                if not finished:
                    controller.abort(RuntimeError("Browser disconnected."))
                    _background.add(task)
                    task.add_done_callback(_background.discard)

        return StreamingResponse(
            stream(),
            headers={**security_headers, "content-type": "application/x-ndjson; charset=utf-8"},
        )

    async def route(request: Request) -> Response:
        url = RequestUrl(request.url.path, request.url.query)
        pathname = url.pathname
        method = request.method
        if method == "GET" and pathname == "/healthz":
            origin = request.headers.get("origin")
            unavailable = environment["sandbox"]["kind"] == "none"
            response = send_json(
                503 if unavailable else 200,
                {
                    "status": "unavailable" if unavailable else "ready",
                    "instanceId": instance_id,
                    "startedAt": started_at,
                    "sandbox": environment["sandbox"]["kind"],
                    "isolated": environment["sandbox"]["isolated"],
                },
            )
            if origin and origin in frame_ancestors:
                response.headers["access-control-allow-origin"] = origin
                response.headers["vary"] = "Origin"
            return response
        # Browser pages may not start, resume or reset local runs from another
        # origin. Origin-less local clients and the authenticated worker
        # callbacks remain supported.
        origin = request.headers.get("origin")
        if method not in ("GET", "HEAD") and origin is not None and origin != (public_origin or server_url):
            return send_json(403, {"error": "Cross-origin requests are not allowed."})
        # The separate local orchestration worker uses its own signed callbacks.
        if pathname.startswith("/internal/"):
            for demo in demos:
                handler = getattr(demo, "route", None)
                if handler is not None and (handled := await handler(context_for(demo), request, url)) is not None:
                    return handled
            return send_json(404, {"error": "Not found."})
        session: str | None = None
        cookie: str | None = None
        if session_for is not None:
            session, cookie = session_for(
                request.headers.get("cookie"), public_origin is not None and public_origin.startswith("https:")
            )
        try:
            response = await route_session(request, session)
        except Exception as error:
            # server.ts sets the cookie before routing, so errors carry it too.
            response = send_json(500, {"error": _error_message(error)})
        if cookie is not None:
            response.headers.append("set-cookie", cookie)
        return response

    async def route_session(request: Request, session: str | None) -> Response:
        url = RequestUrl(request.url.path, request.url.query)
        pathname = url.pathname
        method = request.method
        contexts: dict[str, DemoContext] = {}

        async def request_context(demo: ShowcaseDemo) -> DemoContext:
            context = contexts.get(demo.id)
            if context is None:
                context = context_for(demo, session)
                contexts[demo.id] = context
                await initialize(demo, context)
            return context

        for demo in demos:
            handler = getattr(demo, "route", None)
            if handler is not None and pathname.startswith(f"/api/demos/{demo.id}/"):
                handled = await handler(await request_context(demo), request, url)
                if handled is not None:
                    return handled

        if method == "GET" and pathname == "/api/browser-analytics":
            return send_json(200, analytics)
        if method == "GET" and pathname == "/api/environment":
            return send_json(200, environment)
        if method == "GET" and pathname == "/api/demos":
            return send_json(200, catalog())

        resume = re.fullmatch(r"/api/demos/([a-z-]+)/runs/([A-Za-z0-9_-]+)/resume", pathname)
        if resume and method == "POST":
            demo = next((entry for entry in demos if entry.id == resume[1]), None)
            if demo is None:
                return send_json(404, {"error": "Unknown demo."})
            return await handle_run(demo, request, await request_context(demo), resume[2])

        artifact = re.fullmatch(r"/api/demos/([a-z-]+)/artifacts/([A-Za-z0-9_-]+)", pathname)
        if artifact and method == "GET":
            demo = next((entry for entry in demos if entry.id == artifact[1]), None)
            reader = getattr(demo, "artifact", None) if demo is not None else None
            found = await reader(await request_context(demo), artifact[2]) if reader is not None else None  # type: ignore[arg-type]
            if found is None or not re.fullmatch(r"image/(png|jpeg|gif|webp)", found[0]):
                return send_json(404, {"error": "Unknown artifact."})
            return Response(bytes(found[1]), headers={**security_headers, "content-type": found[0]})

        match = re.fullmatch(r"/api/demos/([a-z-]+)(?:/([a-z]+))?", pathname)
        demo = next((entry for entry in demos if entry.id == match[1]), None) if match else None
        if match and demo is None:
            return send_json(404, {"error": "Unknown demo."})
        if demo is not None and match:
            action = match[2]
            context = await request_context(demo)
            if method == "GET" and not action:
                description = {
                    "id": demo.id,
                    "title": demo.title,
                    "tagline": demo.tagline,
                    "features": demo.features,
                    "sources": demo.sources,
                }
                if demo.unavailable:
                    description["unavailable"] = demo.unavailable
                return send_json(200, {**description, **(await demo.describe(context))})
            if method == "GET" and action == "source":
                source = next((entry for entry in demo.sources if entry["path"] == url.param("path")), None)
                if source is None:
                    return send_json(404, {"error": "Unknown file."})
                text = (showcase_directory / source["path"]).read_text(encoding="utf-8")
                return send_json(200, {**source, "text": text})
            if method == "GET" and action == "state":
                state = getattr(demo, "state", None)
                value = await state(context, url) if state is not None else None
                return send_json(200, value if value is not None else {})
            if method == "POST" and action == "reset":
                if context.data_directory in active:
                    return send_json(409, {"error": "A run is in progress."})
                reset = getattr(demo, "reset", None)
                if reset is not None:
                    await reset(context)
                return send_json(200, {"reset": True})
            if method == "POST" and action == "runs":
                if demo.unavailable:
                    return send_json(409, {"error": demo.unavailable})
                return await handle_run(demo, request, context)
            return send_json(404, {"error": "Not found."})

        if method != "GET":
            return send_json(405, {"error": "Method not allowed."})
        asset = vendor_files.get(pathname)
        if asset is not None:
            return Response(
                Path(asset[0]).read_bytes(),
                headers={**security_headers, "content-type": f"{asset[1]}; charset=utf-8"},
            )
        page = (
            "/index.html"
            if pathname == "/"
            else f"{pathname}.html"
            if re.fullmatch(r"/demos/[a-z-]+", pathname)
            else pathname
        )
        served = serve_public(
            page,
            js.URL(analytics["apiBaseUrl"]).origin if analytics["enabled"] else None,
            frame_ancestors,
        )
        if served is not None:
            return served
        return Response(b"Not found", status_code=404, headers={"content-type": "text/plain; charset=utf-8"})

    vendor_files = {
        path: (resolve_package_file(showcase_directory, file), content_type)
        for path, (file, content_type) in vendor.items()
    }

    async def handler(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            return
        request = Request(scope, receive)
        try:
            response = await route(request)
        except Exception as error:
            response = send_json(500, {"error": _error_message(error)})
        await response(scope, receive, send)

    app = ShowcaseApp(environment=environment, data_directory=data_directory, handler=handler, host=host, port=port)

    def on_listen(url: str) -> None:
        nonlocal server_url
        server_url = url

    app._on_listen.append(on_listen)
    return app


_background: set[asyncio.Task[Any]] = set()


async def main() -> None:
    try:
        app = await create_showcase_app()
    except Exception as error:
        print(f"Error: {_error_message(error)}", file=sys.stderr)
        raise SystemExit(1) from None
    sandbox, live = app.environment["sandbox"], app.environment["live"]
    if sandbox["kind"] == "docker" and not sandbox.get("imagePresent"):
        print(f"Pulling the sandbox image {sandbox['image']} (first run only)…", flush=True)
        if not pull_docker_image(sandbox["image"]):
            print(
                f"Could not pull {sandbox['image']}. Check your connection, or run: docker pull {sandbox['image']}",
                flush=True,
            )
    address = await app.listen()
    live_reason = live["reason"] if live["available"] else f"unavailable — {live['reason']}"
    lines = [
        f"Agent Runtime showcase (Python): http://{'localhost' if address[0] == '::' else address[0]}:{address[1]}",
        f"Sandbox: {sandbox['kind']}{' (isolated)' if sandbox['isolated'] else ''} — {sandbox['detail']}",
        *(f"  note: {note}" for note in sandbox["notes"]),
        f"Live model: {live_reason}",
    ]
    if sandbox["kind"] == "unisolated":
        lines += [
            "",
            "WARNING: no isolated sandbox was found. Workspace commands will run as",
            "ordinary processes on this machine (scripted model only). Start Docker",
            "(or install bubblewrap on Linux) for real isolation.",
        ]
    lines += ["", "Check this setup any time with: npm run doctor:python"]
    print("\n".join(lines), flush=True)
    loop = asyncio.get_running_loop()
    for stop_signal in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):  # Windows
            loop.add_signal_handler(stop_signal, app.stop)
    try:
        await app.serve_forever()
    finally:
        await app.close()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
