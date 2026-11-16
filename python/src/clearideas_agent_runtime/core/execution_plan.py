"""Dependency-safe execution waves (``packages/core/src/execution-plan.ts``)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .._js.regex import WS, escape


@dataclass
class ExecutionWave:
    step_indexes: list[int] = field(default_factory=list)


def _step_output_state_projection_enabled(manifest: dict[str, Any]) -> bool:
    runtime = (manifest.get("extensions") or {}).get("agentRuntime")
    return isinstance(runtime, dict) and runtime.get("stateProjection") == "step-output-state-v1"


def _is_parallel_prompt_step(step: dict[str, Any]) -> bool:
    return step.get("type") == "prompt" and not step.get("tools") and step.get("extensions") is None


def _template_reads_variable(source: str | None, key: str) -> bool:
    if not source:
        return False
    return re.search(r"\{\{" + WS + "*" + escape(key) + r"(?:\.|" + WS + r"*\}\})", source, re.IGNORECASE) is not None


def _condition_reads_variable(expression: str | None, key: str) -> bool:
    if not expression:
        return False
    if _template_reads_variable(expression, key):
        return True
    pattern = r"(^|[^A-Za-z0-9_.-])" + escape(key) + r"(?=$|\.|[^A-Za-z0-9_.-])"
    return re.search(pattern, expression, re.IGNORECASE) is not None


def _reads_variable(step: dict[str, Any], key: str) -> bool:
    if _template_reads_variable(step.get("systemPrompt"), key) or _template_reads_variable(step.get("prompt"), key):
        return True
    for message in step.get("messages") or []:
        for part in message.get("content") or []:
            if part.get("type") == "text" and _template_reads_variable(part.get("text"), key):
                return True
    return _condition_reads_variable(step.get("when"), key)


def _depends_on_current_wave(step: dict[str, Any], current_wave: list[dict[str, Any]]) -> bool:
    for prior in current_wave:
        written = prior.get("outputVariable")
        if not written:
            continue
        if step.get("outputVariable") == written or _reads_variable(step, written):
            return True
    return False


def build_execution_waves(
    manifest: dict[str, Any],
    start_step_index: int,
    execution: dict[str, Any] | None,
    host_maximum_concurrency: int = 8,
) -> list[ExecutionWave]:
    """Contiguous waves; only tool-free prompt steps without extensions run in parallel."""
    execution = execution or {}
    max_concurrency = execution.get("maxConcurrency")
    maximum = max(1, min(4 if max_concurrency is None else max_concurrency, max(1, host_maximum_concurrency)))
    parallel = (
        execution.get("mode") == "parallel" and maximum > 1 and not _step_output_state_projection_enabled(manifest)
    )

    steps = manifest["steps"]
    waves: list[ExecutionWave] = []
    current: list[int] = []

    def flush() -> None:
        nonlocal current
        while current:
            waves.append(ExecutionWave(current[:maximum]))
            current = current[maximum:]

    for step_index in range(start_step_index, len(steps)):
        step = steps[step_index]
        if not parallel or not _is_parallel_prompt_step(step):
            flush()
            waves.append(ExecutionWave([step_index]))
            continue
        if _depends_on_current_wave(step, [steps[index] for index in current]):
            flush()
        current.append(step_index)
        if len(current) == maximum:
            flush()
    flush()
    return waves
