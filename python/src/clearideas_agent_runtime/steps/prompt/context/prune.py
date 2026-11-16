"""Deterministic, model-free reduction (``context/prune.ts``).

Every function is pure: the same input and budget always produce the same
output, so a pruned view can be rebuilt identically on resume.
"""

from __future__ import annotations

import copy
import math
from collections.abc import Callable
from typing import Any

from ...._js import json as js_json
from ...._js.strings import utf16, well_formed
from .measure import head_within_bytes_u16, json_bytes, json_text_bytes, tail_within_bytes_u16

JsonObject = dict[str, Any]


def _omission_marker(omitted_characters: int, label: str | None = None) -> str:
    suffix = f" of {label}" if label else ""
    return f"\n…[agent-runtime omitted {omitted_characters} characters{suffix} to fit the context window]…\n"


def prune_text(text: str, max_bytes: float, label: str | None = None) -> str:
    """Keep the beginning (70%) and end (30%) of ``text`` within ``max_bytes``."""
    if json_text_bytes(text) <= max_bytes:
        return text
    units = utf16(text)
    marker = _omission_marker(len(units), label)
    available = max_bytes - json_text_bytes(marker)
    if available <= 16:
        return well_formed(head_within_bytes_u16(utf16(marker.strip()), max_bytes))
    head = head_within_bytes_u16(units, math.floor(available * 0.7))
    tail = tail_within_bytes_u16(units[len(head) :], available - json_text_bytes(head))
    omitted = len(units) - len(head) - len(tail)
    return well_formed(f"{head}{_omission_marker(omitted, label)}{tail}")


class _Leaf:
    __slots__ = ("kind", "set", "size", "value")

    def __init__(self, kind: str, size: int, setter: Callable[[Any], None], value: Any) -> None:
        self.kind = kind
        self.size = size
        self.set = setter
        self.value = value


def _collect_leaves(value: Any, setter: Callable[[Any], None], leaves: list[_Leaf]) -> None:
    if isinstance(value, str):
        leaves.append(_Leaf("string", json_bytes(value), setter, value))
        return
    if isinstance(value, list):
        leaves.append(_Leaf("array", json_bytes(value), setter, value))
        for index, item in enumerate(value):
            _collect_leaves(item, _item_setter(value, index), leaves)
        return
    if isinstance(value, dict):
        for key in js_json.js_keys(value):
            _collect_leaves(value[key], _item_setter(value, key), leaves)


def _item_setter(container: Any, key: Any) -> Callable[[Any], None]:
    def setter(next_value: Any) -> None:
        container[key] = next_value

    return setter


def _prune_array(items: list[Any], max_bytes: float) -> list[Any]:
    if json_bytes(items) <= max_bytes or len(items) <= 1:
        return items
    keep = len(items) - 1
    while keep > 0:
        head = math.ceil(keep * 0.7)
        tail = keep - head
        candidate = [
            *items[:head],
            f"…[agent-runtime omitted {len(items) - keep} of {len(items)} items]…",
            *items[len(items) - tail :],
        ]
        if json_bytes(candidate) <= max_bytes:
            return candidate
        keep = math.floor(keep * 0.75) if keep > 16 else keep - 1
    return [f"…[agent-runtime omitted all {len(items)} items]…"]


def prune_json(value: Any, max_bytes: float) -> str:
    """Reduce a JSON value to at most ``max_bytes`` of JSON text; returns the JSON text."""
    original = js_json.stringify(value)
    if json_bytes(value) <= max_bytes:
        return original
    if isinstance(value, str):
        return js_json.stringify(prune_text(value, max_bytes - 2))
    working = copy.deepcopy(value)
    for _ in range(64):
        size = json_bytes(working)
        if size <= max_bytes:
            return js_json.stringify(working)
        overflow = size - max_bytes
        leaves: list[_Leaf] = []
        _collect_leaves(working, lambda _value: None, leaves)
        # The root itself cannot be replaced through its setter; skip it.
        candidates = sorted((leaf for leaf in leaves if leaf.value is not working), key=lambda leaf: -leaf.size)
        largest = candidates[0] if candidates else None
        if largest is None or largest.size < 64:
            break
        target = max(32, largest.size - overflow - 64)
        if largest.kind == "string":
            largest.set(prune_text(largest.value, target - 2))
        else:
            largest.set(_prune_array(largest.value, target))
    if isinstance(working, list):
        pruned = _prune_array(working, max_bytes)
        if json_bytes(pruned) <= max_bytes:
            return js_json.stringify(pruned)
    return prune_text(original, max_bytes)


def _tool_result_text(result: JsonObject) -> str:
    if result.get("error") is not None:
        return result["error"]["message"]
    output = result.get("output")
    if isinstance(output, str):
        return output
    return js_json.stringify(output)


def _preview_of(result: JsonObject, max_bytes: float) -> str:
    return prune_text(_tool_result_text(result), max_bytes)


def _artifact_names(result: JsonObject) -> list[str]:
    return [artifact["name"] for artifact in result.get("artifacts") or []]


def stub_tool_result_part(part: JsonObject, preview_bytes: float = 200) -> JsonObject:
    """Replace a tool result's payload with a short, clearly marked stub."""
    result = part["result"]
    artifacts = _artifact_names(result)
    output = result.get("output")
    if output is None:
        output = result.get("error")
    stub: JsonObject = {
        "agentRuntime": "omitted",
        "note": "This earlier tool output was removed to fit the context window. Call the tool again if you need it.",
        "originalBytes": json_bytes(output),
        "preview": _preview_of(result, preview_bytes),
    }
    if artifacts:
        stub["omittedArtifacts"] = artifacts
    rewritten: JsonObject = {"callId": result["callId"], "name": result["name"]}
    if result.get("error") is not None:
        rewritten["error"] = {**result["error"], "message": _preview_of(result, preview_bytes)}
    else:
        rewritten["output"] = stub
    return {**part, "result": rewritten}


def clip_tool_result_part(part: JsonObject, max_bytes: float) -> JsonObject:
    """Clip a tool result's payload to ``max_bytes``, keeping as much as fits."""
    result = part["result"]
    artifacts = _artifact_names(result)
    if result.get("error") is not None:
        return {
            **part,
            "result": {
                "callId": result["callId"],
                "name": result["name"],
                "error": {**result["error"], "message": prune_text(result["error"]["message"], max_bytes)},
            },
        }
    output = result.get("output")
    clipped = prune_text(output, max_bytes) if isinstance(output, str) else prune_json(output, max_bytes)
    clipped_output: Any
    if artifacts:
        clipped_output = {"agentRuntime": "clipped", "output": clipped, "omittedArtifacts": artifacts}
    elif isinstance(output, str):
        clipped_output = clipped
    else:
        clipped_output = {
            "agentRuntime": "clipped",
            "note": "This tool output was shortened to fit the context window.",
            "output": clipped,
        }
    return {**part, "result": {"callId": result["callId"], "name": result["name"], "output": clipped_output}}
