"""Helpers for translating JavaScript regular expressions."""

from __future__ import annotations

# ``\s`` in JavaScript (WhiteSpace and LineTerminator); Python's ``\s`` differs.
WS = "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
NOT_WS = "[^\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"


def escape(value: str) -> str:
    """``value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")``."""
    out = []
    for char in value:
        if char in ".*+?^${}()|[]\\":
            out.append("\\" + char)
        else:
            out.append(char)
    return "".join(out)
