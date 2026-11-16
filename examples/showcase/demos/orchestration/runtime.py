"""
The runtime for the launch-plan agent (Python edition of runtime.ts). Both
execution engines build it the same way: in this process, or inside the
remote worker process.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from clearideas_agent_runtime import (
    AgentRuntime,
    FileAgentManifestSource,
    FileRunStore,
    JexlConditionEvaluator,
    LoopStepExecutor,
    PromptStepExecutor,
    ValueResolutionContext,
    compose_runtime,
    load_agent_runtime_config,
)

from lib.host_kit import run_sync, with_model_overrides
from lib.scripted_model import ScriptedModelAdapter

from .script import orchestration_script

demo_directory = Path(__file__).resolve().parent

manifest = run_sync(FileAgentManifestSource(str(demo_directory), "agent.yaml").load_manifest())
config = with_model_overrides(run_sync(load_agent_runtime_config(demo_directory / "runtime.config.yaml")))


def create_launch_runtime(
    *,
    mode: str,
    pace: float,
    store_directory: str,
    on_event: Callable[[dict[str, Any]], Awaitable[None] | None],
    live_model: Any = None,
) -> AgentRuntime:
    """``live_model`` is for tests only: it replaces the configured live model."""
    composed = (
        compose_runtime(manifest, config, ValueResolutionContext(environment=os.environ))
        if mode == "live" and live_model is None
        else None
    )

    class Forward:
        def emit(self, event: dict[str, Any]) -> Awaitable[None] | None:
            return on_event(event)

    return AgentRuntime(
        model=(live_model or composed.model)
        if mode == "live"
        else ScriptedModelAdapter(orchestration_script, pace=pace),  # type: ignore[union-attr]
        run_store=FileRunStore(store_directory),
        # Loops need the loop executor; `when` and loop goals need conditions.
        step_executors=[PromptStepExecutor(), LoopStepExecutor()],
        condition_evaluator=JexlConditionEvaluator(),
        event_sinks=[Forward()],
        # Delivering events is part of the protocol here: a lost event is a failure.
        event_sink_failure_policy="fail-run",
    )
