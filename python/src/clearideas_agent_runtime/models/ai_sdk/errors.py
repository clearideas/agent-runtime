"""AI SDK errors for failed provider calls, and the AI SDK's retry policy.

A failed HTTP call becomes an ``APICallError`` whose message the provider's
``failedResponseHandler`` extracts from the error body (or the status text);
``retry`` repeats retryable calls the way ``generateText``/``streamText`` do
(two retries, 2 s then 4 s, honouring ``retry-after-ms``/``retry-after``) and
reports a ``RetryError`` when they keep failing. Run records store these
errors' names and messages, so they match the TypeScript runtime's.
"""

from __future__ import annotations

import asyncio
import errno
import math
import socket
import time
from collections.abc import Awaitable, Callable
from email.utils import parsedate_to_datetime
from typing import Any, TypeVar

from ..._js import json as js_json
from .capture import Capture, Exchange
from .core import error_message

T = TypeVar("T")


class APICallError(Exception):
    """``APICallError`` (``@ai-sdk/provider``)."""

    name = "AI_APICallError"

    def __init__(
        self,
        message: str,
        *,
        url: str | None = None,
        status_code: int | None = None,
        response_headers: dict[str, str] | None = None,
        response_body: str | None = None,
        is_retryable: bool | None = None,
        data: Any = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.url = url
        self.statusCode = status_code
        self.responseHeaders = response_headers
        self.responseBody = response_body
        self.isRetryable = (
            is_retryable
            if is_retryable is not None
            else status_code is not None and (status_code in (408, 409, 429) or status_code >= 500)
        )
        self.data = data
        if cause is not None:
            self.cause = cause


class RetryError(Exception):
    """``RetryError`` (``ai``)."""

    name = "AI_RetryError"

    def __init__(self, message: str, reason: str, errors: list[BaseException]) -> None:
        super().__init__(message)
        self.message = message
        self.reason = reason
        self.errors = errors
        self.lastError = errors[-1] if errors else None


def _is_str(value: Any) -> bool:
    return isinstance(value, str)


def _error_message(driver: str, data: Any) -> str | None:
    """The provider's ``errorSchema`` + ``errorToMessage``; ``None`` when the body does not match."""
    if not isinstance(data, dict):
        return None
    error = data.get("error")
    if driver == "anthropic":
        if data.get("type") == "error" and isinstance(error, dict) and _is_str(error.get("type")):
            return error.get("message") if _is_str(error.get("message")) else None
        return None
    if driver == "cohere":
        return data.get("message") if _is_str(data.get("message")) else None
    if driver == "google":
        if (
            isinstance(error, dict)
            and _is_str(error.get("message"))
            and _is_str(error.get("status"))
            and "code" in error
            and (error["code"] is None or isinstance(error["code"], int | float))
        ):
            return error["message"]
        return None
    if driver == "groq":
        if isinstance(error, dict) and _is_str(error.get("message")) and _is_str(error.get("type")):
            return error["message"]
        return None
    if driver == "xai":
        if isinstance(error, dict) and _is_str(error.get("message")):
            return error["message"]
        if isinstance(error, str):
            if _is_str(data.get("code")):
                return f"{data['code']}: {error}"
            return error if "code" not in data else None
        return None
    # openai, openai-compatible
    if isinstance(error, dict) and _is_str(error.get("message")):
        return error["message"]
    return None


def api_call_error(driver: str, exchange: Exchange, cause: BaseException | None = None) -> APICallError:
    """``createJsonErrorResponseHandler`` for the provider."""
    body = exchange.text
    message: str | None = None
    data: Any = None
    if body.strip():
        try:
            data = js_json.parse(body)
            message = _error_message(driver, data)
            if message is None:
                data = None
        except ValueError:
            data = None
    return APICallError(
        message if message is not None else exchange.reason,
        url=exchange.url,
        status_code=exchange.status,
        response_headers=exchange.headers,
        response_body=body,
        data=data,
        cause=cause,
    )


_NODE_CODES = {
    errno.ECONNREFUSED: "ECONNREFUSED",
    errno.ECONNRESET: "ECONNRESET",
    errno.ETIMEDOUT: "ETIMEDOUT",
    errno.EPIPE: "EPIPE",
    errno.EHOSTUNREACH: "EHOSTUNREACH",
    errno.ENETUNREACH: "ENETUNREACH",
}


def _transport_cause(error: BaseException) -> BaseException | None:
    """The transport failure behind an SDK connection error, if any."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        module = type(current).__module__.split(".", 1)[0]
        if module in ("httpx", "httpx2", "httpcore", "aiohttp") or isinstance(current, OSError | socket.gaierror):
            return current
        current = current.__cause__ or current.__context__
    return None


def _node_message(error: BaseException, url: str | None) -> str:
    """The message Node's fetch reports for a failed connection (best effort)."""
    root: BaseException | None = error
    seen: set[int] = set()
    while root is not None and id(root) not in seen:
        seen.add(id(root))
        if isinstance(root, socket.gaierror):
            host = ""
            if url:
                from urllib.parse import urlsplit

                host = urlsplit(url).hostname or ""
            return f"getaddrinfo ENOTFOUND {host}"
        if isinstance(root, OSError) and root.errno in _NODE_CODES:
            code = _NODE_CODES[root.errno]
            if code == "ECONNREFUSED" and url:
                from urllib.parse import urlsplit

                parts = urlsplit(url)
                port = parts.port or (443 if parts.scheme == "https" else 80)
                return f"connect ECONNREFUSED {parts.hostname}:{port}"
            return f"read {code}" if code == "ECONNRESET" else code
        root = root.__cause__ or root.__context__
    return error_message(error).removeprefix("Error: ") if str(error) else "fetch failed"


def to_ai_sdk_error(driver: str, capture: Capture, error: BaseException) -> BaseException:
    """The AI SDK error for a failed pydantic-ai call (the error itself when it is not a provider failure)."""
    if isinstance(error, APICallError | RetryError | asyncio.CancelledError):
        return error
    exchange = capture.last
    if exchange is not None and exchange.status >= 400:
        return api_call_error(driver, exchange, cause=error)
    transport = _transport_cause(error)
    if transport is not None:
        url = exchange.url if exchange is not None else None
        return APICallError(f"Cannot connect to API: {_node_message(transport, url)}", cause=error, is_retryable=True)
    return error


def _retry_delay_ms(error: BaseException, backoff: float) -> float:
    """``getRetryDelayInMs``."""
    headers = getattr(error, "responseHeaders", None)
    if not isinstance(headers, dict) or not headers:
        return backoff
    milliseconds: float | None = None
    retry_after_ms = headers.get("retry-after-ms")
    if retry_after_ms:
        try:
            milliseconds = float(retry_after_ms)
        except ValueError:
            milliseconds = None
        if milliseconds is not None and math.isnan(milliseconds):
            milliseconds = None
    retry_after = headers.get("retry-after")
    if retry_after and milliseconds is None:
        try:
            milliseconds = float(retry_after) * 1000
        except ValueError:
            try:
                milliseconds = parsedate_to_datetime(retry_after).timestamp() * 1000 - time.time() * 1000
            except (TypeError, ValueError):
                milliseconds = None
    if milliseconds is not None and 0 <= milliseconds and (milliseconds < 60_000 or milliseconds < backoff):
        return milliseconds
    return backoff


async def retry(
    attempt: Callable[[], Awaitable[T]],
    *,
    max_retries: int = 2,
    initial_delay_ms: float = 2000,
    backoff_factor: float = 2,
    is_abort: Callable[[BaseException], bool] = lambda error: False,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> T:
    """``retryWithExponentialBackoffRespectingRetryHeaders``."""
    errors: list[BaseException] = []
    delay = initial_delay_ms
    while True:
        try:
            return await attempt()
        except Exception as error:
            if is_abort(error) or max_retries == 0:
                raise
            message = error_message(error)
            errors.append(error)
            tries = len(errors)
            if tries > max_retries:
                raise RetryError(
                    f"Failed after {tries} attempts. Last error: {message}", "maxRetriesExceeded", list(errors)
                ) from error
            if isinstance(error, APICallError) and error.isRetryable is True:
                await sleep(_retry_delay_ms(error, delay) / 1000)
                delay *= backoff_factor
                continue
            if tries == 1:
                raise
            raise RetryError(
                f"Failed after {tries} attempts with non-retryable error: '{message}'",
                "errorNotRetryable",
                list(errors),
            ) from error
