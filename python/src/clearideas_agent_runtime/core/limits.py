"""Durable run usage and limits, matching ``packages/core/src/limits.ts``."""

from __future__ import annotations

import copy
import math
from collections.abc import Callable
from typing import Any

from ..contracts import DEFAULT_RUN_LIMITS

JsonObject = dict[str, Any]

RUN_LIMIT_KEYS = (
    "maxTotalTokens",
    "maxStepTokens",
    "maxEstimatedCost",
    "maxRunActiveMs",
    "maxStepActiveMs",
    "maxRecoveries",
    "maxResumesWithoutProgress",
    "maxTurnsPerPrompt",
    "maxLoopIterations",
    "maxArtifacts",
    "maxArtifactBytes",
    "maxCheckpointBytes",
)
SANDBOX_LIMIT_KEYS = (
    "maxCommands",
    "maxSeconds",
    "commandTimeoutMs",
    "maxCommandTimeoutMs",
    "maxStdoutBytes",
    "maxStderrBytes",
    "maxOutputFiles",
    "maxOutputBytes",
)


def manifest_run_limits(manifest: JsonObject) -> JsonObject:
    limits = manifest.get("limits") or {}
    picked = {key: limits[key] for key in RUN_LIMIT_KEYS if key in limits}
    if limits.get("sandbox"):
        picked["sandbox"] = dict(limits["sandbox"])
    return picked


def merge_run_limits(*layers: JsonObject | None) -> JsonObject:
    merged: JsonObject = {}
    for layer in layers:
        if not layer:
            continue
        for key in RUN_LIMIT_KEYS:
            if key in layer:
                merged[key] = layer[key]
        if layer.get("sandbox"):
            sandbox = merged.setdefault("sandbox", {})
            for key in SANDBOX_LIMIT_KEYS:
                if key in layer["sandbox"]:
                    sandbox[key] = layer["sandbox"][key]
    return merged


def resolve_run_limits(
    manifest: JsonObject,
    *,
    defaults: JsonObject | None = None,
    granted: JsonObject | None = None,
    ceilings: JsonObject | None = None,
) -> JsonObject:
    requested = merge_run_limits(DEFAULT_RUN_LIMITS, defaults, manifest_run_limits(manifest), granted)
    ceilings = ceilings or {}
    effective: JsonObject = {"sandbox": {}}
    for key in RUN_LIMIT_KEYS:
        value, ceiling = requested.get(key), ceilings.get(key)
        if value is not None or ceiling is not None:
            effective[key] = min(value, ceiling) if value is not None and ceiling is not None else value or ceiling
    for key in SANDBOX_LIMIT_KEYS:
        value, ceiling = (requested.get("sandbox") or {}).get(key), (ceilings.get("sandbox") or {}).get(key)
        if value is not None or ceiling is not None:
            effective["sandbox"][key] = (
                min(value, ceiling) if value is not None and ceiling is not None else value or ceiling
            )
    return effective


def transcript_tokens(transcript: list[JsonObject]) -> int:
    total = 0
    for item in transcript:
        usage = item.get("usage") or {}
        count = usage.get("totalTokens")
        if count is None and (usage.get("inputTokens") is not None or usage.get("outputTokens") is not None):
            count = (usage.get("inputTokens") or 0) + (usage.get("outputTokens") or 0)
        if isinstance(count, (int, float)) and not isinstance(count, bool) and math.isfinite(count):
            total += count
    return total


def transcript_cost(transcript: list[JsonObject]) -> float:
    total = 0.0
    for item in transcript:
        cost = (item.get("usage") or {}).get("estimatedCost")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost):
            total += cost
    return total


def _artifact_usage(artifacts: list[JsonObject]) -> JsonObject:
    return {"count": len(artifacts), "bytes": sum(artifact.get("size") or 0 for artifact in artifacts)}


def sandbox_usage_from_checkpoint(checkpoint: JsonObject | None) -> JsonObject | None:
    ledger = (checkpoint or {}).get("ledger") or {}
    if ledger.get("sandbox"):
        return dict(ledger["sandbox"])
    value = ((checkpoint or {}).get("metadata") or {}).get("sandboxBudget")
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("commandsUsed"), int)
        or isinstance(value.get("commandsUsed"), bool)
        or not isinstance(value.get("sandboxSecondsUsed"), (int, float))
    ):
        return None
    return {"commands": value["commandsUsed"], "seconds": value["sandboxSecondsUsed"]}


def seeded_ledger(checkpoint: JsonObject) -> JsonObject:
    cost = transcript_cost(checkpoint["transcript"])
    return {
        "tokens": 0,
        "activeMs": 0,
        "artifacts": {"count": 0, "bytes": 0},
        "inherited": {
            "tokens": transcript_tokens(checkpoint["transcript"]),
            **({"estimatedCost": cost} if cost > 0 else {}),
            "artifacts": _artifact_usage(checkpoint["artifacts"]),
        },
    }


def _js_round(value: float) -> int:
    return math.floor(value + 0.5)


class RunLedgerTracker:
    """One attempt's durable usage ledger."""

    def __init__(self, *, checkpoint: JsonObject | None, now: Callable[[], float]) -> None:
        self._now = now
        ledger = (checkpoint or {}).get("ledger") or {}
        self._base_active_ms = ledger.get("activeMs", 0)
        self._attempt_started_at = now()
        self._sandbox = sandbox_usage_from_checkpoint(checkpoint)
        self._stalled_resumes = copy.deepcopy(ledger.get("stalledResumes"))
        self._recoveries = ledger.get("recoveries", 0)
        self._progress = (ledger.get("progress") or checkpoint["sequence"]) if checkpoint else None
        self._granted = copy.deepcopy(ledger.get("granted"))
        self._inherited = copy.deepcopy(ledger.get("inherited"))
        self._resumed_step = copy.deepcopy(ledger.get("step"))
        self._step: JsonObject | None = None
        self._tokens = 0
        self._cost = 0.0
        self._artifacts: JsonObject = {"count": 0, "bytes": 0}
        if checkpoint:
            self._observe_content(checkpoint)

    @property
    def granted(self) -> JsonObject | None:
        return self._granted

    def grant(self, limits: JsonObject | None) -> None:
        if limits:
            self._granted = merge_run_limits(self._granted, limits)

    @property
    def stalled_resumes(self) -> JsonObject | None:
        return self._stalled_resumes

    @stalled_resumes.setter
    def stalled_resumes(self, value: JsonObject | None) -> None:
        self._stalled_resumes = value

    @property
    def recoveries(self) -> int:
        return self._recoveries

    def record_recovery(self) -> None:
        self._recoveries += 1

    @property
    def progress(self) -> int | None:
        return self._progress

    @property
    def active_ms(self) -> float:
        return self._base_active_ms + (self._now() - self._attempt_started_at)

    @property
    def step_key(self) -> str | None:
        return self._step["key"] if self._step else None

    def step_active_ms(self, key: str) -> float:
        if not self._step or self._step["key"] != key:
            return 0
        return self._step["baseActiveMs"] + (self._now() - self._step["startedAt"])

    def start_step(self, key: str) -> None:
        if self._step and self._step["key"] == key:
            return
        resumed = self._resumed_step if self._resumed_step and self._resumed_step["key"] == key else None
        self._resumed_step = None
        self._step = {
            "key": key,
            "baseActiveMs": (resumed or {}).get("activeMs", 0),
            "startedAt": self._now(),
            "tokens": (resumed or {}).get("tokens", 0),
        }

    def end_step(self, key: str | None = None) -> None:
        if key is None or (self._step and self._step["key"] == key):
            self._step = None

    def set_step_tokens(self, key: str, tokens: int) -> None:
        if self._step and self._step["key"] == key:
            self._step["tokens"] = tokens

    def set_sandbox(self, usage: JsonObject | None) -> None:
        if usage:
            self._sandbox = dict(usage)

    @property
    def sandbox(self) -> JsonObject | None:
        return self._sandbox

    @property
    def tokens(self) -> int:
        return self._tokens

    @property
    def estimated_cost(self) -> float:
        return self._cost

    @property
    def step_tokens(self) -> int:
        return self._step["tokens"] if self._step else 0

    @property
    def artifacts(self) -> JsonObject:
        return self._artifacts

    def observe(self, checkpoint: JsonObject) -> JsonObject:
        self._progress = checkpoint["sequence"]
        self._observe_content(checkpoint)
        return self.snapshot()

    def _observe_content(self, content: JsonObject) -> None:
        inherited = self._inherited or {}
        self._tokens = max(0, transcript_tokens(content["transcript"]) - inherited.get("tokens", 0))
        self._cost = max(0, transcript_cost(content["transcript"]) - inherited.get("estimatedCost", 0))
        all_artifacts = _artifact_usage(content["artifacts"])
        inherited_artifacts = inherited.get("artifacts") or {}
        self._artifacts = {
            "count": max(0, all_artifacts["count"] - inherited_artifacts.get("count", 0)),
            "bytes": max(0, all_artifacts["bytes"] - inherited_artifacts.get("bytes", 0)),
        }

    def snapshot(self) -> JsonObject:
        ledger: JsonObject = {"tokens": self._tokens, "activeMs": _js_round(self.active_ms)}
        if self._cost > 0:
            ledger["estimatedCost"] = self._cost
        if self._step:
            ledger["step"] = {
                "key": self._step["key"],
                "tokens": self._step["tokens"],
                "activeMs": _js_round(self.step_active_ms(self._step["key"])),
            }
        ledger["artifacts"] = dict(self._artifacts)
        if self._progress is not None:
            ledger["progress"] = self._progress
        if self._sandbox:
            ledger["sandbox"] = dict(self._sandbox)
        if self._recoveries > 0:
            ledger["recoveries"] = self._recoveries
        if self._stalled_resumes:
            ledger["stalledResumes"] = dict(self._stalled_resumes)
        if self._granted:
            ledger["granted"] = copy.deepcopy(self._granted)
        if self._inherited:
            ledger["inherited"] = copy.deepcopy(self._inherited)
        return ledger


__all__ = [
    "RunLedgerTracker",
    "manifest_run_limits",
    "merge_run_limits",
    "resolve_run_limits",
    "sandbox_usage_from_checkpoint",
    "seeded_ledger",
    "transcript_cost",
    "transcript_tokens",
]
