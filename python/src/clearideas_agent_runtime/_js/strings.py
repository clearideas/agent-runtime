"""JavaScript string semantics: UTF-16 code-unit lengths and slicing, trim, case."""

from __future__ import annotations

import re

_SURROGATE = re.compile("[\ud800-\udfff]")
_ASTRAL = re.compile("[\U00010000-\U0010ffff]")

# String.prototype.trim: WhiteSpace and LineTerminator code points.
JS_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
    "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def well_formed(text: str) -> str:
    """Join surrogate pairs stored as two code points (as JavaScript sees them)."""
    if not _SURROGATE.search(text):
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def length(text: str) -> int:
    """String.prototype.length (UTF-16 code units)."""
    return len(text) + sum(1 for char in text if ord(char) > 0xFFFF)


def _units(text: str) -> bytes:
    return text.encode("utf-16-le", "surrogatepass")


def _text(units: bytes) -> str:
    return units.decode("utf-16-le", "surrogatepass")


def slice(text: str, start: int, end: int | None = None) -> str:
    """String.prototype.slice with UTF-16 indexes (may split surrogate pairs)."""
    if all(ord(char) <= 0xFFFF for char in text):
        return text[start:end]
    units = _units(text)
    size = len(units) // 2
    begin = _clamp(start, size)
    finish = size if end is None else _clamp(end, size)
    if finish <= begin:
        return ""
    return _text(units[begin * 2 : finish * 2])


def _clamp(index: int, size: int) -> int:
    if index < 0:
        return max(size + index, 0)
    return min(index, size)


def char_code_at(text: str, index: int) -> int | None:
    units = _units(text)
    if index < 0 or index * 2 >= len(units):
        return None
    return int.from_bytes(units[index * 2 : index * 2 + 2], "little")


def char_at(text: str, index: int) -> str:
    code = char_code_at(text, index)
    return "" if code is None else _text(code.to_bytes(2, "little"))


def is_high_surrogate(char: str) -> bool:
    return len(char) == 1 and "\ud800" <= char <= "\udbff"


def is_low_surrogate(char: str) -> bool:
    return len(char) == 1 and "\udc00" <= char <= "\udfff"


def trim(text: str) -> str:
    return text.strip(JS_WHITESPACE)


def trim_start(text: str) -> str:
    return text.lstrip(JS_WHITESPACE)


def trim_end(text: str) -> str:
    return text.rstrip(JS_WHITESPACE)


def lower(text: str) -> str:
    """String.prototype.toLowerCase (Unicode default case mapping)."""
    return text.lower()


def utf8_length(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


def compare_code_units(left: str, right: str) -> int:
    """Default Array.prototype.sort order (UTF-16 code units)."""
    a = _units(well_formed(left))
    b = _units(well_formed(right))
    # Compare as sequences of 16-bit units (big-endian bytes compare correctly).
    a_be = a.decode("utf-16-le", "surrogatepass").encode("utf-16-be", "surrogatepass")
    b_be = b.decode("utf-16-le", "surrogatepass").encode("utf-16-be", "surrogatepass")
    return (a_be > b_be) - (a_be < b_be)


def code_unit_key(text: str) -> bytes:
    return well_formed(text).encode("utf-16-be", "surrogatepass")


def utf16(text: str) -> str:
    """The string as JavaScript stores it: astral characters as surrogate pairs.

    Python ``len``/slicing on the result use UTF-16 code-unit indexes, exactly
    like JavaScript. ``well_formed`` (applied by ``json.stringify``) joins the
    pairs again.
    """
    if not _ASTRAL.search(text):
        return text
    out: list[str] = []
    for char in text:
        code = ord(char)
        if code > 0xFFFF:
            code -= 0x10000
            out.append(chr(0xD800 + (code >> 10)))
            out.append(chr(0xDC00 + (code & 0x3FF)))
        else:
            out.append(char)
    return "".join(out)
