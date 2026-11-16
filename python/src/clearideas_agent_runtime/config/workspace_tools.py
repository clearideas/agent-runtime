"""Workspace tools for models (``packages/runtime/src/workspace-tools.ts``).

Each tool call runs as one command in the run sandbox session for the current
run. The TypeScript adapter relays calls through an in-process MCP server
that holds no policy; the Python adapter forwards the same validated request
to the session directly, with the same tool list, results, and errors.
"""

from __future__ import annotations

import inspect
from typing import Any

from .._js import json as js_json
from .._js.errors import Error, error_message
from ..core.errors import create_limit_suspension
from ..core.runtime import resolve_agent_workspaces
from .mcp_tools import runtime_tool_name

JsonObject = dict[str, Any]
_BUILTIN_NAMES = {"list_files", "read_file", "search_files", "write_file", "delete_file"}


def workspace_tool_name(alias: str, tool_name: str) -> str:
    return runtime_tool_name(alias, tool_name)


def _tool_kind(tool: JsonObject) -> str:
    kind = (tool.get("metadata") or {}).get("kind")
    if kind in ("builtin", "command", "shell"):
        return kind
    if tool["name"] in _BUILTIN_NAMES:
        return "builtin"
    return "shell" if tool["name"] == "shell" else "command"


def _error_code(error: BaseException) -> str:
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and code else "sandbox_command_failed"


async def _maybe(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class WorkspaceToolAdapter:
    """Manifest-bound workspaces as tools prefixed with the workspace alias."""

    def __init__(
        self,
        manifest: JsonObject,
        workspaces: Any,
        run_sandbox: Any,
        *,
        authorize_workspace: Any = None,
        authorize_tool: Any = None,
    ) -> None:
        self._manifest = manifest
        self._workspaces = workspaces
        self._run_sandbox = run_sandbox
        self._authorize_workspace = authorize_workspace
        self._authorize_tool = authorize_tool
        self._relays: list[tuple[Any, list[JsonObject]]] | None = None
        self._resolved: dict[str, JsonObject] = {}

    async def _connect(self) -> list[tuple[Any, list[JsonObject]]]:
        if self._relays is not None:
            return self._relays
        relays: list[tuple[Any, list[JsonObject]]] = []
        for workspace in await resolve_agent_workspaces(self._manifest, self._workspaces):
            if self._authorize_workspace is not None:
                await _maybe(self._authorize_workspace({"binding": workspace.binding, "workspace": workspace}))
            relays.append((workspace, await self._run_sandbox.tools(workspace)))
        self._relays = relays
        return relays

    async def list_tools(self) -> list[JsonObject]:
        tools: list[JsonObject] = []
        resolved: dict[str, JsonObject] = {}
        for workspace, sources in await self._connect():
            for source in sources:
                name = workspace_tool_name(workspace.alias, source["name"])
                if name in resolved:
                    raise Error(f"Workspace tool name collision: {name}. Use a distinct workspace alias.")
                resolved[name] = {"toolName": source["name"], "kind": _tool_kind(source), "workspace": workspace}
                entry: JsonObject = {"name": name}
                if source.get("description"):
                    entry["description"] = source["description"]
                metadata = source.get("metadata") or {}
                entry["inputSchema"] = js_json.to_json_value(source["inputSchema"])
                entry["metadata"] = {
                    "workspace": workspace.binding["ref"],
                    "workspaceAlias": workspace.alias,
                    "workspaceMode": workspace.mode,
                    "sourceTool": source["name"],
                    "kind": _tool_kind(source),
                    "readOnly": metadata.get("readOnly") is True,
                    "destructive": metadata.get("destructive") is True,
                    "sandboxed": True,
                }
                tools.append(entry)
        self._resolved = resolved
        return tools

    async def execute_tool(self, call: JsonObject, context: Any) -> JsonObject:
        if not self._resolved:
            await self.list_tools()
        tool = self._resolved.get(call["name"])
        if tool is None:
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {"code": "tool_not_allowed", "message": f'Tool "{call["name"]}" is not available.'},
            }
        workspace = tool["workspace"]
        if self._authorize_tool is not None:
            try:
                await _maybe(
                    self._authorize_tool(
                        {
                            "binding": workspace.binding,
                            "workspace": workspace,
                            "toolName": tool["toolName"],
                            "call": call,
                        },
                        context,
                    )
                )
            except Exception:
                return {
                    "callId": call["id"],
                    "name": call["name"],
                    "error": {
                        "code": "tool_not_authorized",
                        "message": f'Tool "{call["name"]}" is not authorized for this run.',
                        "retryable": False,
                    },
                }
        if getattr(context, "run_sandbox", None) is None:
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {
                    "code": "sandbox_unavailable",
                    "message": "This run has no run sandbox; workspace tools cannot execute.",
                    "retryable": False,
                },
            }
        try:
            session = await context.run_sandbox()
        except Exception as error:
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {"code": "sandbox_unavailable", "message": error_message(error), "retryable": False},
            }
        metadata: JsonObject = {
            "workspace": workspace.binding["ref"],
            "workspaceAlias": workspace.alias,
            "sourceTool": tool["toolName"],
        }
        request: JsonObject = {"stepId": context.step_id, "toolCallId": call["id"]}
        if getattr(context, "idempotency_key", None):
            request["idempotencyKey"] = context.idempotency_key
        request.update(
            {
                "alias": workspace.alias,
                "kind": tool["kind"],
                "name": tool["toolName"],
                "arguments": call["input"] if call.get("input") is not None else {},
            }
        )
        if getattr(context, "signal", None) is not None:
            request["signal"] = context.signal
        try:
            result = await session.execute(request)
        except Exception as error:
            limit = getattr(error, "limit", None)
            if isinstance(limit, dict) and isinstance(limit.get("name"), str):
                raise create_limit_suspension(
                    limit=limit["name"], used=limit["used"], value=limit["value"], step_id=context.step_id
                ) from error
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {
                    "code": _error_code(error),
                    "message": error_message(error) or "Workspace tool failed.",
                    "retryable": False,
                },
                "metadata": metadata,
            }
        metadata["command"] = js_json.to_json_value(result["record"])
        output = result.get("output")
        if output is None:
            output = {"output": None}
        value: JsonObject = {"callId": call["id"], "name": call["name"], "output": output}
        if result.get("artifacts"):
            value["artifacts"] = result["artifacts"]
        value["metadata"] = metadata
        return value

    async def close(self) -> None:
        self._relays = None
        self._resolved = {}


def create_configured_workspace_tool_adapter(
    manifest: JsonObject, workspaces: Any, run_sandbox: Any, **options: Any
) -> WorkspaceToolAdapter | None:
    if not manifest.get("workspaces") or workspaces is None or run_sandbox is None:
        return None
    return WorkspaceToolAdapter(manifest, workspaces, run_sandbox, **options)
