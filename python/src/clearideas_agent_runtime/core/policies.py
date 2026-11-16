"""Execution policy layering (``packages/core/src/policies.ts``)."""

from __future__ import annotations

import copy
from typing import Any

NESTED_CONTEXT_FIELDS = {"summarizer", "trigger", "retain"}


def _merge_context(base: dict[str, Any] | None, override: dict[str, Any] | None) -> dict[str, Any] | None:
    if base is None:
        return copy.deepcopy(override) if override is not None else None
    if override is None:
        return copy.deepcopy(base)
    merged: dict[str, Any] = {**copy.deepcopy(base)}
    for key, value in override.items():
        if key == "variables":
            variables = {**(merged.get("variables") or {})}
            for name, entry in value.items():
                variables[name] = {**(variables.get(name) or {}), **copy.deepcopy(entry)}
            merged["variables"] = variables
        elif key in NESTED_CONTEXT_FIELDS:
            merged[key] = {**(merged.get(key) or {}), **copy.deepcopy(value)}
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def merge_execution_policies(*layers: dict[str, Any] | None) -> dict[str, Any]:
    """Merge policy layers; later layers override earlier ones field by field."""
    result: dict[str, Any] = {}
    for layer in layers:
        if layer is None:
            continue
        next_policies = {**result}
        context = _merge_context(result.get("context"), layer.get("context"))
        if context is not None:
            next_policies["context"] = context
        if "toolCallLimit" in layer:
            next_policies["toolCallLimit"] = layer["toolCallLimit"]
        if "onError" in layer:
            next_policies["onError"] = layer["onError"]
        if "onFailure" in layer:
            next_policies["onFailure"] = layer["onFailure"]
        if layer.get("modelRetry") is not None:
            next_policies["modelRetry"] = {**(result.get("modelRetry") or {}), **copy.deepcopy(layer["modelRetry"])}
        if layer.get("outputRepair") is not None:
            next_policies["outputRepair"] = {
                **(result.get("outputRepair") or {}),
                **copy.deepcopy(layer["outputRepair"]),
            }
        result = next_policies
    return result


def resolve_step_policies(
    host_defaults: dict[str, Any] | None,
    manifest: dict[str, Any],
    step: dict[str, Any],
    host_enforced: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Host defaults, then the manifest, then the step, then host-enforced policies."""
    return merge_execution_policies(host_defaults, manifest.get("policies"), step.get("policies"), host_enforced)
