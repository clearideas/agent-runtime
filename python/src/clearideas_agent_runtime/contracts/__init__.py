"""Versioned, persistence-independent contracts (``@clearideas/agent-runtime-contracts``)."""

from __future__ import annotations

from typing import Any

from . import schemas
from ._zod import SafeParseResult, ZodError, parse, safe_parse
from .schemas import (
    AGENT_MANIFEST_SCHEMA_VERSION,
    AGENT_RUN_EXECUTION_MODES,
    AGENT_RUN_MANIFEST_SCHEMA_VERSION,
    AGENT_VARIABLE_TYPES,
    CONTEXT_STRATEGIES,
    MESSAGES_SIGNATURE_ALGORITHM,
    MESSAGES_SIGNATURE_VERSION,
    MESSAGES_VARIABLE,
    PROMPT_ONLY_POLICY_FIELDS,
    SUMMARY_KINDS,
    WORKSPACE_MODES,
    is_safe_variable_path,
    messages_marker_of,
    value_matches_agent_variable_type,
)
from .types import *

# Schema handles, named after the TypeScript exports.
json_value_schema = schemas.JsonValue
json_object_schema = schemas.JsonObject
variable_state_schema = schemas.VariableState
variable_path_schema = schemas.VariablePath
agent_variable_key_schema = schemas.AgentVariableKey
agent_variable_definition_schema = schemas.AgentVariableDefinition
agent_variable_override_schema = schemas.AgentVariableOverride
agent_variable_overrides_schema = schemas.AgentVariableOverrides
context_policy_schema = schemas.ContextPolicy
execution_policies_schema = schemas.ExecutionPolicies
step_history_schema = schemas.StepHistory
prompt_message_schema = schemas.PromptMessage
agent_workspace_binding_schema = schemas.AgentWorkspaceBinding
agent_step_schema = schemas.AgentStep
agent_messages_declaration_schema = schemas.AgentMessagesDeclaration
agent_manifest_schema = schemas.AgentManifestSchema
agent_run_budget_schema = schemas.AgentRunBudget
run_budget_state_schema = schemas.RunBudgetState
agent_run_execution_schema = schemas.AgentRunExecution
agent_run_manifest_schema = schemas.AgentRunManifest
artifact_ref_schema = schemas.ArtifactRef
model_usage_schema = schemas.ModelUsage
run_error_schema = schemas.RunError
conversation_messages_schema = schemas.ConversationMessages
conversation_messages_input_schema = schemas.ConversationMessagesInput
messages_signature_schema = schemas.MessagesSignature
run_messages_state_schema = schemas.RunMessagesState
transcript_item_schema = schemas.TranscriptItem
step_result_schema = schemas.StepResult
run_checkpoint_schema = schemas.RunCheckpoint
messages_marker_schema = schemas.MessagesMarker


def parse_agent_manifest(value: Any) -> dict[str, Any]:
    return parse(agent_manifest_schema, value)


def safe_parse_agent_manifest(value: Any) -> SafeParseResult:
    return safe_parse(agent_manifest_schema, value)


def parse_agent_run_manifest(value: Any) -> dict[str, Any]:
    return parse(agent_run_manifest_schema, value)


def safe_parse_agent_run_manifest(value: Any) -> SafeParseResult:
    return safe_parse(agent_run_manifest_schema, value)


def parse_run_checkpoint(value: Any) -> dict[str, Any]:
    return parse(run_checkpoint_schema, value)


def parse_agent_variable_overrides(value: Any) -> list[dict[str, Any]]:
    return parse(agent_variable_overrides_schema, value)


def parse_conversation_messages(value: Any) -> list[dict[str, Any]]:
    return parse(conversation_messages_input_schema, value)


__all__ = [
    "AGENT_MANIFEST_SCHEMA_VERSION",
    "AGENT_RUN_EXECUTION_MODES",
    "AGENT_RUN_MANIFEST_SCHEMA_VERSION",
    "AGENT_VARIABLE_TYPES",
    "CONTEXT_STRATEGIES",
    "MESSAGES_SIGNATURE_ALGORITHM",
    "MESSAGES_SIGNATURE_VERSION",
    "MESSAGES_VARIABLE",
    "PROMPT_ONLY_POLICY_FIELDS",
    "SUMMARY_KINDS",
    "WORKSPACE_MODES",
    "AgentConnectionBinding",
    "AgentManifest",
    "AgentRunBudget",
    "AgentRunExecution",
    "AgentRunManifest",
    "AgentStep",
    "AgentVariableDefinition",
    "AgentVariableOverride",
    "AgentWorkspaceBinding",
    "Any",
    "ArtifactRef",
    "ContentPart",
    "ContextPolicy",
    "ConversationContentPart",
    "ConversationMessage",
    "ConversationMessageInput",
    "ExecutionCursor",
    "ExecutionPolicies",
    "JsonObject",
    "JsonValue",
    "MessagesMarker",
    "MessagesSignature",
    "ModelReference",
    "ModelUsage",
    "PromptMessage",
    "RunBudgetState",
    "RunCheckpoint",
    "RunError",
    "RunEvent",
    "RunMessagesState",
    "RunResult",
    "SafeParseResult",
    "SandboxCommandRecord",
    "StatePatch",
    "StepHistory",
    "StepResult",
    "ToolCall",
    "ToolResult",
    "TranscriptItem",
    "TypeAlias",
    "VariableState",
    "ZodError",
    "agent_manifest_schema",
    "agent_messages_declaration_schema",
    "agent_run_budget_schema",
    "agent_run_execution_schema",
    "agent_run_manifest_schema",
    "agent_step_schema",
    "agent_variable_definition_schema",
    "agent_variable_key_schema",
    "agent_variable_override_schema",
    "agent_variable_overrides_schema",
    "agent_workspace_binding_schema",
    "annotations",
    "artifact_ref_schema",
    "context_policy_schema",
    "conversation_messages_input_schema",
    "conversation_messages_schema",
    "execution_policies_schema",
    "is_safe_variable_path",
    "json_object_schema",
    "json_value_schema",
    "messages_marker_of",
    "messages_marker_schema",
    "messages_signature_schema",
    "model_usage_schema",
    "parse",
    "parse_agent_manifest",
    "parse_agent_run_manifest",
    "parse_agent_variable_overrides",
    "parse_conversation_messages",
    "parse_run_checkpoint",
    "prompt_message_schema",
    "run_budget_state_schema",
    "run_checkpoint_schema",
    "run_error_schema",
    "run_messages_state_schema",
    "safe_parse",
    "safe_parse_agent_manifest",
    "safe_parse_agent_run_manifest",
    "schemas",
    "step_history_schema",
    "step_result_schema",
    "transcript_item_schema",
    "types",
    "value_matches_agent_variable_type",
    "variable_path_schema",
    "variable_state_schema",
]
