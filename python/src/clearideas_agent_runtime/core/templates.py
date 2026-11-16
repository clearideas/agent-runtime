"""``{{ path }}`` prompt templates (``packages/core/src/templates.ts``)."""

from __future__ import annotations

import re
from typing import Any

from .._js import json as js_json
from .._js import ops as js_ops
from .._js import strings as js_strings
from .._js.regex import WS

TEMPLATE_PATTERN = re.compile(r"\{\{" + WS + r"*([^}]+?)" + WS + r"*\}\}")


def get_nested_value(variables: dict[str, Any], path: str) -> Any:
    """Case-insensitive dotted lookup; ``js_ops.UNDEFINED`` when absent."""
    current: Any = variables
    for segment in path.split("."):
        if not isinstance(current, dict):
            return js_ops.UNDEFINED
        lower = js_strings.lower(segment)
        key = next((candidate for candidate in js_json.js_keys(current) if js_strings.lower(candidate) == lower), None)
        if key is None:
            return js_ops.UNDEFINED
        current = current[key]
    return current


def _stringify_template_value(value: Any) -> str:
    if value is None or value is js_ops.UNDEFINED:
        return ""
    if isinstance(value, (dict, list)):
        return js_json.stringify(value)
    return js_ops.to_string(value)


def compile_prompt_template(template: str, variables: dict[str, Any]) -> str:
    return TEMPLATE_PATTERN.sub(
        lambda match: _stringify_template_value(get_nested_value(variables, js_strings.trim(match.group(1)))),
        template,
    )
