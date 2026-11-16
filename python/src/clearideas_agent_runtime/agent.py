"""Standard composition (``@clearideas/agent-runtime``: ``defineAgent``, ``createAgentRuntime``)."""

from __future__ import annotations

import dataclasses
from typing import Any

from .conditions import JexlConditionEvaluator
from .config import ComposeRuntimeOptions, WorkspaceCompositionOptions, compose_runtime, empty_agent_runtime_config
from .contracts import parse_agent_manifest
from .core import AgentRuntime
from .core.messages import MessagesOptions
from .steps.loop import LoopStepExecutor
from .steps.prompt import PromptMessageHistoryCompactor, PromptStepExecutor
from .steps.standard import ApprovalStepExecutor, CodeStepExecutor, SubRunStepExecutor
from .stores.local import MemoryRunStore

JsonObject = dict[str, Any]


def define_agent(manifest: JsonObject) -> JsonObject:
    """Validate an agent definition; returns the parsed manifest."""
    return parse_agent_manifest(manifest)


def _merge_messages(*options: MessagesOptions | None) -> MessagesOptions:
    merged = MessagesOptions(compactor=PromptMessageHistoryCompactor())
    for option in options:
        if option is None:
            continue
        changes = {
            field.name: getattr(option, field.name)
            for field in dataclasses.fields(option)
            if getattr(option, field.name) is not None
        }
        merged = dataclasses.replace(merged, **changes)
    return merged


def create_agent_runtime(
    *,
    manifest: JsonObject,
    config: JsonObject | None = None,
    composition: ComposeRuntimeOptions | None = None,
    **overrides: Any,
) -> AgentRuntime:
    """Standard composition with in-memory persistence.

    ``overrides`` are ``AgentRuntime`` dependencies (``run_store``, ``model``,
    ``tools``, ``workspaces``, ``run_sandbox``, ``event_sinks``, …); supply a
    durable ``run_store`` to resume across processes.
    """
    parsed = parse_agent_manifest(manifest)
    composition = composition or ComposeRuntimeOptions()
    workspace_options = composition.workspace_options
    if overrides.get("workspaces") is not None or overrides.get("run_sandbox") is not None:
        workspace_options = dataclasses.replace(
            workspace_options,
            provider=overrides.get("workspaces") or workspace_options.provider,
            run_sandbox=overrides.get("run_sandbox") or workspace_options.run_sandbox,
        )
    adapters = compose_runtime(
        parsed,
        config if config is not None else empty_agent_runtime_config(),
        None,
        dataclasses.replace(
            composition,
            model=False if overrides.get("model") is not None else composition.model,
            tools=False if overrides.get("tools") is not None else composition.tools,
            workspace_options=workspace_options
            if isinstance(workspace_options, WorkspaceCompositionOptions)
            else WorkspaceCompositionOptions(),
        ),
    )

    class _Source:
        async def load_manifest(self, reference: str | None = None) -> JsonObject:
            return parsed

    dependencies: dict[str, Any] = {
        "run_store": MemoryRunStore(),
        "agent_manifest_source": _Source(),
        "step_executors": [
            PromptStepExecutor(),
            LoopStepExecutor(),
            ApprovalStepExecutor(),
            CodeStepExecutor(),
            SubRunStepExecutor(),
        ],
        "condition_evaluator": JexlConditionEvaluator(),
    }
    for name in ("model", "tools", "workspaces", "run_sandbox"):
        value = getattr(adapters, name)
        if value is not None:
            dependencies[name] = value
    messages_override = overrides.pop("messages", None)
    dependencies.update({key: value for key, value in overrides.items() if value is not None})
    # Host message options refine the configured ones; the compactor is always
    # available so summarizing history policies pass preflight.
    dependencies["messages"] = _merge_messages(adapters.messages, messages_override)
    return AgentRuntime(**dependencies)


__all__ = ["create_agent_runtime", "define_agent"]
