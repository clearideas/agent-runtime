"""Host configuration and composition (``@clearideas/agent-runtime-config``)."""

from ..sandbox.policy import BUILTIN_READ_TOOLS, BUILTIN_WORKSPACE_TOOLS, SHELL_TOOL_NAME

# Schema handles, named after the TypeScript exports (as in ``contracts``).
from . import mcp_integrity as _integrity
from . import schema as _schema
from .compose import (
    ComposedRuntime,
    ComposeRuntimeOptions,
    WorkspaceCompositionOptions,
    compose_runtime,
    validate_runtime_configuration,
)
from .composite_tools import CompositeToolAdapter
from .mcp_integrity import (
    MCP_TOOL_DIGEST_ALGORITHM,
    MCP_TOOL_DIGEST_PREFIX,
    McpToolIntegrityError,
    canonicalize_mcp_tool_metadata,
    compute_mcp_tool_digest,
)
from .mcp_tools import (
    ConfiguredMcpToolAdapter,
    ConnectionAuthorizationRequiredError,
    McpClientRequest,
    create_configured_tool_adapter,
    discover_mcp_connection_tools,
)
from .messages import create_configured_messages_options
from .providers import (
    ConfiguredModelAdapter,
    ModelAuthorizationPolicy,
    create_configured_model_adapter,
    manifest_model_references,
    resolve_model_reference,
    validate_model_capabilities,
)
from .run_sandbox import create_configured_run_sandbox
from .schema import *
from .values import ValueResolutionContext, resolve_environment_reference, resolve_headers, resolve_value_source
from .workspace_tools import WorkspaceToolAdapter, create_configured_workspace_tool_adapter, workspace_tool_name
from .workspaces import ConfiguredWorkspaceProvider, create_configured_workspace_provider

# Schema handles, named after the TypeScript exports (as in ``contracts``).
environment_reference_schema = _schema.EnvironmentReference
mcp_connection_auth_schema = _schema.McpConnectionAuth
mcp_tool_integrity_schema = _schema.McpToolIntegrity
messages_config_schema = _schema.MessagesConfig
agent_runtime_config_schema = _schema.AgentRuntimeConfig
sandbox_command_definition_schema = _schema.SandboxCommandDefinition
sandbox_definition_schema = _schema.SandboxDefinition
sandbox_limits_schema = _schema.SandboxLimits
workspace_definition_schema = _schema.WorkspaceDefinition
#: ``mcpToolDigestPattern``: a full match is a pinned ``sha256:<64 hex>`` digest.
mcp_tool_digest_pattern = _integrity.MCP_TOOL_DIGEST_PATTERN
