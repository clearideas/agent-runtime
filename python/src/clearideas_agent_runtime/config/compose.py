"""Compose host adapters from a manifest and configuration (``packages/runtime/src/index.ts``)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .._js import json as js_json
from .._js.errors import Error
from ..sandbox.policy import BUILTIN_READ_TOOLS, BUILTIN_WORKSPACE_TOOLS, SHELL_TOOL_NAME
from .composite_tools import CompositeToolAdapter
from .mcp_tools import create_configured_tool_adapter
from .messages import create_configured_messages_options
from .providers import (
    ModelAuthorizationPolicy,
    create_configured_model_adapter,
    manifest_model_references,
    resolve_model_reference,
    validate_model_capabilities,
)
from .run_sandbox import create_configured_run_sandbox
from .schema import built_in_provider_definition
from .values import ValueResolutionContext
from .workspace_tools import create_configured_workspace_tool_adapter
from .workspaces import create_configured_workspace_provider

JsonObject = dict[str, Any]


@dataclass
class ComposedRuntime:
    """Adapters to pass to ``AgentRuntime`` (``model``, ``tools``, ``workspaces``, ``run_sandbox``, ``messages``)."""

    model: Any = None
    tools: Any = None
    workspaces: Any = None
    run_sandbox: Any = None
    messages: Any = None


@dataclass
class WorkspaceCompositionOptions:
    provider: Any = None
    run_sandbox: Any = None
    sandbox_provider: Any = None
    base_directory: str | None = None
    create_workspace: Any = None
    authorize_sandbox: Any = None
    authorize_command: Any = None
    authorize_workspace: Any = None
    authorize_tool: Any = None


@dataclass
class ComposeRuntimeOptions:
    model: bool = True
    tools: bool = True
    workspaces: bool = True
    messages: bool = True
    model_policy: ModelAuthorizationPolicy | None = None
    #: Options for ``ConfiguredMcpToolAdapter`` (``credential_provider``, ``client_factory``, …).
    tool_options: dict[str, Any] = field(default_factory=dict)
    workspace_options: WorkspaceCompositionOptions = field(default_factory=WorkspaceCompositionOptions)


def _host_workspace_tool_names(config: JsonObject) -> set[str]:
    names = set(BUILTIN_WORKSPACE_TOOLS)
    sandbox = config.get("sandbox") or {}
    names.update(js_json.js_keys(sandbox.get("commands") or {}))  # pyright: ignore[reportArgumentType]
    if (sandbox.get("shell") or {}).get("enabled"):
        names.add(SHELL_TOOL_NAME)  # pyright: ignore[reportArgumentType]
    return names  # pyright: ignore[reportReturnType]


def validate_runtime_configuration(manifest: JsonObject, config: JsonObject) -> None:
    validate_model_capabilities(manifest, config)
    for reference in manifest_model_references(manifest):
        resolved = resolve_model_reference(reference, config)
        if resolved["provider"] not in (config.get("providers") or {}) and not built_in_provider_definition(
            resolved["provider"]
        ):
            raise Error(f'Unknown model provider "{resolved["provider"]}".')
    connections = config.get("connections") or {}
    for binding in manifest.get("connections") or []:
        connection = connections.get(binding["ref"])
        if connection is None and binding.get("required") is not False:
            raise Error(f'Unknown connection "{binding["ref"]}".')
        if connection is not None and connection.get("mode") == "read" and binding.get("mode") == "read_write":
            raise Error(f'Connection "{binding["ref"]}" is read-only and cannot be elevated by an agent.')
    host_tools = _host_workspace_tool_names(config)
    binds_workspace = False
    for binding in manifest.get("workspaces") or []:
        workspace = (config.get("workspaces") or {}).get(binding["ref"])
        if workspace is None:
            if binding.get("required") is not False:
                raise Error(f'Unknown workspace "{binding["ref"]}".')
            continue
        binds_workspace = True
        if workspace.get("mode") == "read" and binding.get("mode") == "read_write":
            raise Error(f'Workspace "{binding["ref"]}" is read-only and cannot be elevated by an agent.')
        mode = binding.get("mode") or workspace.get("mode")
        for tool in binding.get("tools") or []:
            if tool not in host_tools:
                raise Error(f'Workspace "{binding["ref"]}" binding names a tool the host does not expose: {tool}.')
            if mode == "read" and tool in BUILTIN_WORKSPACE_TOOLS and tool not in BUILTIN_READ_TOOLS:
                raise Error(f'Workspace "{binding["ref"]}" binding names {tool}, which requires read_write.')
    if binds_workspace and not config.get("sandbox"):
        raise Error("Workspace bindings require a sandbox section in the runtime configuration.")


def compose_runtime(
    manifest: JsonObject,
    config: JsonObject,
    context: ValueResolutionContext | None = None,
    options: ComposeRuntimeOptions | None = None,
) -> ComposedRuntime:
    options = options or ComposeRuntimeOptions()
    if options.model:
        validate_runtime_configuration(manifest, config)
    model = create_configured_model_adapter(manifest, config, context, options.model_policy) if options.model else None
    connection_tools = (
        create_configured_tool_adapter(manifest, config, context, **options.tool_options) if options.tools else None
    )
    workspace_options = options.workspace_options
    workspaces = None
    run_sandbox = None
    if options.workspaces:
        workspaces = workspace_options.provider or create_configured_workspace_provider(
            config,
            context,
            base_directory=workspace_options.base_directory,
            create_workspace=workspace_options.create_workspace,
        )
        run_sandbox = workspace_options.run_sandbox or create_configured_run_sandbox(
            config,
            context,
            sandbox_provider=workspace_options.sandbox_provider,
            authorize_sandbox=workspace_options.authorize_sandbox,
            authorize_command=workspace_options.authorize_command,
        )
        if (
            workspaces is not None
            and run_sandbox is None
            and any(binding.get("required") is not False for binding in manifest.get("workspaces") or [])
        ):
            raise Error(
                "Workspace bindings require a sandbox section in the runtime configuration or a host-supplied run sandbox."
            )
    workspace_tools = (
        create_configured_workspace_tool_adapter(
            manifest,
            workspaces,
            run_sandbox,
            authorize_workspace=workspace_options.authorize_workspace,
            authorize_tool=workspace_options.authorize_tool,
        )
        if options.tools and options.workspaces
        else None
    )
    adapters = [adapter for adapter in (connection_tools, workspace_tools) if adapter is not None]
    tools = CompositeToolAdapter(adapters) if len(adapters) > 1 else (adapters[0] if adapters else None)
    messages = create_configured_messages_options(config, context) if options.messages else None
    return ComposedRuntime(model=model, tools=tools, workspaces=workspaces, run_sandbox=run_sandbox, messages=messages)
