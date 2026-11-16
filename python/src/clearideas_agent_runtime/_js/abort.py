"""AbortController / AbortSignal for asyncio.

The TypeScript runtime passes an ``AbortSignal`` through every layer and uses
``signal.reason`` to carry suspension and interruption errors. This module
provides the same contract.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable, Iterable
from typing import Any, TypeVar

T = TypeVar("T")


class AbortError(Exception):
    """DOMException AbortError equivalent."""

    def __init__(self, message: str = "This operation was aborted") -> None:
        super().__init__(message)
        self.name = "AbortError"


class TimeoutError_(Exception):
    def __init__(self, message: str = "The operation was aborted due to timeout") -> None:
        super().__init__(message)
        self.name = "TimeoutError"


class AbortSignal:
    def __init__(self) -> None:
        self._aborted = False
        self._reason: Any = None
        self._listeners: list[Callable[[], None]] = []
        self._event: asyncio.Event | None = None

    @property
    def aborted(self) -> bool:
        return self._aborted

    @property
    def reason(self) -> Any:
        return self._reason

    def throw_if_aborted(self) -> None:
        if self._aborted:
            reason = self._reason
            if isinstance(reason, BaseException):
                raise reason
            raise AbortError()

    def add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Registers ``listener`` for the abort event; returns a remover."""
        if self._aborted:
            listener()
            return lambda: None
        self._listeners.append(listener)

        def remove() -> None:
            with contextlib.suppress(ValueError):
                self._listeners.remove(listener)

        return remove

    def _abort(self, reason: Any) -> None:
        if self._aborted:
            return
        self._aborted = True
        self._reason = AbortError() if reason is None else reason
        if self._event is not None:
            self._event.set()
        listeners, self._listeners = self._listeners, []
        for listener in listeners:
            listener()

    async def wait(self) -> None:
        if self._aborted:
            return
        if self._event is None:
            self._event = asyncio.Event()
        await self._event.wait()

    @staticmethod
    def abort(reason: Any = None) -> AbortSignal:
        signal = AbortSignal()
        signal._abort(reason)
        return signal

    @staticmethod
    def timeout(ms: float) -> AbortSignal:
        signal = AbortSignal()
        loop = asyncio.get_running_loop()
        loop.call_later(ms / 1000, lambda: signal._abort(TimeoutError_()))
        return signal

    @staticmethod
    def any(signals: Iterable[AbortSignal | None]) -> AbortSignal:
        combined = AbortSignal()
        sources = [signal for signal in signals if signal is not None]
        for source in sources:
            if source.aborted:
                combined._abort(source.reason)
                return combined
        for source in sources:
            source.add_listener(lambda source=source: combined._abort(source.reason))
        return combined


class AbortController:
    def __init__(self) -> None:
        self.signal = AbortSignal()

    def abort(self, reason: Any = None) -> None:
        self.signal._abort(reason)


def abort_reason_error(signal: AbortSignal) -> BaseException:
    reason = signal.reason
    return reason if isinstance(reason, BaseException) else AbortError()


async def race_abort(awaitable: Awaitable[T], signal: AbortSignal | None) -> T:
    """Await ``awaitable`` unless ``signal`` aborts first (then raise its reason)."""
    if signal is None:
        return await awaitable
    signal.throw_if_aborted()
    task = asyncio.ensure_future(awaitable)
    waiter = asyncio.ensure_future(signal.wait())
    try:
        done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    except BaseException:
        task.cancel()
        waiter.cancel()
        raise
    if task in done:
        waiter.cancel()
        return task.result()
    task.cancel()
    with contextlib.suppress(BaseException):
        await task
    raise abort_reason_error(signal)


async def sleep(ms: float, signal: AbortSignal | None = None) -> None:
    await race_abort(asyncio.sleep(max(ms, 0) / 1000), signal)
