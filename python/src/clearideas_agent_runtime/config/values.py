"""Environment-backed configuration values (``packages/runtime/src/values.ts``)."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .._js import json as js_json
from .._js.errors import Error


@dataclass
class ValueResolutionContext:
    """``environment`` defaults to ``os.environ``."""

    environment: Mapping[str, str | None] | None = None


def _environment(context: ValueResolutionContext | None) -> Mapping[str, str | None]:
    if context is not None and context.environment is not None:
        return context.environment
    return os.environ


def resolve_environment_reference(
    reference: Mapping[str, Any], context: ValueResolutionContext | None = None, label: str | None = None
) -> str:
    value = _environment(context).get(reference["env"])
    if value is None or len(value) == 0:
        raise Error(
            f"{label if label is not None else reference['env']} requires environment variable {reference['env']}."
        )
    return value


def resolve_value_source(
    source: str | Mapping[str, Any], context: ValueResolutionContext | None = None, label: str = "configuration value"
) -> str:
    if isinstance(source, str):
        return source
    return resolve_environment_reference(source, context, label)


def resolve_headers(
    headers: Mapping[str, Any] | None, context: ValueResolutionContext | None = None
) -> dict[str, str] | None:
    if headers is None:
        return None
    return {
        name: resolve_value_source(value, context, f"Header {name}")
        for name, value in js_json.js_entries(dict(headers))
    }
