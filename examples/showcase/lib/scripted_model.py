"""
A deterministic ModelAdapter for keyless demos and tests (``lib/scripted-model.ts``).

Only the model's *decisions* are scripted. Every tool call it makes is
executed for real by Agent Runtime (workspace tools run in the real run
sandbox), and each decision is computed from the real tool results the
runtime sends back, so the script reacts to failing tests, host-policy
denials, and files that are already fixed.

Text is streamed in small paced chunks so the browser can animate it; the
pace is a multiplier where 0 means "as fast as possible" (used by tests).
"""

from __future__ import annotations

import asyncio
import math
import os
import re
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from . import js

JsonObject = dict[str, Any]


@dataclass
class ScriptRequest:
    """What the script sees: the same request a real model receives, pre-digested."""

    #: Concatenated system message text.
    system: str
    #: Concatenated user message text (the interpolated step prompt).
    prompt: str
    #: Tool names offered to the model for this step.
    tools: list[str]
    #: Results of this step's earlier tool calls, in order.
    results: list[JsonObject]
    #: Zero-based model turn within the current step.
    turn: int
    #: True when the step requested structured output.
    structured: bool
    #: Every non-system message in order, as text: inserted conversation
    #: turns, the step's own prompt, and earlier model turns of this step.
    messages: list[JsonObject]


#: One model turn: narrate, then either call a tool or finish the step.
#: ``{"say"?: str, "call": {"name", "input"}}`` or ``{"say"?: str, "output": value}``.
ScriptTurn = JsonObject
Script = Callable[[ScriptRequest], ScriptTurn]


def _cancelled(signal: Any) -> BaseException:
    reason = signal.reason
    return reason if isinstance(reason, BaseException) else RuntimeError("Model call cancelled")


async def _sleep(milliseconds: float, signal: Any) -> None:
    if signal is not None and signal.aborted:
        raise _cancelled(signal)
    if milliseconds <= 0:
        return
    if signal is None:
        await asyncio.sleep(milliseconds / 1000)
        return
    waiter = asyncio.ensure_future(signal.wait())
    try:
        done, _ = await asyncio.wait({waiter}, timeout=milliseconds / 1000)
    finally:
        waiter.cancel()
    if done:
        raise _cancelled(signal)


def _text_of(request: JsonObject, role: str) -> str:
    return "\n".join(
        part["text"]
        for message in request["messages"]
        if message["role"] == role
        for part in message["content"]
        if part["type"] == "text"
    )


def _messages_of(request: JsonObject) -> list[JsonObject]:
    return [
        {
            "role": message["role"],
            "text": "\n".join(
                part["text"] if part["type"] == "text" else js.stringify(part["value"])
                for part in message["content"]
                if part["type"] in ("text", "json")
            ),
        }
        for message in request["messages"]
        if message["role"] != "system"
    ]


def _tool_results_of(request: JsonObject) -> list[JsonObject]:
    return [
        part["result"]
        for message in request["messages"]
        if message["role"] == "tool"
        for part in message["content"]
        if part["type"] == "tool-result"
    ]


def _estimate_tokens(text: str) -> int:
    return max(1, math.ceil(js.length(text) / 4))


def _record_request(request: JsonObject) -> None:
    """
    Tests only: with SHOWCASE_RECORD_MODEL_REQUESTS set to a file path, append
    every request the scripted model receives, one JSON line each. The
    cross-runtime parity test compares them with the TypeScript showcase's.
    """
    file = os.environ.get("SHOWCASE_RECORD_MODEL_REQUESTS")
    if not file:
        return
    record = {
        "messages": request["messages"],
        "tools": [tool["name"] for tool in request.get("tools") or []],
        "outputSchema": request.get("outputSchema"),
    }
    with open(file, "a", encoding="utf-8") as log:
        log.write(f"{js.stringify(record)}\n")


def _chunks(text: str) -> list[str]:
    """Split text into word-sized chunks so streaming reads naturally."""
    return re.findall(f"{js.WS}*{js.NOT_WS}+{js.WS}*", text) or [text]


class ScriptedModelAdapter:
    def __init__(
        self,
        script: Script,
        *,
        pace: float = 1,
        model_name: str = "scripted",
        stop_on_sandbox_failure: bool = True,
    ) -> None:
        """
        ``pace``: 1 is a comfortable reading speed, 0 disables delays.
        ``model_name``: identifier reported in transcripts.
        ``stop_on_sandbox_failure``: stop with an error when a tool reports
        that the sandbox could not run a command. Adversarial scripts that
        expect refusals turn it off.
        """
        self._script = script
        self._pace = max(0, pace)
        self._model_name = model_name
        self._stop_on_sandbox_failure = stop_on_sandbox_failure
        self._call_sequence = 0

    async def generate(self, request: JsonObject) -> JsonObject:
        completed = None
        async for event in self.stream(request):
            if event["type"] == "completed":
                completed = event["result"]
        if completed is None:
            raise RuntimeError("Scripted model produced no result.")
        return completed

    async def stream(self, request: JsonObject) -> AsyncIterator[JsonObject]:
        _record_request(request)
        signal = request.get("signal")
        results = _tool_results_of(request)
        # A real model might keep going after the sandbox itself breaks; the
        # script stops so the failure is visible where it happened.
        broken = (
            next(
                (
                    result
                    for result in results
                    if (result.get("error") or {}).get("code") in ("sandbox_command_failed", "sandbox_unavailable")
                ),
                None,
            )
            if self._stop_on_sandbox_failure
            else None
        )
        if broken is not None:
            error = broken["error"]
            raise RuntimeError(f"The sandbox could not run {broken['name']} ({error['code']}): {error['message']}")
        turn = self._script(
            ScriptRequest(
                system=_text_of(request, "system"),
                prompt=_text_of(request, "user"),
                tools=[tool["name"] for tool in request.get("tools") or []],
                results=results,
                turn=sum(
                    1
                    for message in request["messages"]
                    if message["role"] == "assistant"
                    and any(part["type"] == "tool-call" for part in message["content"])
                ),
                structured=request.get("outputSchema") is not None,
                messages=_messages_of(request),
            )
        )

        # A short "thinking" pause before the first token makes each model
        # call visible in the animation.
        await _sleep(350 * self._pace, signal)

        if turn.get("say") is not None:
            narration = turn["say"]
        elif "output" in turn:
            output = turn["output"]
            narration = output if isinstance(output, str) else js.stringify(output, 2)
        else:
            narration = ""
        for delta in _chunks(narration):
            if signal is not None and signal.aborted:
                raise _cancelled(signal)
            await _sleep(28 * self._pace, signal)
            yield {"type": "text-delta", "delta": delta}

        usage = {
            "inputTokens": _estimate_tokens(
                "".join(js.stringify(part) for message in request["messages"] for part in message["content"])
            ),
            "outputTokens": _estimate_tokens(narration),
        }

        def item(content: list[JsonObject]) -> JsonObject:
            return {
                "id": f"scripted-{uuid.uuid4()}",
                "type": "message",
                "role": "assistant",
                "content": content,
                "createdAt": js.now_iso(),
                "usage": {**usage, "totalTokens": usage["inputTokens"] + usage["outputTokens"]},
            }

        if "call" in turn:
            await _sleep(250 * self._pace, signal)
            self._call_sequence += 1
            call = {
                "id": f"call-{self._call_sequence}-{str(uuid.uuid4())[:8]}",
                "name": turn["call"]["name"],
                "input": turn["call"]["input"],
            }
            yield {"type": "tool-call", "call": call}
            content = [
                *([{"type": "text", "text": narration}] if narration else []),
                {"type": "tool-call", "call": call},
            ]
            yield {
                "type": "completed",
                "result": {
                    "toolCalls": [call],
                    "finishReason": "tool-calls",
                    "transcript": [{**item(content), "type": "tool-call"}],
                    "providerMetadata": {"model": self._model_name},
                },
            }
            return

        output = turn["output"]
        yield {
            "type": "completed",
            "result": {
                "output": output,
                "finishReason": "stop",
                "transcript": [
                    item(
                        [
                            {"type": "text", "text": output}
                            if isinstance(output, str)
                            else {"type": "json", "value": output}
                        ]
                    )
                ],
                "providerMetadata": {"model": self._model_name},
            },
        }


def last_result(request: ScriptRequest) -> JsonObject | None:
    """The newest tool result this step received."""
    return request.results[-1] if request.results else None


def output_of(result: JsonObject | None) -> Any:
    """A tool result's output, or None when it failed."""
    return result.get("output") if result is not None and result.get("error") is None else None
