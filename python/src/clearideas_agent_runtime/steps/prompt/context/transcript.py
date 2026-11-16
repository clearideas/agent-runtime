"""Durable transcripts with context markers (``context/transcript.ts``).

The durable transcript is never edited. Context reductions are recorded as
marker items, and the model's input is a pure function of the transcript:
markers hide superseded items, substitute reduced content, and insert
summaries. Resume rebuilds the same view without any model call.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ...._js import json as js_json
from ...._js.strings import utf16

JsonObject = dict[str, Any]
#: A context marker: ``{kind, sequence, strategy, reason, replaces?, rewrites?,
#: anchor?, slots?, history?, removedRounds?, removedTools?, removedCalls?}``.
ContextMarker = JsonObject


def context_marker(item: JsonObject) -> ContextMarker | None:
    metadata = item.get("metadata")
    runtime = metadata.get("agentRuntime") if isinstance(metadata, dict) else None
    if not isinstance(runtime, dict):
        return None
    marker = runtime.get("context")
    if not isinstance(marker, dict) or not isinstance(marker.get("kind"), str):
        return None
    return marker


def marker_metadata(marker: ContextMarker) -> JsonObject:
    return {"agentRuntime": {"context": js_json.to_json_value(marker)}}


def fingerprint(text: str) -> str:
    """Small, synchronous content fingerprint (FNV-1a over UTF-16 code units)."""
    units = utf16(text)
    hash_ = 0x811C9DC5
    for char in units:
        hash_ ^= ord(char)
        hash_ = (hash_ * 0x01000193) & 0xFFFFFFFF
    return f"fnv1a:{hash_:08x}:{len(units)}"


def compacted_view(transcript: list[JsonObject]) -> list[JsonObject]:
    """The transcript as the model should see it."""
    superseded: set[str] = set()
    rewrites: dict[str, list[JsonObject]] = {}
    anchored: dict[str, list[JsonObject]] = {}
    present = {item["id"] for item in transcript}
    for item in transcript:
        marker = context_marker(item)
        if not marker:
            continue
        for id_ in marker.get("replaces") or []:
            superseded.add(id_)
        for id_, content in js_json.js_entries(marker.get("rewrites") or {}):
            rewrites[id_] = content
        anchor = marker.get("anchor")
        if anchor and item.get("role") and anchor in present:
            anchored.setdefault(anchor, []).append(item)
    view: list[JsonObject] = []

    def emit(item: JsonObject) -> None:
        if item["id"] in superseded:
            return
        content = rewrites.get(item["id"])
        view.append({**item, "content": content} if content is not None else item)

    for item in transcript:
        for marker_item in anchored.get(item["id"], []):
            emit(marker_item)
        marker = context_marker(item)
        if marker:
            anchor = marker.get("anchor")
            is_anchored = anchor is not None and bool(item.get("role")) and anchor in present
            if item.get("role") and not is_anchored:
                emit(item)
            continue
        emit(item)
    return view


@dataclass
class TranscriptRound:
    kind: str  # "tool" | "marker"
    items: list[JsonObject] = field(default_factory=list)


def derive_rounds(view: list[JsonObject]) -> list[TranscriptRound]:
    """Group a view into rounds: one model response plus its tool results, or one marker."""
    rounds: list[TranscriptRound] = []
    previous: JsonObject | None = None
    for item in view:
        if context_marker(item):
            rounds.append(TranscriptRound("marker", [item]))
        elif item.get("role") == "assistant" and (
            previous is None
            or previous.get("type") == "tool-result"
            or previous.get("role") == "tool"
            or context_marker(previous) is not None
        ):
            rounds.append(TranscriptRound("tool", [item]))
        elif not rounds or rounds[-1].kind == "marker":
            rounds.append(TranscriptRound("tool", [item]))
        else:
            rounds[-1].items.append(item)
        previous = item
    return rounds


def split_retained(
    rounds: list[TranscriptRound], retain_tool_rounds: int
) -> tuple[list[TranscriptRound], list[TranscriptRound]]:
    """Split rounds into a compactable prefix and the retained newest tool rounds."""
    if retain_tool_rounds <= 0:
        return list(rounds), []
    seen = 0
    cut = len(rounds)
    for index in range(len(rounds) - 1, -1, -1):
        if rounds[index].kind != "tool":
            continue
        seen += 1
        cut = index
        if seen >= retain_tool_rounds:
            break
    return rounds[:cut], rounds[cut:]


def tool_rounds_since_compaction(rounds: list[TranscriptRound]) -> int:
    """Tool rounds after the most recent marker that summarized or removed rounds."""
    count = 0
    for round_ in reversed(rounds):
        if round_.kind == "marker":
            marker = context_marker(round_.items[0])
            if marker and (marker.get("kind") == "summary" or len(marker.get("replaces") or []) > 0):
                break
            continue
        count += 1
    return count


def _part_text(part: JsonObject) -> str:
    kind = part["type"]
    if kind == "text":
        return part["text"]
    if kind == "reasoning":
        return ""
    if kind == "json":
        return js_json.stringify(part["value"])
    if kind == "image":
        return "[image]"
    if kind == "file":
        name = part.get("name")
        return f"[file{' ' + name if name else ''}]"
    if kind == "tool-call":
        call = part["call"]
        return f"Called tool {call['name']} with {js_json.stringify(call['input'])}"
    if kind == "tool-result":
        result = part["result"]
        artifacts = result.get("artifacts") or []
        artifact_text = f" (artifacts: {', '.join(artifact['name'] for artifact in artifacts)})" if artifacts else ""
        if result.get("error") is not None:
            error = result["error"]
            return f"Tool {result['name']} failed ({error['code']}): {error['message']}"
        output = result.get("output")
        rendered = output if isinstance(output, str) else js_json.stringify(output)
        return f"Tool {result['name']} returned{artifact_text}: {rendered}"
    return ""


def render_items_as_text(items: list[JsonObject]) -> str:
    """A plain-text rendering of transcript items for a summarizer."""
    rendered: list[str] = []
    for item in items:
        marker = context_marker(item)
        if marker:
            speaker = "Earlier summary" if marker.get("kind") == "summary" else "Runtime note"
        else:
            speaker = {"assistant": "Assistant", "tool": "Tool", "user": "User"}.get(item.get("role") or "", "System")
        text = "\n".join(value for value in (_part_text(part) for part in item["content"]) if value)
        if text:
            rendered.append(f"{speaker}: {text}")
    return "\n\n".join(rendered)


def input_reductions(transcript: list[JsonObject]) -> dict[str, JsonObject]:
    """Latest stored reduction for each opening-prompt slot."""
    reductions: dict[str, JsonObject] = {}
    for item in transcript:
        marker = context_marker(item)
        if not marker or marker.get("kind") != "input":
            continue
        for slot in marker.get("slots") or []:
            reductions[f"{slot['location']}#{js_json.number_to_string(slot['index'])}"] = slot
    return reductions


def history_reduction(transcript: list[JsonObject]) -> JsonObject | None:
    """Latest stored reduction of the inserted conversation history."""
    latest: JsonObject | None = None
    for item in transcript:
        marker = context_marker(item)
        if marker and marker.get("kind") == "input" and marker.get("history") is not None:
            latest = marker["history"]
    return latest


def next_marker_sequence(transcript: list[JsonObject]) -> int:
    highest = 0
    for item in transcript:
        marker = context_marker(item)
        sequence = marker.get("sequence") if marker else None
        highest = max(highest, sequence if sequence is not None else 0)
    return highest + 1


def summary_compactions(transcript: list[JsonObject]) -> int:
    """Summarizing compactions recorded in this step's transcript."""
    return sum(1 for item in transcript if (context_marker(item) or {}).get("kind") == "summary")


def view_messages(items: list[JsonObject]) -> list[JsonObject]:
    """Model messages for view items; runtime marker metadata stays internal."""
    messages: list[JsonObject] = []
    for item in items:
        if not item.get("role"):
            continue
        marker = context_marker(item)
        message: JsonObject = {"role": item["role"], "content": item["content"]}
        if item.get("metadata") is not None and not marker:
            message["metadata"] = item["metadata"]
        if item.get("providerOptions") is not None:
            message["providerOptions"] = item["providerOptions"]
        messages.append(message)
    return messages
