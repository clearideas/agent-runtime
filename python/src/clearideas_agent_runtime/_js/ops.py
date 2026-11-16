"""JavaScript operator semantics for JSON values (used by JEXL conditions).

Implements ToBoolean, ToNumber, ToString, ToPrimitive, loose and strict
equality, relational comparison, and arithmetic exactly as ECMAScript defines
them for the value kinds a variable state can hold.
"""

from __future__ import annotations

import math
import operator
import re
from collections.abc import Callable
from typing import Any

from .json import number_to_string
from .strings import JS_WHITESPACE, code_unit_key


class _Undefined:
    __slots__ = ()
    _instance: _Undefined | None = None

    def __new__(cls) -> _Undefined:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "undefined"

    def __bool__(self) -> bool:
        return False


UNDEFINED = _Undefined()


def is_nullish(value: Any) -> bool:
    return value is None or value is UNDEFINED


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def truthy(value: Any) -> bool:
    """``Boolean(value)``."""
    if value is None or value is UNDEFINED or value is False:
        return False
    if value is True:
        return True
    if is_number(value):
        return not (value == 0 or (isinstance(value, float) and math.isnan(value)))
    if isinstance(value, str):
        return value != ""
    return True


def _int_if_integral(value: float | int) -> float | int:
    if isinstance(value, float) and value.is_integer() and abs(value) <= 2**53 - 1:
        return int(value)
    return value


_DECIMAL = re.compile(r"^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity)$")


def to_number(value: Any) -> int | float:
    if value is None or value is False:
        return 0
    if value is True:
        return 1
    if value is UNDEFINED:
        return math.nan
    if is_number(value):
        return value
    if isinstance(value, str):
        text = value.strip(JS_WHITESPACE)
        if text == "":
            return 0
        lowered = text[:2].lower()
        try:
            if lowered == "0x":
                return int(text[2:], 16)
            if lowered == "0o":
                return int(text[2:], 8)
            if lowered == "0b":
                return int(text[2:], 2)
        except ValueError:
            return math.nan
        if _DECIMAL.fullmatch(text):
            if text.lstrip("+-") == "Infinity":
                return -math.inf if text.startswith("-") else math.inf
            return _int_if_integral(float(text))
        return math.nan
    return to_number(to_primitive(value))


def to_string(value: Any) -> str:
    if value is None:
        return "null"
    if value is UNDEFINED:
        return "undefined"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if is_number(value):
        return number_to_string(value)
    if isinstance(value, str):
        return value
    return to_primitive(value)


def to_primitive(value: Any) -> Any:
    if isinstance(value, list):
        return ",".join("" if is_nullish(item) else to_string(item) for item in value)
    if isinstance(value, dict):
        return "[object Object]"
    return value


def strict_equals(left: Any, right: Any) -> bool:
    if is_number(left) and is_number(right):
        return left == right
    if left is UNDEFINED or right is UNDEFINED:
        return left is right
    if type(left) is not type(right):
        return False
    if isinstance(left, (list, dict)):
        return left is right
    return left == right


def loose_equals(left: Any, right: Any) -> bool:
    if is_nullish(left) or is_nullish(right):
        return is_nullish(left) and is_nullish(right)
    if (is_number(left) and is_number(right)) or type(left) is type(right):
        return strict_equals(left, right)
    if isinstance(left, bool):
        return loose_equals(int(left), right)
    if isinstance(right, bool):
        return loose_equals(left, int(right))
    if is_number(left) and isinstance(right, str):
        return left == to_number(right)
    if isinstance(left, str) and is_number(right):
        return to_number(left) == right
    if isinstance(left, (list, dict)) and not isinstance(right, (list, dict)):
        return loose_equals(to_primitive(left), right)
    if isinstance(right, (list, dict)) and not isinstance(left, (list, dict)):
        return loose_equals(left, to_primitive(right))
    return False


def compare(left: Any, right: Any, op: Callable[[Any, Any], bool]) -> bool:
    left, right = to_primitive(left), to_primitive(right)
    if isinstance(left, str) and isinstance(right, str):
        return op(code_unit_key(left), code_unit_key(right))
    a, b = to_number(left), to_number(right)
    if math.isnan(a) or math.isnan(b):
        return False
    return op(a, b)


def less_than(left: Any, right: Any) -> bool:
    return compare(left, right, operator.lt)


def add(left: Any, right: Any) -> Any:
    left, right = to_primitive(left), to_primitive(right)
    if isinstance(left, str) or isinstance(right, str):
        return to_string(left) + to_string(right)
    return _int_if_integral(to_number(left) + to_number(right))


def subtract(left: Any, right: Any) -> Any:
    return _int_if_integral(to_number(left) - to_number(right))


def multiply(left: Any, right: Any) -> Any:
    a, b = to_number(left), to_number(right)
    try:
        return _int_if_integral(a * b)
    except OverflowError:
        return math.inf if (a > 0) == (b > 0) else -math.inf


def divide(left: Any, right: Any) -> Any:
    a, b = to_number(left), to_number(right)
    if math.isnan(a) or math.isnan(b):
        return math.nan
    if b == 0:
        if a == 0:
            return math.nan
        negative_zero = math.copysign(1, b) < 0
        return math.copysign(math.inf, a) * (-1 if negative_zero else 1)
    return _int_if_integral(a / b)


def remainder(left: Any, right: Any) -> Any:
    a, b = to_number(left), to_number(right)
    if b == 0 or math.isinf(a) or math.isnan(a) or math.isnan(b):
        return math.nan
    if math.isinf(b):
        return a
    return _int_if_integral(math.fmod(a, b))


def power(left: Any, right: Any) -> Any:
    """``Math.pow``."""
    a, b = to_number(left), to_number(right)
    if math.isnan(b):
        return math.nan
    if b == 0:
        return 1
    if math.isnan(a):
        return math.nan
    if abs(a) == 1 and math.isinf(b):
        return math.nan
    try:
        return _int_if_integral(math.pow(a, b))
    except (OverflowError, ValueError):
        integral_exponent = float(b).is_integer()
        odd = integral_exponent and int(b) % 2 == 1
        if a == 0:
            if b < 0:
                return -math.inf if odd and math.copysign(1, a) < 0 else math.inf
            return 0
        if a < 0:
            if not integral_exponent:
                return math.nan
            return -math.inf if odd else math.inf
        return math.inf


def floor(value: Any) -> Any:
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return value
    return math.floor(value)
