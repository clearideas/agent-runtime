"""Run each execution in a worker process (``packages/execution/src/child-process.ts``).

The worker reads one invocation line on stdin and writes worker messages, one
per line, on stdout. Workers of either runtime are interchangeable.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from typing import Any

from .._js import json as js_json
from .._js.errors import Error
from .contracts import ExecutionEngineError
from .in_process import ExecutionHandlerContext, InProcessExecutionEngine
from .worker_protocol import create_worker_invocation, parse_worker_message

JsonObject = dict[str, Any]


def _create_handler(
    command: str,
    args: list[str],
    cwd: str | None,
    env: dict[str, str] | None,
    inherit_environment: bool,
    kill_grace_ms: int,
    maximum_stderr_bytes: int,
) -> Any:
    async def handler(request: JsonObject, context: ExecutionHandlerContext) -> JsonObject:
        environment = {**(os.environ if inherit_environment else {}), **(env or {})}
        process = await asyncio.create_subprocess_exec(
            command,
            *args,
            cwd=cwd,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=32 * 1024 * 1024,
        )
        stderr = ""
        result: JsonObject | None = None
        reported: JsonObject | None = None
        parse_error: BaseException | None = None
        kill_timer: asyncio.TimerHandle | None = None

        def terminate() -> None:
            nonlocal kill_timer
            if process.returncode is not None:
                return
            with contextlib.suppress(ProcessLookupError):
                process.terminate()

            def force() -> None:
                if process.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        process.kill()

            kill_timer = asyncio.get_running_loop().call_later(kill_grace_ms / 1000, force)

        remove = context.signal.add_listener(terminate)

        async def read_stderr() -> None:
            nonlocal stderr
            while True:
                chunk = await process.stderr.read(65536)  # type: ignore[union-attr]
                if not chunk:
                    return
                stderr = (stderr + chunk.decode("utf-8", "replace"))[-maximum_stderr_bytes:]

        async def read_stdout() -> None:
            nonlocal result, reported, parse_error
            while True:
                line = await process.stdout.readline()  # type: ignore[union-attr]
                if not line:
                    return
                text = line.decode("utf-8").rstrip("\r\n")
                if not text.strip() or parse_error is not None:
                    continue
                try:
                    message = parse_worker_message(text)
                    if message["type"] == "event":
                        await context.emit(message["event"])
                    elif message["type"] == "result":
                        result = message["result"]
                    elif message["type"] == "error":
                        reported = message["error"]
                except Exception as error:
                    parse_error = error
                    terminate()

        invocation = create_worker_invocation(request, context.mode)
        process.stdin.write(f"{js_json.stringify(invocation)}\n".encode())  # type: ignore[union-attr]
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            await process.stdin.drain()  # type: ignore[union-attr]
        process.stdin.close()  # type: ignore[union-attr]
        try:
            await asyncio.gather(read_stdout(), read_stderr())
            code = await process.wait()
        finally:
            remove()
            if kill_timer is not None:
                kill_timer.cancel()
        if context.signal.aborted:
            reason = context.signal.reason
            raise reason if isinstance(reason, BaseException) else Error("Child execution aborted.")
        if parse_error is not None:
            raise parse_error
        if reported is not None:
            raise ExecutionEngineError(reported)
        detail = f" {stderr.strip()}" if stderr else ""
        if code != 0:
            status = code if code >= 0 else f"SIG{-code}"
            raise ExecutionEngineError(
                {
                    "code": "WORKER_PROCESS_FAILED",
                    "message": f"Worker exited with {status}.{detail}",
                    "retryable": False,
                }
            )
        if result is None:
            raise ExecutionEngineError(
                {
                    "code": "WORKER_RESULT_MISSING",
                    "message": f"Worker exited without a result.{detail}",
                    "retryable": False,
                }
            )
        return result

    return handler


class ChildProcessExecutionEngine(InProcessExecutionEngine):
    def __init__(
        self,
        *,
        command: str,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        inherit_environment: bool = True,
        kill_grace_ms: int = 2_000,
        maximum_stderr_bytes: int = 16_384,
        name: str | None = None,
    ) -> None:
        if not command.strip():
            raise Error("Child process command is required.")
        super().__init__(
            _create_handler(
                command, list(args or []), cwd, env, inherit_environment, kill_grace_ms, maximum_stderr_bytes
            ),
            name=name or "child-process",
        )
