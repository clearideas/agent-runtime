"""Subprocess helpers shared by the sandbox providers (Node ``spawn`` equivalents)."""

from __future__ import annotations

import asyncio
import codecs
import contextlib
from collections.abc import AsyncIterator
from typing import Any

from .._js.abort import AbortSignal
from .._js.errors import Error

JsonObject = dict[str, Any]
_SIGNALS = {9: "SIGKILL", 15: "SIGTERM", 2: "SIGINT", 6: "SIGABRT", 11: "SIGSEGV", 1: "SIGHUP"}


async def collect(
    binary: str,
    args: list[str],
    input: bytes | str | None = None,
    signal: AbortSignal | None = None,
    maximum_bytes: int | None = None,
    missing_exit_code: int | None = None,
) -> tuple[bytes, bytes, int]:
    """Run a command to completion; returns (stdout, stderr, exit code)."""
    if signal is not None:
        signal.throw_if_aborted()
    try:
        process = await asyncio.create_subprocess_exec(
            binary,
            *args,
            stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError:
        if missing_exit_code is not None:
            return b"", b"", missing_exit_code
        raise
    remove = signal.add_listener(lambda: _kill(process)) if signal is not None else None
    try:
        data = input.encode("utf-8") if isinstance(input, str) else input
        if maximum_bytes is None:
            stdout, stderr = await process.communicate(data)
        else:
            stdout, stderr = await _bounded_communicate(process, data, maximum_bytes)
        code = process.returncode if process.returncode is not None else 1
        return stdout, stderr, code if code >= 0 else 1
    finally:
        if remove is not None:
            remove()
        if signal is not None and signal.aborted:
            signal.throw_if_aborted()


async def _bounded_communicate(process: Any, data: bytes | None, maximum: int) -> tuple[bytes, bytes]:
    if data is not None:
        process.stdin.write(data)
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            await process.stdin.drain()
        process.stdin.close()
    collected = 0
    overflow = False

    async def read(stream: asyncio.StreamReader, into: list[bytes]) -> None:
        nonlocal collected, overflow
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                return
            if overflow:
                continue
            collected += len(chunk)
            if collected > maximum:
                overflow = True
                _kill(process)
                continue
            into.append(chunk)

    stdout: list[bytes] = []
    stderr: list[bytes] = []
    await asyncio.gather(read(process.stdout, stdout), read(process.stderr, stderr))
    await process.wait()
    if overflow:
        raise Error(f"Docker command output exceeded {maximum} bytes.")
    return b"".join(stdout), b"".join(stderr)


def _kill(process: Any) -> None:
    with contextlib.suppress(ProcessLookupError):
        process.kill()


async def stream_process(
    binary: str,
    args: list[str],
    *,
    signal: AbortSignal | None = None,
    timeout_ms: float | None = None,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    exit_code_when_signalled: int = 1,
) -> AsyncIterator[JsonObject]:
    """Run a command, yielding ``stdout``/``stderr`` text events and one ``exit`` event."""
    try:
        process = await asyncio.create_subprocess_exec(
            binary,
            *args,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as error:
        yield {"type": "stderr", "data": str(error)}
        yield {"type": "exit", "exitCode": 127 if exit_code_when_signalled == 137 else exit_code_when_signalled}
        return
    queue: asyncio.Queue[JsonObject | None] = asyncio.Queue()

    async def pump(stream: asyncio.StreamReader, kind: str) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                tail = decoder.decode(b"", final=True)
                if tail:
                    await queue.put({"type": kind, "data": tail})
                return
            text = decoder.decode(chunk)
            if text:
                await queue.put({"type": kind, "data": text})

    def kill() -> None:
        _kill(process)

    remove = signal.add_listener(kill) if signal is not None else None
    timer = asyncio.get_running_loop().call_later(timeout_ms / 1000, kill) if timeout_ms else None
    readers = [
        asyncio.ensure_future(pump(process.stdout, "stdout")),  # type: ignore[arg-type]
        asyncio.ensure_future(pump(process.stderr, "stderr")),  # type: ignore[arg-type]
    ]

    async def finish() -> None:
        await asyncio.gather(*readers)
        code = await process.wait()
        event: JsonObject = {"type": "exit", "exitCode": code if code >= 0 else exit_code_when_signalled}
        if code < 0:
            event["signal"] = _SIGNALS.get(-code, f"SIG{-code}")
        await queue.put(event)
        await queue.put(None)

    waiter = asyncio.ensure_future(finish())
    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            yield event
    finally:
        if timer is not None:
            timer.cancel()
        if remove is not None:
            remove()
        if not waiter.done():
            kill()
            with contextlib.suppress(BaseException):
                await waiter
