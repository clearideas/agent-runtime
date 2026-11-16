"""Byte measures and token estimates (``context/measure.ts``).

Text helpers use JavaScript's UTF-16 indexes: strings are converted with
``utf16`` (astral characters become surrogate pairs) before slicing, and
results are returned well formed.
"""

from __future__ import annotations

import math
import re
from typing import Any

from ...._js import json as js_json
from ...._js.ops import UNDEFINED
from ...._js.strings import utf16, well_formed


def json_bytes(value: Any) -> int:
    """UTF-8 size of a JSON value, measured like ``limits.maxInputBytes``."""
    if value is UNDEFINED:
        return 0
    return js_json.byte_length(value)


def json_text_bytes(text: str) -> int:
    """UTF-8 size of a string as it appears inside JSON (escaped, without quotes)."""
    return max(0, json_bytes(text) - 2)


def utf8_bytes(text: str) -> int:
    return len(well_formed(text).encode("utf-8", "surrogatepass"))


_HIGH = re.compile("[\ud800-\udbff]")
_LOW = re.compile("[\udc00-\udfff]")


def head_within_bytes_u16(text: str, max_bytes: float) -> str:
    """``headWithinBytes`` on a UTF-16 form string; returns UTF-16 form."""
    if max_bytes <= 0:
        return ""
    if json_text_bytes(text) <= max_bytes:
        return text
    low = 0
    high = len(text)
    while low < high:
        middle = math.ceil((low + high) / 2)
        if json_text_bytes(text[:middle]) <= max_bytes:
            low = middle
        else:
            high = middle - 1
    # Never split a surrogate pair.
    end = low - 1 if low > 0 and _HIGH.fullmatch(text[low - 1]) else low
    return text[:end]


def tail_within_bytes_u16(text: str, max_bytes: float) -> str:
    if max_bytes <= 0:
        return ""
    if json_text_bytes(text) <= max_bytes:
        return text
    low = 0
    high = len(text)
    while low < high:
        middle = math.ceil((low + high) / 2)
        if json_text_bytes(text[len(text) - middle :]) <= max_bytes:
            low = middle
        else:
            high = middle - 1
    start = len(text) - low
    safe_start = start + 1 if start < len(text) and _LOW.fullmatch(text[start]) else start
    return text[safe_start:]


def head_within_bytes(text: str, max_bytes: float) -> str:
    """The longest prefix of ``text`` whose JSON-escaped size fits in ``max_bytes``."""
    return well_formed(head_within_bytes_u16(utf16(text), max_bytes))


def tail_within_bytes(text: str, max_bytes: float) -> str:
    """The longest suffix of ``text`` whose JSON-escaped size fits in ``max_bytes``."""
    return well_formed(tail_within_bytes_u16(utf16(text), max_bytes))


DEFAULT_BYTES_PER_TOKEN = 4


class TokenEstimator:
    """Estimates tokens from JSON bytes, calibrated from reported input tokens."""

    def __init__(self) -> None:
        self._bytes_per_token: float = DEFAULT_BYTES_PER_TOKEN
        self._calibrated = False

    @property
    def bytes_per_token(self) -> float:
        return self._bytes_per_token

    @property
    def calibrated(self) -> bool:
        return self._calibrated

    def observe(self, request_bytes: float, input_tokens: Any) -> None:
        if (
            input_tokens is None
            or isinstance(input_tokens, bool)
            or not isinstance(input_tokens, (int, float))
            or not math.isfinite(input_tokens)
            or input_tokens <= 0
            or request_bytes <= 0
        ):
            return
        # JSON framing inflates bytes; clamp to plausible tokenizer ratios.
        self._bytes_per_token = js_json.normalize(min(12, max(1.5, request_bytes / input_tokens)))
        self._calibrated = True

    def tokens(self, byte_count: float) -> int:
        return math.ceil(byte_count / self._bytes_per_token)

    def bytes(self, tokens: float) -> int:
        return math.floor(tokens * self._bytes_per_token)
