"""Provider-neutral classification of model errors (``context/errors.ts``).

Adapters may set ``code`` explicitly; otherwise the checks duck-type common
provider error shapes (``statusCode``/``status_code``, ``isRetryable``,
``responseBody``/``body``, ``cause``/``__cause__``, ``lastError``, ``errors``)
and fall back to well-known provider messages. Errors may be exceptions or
dictionaries.
"""

from __future__ import annotations

import errno as _errno
import re
from typing import Any

from ...._js.errors import error_message, error_name

_MISSING = object()


def _get(entry: Any, *names: str) -> Any:
    for name in names:
        if isinstance(entry, dict):
            if name in entry:
                return entry[name]
        else:
            value = getattr(entry, name, _MISSING)
            if value is not _MISSING:
                return value
    return None


def _is_object(value: Any) -> bool:
    return value is not None and not isinstance(value, (str, int, float, bool, list, tuple))


def _error_chain(error: Any) -> list[Any]:
    """The error and the errors it wraps, outermost first, without cycles."""
    chain: list[Any] = []
    seen: set[int] = set()
    pending: list[Any] = [error]
    while pending and len(chain) < 12:
        current = pending.pop(0)
        if not _is_object(current) or id(current) in seen:
            continue
        seen.add(id(current))
        chain.append(current)
        cause = _get(current, "cause")
        if cause is None and isinstance(current, BaseException):
            cause = current.__cause__
        pending.append(cause)
        pending.append(_get(current, "lastError", "last_error"))
        errors = _get(current, "errors")
        if isinstance(errors, (list, tuple)):
            pending.extend(errors)
        elif isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
    return chain


def _name(entry: Any) -> Any:
    if isinstance(entry, BaseException):
        return error_name(entry)
    return _get(entry, "name")


def _code(entry: Any) -> Any:
    code = _get(entry, "code")
    if code is None and isinstance(entry, OSError) and entry.errno is not None:
        return _errno.errorcode.get(entry.errno)
    return code


def _status(entry: Any) -> int | None:
    value = _get(entry, "statusCode", "status_code")
    if value is None:
        value = _get(entry, "status")
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None  # pyright: ignore[reportReturnType]


def _text(entry: Any) -> str:
    message = error_message(entry) if isinstance(entry, BaseException) else _get(entry, "message")
    body = _get(entry, "responseBody", "response_body", "body")
    return " ".join(value for value in (message, body) if isinstance(value, str))


# JavaScript /iu: \w and \b use ASCII word characters (plus the two characters
# that case-fold into them, which Python's IGNORECASE matches the same way).
_W = "[A-Za-z0-9_]"
_CONTEXT_OVERFLOW_PATTERN = re.compile(
    r"context[_ -]?length|context[_ -]?window|maximum context|prompt is too long|input is too long"
    r"|too many (input )?tokens|request too large"
    rf"|exceed{_W}*[^.]{{0,60}}(?<!{_W})(context|tokens?)(?!{_W})"
    r"|token limit|reduce the length",
    re.IGNORECASE,
)


def is_context_overflow_error(error: Any) -> bool:
    """The model rejected the request because its input was too large."""
    for entry in _error_chain(error):
        if _code(entry) == "MODEL_CONTEXT_OVERFLOW":
            return True
        status = _status(entry)
        # 429 "request too large" messages describe rate limits, not the window.
        if status is not None and status not in (400, 413, 422):
            continue
        if _CONTEXT_OVERFLOW_PATTERN.search(_text(entry)):
            return True
    return False


_RETRYABLE_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504, 529}
_RETRYABLE_CODES = {
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "MODEL_TIMEOUT",
    "MODEL_PROVIDER_UNAVAILABLE",
}
_NETWORK_PATTERN = re.compile(
    r"socket hang up|fetch failed|network error|connection (reset|closed|refused)|terminated|overloaded",
    re.IGNORECASE,
)


def _is_transport_error(entry: Any) -> bool:
    """Python transport failures (the equivalents of Node's socket error codes)."""
    if isinstance(entry, (ConnectionError, TimeoutError)):
        return True
    try:
        import httpx
    except ImportError:  # pragma: no cover - httpx is a dependency
        return False
    return isinstance(entry, httpx.TransportError)


def is_retryable_model_error(error: Any) -> bool:
    """The request may succeed if repeated: timeouts, rate limits, overload, dropped connections."""
    if is_context_overflow_error(error):
        return False
    for entry in _error_chain(error):
        if _name(entry) == "ModelTimeoutError":
            return True
        if _get(entry, "isRetryable", "is_retryable") is True or _get(entry, "retryable") is True:
            return True
        status = _status(entry)
        if status is not None and status in _RETRYABLE_STATUSES:
            return True
        code = _code(entry)
        if isinstance(code, str) and code in _RETRYABLE_CODES:
            return True
        if status is None and (_NETWORK_PATTERN.search(_text(entry)) or _is_transport_error(entry)):
            return True
    return False


def is_invalid_output_error(error: Any) -> bool:
    """The final answer did not match the step's output schema."""
    return any(
        _name(entry) in ("AI_NoObjectGeneratedError", "NoObjectGeneratedError")
        or _code(entry) == "MODEL_OUTPUT_INVALID"
        for entry in _error_chain(error)
    )


def describe_error(error: Any) -> str:
    if isinstance(error, BaseException):
        return error_message(error)
    from ...._js.ops import to_string

    return to_string(error)


def error_summary(error: Any) -> dict[str, Any]:
    chain = _error_chain(error)
    if not chain:
        return {}
    first = chain[0]
    status = _status(first)
    summary: dict[str, Any] = {}
    name = _name(first)
    if isinstance(name, str):
        summary["name"] = name
    if status is not None:
        summary["statusCode"] = status
    return summary
