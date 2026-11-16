"""Variable state paths and patches (``packages/core/src/state.ts``)."""

from __future__ import annotations

import copy
from typing import Any

from .._js import strings as js_strings
from .._js.errors import Error
from ..contracts import is_safe_variable_path


def _segments(path: str) -> list[str]:
    if not is_safe_variable_path(path):
        raise Error(f"Unsafe variable path: {path}")
    return [js_strings.trim(segment) for segment in path.split(".")]


def get_variable_at_path(state: dict[str, Any], path: str) -> Any:
    """Returns the value or ``None`` when absent (JavaScript ``undefined``)."""
    current: Any = state
    for segment in _segments(path):
        if not isinstance(current, dict):
            return None
        if segment not in current:
            return None
        current = current[segment]
    return current


def has_variable_at_path(state: dict[str, Any], path: str) -> bool:
    current: Any = state
    for segment in _segments(path):
        if not isinstance(current, dict) or segment not in current:
            return False
        current = current[segment]
    return True


def set_variable_at_path(state: dict[str, Any], path: str, value: Any) -> None:
    """Mutates a state snapshot at a validated dotted variable path."""
    segments = _segments(path)
    current = state
    for segment in segments[:-1]:
        existing = current.get(segment)
        if not isinstance(existing, dict):
            current[segment] = {}
        current = current[segment]
    current[segments[-1]] = copy.deepcopy(value)


def unset_variable_at_path(state: dict[str, Any], path: str) -> None:
    """Mutates a state snapshot by removing a validated dotted variable path."""
    segments = _segments(path)
    current = state
    for segment in segments[:-1]:
        existing = current.get(segment)
        if not isinstance(existing, dict):
            return
        current = existing
    current.pop(segments[-1], None)


def apply_state_patch(state: dict[str, Any], patch: dict[str, Any] | None = None) -> dict[str, Any]:
    """Applies a top-level variable patch without mutating either input."""
    next_state = copy.deepcopy(state)
    if not patch:
        return next_state
    for name in patch.get("unset") or []:
        unset_variable_at_path(next_state, name)
    for name, value in (patch.get("set") or {}).items():
        set_variable_at_path(next_state, name, value)
    return next_state


def snapshot_state(state: dict[str, Any]) -> dict[str, Any]:
    """A private copy of the state for one step (``Object.freeze(structuredClone(state))``)."""
    return copy.deepcopy(state)
