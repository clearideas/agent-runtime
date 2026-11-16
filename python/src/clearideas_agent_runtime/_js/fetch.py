"""A ``fetch``-shaped HTTP seam (``Headers``, ``Response``, ``fetch``) backed by httpx.

Executors accept any async ``fetch(url, init)`` returning an object with
``status``, ``ok``, ``headers`` and an async byte stream, like the WHATWG
``Response`` the TypeScript executors receive.
"""

from __future__ import annotations

import json as _json
from collections.abc import AsyncIterator, Iterable, Mapping
from typing import Any

import httpx

from .abort import AbortSignal, race_abort


class Headers:
    """Case-insensitive headers (``new Headers(init)``)."""

    def __init__(self, init: Mapping[str, str] | Iterable[tuple[str, str]] | Headers | None = None) -> None:
        self._values: dict[str, str] = {}
        if isinstance(init, Headers):
            self._values = dict(init._values)
        elif isinstance(init, Mapping):
            for name, value in init.items():
                self.set(name, value)  # pyright: ignore[reportArgumentType]
        elif init is not None:
            for name, value in init:
                self.set(name, value)

    def get(self, name: str) -> str | None:
        return self._values.get(name.lower())

    def has(self, name: str) -> bool:
        return name.lower() in self._values

    def set(self, name: str, value: str) -> None:
        self._values[name.lower()] = str(value)

    def items(self) -> list[tuple[str, str]]:
        return sorted(self._values.items())

    def __iter__(self):
        return iter(self.items())


class Response:
    """A WHATWG-style response over an async byte stream."""

    def __init__(
        self,
        body: bytes | str | None = None,
        *,
        status: int = 200,
        headers: Mapping[str, str] | Headers | None = None,
        stream: AsyncIterator[bytes] | None = None,
        on_close: Any = None,
    ) -> None:
        self.status = status
        self.headers = headers if isinstance(headers, Headers) else Headers(headers)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self._body = body
        self._stream = stream
        self._on_close = on_close
        self.cancelled = False

    @property
    def ok(self) -> bool:
        return 200 <= self.status <= 299

    @property
    def has_body(self) -> bool:
        return self._body is not None or self._stream is not None

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        if self._stream is not None:
            async for chunk in self._stream:
                yield chunk
        elif self._body:
            yield self._body

    async def cancel(self) -> None:
        """``response.body.cancel()``."""
        self.cancelled = True
        await self.aclose()

    async def aclose(self) -> None:
        """Release the underlying connection (after the body was read)."""
        if self._on_close is not None:
            on_close, self._on_close = self._on_close, None
            await on_close()

    @staticmethod
    def json(value: Any, *, status: int = 200, headers: Mapping[str, str] | None = None) -> Response:
        merged = {"content-type": "application/json", **(headers or {})}
        return Response(_json.dumps(value), status=status, headers=merged)


async def fetch(url: str, init: Mapping[str, Any] | None = None) -> Response:
    """``fetch`` over httpx. Redirects are not followed (``redirect: "manual"``)."""
    init = dict(init or {})
    headers = init.get("headers")
    header_items = headers.items() if isinstance(headers, Headers) else list((headers or {}).items())
    signal: AbortSignal | None = init.get("signal")
    client = httpx.AsyncClient(follow_redirects=False, timeout=None)
    request = client.build_request(init.get("method", "GET"), url, headers=header_items, content=init.get("body"))

    async def send() -> httpx.Response:
        return await client.send(request, stream=True)

    try:
        response = await race_abort(send(), signal)
    except BaseException:
        await client.aclose()
        raise

    async def stream() -> AsyncIterator[bytes]:
        async for chunk in response.aiter_raw():
            yield chunk

    async def close() -> None:
        await response.aclose()
        await client.aclose()

    return Response(
        status=response.status_code, headers=Headers(list(response.headers.items())), stream=stream(), on_close=close
    )
