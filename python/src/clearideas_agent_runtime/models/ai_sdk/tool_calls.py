"""``StreamingToolCallTracker`` (provider-utils): streamed Chat Completions tool calls.

Accumulates ``tool_calls`` deltas by wire id and index, emits
``tool-input-start``/``tool-input-delta`` as deltas arrive, and finishes every
call (``tool-input-end`` and ``tool-call``) when the stream is flushed.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..._js import strings as js_strings
from ..._js.regex import WS
from .core import JsonObject

_WHITESPACE = re.compile(WS)


def _starts_structured(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    stripped = js_strings.trim_start(value)
    return bool(stripped) and stripped[0] in "{["


class ArgumentState:
    """``StreamingToolCallArgumentState``: whether the arguments hold a complete JSON object or array."""

    def __init__(self, initial: str = "") -> None:
        self.kind = "undetermined"
        self.stack: list[str] = []
        self.in_string = False
        self.escaped = False
        self.complete = False
        self.append(initial)

    @property
    def has_complete_structured_value(self) -> bool:
        return self.kind == "structured" and self.complete

    def append(self, delta: str) -> None:
        for character in delta:
            if self.kind == "undetermined":
                if _WHITESPACE.match(character):
                    continue
                if character not in "{[":
                    self.kind = "other"
                    continue
                self.kind = "structured"
                self.stack = [character]
                self.in_string = False
                self.escaped = False
                self.complete = False
                continue
            if self.kind != "structured" or self.complete:
                continue
            if self.in_string:
                if self.escaped:
                    self.escaped = False
                elif character == "\\":
                    self.escaped = True
                elif character == '"':
                    self.in_string = False
                continue
            if character == '"':
                self.in_string = True
            elif character in "{[":
                self.stack.append(character)
            elif character in "}]":
                expected = "{" if character == "}" else "["
                if not self.stack or self.stack[-1] != expected:
                    self.kind = "other"
                    continue
                self.stack.pop()
                if not self.stack:
                    self.complete = True


@dataclass(eq=False)
class _ToolCall:
    id: str
    index: Any
    sequence: int
    name: str
    arguments: str
    state: ArgumentState
    metadata: Any = None
    finished: bool = False


class InvalidResponseDataError(Exception):
    name = "AI_InvalidResponseDataError"


@dataclass
class ToolCallTracker:
    emit: Callable[[JsonObject], None]
    generate_id: Callable[[], str]
    type_validation: str = "none"
    extract_metadata: Callable[[JsonObject], Any] | None = None
    build_metadata: Callable[[Any], Any] | None = None
    calls: list[_ToolCall] = field(default_factory=list)
    by_id: dict[str, list[_ToolCall]] = field(default_factory=dict)
    by_index: dict[Any, list[_ToolCall]] = field(default_factory=dict)
    used_ids: set[str] = field(default_factory=set)
    suffixes: dict[str, int] = field(default_factory=dict)

    @staticmethod
    def _non_blank(value: Any) -> str | None:
        return value if isinstance(value, str) and js_strings.trim(value) else None

    def process_delta(self, delta: JsonObject) -> None:
        function = delta.get("function") or {}
        wire_name = function.get("name")
        blank_name = isinstance(wire_name, str) and not js_strings.trim(wire_name)
        wire_id = self._non_blank(delta.get("id"))
        name = self._non_blank(wire_name)
        arguments = function.get("arguments")
        index = delta.get("index")
        kind, call = self._resolve(
            wire_id,
            index,
            name,
            name is not None and _starts_structured(arguments),
            arguments is None or not js_strings.trim(arguments),
        )
        if kind == "ambiguous":
            return
        if kind == "new":
            if blank_name:
                return
            call = self._new(delta, wire_id, index, name)
        else:
            assert call is not None
            if wire_id is not None:
                self._associate(self.by_id, wire_id, call)
            self._existing(call, delta)
        if index is not None:
            self._associate(self.by_index, index, call)

    def flush(self) -> None:
        calls = (
            sorted(self.calls, key=lambda call: (call.index, call.sequence))
            if all(call.index is not None for call in self.calls)
            else list(self.calls)
        )
        for call in calls:
            if not call.finished:
                self._finish(call)

    @staticmethod
    def _associate(table: dict[Any, list[_ToolCall]], key: Any, call: _ToolCall) -> None:
        entries = table.setdefault(key, [])
        if call not in entries:
            entries.append(call)

    def _by_name(self, calls: list[_ToolCall] | None, name: str | None) -> list[_ToolCall]:
        if calls is None:
            return []
        return [call for call in calls if name is None or call.name == name]

    def _resolve(
        self, wire_id: str | None, index: Any, name: str | None, explicit_start: bool, empty_arguments: bool
    ) -> tuple[str, _ToolCall | None]:
        indexed = self.by_index.get(index) if index is not None else None
        matching_indexed = self._by_name(indexed, name)
        if wire_id is not None:
            with_id = self.by_id.get(wire_id)
            if with_id is not None:
                if index is not None:
                    matching = [call for call in matching_indexed if call in with_id]
                    result = self._matching(matching, explicit_start)
                    if result[0] != "new":
                        return result
                    if name is not None:
                        return "new", None
                    if indexed is not None:
                        return "ambiguous", None
                    return self._matching(list(with_id), False)
                if name is not None:
                    return self._matching([call for call in with_id if call.name == name], explicit_start)
                return self._matching(list(with_id), False)
            if matching_indexed:
                if explicit_start:
                    return "new", None
                return self._matching(matching_indexed, name is not None and empty_arguments)
            return "new", None
        if indexed is not None:
            return self._matching(matching_indexed, explicit_start)
        if name is not None:
            return "new", None
        return self._matching([call for call in self.calls if not call.finished], False)

    @staticmethod
    def _matching(calls: list[_ToolCall], explicit_start: bool) -> tuple[str, _ToolCall | None]:
        if not calls:
            return "new", None
        continuable = [call for call in calls if not call.state.has_complete_structured_value]
        if not explicit_start and len(calls) == 1:
            return "existing", calls[0]
        if len(continuable) == 1:
            return "existing", continuable[0]
        if len(continuable) > 1 or not explicit_start:
            return "ambiguous", None
        return "new", None

    def _new(self, delta: JsonObject, wire_id: str | None, index: Any, name: str | None) -> _ToolCall:
        if self.type_validation == "required" and delta.get("type") != "function":
            raise InvalidResponseDataError("Expected 'function' type.")
        if self.type_validation == "if-present" and delta.get("type") not in (None, "function"):
            raise InvalidResponseDataError("Expected 'function' type.")
        if name is None:
            raise InvalidResponseDataError("Expected 'function.name' to be a string.")
        call_id = self._create_id(wire_id)
        self.emit({"type": "tool-input-start", "id": call_id, "toolName": name})
        metadata = self.extract_metadata(delta) if self.extract_metadata else None
        initial = (delta.get("function") or {}).get("arguments") or ""
        call = _ToolCall(call_id, index, len(self.calls), name, initial, ArgumentState(initial), metadata)
        self.calls.append(call)
        if wire_id is not None:
            self._associate(self.by_id, wire_id, call)
        if call.arguments:
            self.emit({"type": "tool-input-delta", "id": call.id, "delta": call.arguments})
        return call

    def _create_id(self, wire_id: str | None) -> str:
        if wire_id is not None and wire_id not in self.used_ids:
            self.used_ids.add(wire_id)
            return wire_id
        generated = self._non_blank(self.generate_id()) or "tool-call"
        if generated not in self.used_ids:
            self.used_ids.add(generated)
            return generated
        start = self.suffixes.get(generated, 1)
        for suffix in range(start, start + len(self.used_ids) + 1):
            candidate = f"{generated}-{suffix}"
            if candidate not in self.used_ids:
                self.used_ids.add(candidate)
                self.suffixes[generated] = suffix + 1
                return candidate
        raise RuntimeError("Failed to create a unique tool call ID.")

    def _existing(self, call: _ToolCall, delta: JsonObject) -> None:
        if call.finished:
            return
        arguments = (delta.get("function") or {}).get("arguments")
        if arguments is not None:
            call.state.append(arguments)
            call.arguments += arguments
            self.emit({"type": "tool-input-delta", "id": call.id, "delta": arguments})

    def _finish(self, call: _ToolCall) -> None:
        self.emit({"type": "tool-input-end", "id": call.id})
        metadata = self.build_metadata(call.metadata) if self.build_metadata else None
        part: JsonObject = {"type": "tool-call", "toolCallId": call.id, "toolName": call.name, "input": call.arguments}
        if metadata:
            part["providerMetadata"] = metadata
        self.emit(part)
        call.finished = True
