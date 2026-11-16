"""Type aliases for contract data.

Contract values are plain JSON data (``dict``/``list``/scalars) with the
camelCase keys of the wire format, exactly as the TypeScript runtime stores
and exchanges them. These aliases document intent at API boundaries.
"""

from __future__ import annotations

from typing import Any, TypeAlias

JsonValue: TypeAlias = Any
JsonObject: TypeAlias = dict[str, Any]
VariableState: TypeAlias = dict[str, Any]
StatePatch: TypeAlias = dict[str, Any]
ArtifactRef: TypeAlias = dict[str, Any]
ModelUsage: TypeAlias = dict[str, Any]
ToolCall: TypeAlias = dict[str, Any]
ToolResult: TypeAlias = dict[str, Any]
ContentPart: TypeAlias = dict[str, Any]
PromptMessage: TypeAlias = dict[str, Any]
ConversationContentPart: TypeAlias = dict[str, Any]
ConversationMessage: TypeAlias = dict[str, Any]
ConversationMessageInput: TypeAlias = dict[str, Any]
MessagesSignature: TypeAlias = dict[str, Any]
MessagesMarker: TypeAlias = dict[str, Any]
RunMessagesState: TypeAlias = dict[str, Any]
TranscriptItem: TypeAlias = dict[str, Any]
ModelReference: TypeAlias = dict[str, Any]
AgentConnectionBinding: TypeAlias = dict[str, Any]
AgentWorkspaceBinding: TypeAlias = dict[str, Any]
SandboxCommandRecord: TypeAlias = dict[str, Any]
AgentVariableDefinition: TypeAlias = dict[str, Any]
AgentVariableOverride: TypeAlias = dict[str, Any]
ContextPolicy: TypeAlias = dict[str, Any]
ExecutionPolicies: TypeAlias = dict[str, Any]
StepHistory: TypeAlias = Any
AgentStep: TypeAlias = dict[str, Any]
AgentManifest: TypeAlias = dict[str, Any]
AgentRunManifest: TypeAlias = dict[str, Any]
AgentRunBudget: TypeAlias = dict[str, Any]
RunBudgetState: TypeAlias = dict[str, Any]
AgentRunExecution: TypeAlias = dict[str, Any]
ExecutionCursor: TypeAlias = dict[str, Any]
StepResult: TypeAlias = dict[str, Any]
RunCheckpoint: TypeAlias = dict[str, Any]
RunError: TypeAlias = dict[str, Any]
RunEvent: TypeAlias = dict[str, Any]
RunResult: TypeAlias = dict[str, Any]
