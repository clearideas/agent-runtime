"""The worker protocol (``packages/execution/src/worker-protocol.ts``).

Invocations and messages are JSON; workers in either runtime read and write
the same documents (one message per line).
"""

from __future__ import annotations

import copy
import math
from typing import Any

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.errors import Error
from .._js.ops import UNDEFINED, to_string
from ..contracts import (
    agent_run_budget_schema,
    agent_run_execution_schema,
    messages_signature_schema,
    parse_agent_manifest,
    parse_agent_variable_overrides,
    parse_conversation_messages,
    parse_run_checkpoint,
)
from ..contracts._zod import parse as zod_parse
from .contracts import EXECUTION_PROTOCOL_VERSION

JsonObject = dict[str, Any]
MAXIMUM_WORKER_INVOCATION_BYTES = 16 * 1024 * 1024
_MAXIMUM_DEPTH = 128
_MAXIMUM_NODES = 100_000


def create_worker_invocation(request: JsonObject, action: str = "run") -> JsonObject:
    return {"protocolVersion": EXECUTION_PROTOCOL_VERSION, "action": action, "request": copy.deepcopy(request)}


def serialize_worker_message(message: JsonObject) -> str:
    return f"{js_json.stringify(message)}\n"


def _assert_structure(value: Any) -> None:
    pending: list[tuple[Any, int]] = [(value, 0)]
    nodes = 0
    seen: set[int] = set()
    while pending:
        current, depth = pending.pop()
        nodes += 1
        if nodes > _MAXIMUM_NODES:
            raise Error("Worker invocation exceeds the structure size limit.")
        if depth > _MAXIMUM_DEPTH:
            raise Error("Worker invocation exceeds the structure depth limit.")
        if not isinstance(current, (dict, list)):
            continue
        if id(current) in seen:
            raise Error("Worker invocation must be a non-cyclic JSON tree.")
        seen.add(id(current))
        children = list(current) if isinstance(current, list) else [current[key] for key in js_json.js_keys(current)]
        if nodes + len(children) > _MAXIMUM_NODES:
            raise Error("Worker invocation exceeds the structure size limit.")
        for child in reversed(children):
            pending.append((child, depth + 1))


def _require_non_empty_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not js_strings.trim(value):
        raise Error(f"{label} must be a non-empty string.")


def _is_safe_integer(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return abs(value) <= js_json.MAX_SAFE_INTEGER


def parse_worker_invocation(value: Any) -> JsonObject:
    if isinstance(value, str):
        if js_strings.utf8_length(value) > MAXIMUM_WORKER_INVOCATION_BYTES:
            raise Error("Worker invocation exceeds the input size limit.")
        value = js_json.parse(value)
    _assert_structure(value)
    if not isinstance(value, dict):
        raise Error("Worker invocation must be an object.")
    if value.get("protocolVersion") != EXECUTION_PROTOCOL_VERSION:
        raise Error(f"Unsupported execution protocol {to_string(value.get('protocolVersion', UNDEFINED))}.")
    if value.get("action") not in ("run", "resume"):
        raise Error("Worker invocation action must be run or resume.")
    request = value.get("request")
    if not isinstance(request, dict) or not isinstance(request.get("manifest"), dict):
        raise Error("Worker invocation requires a manifest-bearing request.")
    manifest = parse_agent_manifest(request["manifest"])
    if request.get("runId") is not None:
        _require_non_empty_string(request["runId"], "Worker request runId")
    if request.get("variables") is not None:
        parse_agent_variable_overrides(request["variables"])
    if request.get("execution") is not None:
        zod_parse(agent_run_execution_schema, request["execution"])
    if request.get("budget") is not None:
        zod_parse(agent_run_budget_schema, request["budget"])
    if request.get("messages") is not None:
        parse_conversation_messages(request["messages"])
    if request.get("messagesSignature") is not None:
        zod_parse(messages_signature_schema, request["messagesSignature"])
    if request.get("messagesScope") is not None and not isinstance(request["messagesScope"], str):
        raise Error("Worker request messagesScope must be a string.")
    if request.get("configuration") is not None and not isinstance(request["configuration"], dict):
        raise Error("Worker request configuration must be an object.")
    if request.get("timeoutMs") is not None and (
        not _is_safe_integer(request["timeoutMs"]) or request["timeoutMs"] <= 0
    ):
        raise Error("Worker request timeoutMs must be a positive safe integer.")
    if value["action"] == "resume":
        if request.get("variables") is not None:
            raise Error("Resume request cannot include run variable overrides.")
        if any(request.get(key) is not None for key in ("messages", "messagesSignature", "messagesScope")):
            raise Error("Resume request cannot include conversation messages.")
        _require_non_empty_string(request.get("runId"), "Resume request runId")
        if not _is_safe_integer(request.get("attempt")) or request["attempt"] < 2:
            raise Error("Resume request attempt must be an integer greater than one.")
        if request.get("checkpoint") is None and request.get("checkpointReference") is None:
            raise Error("Resume request requires checkpoint or checkpointReference.")
        if request.get("checkpoint") is not None:
            parse_run_checkpoint(request["checkpoint"])
        if request.get("checkpointReference") is not None:
            _require_non_empty_string(request["checkpointReference"], "Resume checkpointReference")
    cloned = copy.deepcopy(value)
    cloned["request"]["manifest"] = manifest
    if value["action"] == "run" and request.get("variables") is not None:
        cloned["request"]["variables"] = parse_agent_variable_overrides(request["variables"])
    if value["action"] == "run" and request.get("messages") is not None:
        cloned["request"]["messages"] = parse_conversation_messages(request["messages"])
    if value["action"] == "resume" and request.get("checkpoint") is not None:
        cloned["request"]["checkpoint"] = parse_run_checkpoint(request["checkpoint"])
    return cloned


def _validate_event(value: Any) -> None:
    if not isinstance(value, dict):
        raise Error("Worker event message requires an event object.")
    for key in ("id", "runId", "timestamp", "type"):
        _require_non_empty_string(value.get(key), f"Worker event {key}")
    if not _is_safe_integer(value.get("sequence")) or value["sequence"] < 1:
        raise Error("Worker event sequence must be a positive safe integer.")
    if value.get("attempt") is not None and (not _is_safe_integer(value["attempt"]) or value["attempt"] < 1):
        raise Error("Worker event attempt must be a positive safe integer.")


def _validate_result(value: Any) -> None:
    if not isinstance(value, dict):
        raise Error("Worker result message requires a result object.")
    _require_non_empty_string(value.get("runId"), "Worker result runId")
    if not isinstance(value.get("state"), dict):
        raise Error("Worker result state must be an object.")
    for field in ("stepResults", "transcript", "artifacts"):
        if not isinstance(value.get(field), list):
            raise Error(f"Worker result {field} must be an array.")
    _require_non_empty_string(value.get("startedAt"), "Worker result startedAt")
    _require_non_empty_string(value.get("completedAt"), "Worker result completedAt")


def parse_worker_message(value: Any) -> JsonObject:
    if isinstance(value, str):
        value = js_json.parse(value)
    if not isinstance(value, dict):
        raise Error("Worker message must be an object.")
    if value.get("protocolVersion") != EXECUTION_PROTOCOL_VERSION:
        raise Error(f"Unsupported execution protocol {to_string(value.get('protocolVersion', UNDEFINED))}.")
    if to_string(value.get("type", UNDEFINED)) not in ("ready", "event", "status", "result", "error"):
        raise Error(f"Unsupported worker message type {to_string(value.get('type', UNDEFINED))}.")
    if value["type"] == "event":
        _validate_event(value.get("event"))
    if value["type"] == "result":
        _validate_result(value.get("result"))
    if value["type"] == "error":
        error = value.get("error")
        if not isinstance(error, dict):
            raise Error("Worker error message requires an error object.")
        _require_non_empty_string(error.get("code"), "Worker error code")
        if not isinstance(error.get("message"), str):
            raise Error("Worker error message must be a string.")
    return copy.deepcopy(value)
