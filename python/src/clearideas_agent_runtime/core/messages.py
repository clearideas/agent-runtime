"""Conversation messages (``packages/core/src/messages.ts``).

Canonical signing, selection, the variable view, pre-creation validation, and
compaction planning for the history an agent manifest declares it accepts.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import math
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.base64 import atob, from_base64url, to_base64url
from .._js.errors import Error
from .._js.ops import UNDEFINED
from ..contracts import (
    MESSAGES_SIGNATURE_ALGORITHM,
    MESSAGES_SIGNATURE_VERSION,
    MESSAGES_VARIABLE,
    conversation_messages_input_schema,
    messages_marker_of,
    safe_parse,
)
from .templates import compile_prompt_template

JsonObject = dict[str, Any]

# ─── Errors ─────────────────────────────────────────────────────────────────


class MessagesValidationError(Error):
    """A supplied history was refused before the run was created."""

    name = "MessagesValidationError"
    retryable = False

    def __init__(self, code: str, message: str, reason: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.reason = reason


# ─── Canonical JSON (RFC 8785) ──────────────────────────────────────────────

canonical_json = js_json.canonical_json

# ─── Signing ────────────────────────────────────────────────────────────────

SIGNING_DOMAIN = "clearideas-agent-runtime/messages/v1\n"
MINIMUM_SIGNING_KEY_BYTES = 32


def messages_signing_payload(messages: list[JsonObject], scope: str | None) -> str:
    """The exact text a messages signature authenticates."""
    return SIGNING_DOMAIN + canonical_json(
        {"version": MESSAGES_SIGNATURE_VERSION, "scope": scope, "messages": messages}
    )


class MessageHistorySigner(Protocol):
    async def sign(self, messages: list[JsonObject], scope: str | None = None) -> JsonObject: ...
    async def verify(
        self, messages: list[JsonObject], signature: JsonObject, scope: str | None = None
    ) -> JsonObject: ...


def parse_message_signing_key(value: str | bytes) -> bytes:
    """Decode a signing key without accepting ambiguous raw strings."""
    if not isinstance(value, str):
        key = bytes(value)
    elif value.startswith("base64:"):
        encoded = value[len("base64:") :]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
            raise Error("Base64 message signing keys must use base64url.")
        key = from_base64url(encoded)
    elif value.startswith("hex:"):
        encoded = value[len("hex:") :]
        if not re.fullmatch(r"(?:[A-Fa-f0-9]{2})+", encoded):
            raise Error("Hex message signing keys must contain hex byte pairs.")
        key = bytes.fromhex(encoded)
    else:
        raise Error("String message signing keys must start with base64: or hex:.")
    if len(key) < MINIMUM_SIGNING_KEY_BYTES:
        raise Error(f"Message signing keys must contain at least {MINIMUM_SIGNING_KEY_BYTES} bytes.")
    return key


class HmacMessageSigner:
    """HMAC-SHA-256 signer over RFC 8785 canonical JSON."""

    def __init__(self, active_key_id: str, keys: dict[str, str | bytes]) -> None:
        self._keys: dict[str, bytes] = {}
        for key_id, value in keys.items():
            if not key_id:
                raise Error("Message signing key ids cannot be empty.")
            self._keys[key_id] = parse_message_signing_key(value)
        if active_key_id not in self._keys:
            raise Error(f"The active message signing key {active_key_id} is not configured.")
        self._active = active_key_id

    def _mac(self, key_id: str, messages: list[JsonObject], scope: str | None) -> bytes:
        payload = messages_signing_payload(messages, scope).encode("utf-8", "surrogatepass")
        return hmac.new(self._keys[key_id], payload, hashlib.sha256).digest()

    async def sign(self, messages: list[JsonObject], scope: str | None = None) -> JsonObject:
        return {
            "version": MESSAGES_SIGNATURE_VERSION,
            "algorithm": MESSAGES_SIGNATURE_ALGORITHM,
            "keyId": self._active,
            "count": len(messages),
            "value": to_base64url(self._mac(self._active, messages, scope)),
        }

    async def verify(self, messages: list[JsonObject], signature: JsonObject, scope: str | None = None) -> JsonObject:
        # A host may pass a browser-supplied value: anything but an object has no key id.
        key_id = signature.get("keyId") if isinstance(signature, dict) else None
        if not isinstance(key_id, str) or key_id not in self._keys:
            return {"valid": False, "reason": "unknown-key"}
        if (
            signature.get("version") != MESSAGES_SIGNATURE_VERSION
            or signature.get("algorithm") != MESSAGES_SIGNATURE_ALGORITHM
            or signature.get("count") != len(messages)
        ):
            return {"valid": False, "reason": "authentication-failed"}
        try:
            mac = from_base64url(signature.get("value") or "")
        except ValueError:
            return {"valid": False, "reason": "authentication-failed"}
        if hmac.compare_digest(mac, self._mac(key_id, messages, scope)):
            return {"valid": True}
        return {"valid": False, "reason": "authentication-failed"}


def create_hmac_message_signer(active_key_id: str, keys: dict[str, str | bytes]) -> HmacMessageSigner:
    return HmacMessageSigner(active_key_id, keys)


# ─── History structure ──────────────────────────────────────────────────────


def declares_messages(manifest: JsonObject) -> bool:
    return manifest.get("messages") is not None


def history_bytes(value: Any) -> int:
    """UTF-8 bytes of a value's JSON, the measure ``maxBytes`` uses."""
    return js_json.byte_length(value)


def history_marker(history: list[JsonObject]) -> JsonObject | None:
    return messages_marker_of(history[0]) if history else None


def new_turn_start(history: list[JsonObject]) -> int:
    """Index where the new turn starts (trailing user messages after the last reply)."""
    first = 1 if history_marker(history) else 0
    index = len(history)
    while index > first and history[index - 1]["role"] == "user":
        index -= 1
    return index


def media_placeholder(part: JsonObject) -> str:
    artifact = part.get("artifact") or {}
    name = (part.get("name") if part["type"] == "file" else None) or artifact.get("name")
    media_type = part.get("mediaType") or artifact.get("mediaType")
    detail = " ".join(value for value in [name, f"({media_type})" if media_type else None] if value)
    return f"[{part['type']}{': ' + detail if detail else ''}]"


def _part_text(part: JsonObject) -> str:
    kind = part["type"]
    if kind == "text":
        return part["text"]
    if kind == "json":
        return js_json.stringify(part["value"])
    return media_placeholder(part)


def message_text(message: JsonObject) -> str:
    """A message as plain text: text parts, stringified JSON, and media placeholders."""
    return "\n".join(_part_text(part) for part in message["content"])


def marker_body(message: JsonObject) -> str:
    """The marker's text without its preamble: the summary, or the note."""
    marker = messages_marker_of(message)
    texts = [part["text"] for part in message["content"] if part["type"] == "text"]
    if marker and marker["kind"] == "summary" and len(texts) > 1:
        return "\n".join(texts[1:])
    return "\n".join(texts)


# ─── Turns ──────────────────────────────────────────────────────────────────


@dataclass
class ConversationTurns:
    current_turn: int
    summarized: JsonObject | None
    places: list[JsonObject | None]


def conversation_turns(history: list[JsonObject]) -> ConversationTurns:
    marker = history_marker(history)
    covered_turns = (marker or {}).get("turns") or 0
    covered_messages = (marker or {}).get("replaces") or 0
    first = 1 if marker else 0
    replies = 0
    places: list[JsonObject | None] = []
    for index, message in enumerate(history):
        if index < first:
            places.append(None)
            continue
        position = covered_messages + index - first + 1
        if message["role"] == "assistant":
            replies += 1
            places.append({"turn": covered_turns + replies, "position": position})
        else:
            places.append({"turn": covered_turns + replies + 1, "position": position})
    return ConversationTurns(
        current_turn=covered_turns + replies + 1,
        summarized={"turns": covered_turns, "messages": covered_messages} if marker else None,
        places=places,
    )


def turn_range(first: int, last: int) -> str:
    return f"turn {last}" if first == last else f"turns {first}–{last}"


def render_history_text(messages: list[JsonObject], places: list[JsonObject | None] | None = None) -> str:
    """A history as plain text, in the format of ``messages.text``."""
    if places is None:
        places = conversation_turns(messages).places
    lines = []
    for index, message in enumerate(messages):
        marker = messages_marker_of(message) if index == 0 else None
        if marker and marker["kind"] == "summary":
            turns = marker.get("turns") or 0
            covered = turn_range(1, turns) if turns > 0 else "the earlier conversation"
            lines.append(f"[Summary of {covered}]\n{marker_body(message)}")
            continue
        if marker and marker["kind"] == "note":
            lines.append(marker_body(message))
            continue
        place = places[index] if index < len(places) else None
        suffix = f" (turn {place['turn']})" if place else ""
        lines.append(f"{message['role']}{suffix}: {message_text(message)}")
    return "\n\n".join(lines)


# ─── Selection and the messages variable ────────────────────────────────────


@dataclass
class HistorySelection:
    messages: list[JsonObject]
    places: list[JsonObject | None]
    current_turn: int
    summarized: JsonObject | None
    explicit: bool
    insert: bool
    media: str


def _apply_media_mode(messages: list[JsonObject], media: str) -> list[JsonObject]:
    if media == "include":
        return messages
    keep = -1
    if media == "latest":
        for index in range(len(messages) - 1, -1, -1):
            if messages[index]["role"] == "user" and not messages_marker_of(messages[index]):
                keep = index
                break
    result = []
    for index, message in enumerate(messages):
        if index == keep or not any(part["type"] in ("image", "file") for part in message["content"]):
            result.append(message)
            continue
        content = []
        for part in message["content"]:
            if part["type"] in ("image", "file"):
                replaced: JsonObject = {"type": "text", "text": media_placeholder(part)}
                if part.get("metadata"):
                    replaced["metadata"] = part["metadata"]
                content.append(replaced)
            else:
                content.append(part)
        result.append({**message, "content": content})
    return result


def select_history(history: list[JsonObject], setting: Any) -> HistorySelection:
    """Apply a step's ``history`` setting to the effective history."""
    options = {} if setting == "all" else (setting or {})
    turns = conversation_turns(history)
    marker = history[0] if history_marker(history) else None
    first = 1 if marker is not None else 0
    last = options.get("last")
    start = max(first, len(history) - last) if last is not None else first
    summary = options.get("summary")
    include_marker = marker is not None and (summary if summary is not None else last is None)
    media = options.get("media") or "include"
    selected = ([marker] if include_marker else []) + history[start:]
    return HistorySelection(
        messages=_apply_media_mode(copy.deepcopy(selected), media),  # pyright: ignore[reportArgumentType]
        places=([None] if include_marker else []) + turns.places[start:],
        current_turn=turns.current_turn,
        summarized=turns.summarized,
        explicit=setting is not None,
        insert=setting is not None and options.get("insert") is not False,
        media=media,
    )


def _role_text(message: JsonObject | None, place: JsonObject | None) -> Any:
    if message is None:
        return None
    value: JsonObject = {"role": message["role"], "text": message_text(message)}
    if place:
        value["turn"] = place["turn"]
        value["position"] = place["position"]
    return value


def messages_view(selection: HistorySelection) -> JsonObject:
    """The read-only ``messages`` variable for one step's selection."""
    has_marker = bool(selection.messages) and messages_marker_of(selection.messages[0]) is not None
    marker = selection.messages[0] if has_marker else None
    all_messages = selection.messages[1:] if has_marker else selection.messages
    places = selection.places[1:] if has_marker else selection.places
    last_user_index = len(all_messages) - 1
    while last_user_index >= 0 and all_messages[last_user_index]["role"] != "user":
        last_user_index -= 1
    entries = []
    for index, message in enumerate(all_messages):
        entry = copy.deepcopy(message)
        place = places[index] if index < len(places) else None
        if place:
            entry["turn"] = place["turn"]
            entry["position"] = place["position"]
        entries.append(entry)
    return {
        "all": entries,
        "count": len(all_messages),
        "turn": selection.current_turn,
        "last": _role_text(all_messages[-1] if all_messages else None, places[-1] if places else None),
        "lastUser": _role_text(all_messages[last_user_index], places[last_user_index])
        if last_user_index >= 0
        else None,
        "summary": marker_body(marker) if marker else None,
        "summarized": {**selection.summarized} if selection.summarized else None,
        "text": render_history_text(selection.messages, selection.places),
    }


def _is_messages_key(key: str) -> bool:
    return js_strings.lower(key) == MESSAGES_VARIABLE


def with_messages_view(manifest: JsonObject, variables: JsonObject, selection: HistorySelection | None) -> JsonObject:
    base = without_messages_view(manifest, variables)
    if not declares_messages(manifest) or selection is None:
        return base
    return {**base, MESSAGES_VARIABLE: messages_view(selection)}


def without_messages_view(manifest: JsonObject, variables: JsonObject) -> JsonObject:
    if not declares_messages(manifest):
        return {**variables}
    return {key: value for key, value in variables.items() if not _is_messages_key(key)}


def without_messages_patch(manifest: JsonObject, patch: JsonObject | None) -> JsonObject | None:
    """A state patch that cannot write the ``messages`` view into run state."""
    if not patch or not declares_messages(manifest):
        return patch
    result: JsonObject = {}
    if patch.get("set") is not None:
        result["set"] = {key: value for key, value in patch["set"].items() if not _is_messages_key(key)}
    if patch.get("unset") is not None:
        result["unset"] = [path for path in patch["unset"] if not _is_messages_key(js_strings.trim(path.split(".")[0]))]
    return result


def output_history(history: list[JsonObject], output: Any = UNDEFINED) -> list[JsonObject]:
    """The effective history plus the final output (when defined) as assistant text."""
    result = copy.deepcopy(history)
    if output is not UNDEFINED:
        text = output if isinstance(output, str) else js_json.stringify(output)
        result.append({"role": "assistant", "content": [{"type": "text", "text": text}]})
    return result


# ─── Host options ───────────────────────────────────────────────────────────


MESSAGES_DEFAULTS = {"maxInlineBytes": 10 * 1024 * 1024, "maxSuppliedMessages": 500, "maxSuppliedBytes": 2_000_000}


@dataclass
class MessagesOptions:
    """Host configuration for conversation messages (``AgentRuntimeMessagesOptions``)."""

    signer: Any = None
    require_signature: bool | None = None
    authorize_artifact: Callable[[JsonObject, JsonObject], bool | Awaitable[bool]] | None = None
    max_inline_bytes: int | None = None
    max_supplied_messages: int | None = None
    max_supplied_bytes: int | None = None
    compactor: Any = None


@dataclass
class MessageHistoryCompactionRequest:
    run_id: str
    manifest: JsonObject
    text: str
    label: str
    task: str
    segment_bytes: int
    max_target_bytes: int
    policies: JsonObject
    checkpoint: Callable[[JsonObject, list[JsonObject]], Awaitable[None]]
    emit: Callable[..., Awaitable[JsonObject]]
    model: Any = None
    summarizer: Any = None
    token_budget: Any = None
    journal: JsonObject | None = None
    signal: Any = None


# ─── Compaction planning ────────────────────────────────────────────────────

MARKER_RESERVE_BYTES = 1_024
MARKER_OVERHEAD_BYTES = 400


@dataclass
class HistoryCompactionPlan:
    reason: str
    segment: list[JsonObject]
    retained: list[JsonObject]
    previous: JsonObject | None
    replaced_messages: int
    replaced_turns: int
    marker_bytes: float = field(default=0)


def compaction_reason(history: list[JsonObject], manifest: JsonObject) -> str | None:
    declaration = manifest.get("messages")
    if not declaration:
        return None
    if declaration.get("maxMessages") is not None and len(history) > declaration["maxMessages"]:
        return "message-count"
    if declaration.get("maxBytes") is not None and history_bytes(history) > declaration["maxBytes"]:
        return "input-size"
    return None


def new_turn_exceeds_triggers(history: list[JsonObject], manifest: JsonObject) -> bool:
    declaration = manifest.get("messages")
    if not declaration:
        return False
    new_turn = history[new_turn_start(history) :]
    return (declaration.get("maxMessages") is not None and len(new_turn) > declaration["maxMessages"]) or (
        declaration.get("maxBytes") is not None and history_bytes(new_turn) > declaration["maxBytes"]
    )


def plan_history_compaction(
    history: list[JsonObject], manifest: JsonObject, reduce_to: float
) -> HistoryCompactionPlan | None:
    reason = compaction_reason(history, manifest)
    if not reason:
        return None
    declaration = manifest["messages"]
    previous = history_marker(history)
    first = 1 if previous else 0
    turn_start = new_turn_start(history)
    new_turn = history[turn_start:]
    middle = history[first:turn_start]
    count_target: float = (
        max(len(new_turn) + 1, math.floor(declaration["maxMessages"] * reduce_to))
        if declaration.get("maxMessages") is not None
        else math.inf
    )
    bytes_target: float = (
        math.floor(declaration["maxBytes"] * reduce_to) if declaration.get("maxBytes") is not None else math.inf
    )
    reserve = (
        min(MARKER_RESERVE_BYTES, math.floor(bytes_target / 4)) if math.isfinite(bytes_target) else MARKER_RESERVE_BYTES
    )

    def ends_turn(cut: int) -> bool:
        return cut == 0 or middle[cut - 1]["role"] == "assistant"

    keep = 0
    for next_count in range(1, len(middle) + 1):
        candidate = middle[len(middle) - next_count :] + new_turn
        if 1 + len(candidate) > count_target:
            break
        if history_bytes(candidate) + reserve > bytes_target:
            break
        if ends_turn(len(middle) - next_count):
            keep = next_count
    recent = middle[len(middle) - keep :] if keep > 0 else []
    older = middle[: len(middle) - keep]
    if len(older) == 0 and not previous:
        return None
    retained = recent + new_turn
    room = bytes_target - history_bytes(retained) - MARKER_OVERHEAD_BYTES if math.isfinite(bytes_target) else math.inf
    return HistoryCompactionPlan(
        reason=reason,
        segment=history[: first + len(older)],
        retained=copy.deepcopy(retained),
        previous=previous,
        replaced_messages=len(older),
        replaced_turns=sum(1 for message in older if message["role"] == "assistant"),
        marker_bytes=max(256, room),
    )


def _marker_values(turns: int, messages: int) -> JsonObject:
    return {
        "context": {
            "firstTurn": 1 if turns > 0 else 0,
            "lastTurn": turns,
            "turns": ("1" if turns == 1 else f"1–{turns}") if turns > 0 else "",
            "messages": messages,
        }
    }


def _summary_heading(turns: int, messages: int, template: str | None) -> str:
    if template:
        return compile_prompt_template(template, _marker_values(turns, messages))
    covered = f"{turn_range(1, turns)} of this conversation" if turns > 0 else "the earlier conversation"
    return f"[Summary of {covered}, written by Agent Runtime to fit the context window. It replaces {messages} earlier messages.]"


def _note_text(turns: int, messages: int, template: str | None) -> str:
    if template:
        return compile_prompt_template(template, _marker_values(turns, messages))
    if turns > 0:
        return f"[Agent Runtime removed {turn_range(1, turns)} ({messages} messages) of this conversation to fit the context window.]"
    return f"[Agent Runtime removed {messages} earlier messages of this conversation to fit the context window.]"


def compaction_label(plan: HistoryCompactionPlan) -> str:
    turns = ((plan.previous or {}).get("turns") or 0) + plan.replaced_turns
    return f"{turn_range(1, turns)} of the conversation" if turns > 0 else f"{plan.replaced_messages} earlier messages"


def _marker_metadata(marker: JsonObject) -> JsonObject:
    return {"agentRuntime": {"messages": {**marker}}}


def summary_marker_message(plan: HistoryCompactionPlan, summary: str, wording: JsonObject | None = None) -> JsonObject:
    wording = wording or {}
    previous = plan.previous or {}
    marker = {
        "kind": "summary",
        "replaces": (previous.get("replaces") or 0) + plan.replaced_messages,
        "turns": (previous.get("turns") or 0) + plan.replaced_turns,
        "sequence": (previous.get("sequence") or 0) + 1,
        "strategy": "summarize",
    }
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": _summary_heading(marker["turns"], marker["replaces"], wording.get("summary"))},
            {"type": "text", "text": summary},
        ],
        "metadata": _marker_metadata(marker),
    }


def _clip_text(text: str, max_bytes: float) -> str:
    if history_bytes(text) <= max_bytes:
        return text
    suffix = " [...]"
    end = js_strings.length(text)
    while end > 0 and history_bytes(js_strings.slice(text, 0, end)) + 8 > max_bytes:
        end = math.floor(end * 0.9)
    return f"{js_strings.slice(text, 0, end)}{suffix}"


def prune_marker_message(
    plan: HistoryCompactionPlan, segment_first: JsonObject | None, wording: JsonObject | None = None
) -> JsonObject:
    wording = wording or {}
    previous = plan.previous or {}
    replaces = (previous.get("replaces") or 0) + plan.replaced_messages
    turns = (previous.get("turns") or 0) + plan.replaced_turns
    sequence = (previous.get("sequence") or 0) + 1
    if previous.get("kind") == "summary" and segment_first is not None:
        marker = {"kind": "summary", "replaces": replaces, "turns": turns, "sequence": sequence, "strategy": "prune"}
        return {
            "role": "user",
            "content": [
                {"type": "text", "text": _summary_heading(turns, replaces, wording.get("summary"))},
                {"type": "text", "text": _clip_text(marker_body(segment_first), plan.marker_bytes)},
            ],
            "metadata": _marker_metadata(marker),
        }
    return {
        "role": "user",
        "content": [{"type": "text", "text": _note_text(turns, replaces, wording.get("note"))}],
        "metadata": _marker_metadata(
            {"kind": "note", "replaces": replaces, "turns": turns, "sequence": sequence, "strategy": "prune"}
        ),
    }


# ─── Validation before the run is created ───────────────────────────────────


@dataclass
class PreparedHistory:
    history: list[JsonObject]
    signed_count: int
    verified: bool
    ingested_artifacts: int
    compaction: str


def _fail(code: str, message: str, reason: str | None = None) -> Any:
    raise MessagesValidationError(code, message, reason)


def _without_inline_data(value: Any) -> Any:
    if isinstance(value, list):
        return [_without_inline_data(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "" if key == "data" and isinstance(item, str) else _without_inline_data(item)
            for key, item in value.items()
        }
    return value


def _base64_bytes(value: str) -> bytes:
    try:
        return atob(re.sub(r"\s+", "", value))
    except ValueError:
        return _fail("MESSAGES_INVALID", "Inline message media must be valid base64.")


def _model_key(reference: JsonObject | None) -> str | None:
    if reference is None:
        return None
    if "ref" in reference:
        return f"ref/{reference['ref']}"
    return f"{reference['provider']}/{reference['model']}"


def _prompt_steps_with_history(steps: list[JsonObject]) -> list[JsonObject]:
    found: list[JsonObject] = []
    for step in steps:
        if step["type"] == "loop":
            found += _prompt_steps_with_history(step["steps"])
        elif step["type"] == "prompt" and "history" in step:
            found.append(step)
    return found


def _path_text(path: list[Any]) -> str:
    from .._js.ops import to_string

    return ".".join(to_string(segment) for segment in path)


async def prepare_supplied_history(
    *,
    run_id: str,
    manifest: JsonObject,
    messages: Any,
    options: MessagesOptions,
    strategy: str,
    signature: JsonObject | None = None,
    scope: str | None = None,
    artifacts: Any = None,
    describe_model: Callable[[str], Awaitable[JsonObject | None]] | None = None,
    messages_supplied: bool = True,
) -> PreparedHistory | None:
    """Validate, verify, authorize, and ingest a supplied history before the run exists."""
    declaration = manifest.get("messages")
    if declaration is None:
        if (messages_supplied and messages is not None) or signature is not None:
            _fail(
                "MESSAGES_NOT_ACCEPTED",
                "Conversation messages were supplied, but the agent manifest does not declare messages.",
            )
        return None

    max_messages = (
        options.max_supplied_messages
        if options.max_supplied_messages is not None
        else MESSAGES_DEFAULTS["maxSuppliedMessages"]
    )
    max_bytes = (
        options.max_supplied_bytes if options.max_supplied_bytes is not None else MESSAGES_DEFAULTS["maxSuppliedBytes"]
    )
    if isinstance(messages, list) and len(messages) > max_messages:
        _fail(
            "MESSAGES_LIMIT_EXCEEDED",
            f"The conversation has {len(messages)} messages, exceeding the host limit of {max_messages}.",
        )
    if messages is not None and history_bytes(_without_inline_data(messages)) > max_bytes:
        _fail("MESSAGES_LIMIT_EXCEEDED", f"The conversation exceeds the host limit of {max_bytes} bytes.")

    parsed = safe_parse(conversation_messages_input_schema, messages if messages is not None else [])
    if not parsed.success:
        assert parsed.error is not None
        reasons = "; ".join(
            f"{_path_text(issue['path'])}: {issue['message']}" if issue["path"] else issue["message"]
            for issue in parsed.error.issues
        )
        _fail("MESSAGES_INVALID", f"Conversation messages are invalid: {reasons}")
    history: list[JsonObject] = copy.deepcopy(parsed.data)
    if declaration.get("required") is True and len(history) == 0:
        _fail("MESSAGES_REQUIRED", "The agent requires conversation messages, and none were supplied.")

    required = declaration.get("requireSignature") is True or options.require_signature is True
    turn_start = new_turn_start(history)
    signed_count = 0
    if signature:
        if not options.signer:
            _fail(
                "MESSAGES_SIGNATURE_INVALID",
                "A conversation signature was supplied, but no message signer is configured.",
                "no-signer",
            )
        if signature["count"] > len(history):
            _fail(
                "MESSAGES_SIGNATURE_INVALID",
                "The conversation signature covers more messages than were supplied.",
                "authentication-failed",
            )
        verification = await options.signer.verify(history[: signature["count"]], signature, scope)
        if not verification.get("valid"):
            reason = verification.get("reason")
            _fail("MESSAGES_SIGNATURE_INVALID", f"The conversation signature is invalid ({reason}).", reason)
        if any(message["role"] != "user" for message in history[signature["count"] :]):
            _fail(
                "MESSAGES_SIGNATURE_INVALID",
                "Only user messages may follow the signed part of a conversation.",
                "unsigned-assistant",
            )
        signed_count = signature["count"]
    elif required and turn_start > 0:
        _fail(
            "MESSAGES_SIGNATURE_REQUIRED",
            "The conversation must be signed: only a first turn of user messages may be unsigned.",
        )

    inline: list[tuple[int, int]] = []
    for message_index, message in enumerate(history):
        for part_index, part in enumerate(message["content"]):
            if part["type"] not in ("image", "file"):
                continue
            if "data" in part:
                if artifacts is None:
                    _fail("MESSAGES_INVALID", "Inline message media requires an ArtifactStore.")
                size = len(_base64_bytes(part["data"]))
                limit = (
                    options.max_inline_bytes
                    if options.max_inline_bytes is not None
                    else MESSAGES_DEFAULTS["maxInlineBytes"]
                )
                if size > limit:
                    _fail(
                        "MESSAGES_LIMIT_EXCEEDED",
                        f"Inline message media is {size} bytes, exceeding the host limit of {limit}.",
                    )
                inline.append((message_index, part_index))
                continue
            artifact = part.get("artifact")
            if not artifact:
                continue
            if artifacts is None:
                _fail("MESSAGES_INVALID", "Message media artifact references require an ArtifactStore.")
            if not artifact.get("sha256"):
                _fail("MESSAGES_INVALID", f"Message media artifact {artifact['id']} requires sha256.")
            if message_index < signed_count:
                continue
            authorized: Any = False
            if options.authorize_artifact is not None:
                authorized = options.authorize_artifact(artifact, {"runId": run_id, "scope": scope})
                if hasattr(authorized, "__await__"):
                    authorized = await authorized
            if authorized is not True:
                _fail(
                    "MESSAGES_ARTIFACT_UNAUTHORIZED",
                    f"Message media artifact {artifact['id']} is not authorized for this run.",
                )

    if describe_model is not None:
        for step in _prompt_steps_with_history(manifest["steps"]):
            selection = select_history(history, step.get("history"))
            if not selection.insert or selection.media == "omit":
                continue
            if not any(part["type"] == "image" for message in selection.messages for part in message["content"]):
                continue
            key = _model_key(step.get("model") or manifest.get("model"))
            if not key:
                continue
            try:
                description = await describe_model(key)
            except Exception:
                description = None
            if description is not None and description.get("imageInput") is False:
                _fail(
                    "MESSAGES_MEDIA_UNSUPPORTED",
                    f"Step {step['id']} would send images to {key}, which is declared without image input; set history.media to omit.",
                )

    if new_turn_exceeds_triggers(history, manifest):
        _fail("MESSAGES_LIMIT_EXCEEDED", "The newest user messages alone exceed the conversation's declared limits.")
    reason = compaction_reason(history, manifest)
    if reason and strategy == "fail":
        limit_name = "maxMessages" if reason == "message-count" else "maxBytes"
        _fail(
            "MESSAGES_LIMIT_EXCEEDED",
            f"The conversation exceeds its declared {limit_name}, and its context strategy is fail.",
        )

    for message_index, part_index in inline:
        message = history[message_index]
        part = message["content"][part_index]
        name = (
            part.get("name") if part["type"] == "file" else None
        ) or f"message-{message_index + 1}-part-{part_index + 1}"
        ref = await artifacts.put(
            {
                "name": name,
                "mediaType": part["mediaType"],
                "data": _base64_bytes(part["data"]),
                "metadata": {"source": "messages", "runId": run_id},
            }
        )
        rest = {key: value for key, value in part.items() if key not in ("data", "url")}
        message["content"][part_index] = {**rest, "artifact": ref}

    return PreparedHistory(
        history=history,
        signed_count=signed_count,
        verified=signature is not None,
        ingested_artifacts=len(inline),
        compaction="pending" if reason else "complete",
    )
