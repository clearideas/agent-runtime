"""JSON.stringify / JSON.parse semantics for JSON values.

Scalars are serialized by ``rfc8785`` (ECMAScript string escaping and number
formatting). Containers follow JavaScript property order: integer-like keys
first in ascending order, then insertion order.
"""

from __future__ import annotations

import copy
import json as _json
import math
import re
from json.encoder import encode_basestring as _encode_basestring  # type: ignore[attr-defined]
from typing import Any

import rfc8785

from .strings import well_formed

MAX_SAFE_INTEGER = 2**53 - 1

JsonValue = Any  # None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]


def is_array_index(key: str) -> bool:
    """True for keys JavaScript orders first: canonical integers below 2**32 - 1."""
    return key.isdigit() and key.isascii() and (key == "0" or key[0] != "0") and int(key) < 2**32 - 1


def js_keys(obj: dict[str, Any]) -> list[str]:
    """Object.keys order for a plain object."""
    index = sorted((key for key in obj if is_array_index(key)), key=int)
    if not index:
        return list(obj)
    return index + [key for key in obj if not is_array_index(key)]


def js_entries(obj: dict[str, Any]) -> list[tuple[str, Any]]:
    return [(key, obj[key]) for key in js_keys(obj)]


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _escape_surrogate(match: re.Match[str]) -> str:
    return f"\\u{ord(match.group()):04x}"


def _string(text: str) -> str:
    """JSON.stringify for a string (well-formed: lone surrogates are escaped).

    The C encoder escapes exactly what JSON.stringify escapes: quotes,
    backslashes, the short control escapes, and other control characters as
    lowercase hexadecimal escapes.
    """
    if _LONE_SURROGATE.search(text) is None:
        return _encode_basestring(text)
    text = well_formed(text)
    return _LONE_SURROGATE.sub(_escape_surrogate, _encode_basestring(text))


def number_to_string(value: int | float) -> str:
    """Number.prototype.toString for finite numbers (as JSON.stringify prints them)."""
    if isinstance(value, bool):
        raise TypeError("booleans are not numbers")
    if isinstance(value, int):
        if abs(value) <= MAX_SAFE_INTEGER:
            return str(value)
        value = float(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    return rfc8785.dumps(value).decode("utf-8")


def _scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return "null"
        return number_to_string(value)
    raise TypeError(f"Value of type {type(value).__name__} is not JSON serializable")


def stringify(value: Any, indent: int | None = None) -> str:
    """JSON.stringify(value) or JSON.stringify(value, null, indent)."""
    if indent:
        return _pretty(value, " " * indent, "")
    if _plain(value):
        # Python's C encoder prints these values exactly as JSON.stringify does.
        return _FAST.encode(value)
    return _compact(value)


_FAST = _json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), check_circular=False)


def _plain(value: Any) -> bool:
    """True when the C encoder's output equals JSON.stringify's for ``value``.

    That holds for strings without lone surrogates, booleans, null, safe
    integers, non-integral floats printed without an exponent by both
    languages, lists, and dictionaries whose keys are not integer-like (so
    insertion order is JavaScript's property order).
    """
    stack = [value]
    search = _LONE_SURROGATE.search
    while stack:
        current = stack.pop()
        kind = type(current)
        if kind is str:
            if search(current):
                return False
        elif kind is dict:
            for key, item in current.items():
                if type(key) is not str or (key and key[0] in "0123456789") or search(key):
                    return False
                stack.append(item)
        elif kind is list or kind is tuple:
            stack.extend(current)
        elif kind is int:
            if not -MAX_SAFE_INTEGER <= current <= MAX_SAFE_INTEGER:
                return False
        elif kind is float:
            magnitude = abs(current)
            if not (1e-4 <= magnitude < 1e16) or current.is_integer():
                return False
        elif current is not None and kind is not bool:
            return False
    return True


def _compact(value: Any) -> str:
    if isinstance(value, dict):
        return "{" + ",".join(_string(key) + ":" + _compact(value[key]) for key in js_keys(value)) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_compact(item) for item in value) + "]"
    return _scalar(value)


def _pretty(value: Any, gap: str, current: str) -> str:
    inner = current + gap
    if isinstance(value, dict):
        if not value:
            return "{}"
        members = [inner + _string(key) + ": " + _pretty(value[key], gap, inner) for key in js_keys(value)]
        return "{\n" + ",\n".join(members) + "\n" + current + "}"
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        items = [inner + _pretty(item, gap, inner) for item in value]
        return "[\n" + ",\n".join(items) + "\n" + current + "]"
    return _scalar(value)


def canonical_json(value: Any) -> str:
    """RFC 8785 canonical JSON, as ``canonicalJson`` in the TypeScript core."""
    if value is None:
        return "null"
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Canonical JSON cannot encode a non-finite number.")
    if isinstance(value, dict):
        keys = sorted(
            (key for key in value if not _is_undefined(value[key])),
            key=lambda key: well_formed(key).encode("utf-16-be", "surrogatepass"),
        )
        return "{" + ",".join(_string(key) + ":" + canonical_json(value[key]) for key in keys) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join("null" if _is_undefined(item) else canonical_json(item) for item in value) + "]"
    if isinstance(value, (bool, int, float, str)):
        return _scalar(value)
    raise ValueError(f"Canonical JSON cannot encode a {type(value).__name__}.")


def _is_undefined(value: Any) -> bool:
    return type(value).__name__ == "_Undefined"


def byte_length(value: Any) -> int:
    """UTF-8 bytes of JSON.stringify(value) (``TextEncoder().encode(...).byteLength``)."""
    return len(stringify(value).encode("utf-8", "surrogatepass"))


def _normalize_scalar(value: Any) -> Any:
    if isinstance(value, float):
        if value.is_integer() and abs(value) <= MAX_SAFE_INTEGER:
            return int(value)
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value if abs(value) <= MAX_SAFE_INTEGER else float(value)
    return value


def normalize(value: Any) -> Any:
    """Give parsed values JavaScript number semantics: one numeric type.

    Integral floats within the safe range become ``int`` and integers beyond it
    become ``float`` (JavaScript stores every number as a double). Containers
    are copied; the walk is iterative, so deeply nested input is safe.
    """
    if not isinstance(value, (dict, list, tuple)):
        return _normalize_scalar(value)
    root: list[Any] = [None]
    stack: list[tuple[Any, Any, Any]] = [(value, root, 0)]
    while stack:
        source, target, slot = stack.pop()
        if isinstance(source, dict):
            copied: Any = {}
            target[slot] = copied
            for key, item in source.items():
                if isinstance(item, (dict, list, tuple)):
                    copied[key] = None
                    stack.append((item, copied, key))
                else:
                    copied[key] = _normalize_scalar(item)
        elif isinstance(source, (list, tuple)):
            copied = [None] * len(source)
            target[slot] = copied
            for index, item in enumerate(source):
                if isinstance(item, (dict, list, tuple)):
                    stack.append((item, copied, index))
                else:
                    copied[index] = _normalize_scalar(item)
        else:
            target[slot] = _normalize_scalar(source)
    return root[0]


def _parse_int(text: str) -> int | float:
    number = int(text)
    return number if abs(number) <= MAX_SAFE_INTEGER else float(text)


def _parse_float(text: str) -> int | float:
    number = float(text)
    if number.is_integer() and abs(number) <= MAX_SAFE_INTEGER:
        return int(number)
    return number


def _parse_constant(name: str) -> Any:
    raise ValueError(f"Unexpected token {name} in JSON")


def parse(text: str | bytes) -> Any:
    """JSON.parse with JavaScript number semantics and key order.

    Invalid input raises ``SyntaxError_`` (a ``ValueError``) with V8's message.
    """
    if isinstance(text, bytes):
        text = text.decode("utf-8")
    try:
        value = _json.loads(
            text,
            parse_int=_parse_int,
            parse_float=_parse_float,
            parse_constant=_parse_constant,
        )
    except ValueError as error:
        from .errors import SyntaxError_
        from .json_syntax import v8_syntax_error

        raise SyntaxError_(v8_syntax_error(text) or str(error)) from None
    return _order(value)


def _order(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _order(value[key]) for key in js_keys(value)}
    if isinstance(value, list):
        return [_order(item) for item in value]
    return value


def clone(value: Any) -> Any:
    """structuredClone for JSON values."""
    return copy.deepcopy(value)


def to_json_value(value: Any) -> Any:
    """JSON.parse(JSON.stringify(value)) for plain data (drops non-JSON members)."""
    return parse(stringify(value))
