"""Host-approved MCP tool metadata digests (``packages/runtime/src/mcp-integrity.ts``).

The ``sha256:`` canonicalization rules are frozen: hosts store digests, so the
Python runtime must compute exactly the TypeScript runtime's digest.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.errors import Error, error_message

MCP_TOOL_DIGEST_ALGORITHM = "sha256"
MCP_TOOL_DIGEST_PREFIX = f"{MCP_TOOL_DIGEST_ALGORITHM}:"
MCP_TOOL_DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")


def _is_empty_top_level(value: Any) -> bool:
    return value is None or value == "" or (isinstance(value, dict) and len(value) == 0)


def _canonical_value(value: Any) -> Any:
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _canonical_value(value[key]) for key in sorted(value, key=js_strings.code_unit_key)}
    return value


def canonicalize_mcp_tool_metadata(tool: dict[str, Any]) -> str:
    """The canonical JSON text that ``compute_mcp_tool_digest`` hashes."""
    name = tool.get("name") if isinstance(tool, dict) else None
    if not isinstance(name, str) or len(name) == 0:
        raise Error("MCP tool metadata requires a non-empty name.")
    subject: dict[str, Any] = {"name": name}
    for field in ("title", "description", "inputSchema", "annotations"):
        value = tool.get(field)
        if _is_empty_top_level(value):
            continue
        subject[field] = js_json.to_json_value(value)
    return js_json.stringify(_canonical_value(subject))


def compute_mcp_tool_digest(tool: dict[str, Any]) -> str:
    text = canonicalize_mcp_tool_metadata(tool)
    return (
        MCP_TOOL_DIGEST_PREFIX
        + hashlib.sha256(js_strings.well_formed(text).encode("utf-8", "surrogatepass")).hexdigest()
    )


class McpToolIntegrityError(Error):
    """A discovered MCP tool definition does not match host-approved metadata.

    ``reason``: ``mismatch``, ``unpinned``, or ``rejected`` (the host's
    ``verify_tool_metadata`` raised; see ``cause``).
    """

    name = "McpToolIntegrityError"

    def __init__(
        self,
        *,
        connection_ref: str,
        tool_name: str,
        reason: str,
        actual_digest: str,
        tool: dict[str, Any],
        expected_digest: str | None = None,
        cause: Any = None,
    ) -> None:
        subject = f'Connection "{connection_ref}" tool "{tool_name}"'
        if reason == "mismatch":
            message = (
                f"{subject} metadata digest {actual_digest} does not match the host-approved digest {expected_digest}."
            )
        elif reason == "unpinned":
            message = f"{subject} has no host-approved digest in toolIntegrity.digests (discovered {actual_digest})."
        else:
            detail = error_message(cause) if isinstance(cause, BaseException) else str(cause)
            message = f"{subject} metadata was rejected by the host: {detail}"
        super().__init__(message, cause=cause)
        self.connection_ref = connection_ref
        self.tool_name = tool_name
        self.reason = reason
        self.expected_digest = expected_digest
        self.actual_digest = actual_digest
        self.tool = tool
