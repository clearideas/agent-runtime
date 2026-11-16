"""The shape Zod gives parsed provider data.

The AI SDK parses provider responses with Zod schemas and passes parts of the
parsed value on (usage as ``raw``, logprobs, annotations, ...). ``z.object``
drops unknown keys and orders known keys by the schema; ``z.looseObject``
keeps unknown keys after the known ones; intersections with a record keep the
input order. ``shape`` reproduces that for the schemas whose output reaches a
``ModelResult``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Obj:
    fields: tuple[tuple[str, Any], ...]
    loose: bool = False


@dataclass(frozen=True)
class Arr:
    item: Any


def obj(*fields: tuple[str, Any] | str) -> Obj:
    """``z.object``: known keys in schema order; unknown keys dropped."""
    return Obj(tuple((field, None) if isinstance(field, str) else field for field in fields))


def loose(*fields: tuple[str, Any] | str) -> Obj:
    """``z.looseObject``: known keys in schema order, then unknown keys in input order."""
    return Obj(tuple((field, None) if isinstance(field, str) else field for field in fields), loose=True)


def arr(item: Any) -> Arr:
    return Arr(item)


def shape(value: Any, spec: Any) -> Any:
    """``value`` as Zod outputs it for ``spec`` (``None``: the value as received)."""
    if spec is None or value is None:
        return value
    if isinstance(spec, Arr):
        return [shape(item, spec.item) for item in value] if isinstance(value, list) else value
    if isinstance(spec, Obj):
        if not isinstance(value, dict):
            return value
        result: dict[str, Any] = {}
        known = set()
        for name, field_spec in spec.fields:
            known.add(name)
            if name in value:
                result[name] = shape(value[name], field_spec)
        if spec.loose:
            for name, item in value.items():
                if name not in known:
                    result[name] = item
        return result
    return value
