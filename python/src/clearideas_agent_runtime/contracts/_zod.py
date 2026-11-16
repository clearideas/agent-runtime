"""Zod 4 semantics on pydantic models.

The TypeScript contracts are Zod schemas. Parsed output, issue objects, issue
order, and error messages are observable (they reach run errors and thrown
``ZodError`` messages), so this module reproduces Zod 4 exactly while pydantic
walks models, lists, and fields:

* ``ZodModel`` is ``z.strictObject``: unknown keys are rejected as one
  ``unrecognized_keys`` issue per object, output keys follow declaration order,
  and ``refine(cls, data)`` runs like ``superRefine`` unless an aborting issue
  occurred (Zod's ``continue`` rule).
* ``string``, ``integer``, ``number``, ``boolean``, ``literal``, ``enum``,
  ``array``, ``record``, ``json_value``, ``union``, ``discriminated``, and
  ``optional`` reproduce the corresponding Zod constructs and their issues.
* ``translate`` converts pydantic's structural errors into Zod issues.

Issues are dictionaries with Zod's key order, so ``json.stringify(issues, 2)``
equals ``ZodError.message``.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import cache
from typing import Annotated, Any, ClassVar, Union, get_args, get_origin

from pydantic import (
    BaseModel,
    ConfigDict,
    TypeAdapter,
    ValidationError,
    WrapValidator,
    model_validator,
)
from pydantic_core import PydanticCustomError

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.url import can_parse

MAX_SAFE = 2**53 - 1
SAFE_NOTE = "Integers must be within the safe integer range."
TAG = "\u00a7"
ABORTING_CODES = frozenset({"invalid_type", "invalid_value", "invalid_union", "invalid_key"})

Issue = dict[str, Any]


class ZodError(ValueError):
    """A failed parse. ``str(error)`` equals Zod's ``ZodError.message``."""

    def __init__(self, issues: list[Issue]) -> None:
        self.issues = issues
        super().__init__(js_json.stringify(issues, 2))

    @property
    def name(self) -> str:
        return "ZodError"


@dataclass
class SafeParseResult:
    success: bool
    data: Any = None
    error: ZodError | None = None


# ─── Issue constructors (Zod key order) ─────────────────────────────────────


def parsed_type(value: Any) -> str:
    if value is _UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "nan" if value != value else "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        return "array"
    if callable(value) and not isinstance(value, (dict, BaseModel)):
        return "function"
    return "object"


def _type_name(kind: str, value: Any = None) -> str:
    if kind == "number" and isinstance(value, float) and value in (float("inf"), float("-inf")):
        return "Infinity" if value > 0 else "-Infinity"
    return "NaN" if kind == "nan" else kind


def _primitive(value: Any) -> str:
    if isinstance(value, str):
        return f'"{value}"'
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    return js_json.number_to_string(value)


def invalid_type(expected: str, value: Any, *, int_format: bool = False) -> Issue:
    received = _type_name(parsed_type(value), value)
    message = f"Invalid input: expected {expected}, received {received}"
    if int_format:
        return {
            "expected": "int",
            "format": "safeint",
            "code": "invalid_type",
            "path": [],
            "message": message,
        }
    return {"expected": expected, "code": "invalid_type", "path": [], "message": message}


def invalid_value(values: Sequence[Any]) -> Issue:
    if len(values) == 1:
        message = f"Invalid input: expected {_primitive(values[0])}"
    else:
        message = "Invalid option: expected one of " + "|".join(_primitive(value) for value in values)
    return {"code": "invalid_value", "values": list(values), "path": [], "message": message}


_SIZING = {
    "string": "characters",
    "array": "items",
    "set": "items",
    "file": "bytes",
    "map": "entries",
}


def _bound(value: Any) -> str:
    return js_json.number_to_string(value)


def too_small(origin: str, minimum: int | float, inclusive: bool) -> Issue:
    adj = ">=" if inclusive else ">"
    unit = _SIZING.get(origin)
    message = (
        f"Too small: expected {origin} to have {adj}{_bound(minimum)} {unit}"
        if unit
        else f"Too small: expected {origin} to be {adj}{_bound(minimum)}"
    )
    return {
        "origin": origin,
        "code": "too_small",
        "minimum": minimum,
        "inclusive": inclusive,
        "path": [],
        "message": message,
    }


def too_big(origin: str, maximum: int | float, inclusive: bool) -> Issue:
    adj = "<=" if inclusive else "<"
    unit = _SIZING.get(origin)
    message = (
        f"Too big: expected {origin} to have {adj}{_bound(maximum)} {unit}"
        if unit
        else f"Too big: expected {origin} to be {adj}{_bound(maximum)}"
    )
    return {
        "origin": origin,
        "code": "too_big",
        "maximum": maximum,
        "inclusive": inclusive,
        "path": [],
        "message": message,
    }


def _safe_range(value: int | float) -> Issue | None:
    if value > MAX_SAFE:
        return {
            "code": "too_big",
            "maximum": MAX_SAFE,
            "note": SAFE_NOTE,
            "origin": "int",
            "inclusive": True,
            "path": [],
            "message": f"Too big: expected int to be <={MAX_SAFE}",
        }
    if value < -MAX_SAFE:
        return {
            "code": "too_small",
            "minimum": -MAX_SAFE,
            "note": SAFE_NOTE,
            "origin": "int",
            "inclusive": True,
            "path": [],
            "message": f"Too small: expected int to be >={-MAX_SAFE}",
        }
    return None


def regex_issue(pattern: str, message: str | None = None) -> Issue:
    return {
        "origin": "string",
        "code": "invalid_format",
        "format": "regex",
        "pattern": pattern,
        "path": [],
        "message": message or f"Invalid string: must match pattern {pattern}",
    }


def unrecognized_keys(keys: list[str]) -> Issue:
    joined = ", ".join(_primitive(key) for key in keys)
    return {
        "code": "unrecognized_keys",
        "keys": keys,
        "path": [],
        "message": f"Unrecognized key{'s' if len(keys) > 1 else ''}: {joined}",
    }


def invalid_union(errors: list[list[Issue]]) -> Issue:
    return {"code": "invalid_union", "errors": errors, "path": [], "message": "Invalid input"}


def custom(
    message: str,
    path: Sequence[Any] | None = None,
    *,
    order: str = "code,path,message",
    fatal: bool = False,
) -> Issue:
    """A custom issue with the key order of the TypeScript ``addIssue`` call.

    ``order`` lists the keys as the TypeScript source wrote them; ``path`` is
    appended when the source omitted it (as Zod does).
    """
    issue: Issue = {}
    for key in order.split(","):
        if key == "code":
            issue["code"] = "custom"
        elif key == "message":
            issue["message"] = message
        elif key == "path":
            issue["path"] = list(path or [])
        elif key == "fatal":
            issue["fatal"] = fatal
    if "path" not in issue:
        issue["path"] = list(path or [])
    return issue


def is_aborting(issue: Issue) -> bool:
    return issue.get("code") in ABORTING_CODES or issue.get("fatal") is True


def any_aborting(issues: Sequence[Issue]) -> bool:
    return any(is_aborting(issue) for issue in issues)


def fail(issues: list[Issue]) -> Any:
    raise PydanticCustomError("zod_issues", "zod issues", {"issues": issues})


class _UndefinedType:
    """JavaScript ``undefined``: the value of a missing key."""

    def __repr__(self) -> str:
        return "undefined"


_UNDEFINED = _UndefinedType()


# ─── Schema metadata: what Zod reports for a missing (undefined) value ──────


@dataclass(frozen=True)
class ZodMeta:
    undefined_issues: Callable[[], list[Issue]]


def _meta_of(annotation: Any) -> ZodMeta | None:
    for item in getattr(annotation, "__metadata__", ()):
        if isinstance(item, ZodMeta):
            return item
    return None


def _strip_annotated(annotation: Any) -> Any:
    while get_origin(annotation) is Annotated:
        annotation = get_args(annotation)[0]
    return annotation


def undefined_issues(annotation: Any) -> list[Issue]:
    """Issues Zod reports when a required value of this schema is missing."""
    meta = _meta_of(annotation)
    if meta is not None:
        return meta.undefined_issues()
    inner = _strip_annotated(annotation)
    if isinstance(inner, type) and issubclass(inner, BaseModel):
        return [invalid_type("object", _UNDEFINED)]
    origin = get_origin(inner)
    if origin is list or inner is list:
        return [invalid_type("array", _UNDEFINED)]
    if origin is dict or inner is dict:
        return [invalid_type("record", _UNDEFINED)]
    return [invalid_type("unknown", _UNDEFINED)]


# ─── Scalars ────────────────────────────────────────────────────────────────


def _prefix(issues: list[Issue], path: Sequence[Any]) -> list[Issue]:
    for issue in issues:
        issue["path"][:0] = list(path)
    return issues


def string(
    *,
    trim: bool = False,
    min: int | None = None,
    max: int | None = None,
    regex: tuple[str, str | None] | None = None,
    url: bool = False,
    datetime: bool = False,
    refine: Sequence[tuple[Callable[[str], bool], str]] = (),
) -> Any:
    """``z.string()`` with ``.trim()``, ``.min()``, ``.max()``, ``.regex()``, ``z.url()``,
    ``z.iso.datetime({offset: true})``, and ``.refine()`` checks, in that order."""
    compiled = re.compile(_python_regex(regex[0])) if regex else None

    def check(value: Any) -> Any:
        if not isinstance(value, str):
            issues = [invalid_type("string", value)]
            # Zod still runs length checks on values with a length.
            if isinstance(value, list):
                if min is not None and len(value) < min:
                    issues.append(too_small("array", min, True))
                if max is not None and len(value) > max:
                    issues.append(too_big("array", max, True))
            fail(issues)
        if trim:
            value = js_strings.trim(value)  # pyright: ignore[reportArgumentType]
        issues: list[Issue] = []
        size = js_strings.length(value)  # pyright: ignore[reportArgumentType]
        if min is not None and size < min:
            issues.append(too_small("string", min, True))
        if max is not None and size > max:
            issues.append(too_big("string", max, True))
        if compiled is not None and regex is not None and not compiled.search(value):  # pyright: ignore[reportCallIssue, reportArgumentType]
            issues.append(regex_issue(regex[0], regex[1]))
        if url and not can_parse(value):  # pyright: ignore[reportArgumentType]
            issues.append({"code": "invalid_format", "format": "url", "path": [], "message": "Invalid URL"})
        if datetime and not _DATETIME.fullmatch(value):  # pyright: ignore[reportCallIssue, reportArgumentType]
            issues.append(
                {
                    "origin": "string",
                    "code": "invalid_format",
                    "format": "datetime",
                    "pattern": DATETIME_PATTERN,
                    "path": [],
                    "message": "Invalid ISO datetime",
                }
            )
        for predicate, message in refine:
            if not predicate(value):  # pyright: ignore[reportArgumentType]
                issues.append(custom(message))
        if issues:
            fail(issues)
        return value

    return Annotated[
        str,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_type("string", _UNDEFINED)]),
    ]


def _python_regex(js_pattern: str) -> str:
    """``/source/flags`` → Python pattern (only the subset used by the contracts)."""
    source = js_pattern[1 : js_pattern.rindex("/")]
    # JavaScript `$` (without the m flag) matches only at the very end; Python's `$` also
    # matches before a final newline.
    if source.endswith("$") and not source.endswith("\\$"):
        source = source[:-1] + r"\Z"
    return source


DATETIME_PATTERN = (
    r"/^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))"
    r"T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/"
)
_DATETIME = re.compile(DATETIME_PATTERN[1:-1], re.ASCII)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _number_checks(value: int | float, gt: Any, ge: Any, lt: Any, le: Any) -> list[Issue]:
    issues: list[Issue] = []
    if gt is not None and not value > gt:
        issues.append(too_small("number", gt, False))
    if ge is not None and not value >= ge:
        issues.append(too_small("number", ge, True))
    if lt is not None and not value < lt:
        issues.append(too_big("number", lt, False))
    if le is not None and not value <= le:
        issues.append(too_big("number", le, True))
    return issues


def integer(*, gt: Any = None, ge: Any = None, lt: Any = None, le: Any = None, safe: bool = False) -> Any:
    """``z.number().int()`` plus bounds (and ``.safe()``)."""

    def check(value: Any) -> Any:
        if not _is_number(value) or value != value or value in (float("inf"), float("-inf")):
            fail([invalid_type("number", value)])
        if isinstance(value, float) and not value.is_integer():
            fail([invalid_type("int", value, int_format=True)])
        issues: list[Issue] = []
        safe_issue = _safe_range(value)
        if safe_issue is not None:
            issues.append(safe_issue)
        issues += _number_checks(value, gt, ge, lt, le)
        if safe and safe_issue is not None:
            # ``.safe()`` repeats the safe-integer range check after the bounds.
            issues.append(dict(safe_issue, path=[]))
        if issues:
            fail(issues)
        return js_json.normalize(value)

    return Annotated[
        int,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_type("number", _UNDEFINED)]),
    ]


def number(*, gt: Any = None, ge: Any = None, lt: Any = None, le: Any = None) -> Any:
    """``z.number()`` plus bounds."""

    def check(value: Any) -> Any:
        if not _is_number(value) or value != value or value in (float("inf"), float("-inf")):
            fail([invalid_type("number", value)])
        issues = _number_checks(value, gt, ge, lt, le)
        if issues:
            fail(issues)
        return js_json.normalize(value)

    return Annotated[
        float,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_type("number", _UNDEFINED)]),
    ]


def boolean() -> Any:
    def check(value: Any) -> Any:
        if not isinstance(value, bool):
            fail([invalid_type("boolean", value)])
        return value

    return Annotated[
        bool,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_type("boolean", _UNDEFINED)]),
    ]


def literal(*values: Any) -> Any:
    """``z.literal`` / ``z.enum``: one issue listing the allowed values."""

    def check(value: Any) -> Any:
        if not any(type(value) is type(allowed) and value == allowed for allowed in values):
            fail([invalid_value(values)])
        return value

    return Annotated[
        Any,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_value(values)]),
    ]


enum = literal


def unknown() -> Any:
    return Annotated[Any, WrapValidator(lambda value, _handler: js_json.clone(value)), ZodMeta(lambda: [])]


# ─── JSON values ────────────────────────────────────────────────────────────

_JSON_BRANCHES = ("string", "number", "boolean", "null", "array", "record")


def _json_union_issue(
    value: Any,
    errors_for_array: list[Issue] | None = None,
    errors_for_record: list[Issue] | None = None,
) -> Issue:
    errors: list[list[Issue]] = []
    for kind in _JSON_BRANCHES:
        if kind == "array" and errors_for_array is not None:
            errors.append(errors_for_array)
        elif kind == "record" and errors_for_record is not None:
            errors.append(errors_for_record)
        else:
            errors.append([invalid_type(kind, value)])
    return invalid_union(errors)


def _json_copy(value: Any) -> tuple[Any, list[Issue]]:
    """Validates ``jsonValueSchema`` and returns (copy, issues)."""
    if value is None or isinstance(value, (bool, str)):
        return value, []
    if _is_number(value):
        if value != value or value in (float("inf"), float("-inf")):
            return None, [_json_union_issue(value)]
        return js_json.normalize(value), []
    if isinstance(value, (list, tuple)):
        items: list[Any] = []
        nested: list[Issue] = []
        for index, item in enumerate(value):
            copied, issues = _json_copy(item)
            items.append(copied)
            nested += _prefix(issues, [index])
        if nested:
            return None, [
                _json_union_issue(
                    value,
                    errors_for_array=nested,
                    errors_for_record=[invalid_type("record", value)],
                )
            ]
        return items, []
    if isinstance(value, dict):
        copied_dict, issues = _json_record(value)
        if issues:
            return None, [_json_union_issue(value, errors_for_record=issues)]
        return copied_dict, []
    return None, [_json_union_issue(value)]


def _json_record(value: dict[Any, Any]) -> tuple[dict[str, Any], list[Issue]]:
    result: dict[str, Any] = {}
    issues: list[Issue] = []
    for key, item in value.items():
        if not isinstance(key, str):
            issues.append(
                {
                    "code": "invalid_key",
                    "origin": "record",
                    "issues": [invalid_type("string", key)],
                    "path": [key],
                    "message": "Invalid key in record",
                }
            )
            continue
        copied, nested = _json_copy(item)
        result[key] = copied
        issues += _prefix(nested, [key])
    return result, issues


def json_value() -> Any:
    """``jsonValueSchema`` (returns a copy, as Zod does)."""

    def check(value: Any) -> Any:
        copied, issues = _json_copy(value)
        if issues:
            fail(issues)
        return copied

    return Annotated[
        Any,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [_json_union_issue(_UNDEFINED)]),
    ]


def json_object() -> Any:
    """``jsonObjectSchema`` (``z.record(z.string(), jsonValueSchema)``)."""

    def check(value: Any) -> Any:
        if not isinstance(value, dict):
            fail([invalid_type("record", value)])
        copied, issues = _json_record(value)
        if issues:
            fail(issues)
        return copied

    return Annotated[
        dict[str, Any],
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_type("record", _UNDEFINED)]),
    ]


# ─── Containers and combinators ─────────────────────────────────────────────


@cache
def _adapter(annotation: Any) -> TypeAdapter[Any]:
    return TypeAdapter(annotation)


def validate(annotation: Any, value: Any) -> tuple[Any, list[Issue]]:
    """Validates ``value`` against an annotation; returns (output, issues)."""
    try:
        return _dump(_adapter(annotation).validate_python(value)), []
    except ValidationError as error:
        return None, translate(error, annotation)


def _dump(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="python", exclude_unset=True, by_alias=True)
    if isinstance(value, list):
        return [_dump(item) for item in value]
    if isinstance(value, dict):
        return {key: _dump(item) for key, item in value.items()}
    return value


def array(item: Any, *, min: int | None = None, refine: Callable[[list[Any]], list[Issue]] | None = None) -> Any:
    """``z.array(item)`` with ``.min()`` and ``.superRefine()``: element issues, then checks."""

    def check(value: Any) -> Any:
        if not isinstance(value, list):
            issues = [invalid_type("array", value)]
            # Zod still runs the length check on other values with a length.
            if isinstance(value, str) and min is not None and js_strings.length(value) < min:
                issues.append(too_small("string", min, True))
            fail(issues)
        output: list[Any] = []
        issues: list[Issue] = []
        for index, element in enumerate(value):
            parsed, nested = validate(item, element)
            output.append(parsed)
            issues += _prefix(nested, [index])
        if min is not None and not any_aborting(issues) and len(value) < min:
            issues.append(too_small("array", min, True))
        if refine is not None and not any_aborting(issues):
            issues += refine(output if not issues else [js_json.normalize(element) for element in value])
        if issues:
            fail(issues)
        return output

    return Annotated[
        list[Any],
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_type("array", _UNDEFINED)]),
    ]


def record(key: Any, value_type: Any) -> Any:
    """``z.record(key, value)``: invalid keys are ``invalid_key`` issues; keys keep
    their parsed (for example trimmed) form."""

    def check(value: Any) -> Any:
        if not isinstance(value, dict):
            fail([invalid_type("record", value)])
        output: dict[str, Any] = {}
        issues: list[Issue] = []
        for raw_key, item in value.items():
            parsed_key, key_issues = validate(key, raw_key)
            if key_issues:
                issues.append(
                    {
                        "code": "invalid_key",
                        "origin": "record",
                        "issues": key_issues,
                        "path": [raw_key],
                        "message": "Invalid key in record",
                    }
                )
                continue
            parsed, nested = validate(value_type, item)
            output[parsed_key] = parsed
            issues += _prefix(nested, [raw_key])
        if issues:
            fail(issues)
        return output

    return Annotated[
        dict[str, Any],
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_type("record", _UNDEFINED)]),
    ]


def union(*options: Any) -> Any:
    """``z.union`` (Zod 4): the first option without issues wins; if exactly one
    option did not abort, its result is reported; otherwise ``invalid_union``."""

    def check(value: Any) -> Any:
        results = [validate(option, value) for option in options]
        for parsed, issues in results:
            if not issues:
                return parsed
        nonaborted = [issues for _, issues in results if not any_aborting(issues)]
        if len(nonaborted) == 1:
            fail(nonaborted[0])
        fail([invalid_union([issues for _, issues in results])])

    return Annotated[
        Any,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_union([undefined_issues(option) for option in options])]),
    ]


def discriminated(key: str, *models: type[ZodModel]) -> Any:
    """``z.discriminatedUnion(key, models)``."""
    tags: dict[str, type[ZodModel]] = {}
    for model in models:
        (tag_value,) = _literal_values(field_annotation(model.model_fields[key]))
        tags[tag_value] = model
    options = list(tags)

    def no_match() -> Issue:
        expected = " | ".join(f"'{tag}'" for tag in options)
        return {
            "code": "invalid_union",
            "errors": [],
            "note": "No matching discriminator",
            "discriminator": key,
            "options": options,
            "path": [key],
            "message": f"Invalid discriminator value. Expected {expected}",
        }

    def check(value: Any) -> Any:
        if not isinstance(value, dict):
            issue = invalid_type("object", value)
            fail(
                [
                    {
                        "code": "invalid_type",
                        "expected": "object",
                        "path": [],
                        "message": issue["message"],
                    }
                ]
            )
        tag = value.get(key, _UNDEFINED)
        if not isinstance(tag, str) or tag not in tags:
            fail([no_match()])
        parsed, issues = validate(tags[tag], value)
        if issues:
            fail(issues)
        return parsed

    return Annotated[
        Any,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: [invalid_type("object", _UNDEFINED)]),
    ]


def field_annotation(field: Any) -> Any:
    """A model field's annotation including the metadata pydantic moved to ``field.metadata``."""
    if field.metadata:
        return Annotated[(field.annotation, *field.metadata)]  # type: ignore[valid-type]
    return field.annotation


def _literal_values(annotation: Any) -> tuple[Any, ...]:
    for item in getattr(annotation, "__metadata__", ()):
        values = getattr(item, "values", None)
        if values:
            return tuple(values)
    raise TypeError("discriminator fields must use tag()")


@dataclass(frozen=True)
class _TagValues:
    values: tuple[Any, ...]


def tag(value: str) -> Any:
    """A discriminator field: ``z.literal(value)``."""
    base = literal(value)
    return Annotated[base, _TagValues((value,))]


def optional(annotation: Any) -> Any:
    """``.optional()``: the key may be absent; ``null`` is still invalid."""

    def check(value: Any) -> Any:
        parsed, issues = validate(annotation, value)
        if issues:
            fail(issues)
        return parsed

    return Annotated[Any, WrapValidator(lambda value, _handler: check(value))]


def lazy(factory: Callable[[], Any]) -> Any:
    """``z.lazy``: resolves the annotation on first use."""

    def check(value: Any) -> Any:
        parsed, issues = validate(factory(), value)
        if issues:
            fail(issues)
        return parsed

    return Annotated[
        Any,
        WrapValidator(lambda value, _handler: check(value)),
        ZodMeta(lambda: undefined_issues(factory())),
    ]


# ─── Objects ────────────────────────────────────────────────────────────────


class ZodModel(BaseModel):
    """``z.strictObject``. Subclasses may define ``refine(cls, data) -> list[Issue]``."""

    model_config = ConfigDict(extra="forbid", strict=True, arbitrary_types_allowed=True)
    __zod_defaults__: ClassVar[tuple[str, ...]] = ()

    @model_validator(mode="wrap")
    @classmethod
    def _zod_object(cls, data: Any, handler: Any) -> Any:
        preprocess = cls.__dict__.get("preprocess")
        if preprocess is not None:
            data = preprocess.__func__(cls, data)
        if not isinstance(data, dict):
            fail([invalid_type("object", data)])
        refine = cls.__dict__.get("refine")
        try:
            model = handler(data)
        except ValidationError as error:
            issues = translate(error, cls)
            if refine is not None and not any_aborting(issues):
                issues += refine.__func__(cls, js_json.normalize(data))
            fail(issues)
        for name in cls.__zod_defaults__:
            model.model_fields_set.add(name)  # pyright: ignore[reportPossiblyUnboundVariable]
        if refine is not None:
            extra = refine.__func__(cls, model.model_dump(mode="python", exclude_unset=True, by_alias=True))  # pyright: ignore[reportPossiblyUnboundVariable]
            if extra:
                fail(extra)
        return model  # pyright: ignore[reportPossiblyUnboundVariable]

    def to_data(self) -> dict[str, Any]:
        return self.model_dump(mode="python", exclude_unset=True, by_alias=True)

    @classmethod
    def __pydantic_init_subclass__(cls, **kwargs: Any) -> None:
        super().__pydantic_init_subclass__(**kwargs)
        cls.__zod_defaults__ = tuple(
            name for name, field in cls.model_fields.items() if not field.is_required() and field.default is not None
        )


# ─── pydantic error translation ─────────────────────────────────────────────


def _annotation_at(root: Any, loc: Sequence[Any]) -> Any:
    annotation = root
    for segment in loc:
        annotation = _strip_annotated(annotation)
        if isinstance(segment, str) and segment.startswith(TAG):
            continue
        if isinstance(annotation, type) and issubclass(annotation, BaseModel) and segment in annotation.model_fields:
            annotation = field_annotation(annotation.model_fields[segment])
        elif get_origin(annotation) is list:
            annotation = get_args(annotation)[0]
        elif get_origin(annotation) is dict:
            annotation = get_args(annotation)[1]
        elif get_origin(annotation) is Union:
            continue
    return annotation


_TYPE_ERRORS = {
    "model_type": "object",
    "model_attributes_type": "object",
    "dict_type": "record",
    "list_type": "array",
    "string_type": "string",
    "bool_type": "boolean",
    "int_type": "number",
    "float_type": "number",
}


def translate(error: ValidationError, root: Any = None) -> list[Issue]:
    issues: list[Issue] = []
    unknown: dict[tuple[Any, ...], Issue] = {}
    for detail in error.errors(include_url=False, include_context=True):
        raw_loc = detail["loc"]
        loc = [segment for segment in raw_loc if not (isinstance(segment, str) and segment.startswith(TAG))]
        kind = detail["type"]
        context = detail.get("ctx") or {}
        if kind == "zod_issues":
            issues += _prefix([_copy_issue(issue) for issue in context["issues"]], loc)
        elif kind == "extra_forbidden":
            parent = tuple(loc[:-1])
            if parent not in unknown:
                unknown[parent] = {
                    "code": "unrecognized_keys",
                    "keys": [],
                    "path": list(parent),
                    "message": "",
                }
                issues.append(unknown[parent])
            unknown[parent]["keys"].append(loc[-1])
        elif kind == "missing":
            annotation = _annotation_at(root, raw_loc) if root is not None else None
            issues += _prefix(undefined_issues(annotation), loc)
        elif kind in _TYPE_ERRORS:
            issues += _prefix([invalid_type(_TYPE_ERRORS[kind], detail.get("input"))], loc)
        else:
            issues += _prefix([custom(detail["msg"])], loc)
    for issue in unknown.values():
        issue["message"] = unrecognized_keys(issue["keys"])["message"]
    return issues


def _copy_issue(issue: Issue) -> Issue:
    copied = dict(issue)
    copied["path"] = list(issue.get("path", []))
    return copied


# ─── Parsing API ────────────────────────────────────────────────────────────


def safe_parse(annotation: Any, value: Any) -> SafeParseResult:
    parsed, issues = validate(annotation, js_json.normalize(value))
    if issues:
        return SafeParseResult(False, None, ZodError(issues))
    return SafeParseResult(True, parsed, None)


def parse(annotation: Any, value: Any) -> Any:
    result = safe_parse(annotation, value)
    if not result.success:
        assert result.error is not None
        raise result.error
    return result.data
