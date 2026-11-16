"""Records the provider's HTTP responses for the request in progress.

The AI SDK builds a ``ModelResult`` (content, provider metadata, usage) from the
provider's response body or server-sent events. To build the same result, the
Python adapter reads the same raw responses: every provider SDK client it
creates uses an HTTP client whose transport is wrapped by ``instrument``, and
``capturing()`` collects the responses of the requests made inside it.

Bodies are decoded (``gzip``/``deflate``, and ``br``/``zstd`` when their
packages are installed) without changing what the SDK reads.
"""

from __future__ import annotations

import contextlib
import zlib
from collections.abc import AsyncIterator, Iterator
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from ..._js import json as js_json

JsonObject = dict[str, Any]


@dataclass
class SseEvent:
    event: str | None
    data: str

    def json(self) -> Any:
        return js_json.parse(self.data)


class _SseParser:
    """Server-sent events (WHATWG), fed incrementally."""

    def __init__(self) -> None:
        self._buffer = ""
        self._event: str | None = None
        self._data: list[str] = []

    def feed(self, text: str) -> list[SseEvent]:
        self._buffer += text
        events: list[SseEvent] = []
        while True:
            newline = self._buffer.find("\n")
            carriage = self._buffer.find("\r")
            if newline == -1 and carriage == -1:
                break
            if carriage != -1 and (newline == -1 or carriage < newline):
                if carriage + 1 == len(self._buffer):
                    break  # a "\r" at the end may be the first half of "\r\n"
                line = self._buffer[:carriage]
                skip = 2 if self._buffer[carriage + 1] == "\n" else 1
                self._buffer = self._buffer[carriage + skip :]
            else:
                line = self._buffer[:newline]
                self._buffer = self._buffer[newline + 1 :]
            event = self._line(line)
            if event is not None:
                events.append(event)
        return events

    def close(self) -> list[SseEvent]:
        """End of stream: a final unterminated line and event are still delivered."""
        events: list[SseEvent] = []
        if self._buffer:
            line, self._buffer = self._buffer.rstrip("\r"), ""
            event = self._line(line)
            if event is not None:
                events.append(event)
        event = self._line("")
        if event is not None:
            events.append(event)
        return events

    def _line(self, line: str) -> SseEvent | None:
        if line == "":
            if not self._data:
                self._event = None
                return None
            event = SseEvent(self._event, "\n".join(self._data))
            self._event = None
            self._data = []
            return event
        if line.startswith(":"):
            return None
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "data":
            self._data.append(value)
        elif name == "event":
            self._event = value
        return None


class _Decoder:
    def __init__(self, encodings: list[str]) -> None:
        self.supported = True
        self._steps: list[Any] = []
        for encoding in reversed(encodings):
            if encoding in ("", "identity"):
                continue
            if encoding in ("gzip", "x-gzip"):
                self._steps.append(zlib.decompressobj(16 + zlib.MAX_WBITS))
            elif encoding == "deflate":
                self._steps.append(_Deflate())
            elif encoding == "br":
                brotli = _optional("brotli") or _optional("brotlicffi")
                if brotli is None:
                    self.supported = False
                else:
                    self._steps.append(brotli.Decompressor())
            elif encoding == "zstd":
                zstandard = _optional("zstandard")
                if zstandard is None:
                    self.supported = False
                else:
                    self._steps.append(zstandard.ZstdDecompressor().decompressobj())
            else:
                self.supported = False

    def decode(self, data: bytes) -> bytes:
        for step in self._steps:
            data = step.process(data) if hasattr(step, "process") else step.decompress(data)
        return data

    def flush(self) -> bytes:
        data = b""
        for step in self._steps:
            if data:
                data = step.process(data) if hasattr(step, "process") else step.decompress(data)
            if hasattr(step, "flush"):
                with contextlib.suppress(Exception):
                    data += step.flush()
        return data


class _Deflate:
    def __init__(self) -> None:
        self._first = True
        self._decompressor = zlib.decompressobj()

    def decompress(self, data: bytes) -> bytes:
        if self._first:
            self._first = False
            try:
                return self._decompressor.decompress(data)
            except zlib.error:
                self._decompressor = zlib.decompressobj(-zlib.MAX_WBITS)
        return self._decompressor.decompress(data)

    def flush(self) -> bytes:
        return self._decompressor.flush()


def _optional(name: str) -> Any:
    try:
        return __import__(name)
    except ImportError:
        return None


@dataclass
class Exchange:
    """One HTTP response: its status, content type, and (decoded) body or events."""

    status: int
    content_type: str
    decodable: bool = True
    reason: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    url: str = ""
    body: bytearray = field(default_factory=bytearray)
    events: list[SseEvent] = field(default_factory=list)
    complete: bool = False
    _text: Any = None
    _parser: _SseParser | None = None

    @property
    def is_event_stream(self) -> bool:
        return "text/event-stream" in self.content_type

    def _feed(self, data: bytes) -> None:
        if self.is_event_stream:
            if self._text is None:
                import codecs

                self._text = codecs.getincrementaldecoder("utf-8")(errors="replace")
                self._parser = _SseParser()
            assert self._parser is not None
            self.events.extend(self._parser.feed(self._text.decode(data)))
        else:
            self.body.extend(data)

    def _close(self) -> None:
        if self.is_event_stream and self._parser is not None:
            self.events.extend(self._parser.feed(self._text.decode(b"", final=True)))
            self.events.extend(self._parser.close())
        self.complete = True

    def json(self) -> Any:
        return js_json.parse(self.body.decode("utf-8"))

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")


class Capture:
    """The responses of one model call (several when the SDK retries)."""

    def __init__(self) -> None:
        self.exchanges: list[Exchange] = []

    @property
    def last(self) -> Exchange | None:
        return self.exchanges[-1] if self.exchanges else None

    def successful(self) -> Exchange | None:
        for exchange in reversed(self.exchanges):
            if 200 <= exchange.status < 300 and exchange.decodable:
                return exchange
        return None


_CAPTURE: ContextVar[Capture | None] = ContextVar("clearideas_http_capture", default=None)


@contextlib.contextmanager
def capturing() -> Iterator[Capture]:
    capture = Capture()
    token = _CAPTURE.set(capture)
    try:
        yield capture
    finally:
        _CAPTURE.reset(token)


class _TeeStream:
    """Yields the response bytes unchanged while recording their decoded form."""

    def __init__(self, stream: Any, exchange: Exchange, decoder: _Decoder) -> None:
        self._stream = stream
        self._exchange = exchange
        self._decoder = decoder

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._stream:
            if self._exchange.decodable:
                try:
                    self._exchange._feed(self._decoder.decode(chunk))
                except Exception:
                    self._exchange.decodable = False
            yield chunk
        if self._exchange.decodable:
            try:
                tail = self._decoder.flush()
                if tail:
                    self._exchange._feed(tail)
                self._exchange._close()
            except Exception:
                self._exchange.decodable = False

    async def aclose(self) -> None:
        close = getattr(self._stream, "aclose", None)
        if close is not None:
            await close()


_TEE_CLASSES: dict[type, type] = {}


def _tee(stream: Any, exchange: Exchange, decoder: _Decoder) -> Any:
    """A ``_TeeStream`` that is also the HTTP library's ``AsyncByteStream`` (which ``httpx`` checks)."""
    base = next((cls for cls in type(stream).__mro__ if cls.__name__ == "AsyncByteStream"), None)
    if base is None:
        return _TeeStream(stream, exchange, decoder)
    tee = _TEE_CLASSES.get(base)
    if tee is None:
        tee = type("CapturingByteStream", (_TeeStream, base), {})
        _TEE_CLASSES[base] = tee
    return tee(stream, exchange, decoder)


def _reason_phrase(response: Any) -> str:
    """The status line's reason phrase (``response.statusText``)."""
    phrase = (getattr(response, "extensions", None) or {}).get("reason_phrase")
    if isinstance(phrase, bytes):
        return phrase.decode("ascii", "replace")
    if isinstance(phrase, str):
        return phrase
    return getattr(response, "reason_phrase", "") or ""


class CapturingTransport:
    """Wraps an ``httpx``/``httpx2`` async transport; responses are recorded inside ``capturing()``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    async def handle_async_request(self, request: Any) -> Any:
        response = await self._inner.handle_async_request(request)
        capture = _CAPTURE.get()
        if capture is None:
            return response
        encodings = [
            value.strip().lower() for value in response.headers.get("content-encoding", "").split(",") if value.strip()
        ]
        decoder = _Decoder(encodings)
        exchange = Exchange(
            status=response.status_code,
            content_type=response.headers.get("content-type", "").lower(),
            decodable=decoder.supported,
            reason=_reason_phrase(response),
            headers={key.lower(): value for key, value in response.headers.items()},
            url=str(request.url),
        )
        capture.exchanges.append(exchange)
        response.stream = _tee(response.stream, exchange, decoder)
        return response

    async def aclose(self) -> None:
        await self._inner.aclose()

    async def __aenter__(self) -> CapturingTransport:
        enter = getattr(self._inner, "__aenter__", None)
        if enter is not None:
            await enter()
        return self

    async def __aexit__(self, *args: Any) -> None:
        exit_ = getattr(self._inner, "__aexit__", None)
        if exit_ is not None:
            await exit_(*args)


def instrument(client: Any) -> Any:
    """Wraps the transports of an ``httpx``/``httpx2`` ``AsyncClient`` (in place) and returns it."""
    transport = getattr(client, "_transport", None)
    if transport is not None and not isinstance(transport, CapturingTransport):
        client._transport = CapturingTransport(transport)
    mounts = getattr(client, "_mounts", None)
    if isinstance(mounts, dict):
        for pattern, mounted in list(mounts.items()):
            if mounted is not None and not isinstance(mounted, CapturingTransport):
                mounts[pattern] = CapturingTransport(mounted)
    return client
