"""JavaScript error identity.

The TypeScript runtime classifies errors by ``error.name`` and ``error.code``
and records ``name`` in ``RunError.details``. Python exceptions carry the same
attributes: ``Error`` is ``new Error(message)``; subclasses set ``name``.
"""

from __future__ import annotations

from typing import Any


class Error(Exception):
    """``new Error(message)``."""

    name = "Error"

    def __init__(self, message: str = "", *, cause: Any = None) -> None:
        super().__init__(message)
        self.message = message
        if cause is not None:
            self.cause = cause

    def __str__(self) -> str:
        return self.message


class TypeError_(Error):
    """``new TypeError(message)``."""

    name = "TypeError"


class RangeError(Error):
    name = "RangeError"


class SyntaxError_(Error, ValueError):
    """``new SyntaxError(message)`` (also a ``ValueError``, for Python callers)."""

    name = "SyntaxError"


def error_name(error: BaseException) -> str:
    """``error.name``: the JavaScript name, or the Python class name."""
    name = getattr(error, "name", None)
    if isinstance(name, str):
        return name
    return type(error).__name__


def error_message(error: BaseException) -> str:
    """``error.message`` (``String(error)`` for values that are not errors)."""
    message = getattr(error, "message", None)
    if isinstance(message, str):
        return message
    return str(error)
