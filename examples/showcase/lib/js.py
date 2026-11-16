"""
JavaScript semantics for the demo hosts and scripts, so both showcase servers
produce the same bytes: JSON with JavaScript number formatting and key order,
UTF-16 string lengths, JavaScript's string ordering, ``Number.prototype.toFixed``,
and ``toLocaleString("en-US")``. The runtime implements these for its own
parity with TypeScript (``clearideas_agent_runtime._js``, not a public API);
this module is the showcase's one door to them. It also names JavaScript's
``undefined`` (``UNDEFINED``), the WHATWG ``URL`` parser Node uses, and the
character classes of JavaScript's ``\\s`` and ``\\S`` (``WS``, ``NOT_WS``).
"""

from __future__ import annotations

import base64
import math
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from clearideas_agent_runtime._js import json as _json
from clearideas_agent_runtime._js import strings as _strings
from clearideas_agent_runtime._js import time as _time
from clearideas_agent_runtime._js.collation import locale_compare
from clearideas_agent_runtime._js.ops import UNDEFINED
from clearideas_agent_runtime._js.ops import to_number as number
from clearideas_agent_runtime._js.regex import NOT_WS, WS
from clearideas_agent_runtime._js.url import URL

__all__ = [
    "NOT_WS",
    "UNDEFINED",
    "URL",
    "WS",
    "byte_length",
    "code_unit_key",
    "compare_code_units",
    "from_base64",
    "is_safe_integer",
    "json_or",
    "length",
    "locale_compare",
    "now_iso",
    "number",
    "parse",
    "round_half_up",
    "slice",
    "stringify",
    "to_fixed",
    "to_locale_string",
    "trim",
    "trim_end",
]

#: ``JSON.parse`` (JavaScript number semantics and key order; V8's error messages).
parse = _json.parse
#: ``JSON.stringify(value)`` or ``JSON.stringify(value, null, indent)``.
stringify = _json.stringify
#: UTF-8 bytes of ``JSON.stringify(value)``.
byte_length = _json.byte_length
#: ``text.length`` and ``text.slice(start, end)``, in UTF-16 code units.
length = _strings.length
slice = _strings.slice
#: ``text.trim()`` and ``text.trimEnd()`` (JavaScript's whitespace).
trim = _strings.trim
trim_end = _strings.trim_end
#: Sort key and comparison in JavaScript's default string order (UTF-16 code units).
code_unit_key = _strings.code_unit_key
compare_code_units = _strings.compare_code_units


def from_base64(text: str) -> bytes:
    """``Buffer.from(text, "base64")``: lenient, as Node decodes it.

    Standard and URL-safe alphabets are both accepted, other characters are
    skipped, and decoding stops at the first padding character.
    """
    cleaned = re.sub(r"[^A-Za-z0-9+/_-]", "", text.split("=", 1)[0]).translate(str.maketrans("-_", "+/"))
    usable = len(cleaned) - (len(cleaned) % 4 == 1)  # a lone trailing character carries no byte
    cleaned = cleaned[:usable]
    return base64.b64decode(cleaned + "=" * (-len(cleaned) % 4))


def now_iso() -> str:
    """``new Date().toISOString()``."""
    return _time.to_iso(_time.now())


def to_fixed(value: float, digits: int) -> str:
    """``value.toFixed(digits)``: the exact double, rounded half away from zero."""
    if math.isnan(value):
        return "NaN"
    if abs(value) >= 1e21:
        return _json.number_to_string(value)
    sign = "-" if value < 0 else ""
    rounded = Decimal(abs(value)).quantize(Decimal(1).scaleb(-digits), ROUND_HALF_UP)
    return f"{sign}{rounded:f}"


def to_locale_string(value: float) -> str:
    """``value.toLocaleString("en-US")``: grouped, at most three fraction digits."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "∞" if value > 0 else "-∞"
    rounded = Decimal(repr(float(value))).quantize(Decimal("0.001"), ROUND_HALF_UP)
    text = f"{rounded:,f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def is_safe_integer(value: Any) -> bool:
    """``Number.isSafeInteger(value)``."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and float(value).is_integer()
        and abs(value) <= 2**53 - 1
    )


def round_half_up(value: float) -> int:
    """``Math.round(value)``: halves round up, toward positive infinity."""
    whole = math.floor(value)
    return whole + 1 if value - whole >= 0.5 else whole


def json_or(text: str | None, fallback: Any) -> Any:
    """``JSON.parse(text)``, or ``fallback`` when the text is missing or invalid."""
    if text is None:
        return fallback
    try:
        return _json.parse(text)
    except ValueError:
        return fallback
