"""One execution of a prompt step (``step-prompt/src/execution.ts``).

The model/tool loop plus the safeguards that let it finish instead of failing
on recoverable conditions:

- Context: the opening prompt, individual tool results, and older tool rounds
  are reduced (summarized or pruned) when the input nears a trigger, a hard
  limit, or the provider's context window.
- Model errors: retryable failures are retried with backoff; a context
  overflow reported by the provider is compacted and retried.
- Output: invalid structured output, empty answers, and truncated responses
  get a bounded number of repair turns.
- Tools: invalid and out-of-scope tool calls are answered with an error
  instead of being executed, and reaching the tool-call limit asks the model
  for a final answer.

Every reduction is a marker item in the durable transcript, so resuming
rebuilds the same model input without repeating model calls.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import inspect
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..._js import json as js_json
from ..._js import ops as js_ops
from ..._js import strings as js_strings
from ..._js import time as js_time
from ..._js.errors import Error
from ..._js.ops import UNDEFINED
from ...core.errors import RunSuspendedError, is_run_suspended_error
from ...core.ports import ToolExecutionContext
from ...core.runtime import StepExecutionContext, maybe_await
from .context.errors import (
    describe_error,
    error_summary,
    is_context_overflow_error,
    is_invalid_output_error,
    is_retryable_model_error,
)
from .context.measure import TokenEstimator, json_bytes, json_text_bytes
from .context.opening import OpeningPrompt, build_opening_prompt
from .context.prune import clip_tool_result_part, prune_json, prune_text, stub_tool_result_part
from .context.summarize import (
    ChunkedSummarizer,
    SummarizeInput,
    SummarizerCallInput,
    SummarizerError,
    summarizer_messages,
)
from .context.template import CompiledTemplate, TemplateSlot, template_slots
from .context.transcript import (
    TranscriptRound,
    compacted_view,
    context_marker,
    derive_rounds,
    fingerprint,
    history_reduction,
    input_reductions,
    marker_metadata,
    next_marker_sequence,
    render_items_as_text,
    split_retained,
    summary_compactions,
    tool_rounds_since_compaction,
    view_messages,
)
from .helpers import (
    ModelCompletionError,
    ModelTimeoutError,
    abort_reason,
    has_output,
    is_truncated_finish_reason,
    model_key_from_reference,
    model_operation,
    race_with_signal,
    reference_provider,
    reported_total_tokens,
    resolve_message_media,
    result_usage,
    safe_model_completed_data,
    step_model_reference,
)

JsonObject = dict[str, Any]


@dataclass
class PromptExecutionDependencies:
    now: Callable[[], datetime]
    generate_transcript_id: Callable[[], str]
    generate_tool_idempotency_key: Callable[[], str]
    default_max_tool_calls: int
    sleep: Callable[[float, Any], Awaitable[None]]


#: Built-in policy values used when neither host, manifest, nor step sets one.
PROMPT_POLICY_DEFAULTS: JsonObject = {
    "strategy": "prune",
    "retainToolRounds": 2,
    "maxCompactions": 25,
    # Applied when the adapter describes the model's input window.
    "contextRatio": 0.8,
    "toolCallLimit": "finalize",
    "modelRetry": {"maxAttempts": 3, "initialDelayMs": 1_000, "maxDelayMs": 20_000},
    "outputRepairAttempts": 1,
    "overflowRetries": 3,
    # Size a reduction aims for, as a fraction of the trigger.
    "reduceTo": 0.25,
    # Opening-prompt budget as a fraction of the trigger.
    "openingShareWithTools": 0.5,
    "openingShareWithoutTools": 0.9,
    # Single tool-result cap as a fraction of the trigger.
    "toolResultShare": 0.4,
}

STUB_MINIMUM_BYTES = 600
#: Built-in summarizer defaults; every value is a summarizer policy setting.
SUMMARIZER_DEFAULTS: JsonObject = {
    "summaryShare": 0.25,
    "minSummaryBytes": 1_024,
    "maxSummaryBytes": 16_384,
    "minimumMaxCalls": 16,
    "callsPerCompaction": 8,
    "chunkBytes": 48_000,
    "maxPasses": 4,
}
MINIMUM_NOTE_BYTES = 400
#: Calls a removal note lists by name and main argument.
MAXIMUM_LISTED_CALLS = 40
MESSAGE_OVERHEAD_BYTES = 300
DEFAULT_CHUNK_BYTES = SUMMARIZER_DEFAULTS["chunkBytes"]
TASK_OUTLINE_BYTES = 2_000


def _s(value: Any) -> str:
    """``${value}`` interpolation."""
    return js_ops.to_string(value)


def _describe_call(call: JsonObject) -> str:
    """A tool call as ``name(first string argument)``, short enough for a note."""
    argument = next((value for _, value in js_json.js_entries(call["input"]) if isinstance(value, str)), None)
    if argument is None:
        shown = ""
    elif js_strings.length(argument) > 60:
        shown = f"{js_strings.slice(argument, 0, 57)}..."
    else:
        shown = argument
    return f"{call['name']}({shown})"


def _pick(value: Any, default: Any) -> Any:
    return default if value is None else value


def resolve_prompt_policies(policies: JsonObject | None) -> JsonObject:
    """The effective prompt-step policies with every built-in default filled in."""
    policies = policies or {}
    context: JsonObject = policies.get("context") or {}
    retain = context.get("retain") or {}
    model_retry = policies.get("modelRetry") or {}
    defaults = PROMPT_POLICY_DEFAULTS
    return {
        "context": {
            "strategy": _pick(context.get("strategy"), defaults["strategy"]),
            "trigger": _pick(context.get("trigger"), {}),
            "retainToolRounds": _pick(retain.get("recentToolRounds"), defaults["retainToolRounds"]),
            "maxCompactions": _pick(context.get("maxCompactions"), defaults["maxCompactions"]),
            "maxToolResultBytes": context.get("maxToolResultBytes"),
            "reduceTo": _pick(context.get("reduceTo"), defaults["reduceTo"]),
            "overflowRetries": _pick(context.get("overflowRetries"), defaults["overflowRetries"]),
            "openingShare": context.get("openingShare"),
            "toolResultShare": _pick(context.get("toolResultShare"), defaults["toolResultShare"]),
            "summarizer": _pick(context.get("summarizer"), {}),
            "variables": _pick(context.get("variables"), {}),
        },
        "toolCallLimit": _pick(policies.get("toolCallLimit"), defaults["toolCallLimit"]),
        "modelRetry": {
            "maxAttempts": _pick(model_retry.get("maxAttempts"), defaults["modelRetry"]["maxAttempts"]),
            "initialDelayMs": _pick(model_retry.get("initialDelayMs"), defaults["modelRetry"]["initialDelayMs"]),
            "maxDelayMs": _pick(model_retry.get("maxDelayMs"), defaults["modelRetry"]["maxDelayMs"]),
        },
        "outputRepairAttempts": _pick(
            (policies.get("outputRepair") or {}).get("maxAttempts"), defaults["outputRepairAttempts"]
        ),
    }


@dataclass
class PendingModelResult:
    result: JsonObject
    next_tool_index: int
    tool_idempotency_keys: list[str]


@dataclass
class _Restored:
    tool_call_count: int
    pending: PendingModelResult | None = None


def _is_safe_integer(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return abs(value) <= js_json.MAX_SAFE_INTEGER


def _is_json_object(value: Any) -> bool:
    return isinstance(value, dict)


def _parse_prompt_continuation(context: StepExecutionContext) -> _Restored | None:
    value = (context.resume or {}).get("continuation")
    if not isinstance(value, dict) or value.get("type") != "prompt" or value.get("stepId") != context.step["id"]:
        return None
    if not _is_safe_integer(value.get("toolCallCount")) or value["toolCallCount"] < 0:
        return None
    tool_call_count = int(value["toolCallCount"])
    if value.get("phase") == "ready":
        return _Restored(tool_call_count)
    tool_calls = value.get("toolCalls")
    keys = value.get("toolIdempotencyKeys")
    next_index = value.get("nextToolIndex")
    if (
        value.get("phase") != "model-completed"
        or not isinstance(value.get("hasOutput"), bool)
        or not isinstance(tool_calls, list)
        or not isinstance(keys, list)
        or len(keys) != len(tool_calls)
        or any(not isinstance(key, str) or len(key) == 0 for key in keys)
        or not _is_safe_integer(next_index)
        or next_index < 0
        or next_index > len(tool_calls)
    ):
        return None
    result: JsonObject = {}
    if value["hasOutput"]:
        result["output"] = copy.deepcopy(value.get("output"))
    result["transcript"] = []
    result["toolCalls"] = copy.deepcopy(tool_calls)
    if isinstance(value.get("finishReason"), str):
        result["finishReason"] = value["finishReason"]
    return _Restored(tool_call_count, PendingModelResult(result, int(next_index), list(keys)))  # pyright: ignore[reportArgumentType]


def _invalid_call_error(call: JsonObject) -> str | None:
    runtime = (call.get("metadata") or {}).get("agentRuntime")
    if not _is_json_object(runtime) or runtime.get("invalid") is not True:
        return None
    return runtime["error"] if isinstance(runtime.get("error"), str) else "Invalid tool call."


def _has_tool_result_for(items: list[JsonObject], call_id: str) -> bool:
    return any(
        part["type"] == "tool-result" and part["result"]["callId"] == call_id
        for item in items
        for part in item["content"]
    )


def _tool_result_text(result: JsonObject) -> str:
    if result.get("error") is not None:
        return result["error"]["message"]
    output = result.get("output")
    return output if isinstance(output, str) else js_json.stringify(output)


def _water_fill(sizes: list[int], available: float) -> list[int]:
    """Distribute ``available`` bytes over sizes; small entries keep their size."""
    order = sorted(range(len(sizes)), key=lambda index: sizes[index])
    caps = list(sizes)
    remaining = max(0, available)
    for position, index in enumerate(order):
        share = math.floor(remaining / (len(order) - position))
        if sizes[index] <= share:
            remaining -= sizes[index]
            continue
        for rest in order[position:]:
            caps[rest] = share
        break
    return caps


def _output_of(result: JsonObject) -> Any:
    return result.get("output", UNDEFINED)


class _Fits:
    def __init__(self, goal: float, must: float, goal_met: Callable[[], bool], must_met: Callable[[], bool]) -> None:
        self.goal = goal
        self.must = must
        self.goal_met = goal_met
        self.must_met = must_met


@dataclass
class _SlotTarget:
    template: CompiledTemplate
    index: int
    slot: TemplateSlot
    cap: int


@dataclass
class _SummaryJournal:
    """Replaying this journal rebuilds map/reduce passes without repeating model calls."""

    key: str
    plans: list[float] = field(default_factory=list)
    calls: list[JsonObject] = field(default_factory=list)
    result: str | None = None

    def to_json(self) -> JsonObject:
        value: JsonObject = {"key": self.key, "plans": list(self.plans), "calls": copy.deepcopy(self.calls)}
        if self.result is not None:
            value["result"] = self.result
        return value


class PromptExecution:
    def __init__(self, context: StepExecutionContext, deps: PromptExecutionDependencies) -> None:
        self._context = context
        self._deps = deps
        self._policy = resolve_prompt_policies(context.policies)
        self._model_key = model_key_from_reference(step_model_reference(context.step, context), context.step["id"])
        self._estimator = TokenEstimator()
        self._resolved_cache: dict[str, JsonObject] = {}
        self._transcript: list[JsonObject] = copy.deepcopy((context.resume or {}).get("transcript") or [])
        self._tools: list[JsonObject] = []
        self._allowed_tools: dict[str, None] = {}
        self._unavailable_tools: list[JsonObject] = []
        self._opening: OpeningPrompt
        self._task = ""
        self._initial_messages: list[JsonObject] = []
        self._messages: list[JsonObject] = []
        self._dirty = True
        self._description: JsonObject | None = None
        self._overflow_ceiling_bytes: float | None = None
        self._tool_call_count = 0
        limits = context.manifest.get("limits") or {}
        self._max_tool_calls = _pick(limits.get("maxToolCallsPerIteration"), deps.default_max_tool_calls)
        self._repairs_used = 0
        self._output_token_override: int | None = None
        self._checkpoint_rounds = False
        self._pending: PendingModelResult | None = None
        self._pending_reductions: list[str] = []
        self._summary_journals: list[_SummaryJournal] = []
        self._active_summary: _SummaryJournal | None = None
        self._summary_call_cursor = 0
        self._summary_plan_cursor = 0
        self._summarizer_calls_used = 0
        self._usage_estimate_reported = False
        self._compaction_limit_reported = False
        self._reductions = 0

    @property
    def _step(self) -> JsonObject:
        return self._context.step

    @property
    def _strategy(self) -> str:
        return self._policy["context"]["strategy"]

    @property
    def _completion_policy(self) -> JsonObject:
        return self._step.get("completionPolicy") or {}

    # ─── Entry point ─────────────────────────────────────────────────────────

    async def run(self) -> JsonObject:
        context = self._context
        if not context.model:
            raise Error(f"Prompt step {self._step['id']} requires a ModelAdapter")
        if context.token_budget is not None and context.checkpoint is None:
            raise Error("Budgeted prompt execution requires checkpoint support")
        restored = _parse_prompt_continuation(context)
        self._tool_call_count = restored.tool_call_count if restored else 0
        self._pending = restored.pending if restored else None
        self._restore_progress()
        await self._prepare()
        await self._finish_tool_reductions()
        pending = restored.pending if restored else None
        final_result: JsonObject | None = None

        while True:
            if pending is None:
                # A run cancelled during a tool call must not start another turn.
                if context.signal is not None and context.signal.aborted:
                    raise abort_reason(context.signal)
                self._suspend_if_exhausted()
                finalize = (
                    self._policy["toolCallLimit"] == "finalize"
                    and len(self._tools) > 0
                    and self._tool_call_count >= self._max_tool_calls
                )
                await self._fit_context("trigger")
                if finalize:
                    await self._ensure_finalize_notice()
                await self._rebuild()
                self._enforce_input_limits()
                result = await self._request_model(finalize)
                pending = self._pending = PendingModelResult(
                    result,
                    0,
                    [self._deps.generate_tool_idempotency_key() for _ in result.get("toolCalls") or []],
                )

            result = pending.result
            calls = result.get("toolCalls") or []
            await self._checkpoint_pending(pending)

            if (
                is_truncated_finish_reason(result.get("finishReason"))
                and self._completion_policy.get("onTruncation") != "accept"
            ):
                if await self._repair_truncation(result):
                    self._pending = None
                    await self._checkpoint_ready()
                    pending = None
                    continue
                raise ModelCompletionError(
                    f"Model response for prompt step {self._step['id']} was truncated ({result.get('finishReason')}); "
                    "increase the output budget or set completionPolicy.onTruncation to accept.",
                    result.get("finishReason"),
                )
            if len(calls) == 0:
                if (
                    self._completion_policy.get("requireOutput")
                    and not has_output(_output_of(result))
                    and await self._repair_empty_output()
                ):
                    self._pending = None
                    await self._checkpoint_ready()
                    pending = None
                    continue
                final_result = result
                break

            self._suspend_if_exhausted()
            await self._execute_tool_calls(pending)
            pending = self._pending = None
            await self._checkpoint_ready()

        if final_result is None:
            raise Error("Prompt execution ended without a result")
        output = _output_of(final_result)
        if self._completion_policy.get("requireOutput") and not has_output(output):
            raise ModelCompletionError(
                f"Model response for prompt step {self._step['id']} did not contain required output.",
                final_result.get("finishReason"),
            )

        step_result: JsonObject = {}
        if output is not UNDEFINED:
            step_result["output"] = output
        if self._step.get("outputVariable") and output is not UNDEFINED:
            step_result["statePatch"] = {"set": {self._step["outputVariable"]: output}}
        step_result["transcript"] = self._transcript
        metadata: JsonObject = {
            "model": self._model_key,
            "toolCallCount": self._tool_call_count,
            "streamed": getattr(context.model, "stream", None) is not None,
        }
        if self._reductions > 0:
            metadata["contextReductions"] = self._reductions
        step_result["metadata"] = metadata
        return step_result

    # ─── Setup ───────────────────────────────────────────────────────────────

    async def _prepare(self) -> None:
        context = self._context
        self._tools = await self._resolve_tools()
        self._allowed_tools = dict.fromkeys(tool["name"] for tool in self._tools)
        self._checkpoint_rounds = context.checkpoint is not None
        self._description = await self._describe(self._model_key)
        history = context.history
        self._opening = build_opening_prompt(
            self._step,
            context.variables,
            history.messages if history is not None and history.insert else None,
            [place.get("turn") if place else None for place in history.places] if history is not None else [],
        )
        self._task = prune_text(self._opening.outline(), TASK_OUTLINE_BYTES)
        self._apply_stored_input_reductions()
        await self._render_initial()
        if self._unavailable_tools:
            await context.emit(
                "diagnostic",
                {"code": "TOOLS_UNAVAILABLE", "tools": [tool["name"] for tool in self._unavailable_tools]},
            )
        await self._apply_variable_caps()
        await self._fit_opening_prompt()

    async def _resolve_tools(self) -> list[JsonObject]:
        context = self._context
        names = self._step.get("tools") or []
        if not names:
            return []
        if not context.tools:
            raise Error(f"Prompt step {self._step['id']} names tools but no ToolAdapter is configured")
        available = await context.tools.list_tools()
        by_name = {tool["name"]: tool for tool in available}
        selected: list[JsonObject] = []
        is_excluded = getattr(context.tools, "is_tool_excluded", None)
        unavailable_reason = getattr(context.tools, "unavailable_tool_reason", None)
        for name in names:
            tool = by_name.get(name)
            if tool is not None:
                selected.append(tool)
                continue
            if is_excluded is not None and is_excluded(name) is True:
                continue
            reason = unavailable_reason(name) if unavailable_reason is not None else None
            if reason is not None:
                self._unavailable_tools.append({"name": name, "reason": reason})
                continue
            raise Error(f"Tool {name} is not available")
        return selected

    async def _describe(self, model: str) -> JsonObject | None:
        describe = getattr(self._context.model, "describe_model", None)
        if describe is None:
            return None
        try:
            return await maybe_await(describe(model))
        except Exception:
            return None

    # ─── Opening prompt ──────────────────────────────────────────────────────

    def _variable_policy(self, path: str) -> JsonObject:
        variables = self._policy["context"]["variables"]
        lower = js_strings.lower(path)
        root = lower.split(".")[0]
        entries = js_json.js_entries(variables)
        entry = next((item for item in entries if js_strings.lower(item[0]) == lower), None) or next(
            (item for item in entries if js_strings.lower(item[0]) == root), None
        )
        return entry[1] if entry is not None else {}

    def _slot_strategy(self, path: str) -> str:
        return _pick(self._variable_policy(path).get("strategy"), self._strategy)

    def _apply_stored_input_reductions(self) -> None:
        history = self._opening.history
        stored_history = history_reduction(self._transcript) if history is not None else None
        if (
            history is not None
            and stored_history is not None
            and stored_history.get("sourceHash") == self._history_fingerprint()
            and stored_history["dropped"] <= len(history.messages)
        ):
            history.dropped = stored_history["dropped"]
            history.replacement = stored_history["text"]
        stored = input_reductions(self._transcript)
        if not stored:
            return
        for template in self._opening.templates:
            for index, segment in enumerate(template.segments):
                if segment.slot is None:
                    continue
                reduction = stored.get(f"{template.location}#{index}")
                if reduction and reduction.get("sourceHash") == fingerprint(segment.slot.original_text):
                    segment.slot.text = reduction["text"]

    async def _render_initial(self) -> None:
        rendered = self._opening.render()
        if self._unavailable_tools:
            listed = "; ".join(f"{tool['name']} ({tool['reason']})" for tool in self._unavailable_tools)
            notice = {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": f"These tools are unavailable for this step right now and cannot be called: {listed}. "
                        "Complete the task without them, and say so if that limits the answer.",
                    }
                ],
            }
            at = next((index for index, message in enumerate(rendered) if message["role"] != "system"), len(rendered))
            rendered.insert(at, notice)
        self._initial_messages = list(
            await asyncio.gather(*(resolve_message_media(message, self._context) for message in rendered))
        )
        self._dirty = True

    async def _apply_variable_caps(self) -> None:
        """Variables with an explicit maxBytes are always capped."""
        targets: list[_SlotTarget] = []
        for entry in template_slots(self._opening.templates):
            policy = self._variable_policy(entry.slot.path)
            if policy.get("keep") or policy.get("maxBytes") is None:
                continue
            if self._slot_strategy(entry.slot.path) == "fail":
                continue
            if json_text_bytes(entry.slot.text) <= policy["maxBytes"]:
                continue
            targets.append(_SlotTarget(entry.template, entry.index, entry.slot, policy["maxBytes"]))
        if targets:
            await self._reduce_slots(targets, "variable-limit")

    async def _fit_opening_prompt(self) -> None:
        """Reduce the opening prompt when it alone would use most of the budget."""
        if self._strategy == "fail":
            return
        trigger_bytes = self._thresholds()["triggerBytes"]
        if not math.isfinite(trigger_bytes):
            return
        share = self._policy["context"]["openingShare"]
        if share is None:
            share = (
                PROMPT_POLICY_DEFAULTS["openingShareWithTools"]
                if self._tools
                else PROMPT_POLICY_DEFAULTS["openingShareWithoutTools"]
            )
        budget = math.floor(trigger_bytes * share)
        if json_bytes(self._initial_messages) <= budget:
            return
        await self._reduce_opening_prompt(budget, "opening-prompt")

    def _history_fingerprint(self) -> str:
        history = self._opening.history
        return fingerprint(js_json.stringify(history.messages if history is not None else []))

    async def _reduce_history(self, budget: float, reason: str) -> bool:
        """Replace the oldest inserted conversation messages with one summary or note."""
        history = self._opening.history
        if history is None or self._strategy == "fail":
            return False
        bytes_before = json_bytes(self._initial_messages)
        if bytes_before <= budget:
            return False
        remaining = len(history.messages) - history.dropped
        if remaining <= 1:
            return False
        sizes = [json_bytes(message) + 1 for message in history.messages]
        excess = bytes_before - budget + MINIMUM_NOTE_BYTES
        dropped = history.dropped
        freed = 0
        while dropped < len(history.messages) - 1 and freed < excess:
            freed += sizes[dropped]
            dropped += 1
        if dropped == history.dropped:
            return False
        count = dropped

        def part_text(part: JsonObject) -> str:
            if part["type"] == "text":
                return part["text"]
            if part["type"] == "json":
                return js_json.stringify(part["value"])
            return f"[{part['type']}]"

        material_parts: list[str] = [history.replacement] if history.replacement else []
        for offset, message in enumerate(history.messages[history.dropped : dropped]):
            turn = history.turns[history.dropped + offset] if history.dropped + offset < len(history.turns) else None
            turn_text = f" (turn {_s(turn)})" if turn is not None else ""
            body = "\n".join(part_text(part) for part in message["content"])
            material_parts.append(f"{message['role']}{turn_text}: {body}")
        material = "\n\n".join(material_parts)
        text = (
            f"[Agent Runtime removed {count} earlier messages of this conversation to fit this step's context window.]"
        )
        strategy = "prune"
        if self._strategy in ("summarize", "summarize-or-prune"):
            room = max(MINIMUM_NOTE_BYTES, budget - (bytes_before - freed) - MESSAGE_OVERHEAD_BYTES)
            try:
                summary = await self._summarize(
                    SummarizeInput(
                        text=material,
                        target_bytes=math.floor(room * 0.9),
                        kind="messages",
                        label=f"{count} earlier messages",
                        task=self._task,
                    )
                )
                shown = prune_text(summary, room) if json_text_bytes(summary) > room else summary
                text = (
                    "[Summary of earlier messages in this conversation, written by Agent Runtime to fit this "
                    f"step's context window. It replaces {count} messages.]\n\n{shown}"
                )
                strategy = "summarize"
            except Exception as error:
                self._rethrow_control_flow(error)
                if self._strategy == "summarize":
                    raise self._summary_failure(error) from error
                await self._context.emit(
                    "diagnostic",
                    {"code": "CONTEXT_SUMMARY_FAILED", "scope": "messages", "message": describe_error(error)},
                )
        history.dropped = dropped
        history.replacement = text
        self._push_marker(
            {
                "kind": "input",
                "strategy": strategy,
                "reason": reason,
                "history": {
                    "sourceHash": self._history_fingerprint(),
                    "dropped": dropped,
                    "text": text,
                    "strategy": strategy,
                },
            }
        )
        await self._render_initial()
        await self._emit_reduced(
            {
                "scope": "messages",
                "strategy": strategy,
                "reason": reason,
                "messagesRemoved": count,
                "bytesBefore": bytes_before,
                "bytesAfter": json_bytes(self._initial_messages),
            }
        )
        await self._checkpoint_ready()
        return True

    async def _reduce_opening_prompt(self, budget: float, reason: str) -> bool:
        """Shrink the inserted history, then interpolated variables, so the opening prompt fits."""
        reduced_history = await self._reduce_history(budget, reason)
        if reduced_history and json_bytes(self._initial_messages) <= budget:
            return True
        candidates = [
            entry
            for entry in template_slots(self._opening.templates)
            if self._variable_policy(entry.slot.path).get("keep") is not True
            and self._slot_strategy(entry.slot.path) != "fail"
            and json_text_bytes(entry.slot.text) > 256
        ]
        if not candidates:
            return reduced_history
        sizes = [json_text_bytes(entry.slot.text) for entry in candidates]
        reducible = sum(sizes)
        fixed = json_bytes(self._initial_messages) - reducible
        available = max(len(candidates) * 256, budget - fixed)
        caps = _water_fill(sizes, available)
        targets = [
            _SlotTarget(candidate.template, candidate.index, candidate.slot, max(256, caps[position]))
            for position, candidate in enumerate(candidates)
            if caps[position] < sizes[position]
        ]
        if not targets:
            return reduced_history
        await self._reduce_slots(targets, reason)
        return True

    async def _reduce_slots(self, targets: list[_SlotTarget], reason: str) -> None:
        reductions: list[JsonObject] = []
        reused: dict[str, JsonObject] = {}
        events: list[JsonObject] = []
        for target in targets:
            before = json_text_bytes(target.slot.text)
            key = f"{fingerprint(target.slot.text)}@{_s(target.cap)}"
            reduced = reused.get(key)
            if reduced is None:
                reduced = await self._reduce_text(
                    text=target.slot.text,
                    value=target.slot.value,
                    cap=target.cap,
                    strategy=self._slot_strategy(target.slot.path),
                    kind="input",
                    label=f"the variable {target.slot.path}",
                )
            reused[key] = reduced
            target.slot.text = reduced["text"]
            reductions.append(
                {
                    "location": target.template.location,
                    "index": target.index,
                    "path": target.slot.path,
                    "sourceHash": fingerprint(target.slot.original_text),
                    "text": reduced["text"],
                    "strategy": reduced["strategy"],
                }
            )
            events.append(
                {
                    "scope": "input",
                    "strategy": reduced["strategy"],
                    "reason": reason,
                    "variable": target.slot.path,
                    "bytesBefore": before,
                    "bytesAfter": json_text_bytes(reduced["text"]),
                }
            )
        self._push_marker(
            {
                "kind": "input",
                "strategy": "summarize" if any(entry["strategy"] == "summarize" for entry in reductions) else "prune",
                "reason": reason,
                "slots": reductions,
            }
        )
        await self._render_initial()
        for event in events:
            await self._emit_reduced(event)
        await self._checkpoint_ready()

    async def _reduce_text(
        self, *, text: str, value: Any, cap: float, strategy: str, kind: str, label: str
    ) -> JsonObject:
        """Reduce one text to ``cap`` bytes; summarize falls back to prune when allowed."""
        if strategy in ("summarize", "summarize-or-prune"):
            try:
                summary = await self._summarize(
                    SummarizeInput(
                        text=text, target_bytes=math.floor(cap * 0.9), kind=kind, label=label, task=self._task
                    )
                )
                if strategy == "summarize-or-prune" and json_text_bytes(summary) > cap:
                    return {"text": prune_text(summary, cap), "strategy": "summarize"}
                return {"text": summary, "strategy": "summarize"}
            except Exception as error:
                self._rethrow_control_flow(error)
                if strategy == "summarize":
                    raise self._summary_failure(error) from error
                await self._context.emit(
                    "diagnostic",
                    {"code": "CONTEXT_SUMMARY_FAILED", "scope": kind, "message": describe_error(error)},
                )
        structured = isinstance(value, (dict, list))
        return {
            "text": prune_json(value, cap) if structured else prune_text(text, cap, label),
            "strategy": "prune",
        }

    # ─── Messages and limits ─────────────────────────────────────────────────

    async def _rebuild(self) -> None:
        if not self._dirty:
            return
        originals = {item["id"]: item for item in self._transcript}
        view = compacted_view(self._transcript)
        resolved: list[JsonObject] = []
        for item in view:
            if not item.get("role"):
                continue
            original = originals.get(item["id"]) is item
            key = item["id"] if original else f"{item['id']}:{fingerprint(js_json.stringify(item['content']))}"
            message = self._resolved_cache.get(key)
            if message is None:
                message = await resolve_message_media(view_messages([item])[0], self._context)
                self._resolved_cache[key] = message
            resolved.append(message)
        self._messages = [*self._initial_messages, *resolved]
        self._dirty = False

    def _thresholds(self) -> JsonObject:
        limits = self._context.manifest.get("limits") or {}
        trigger = self._policy["context"]["trigger"]
        candidates: list[float] = []
        if trigger.get("inputBytes") is not None:
            candidates.append(trigger["inputBytes"])
        if trigger.get("inputTokens") is not None:
            candidates.append(self._estimator.bytes(trigger["inputTokens"]))
        window = (self._description or {}).get("maxInputTokens")
        ratio = trigger.get("contextRatio")
        if ratio is None and window is not None:
            ratio = PROMPT_POLICY_DEFAULTS["contextRatio"]
        if window is not None and ratio is not None:
            candidates.append(self._estimator.bytes(window * ratio))
        if limits.get("maxInputBytes") is not None:
            candidates.append(limits["maxInputBytes"])
        if self._overflow_ceiling_bytes is not None:
            candidates.append(self._overflow_ceiling_bytes)
        return {
            "triggerBytes": min(candidates) if candidates else math.inf,
            "hardBytes": limits.get("maxInputBytes"),
            "maxMessages": limits.get("maxMessagesPerPrompt"),
        }

    def _enforce_input_limits(self) -> None:
        thresholds = self._thresholds()
        hard_bytes = thresholds["hardBytes"]
        max_messages = thresholds["maxMessages"]
        if max_messages is not None and len(self._messages) > max_messages:
            raise Error(
                f"Prompt step {self._step['id']} has {len(self._messages)} messages, exceeding the "
                f"{_s(max_messages)}-message input limit"
            )
        if hard_bytes is None:
            return
        input_bytes = json_bytes(self._messages)
        if input_bytes > hard_bytes:
            raise Error(
                f"Prompt step {self._step['id']} input is {input_bytes} bytes, exceeding the "
                f"{_s(hard_bytes)}-byte input limit"
            )

    # ─── Context reduction ───────────────────────────────────────────────────

    async def _fit_context(self, reason: str) -> None:
        """Compact when the input reaches a trigger, a hard limit, or a learned ceiling."""
        if self._strategy == "fail":
            return
        await self._rebuild()
        thresholds = self._thresholds()
        trigger_bytes = thresholds["triggerBytes"]
        max_messages = thresholds["maxMessages"]
        size = json_bytes(self._messages)
        over_bytes = size >= trigger_bytes
        over_messages = max_messages is not None and len(self._messages) > max_messages
        rounds_trigger = self._policy["context"]["trigger"].get("toolRounds")
        rounds_due = (
            rounds_trigger is not None
            and tool_rounds_since_compaction(derive_rounds(compacted_view(self._transcript))) >= rounds_trigger
        )
        if reason == "trigger" and not over_bytes and not over_messages and not rounds_due:
            return
        finite = math.isfinite(trigger_bytes)
        goal = math.floor(trigger_bytes * self._policy["context"]["reduceTo"]) if finite else math.inf
        must = trigger_bytes - 1 if finite else math.inf

        def count_fits() -> bool:
            return max_messages is None or len(self._messages) <= max_messages

        fits = _Fits(
            goal,
            must,
            lambda: json_bytes(self._messages) <= goal and count_fits(),
            lambda: json_bytes(self._messages) <= must and count_fits(),
        )
        if reason == "overflow":
            label = "provider-context-overflow"
        elif over_bytes:
            label = "input-size"
        elif over_messages:
            label = "message-count"
        else:
            label = "tool-rounds"
        force_once = reason == "trigger" and rounds_due and not over_bytes and not over_messages

        await self._compact_transcript(fits, label, force_once)
        if fits.must_met() or force_once:
            return
        # Older rounds are gone; shrink the opening prompt's variables to make room.
        await self._rebuild()
        view_bytes = json_bytes(self._messages) - json_bytes(self._initial_messages)
        if finite:
            await self._reduce_opening_prompt(max(math.floor(goal * 0.5), goal - view_bytes), label)
        await self._rebuild()

    async def _compact_transcript(self, fits: _Fits, reason: str, force_once: bool) -> None:
        if not force_once and fits.goal_met():
            return
        strategy = self._strategy
        if strategy in ("summarize", "summarize-or-prune"):
            if summary_compactions(self._transcript) >= self._policy["context"]["maxCompactions"]:
                if not self._compaction_limit_reported:
                    self._compaction_limit_reported = True
                    await self._context.emit(
                        "diagnostic",
                        {
                            "code": "COMPACTION_LIMIT_REACHED",
                            "maxCompactions": self._policy["context"]["maxCompactions"],
                        },
                    )
                if strategy == "summarize":
                    return
            else:
                done = await self._summarize_rounds(fits, reason, force_once)
                if done or strategy == "summarize":
                    return
        await self._prune_rounds(fits, reason, force_once)

    def _view_rounds(self) -> list[TranscriptRound]:
        return derive_rounds(compacted_view(self._transcript))

    async def _message_bytes_of(self, items: list[JsonObject]) -> int:
        messages = await asyncio.gather(
            *(resolve_message_media(message, self._context) for message in view_messages(items))
        )
        return sum(json_bytes(message) + 1 for message in messages)

    async def _choose_retention(self, fits: _Fits, minimum_kept: float) -> int:
        """How many of the newest tool rounds to keep verbatim in this reduction."""
        configured = self._policy["context"]["retainToolRounds"]
        if configured <= 0:
            return 0
        rounds = self._view_rounds()
        opening = json_bytes(self._initial_messages)

        async def kept_bytes(retain: int) -> float:
            _, retained = split_retained(rounds, retain)
            return (
                opening
                + await self._message_bytes_of([item for round_ in retained for item in round_.items])
                + MESSAGE_OVERHEAD_BYTES
                + minimum_kept
            )

        for retain in range(configured, 0, -1):
            if await kept_bytes(retain) <= fits.goal:
                return retain
        return 1 if await kept_bytes(1) <= fits.must else 0

    def _summarizer_settings(self) -> JsonObject:
        settings = self._policy["context"]["summarizer"]
        max_calls = settings.get("maxCalls")
        if max_calls is None:
            max_calls = max(
                SUMMARIZER_DEFAULTS["minimumMaxCalls"],
                self._policy["context"]["maxCompactions"] * SUMMARIZER_DEFAULTS["callsPerCompaction"],
            )
        return {
            "summaryShare": _pick(settings.get("summaryShare"), SUMMARIZER_DEFAULTS["summaryShare"]),
            "minSummaryBytes": _pick(settings.get("minSummaryBytes"), SUMMARIZER_DEFAULTS["minSummaryBytes"]),
            "maxSummaryBytes": _pick(settings.get("maxSummaryBytes"), SUMMARIZER_DEFAULTS["maxSummaryBytes"]),
            "maxCalls": max_calls,
        }

    async def _summarize_rounds(self, fits: _Fits, reason: str, force_once: bool) -> bool:
        """Replace older rounds with one summary, in a single summarizer pass."""
        chosen = (
            self._policy["context"]["retainToolRounds"]
            if force_once
            else await self._choose_retention(fits, self._summarizer_settings()["minSummaryBytes"])
        )
        # A second pass, with nothing kept, only when the first cannot fit.
        for retain in [chosen, 0] if chosen > 0 and not force_once else [chosen]:
            await self._rebuild()
            prefix, retained = split_retained(self._view_rounds(), retain)
            if not any(round_.kind == "tool" for round_ in prefix):
                if force_once or fits.must_met():
                    return True
                continue
            prefix_items = [item for round_ in prefix for item in round_.items]
            retained_items = [item for round_ in retained for item in round_.items]
            fixed = (
                json_bytes(self._initial_messages)
                + await self._message_bytes_of(retained_items)
                + MESSAGE_OVERHEAD_BYTES
            )
            prefix_bytes = await self._message_bytes_of(prefix_items)
            limits = self._summarizer_settings()
            summary_target = max(
                limits["minSummaryBytes"],
                min(
                    fits.goal - fixed,
                    limits["maxSummaryBytes"],
                    max(limits["minSummaryBytes"], math.floor(prefix_bytes * limits["summaryShare"])),
                ),
            )
            calls_before = self._summarizer_calls_used
            bytes_before = json_bytes(self._messages)
            tool_rounds = sum(1 for round_ in prefix if round_.kind == "tool")
            try:
                summary = await self._summarize(
                    SummarizeInput(
                        text=render_items_as_text(prefix_items),
                        target_bytes=summary_target,
                        kind="transcript",
                        label=f"{tool_rounds} earlier tool rounds",
                        task=self._task,
                    )
                )
            except Exception as error:
                self._rethrow_control_flow(error)
                if self._strategy == "summarize":
                    raise self._summary_failure(error) from error
                await self._context.emit(
                    "diagnostic",
                    {"code": "CONTEXT_SUMMARY_FAILED", "scope": "transcript", "message": describe_error(error)},
                )
                return False
            marker: JsonObject = {
                "kind": "summary",
                "strategy": "summarize",
                "reason": reason,
                "replaces": [item["id"] for item in prefix_items],
            }
            if retained_items:
                marker["anchor"] = retained_items[0]["id"]
            self._push_marker(
                marker,
                "user",
                "[Summary of earlier work in this step, written by Agent Runtime to fit the context window. "
                f"It replaces {tool_rounds} earlier tool rounds.]\n\n{summary}",
            )
            await self._rebuild()
            await self._emit_reduced(
                {
                    "scope": "transcript",
                    "strategy": "summarize",
                    "reason": reason,
                    "summarizedRounds": tool_rounds,
                    "retainedRounds": sum(1 for round_ in retained if round_.kind == "tool"),
                    "bytesBefore": bytes_before,
                    "bytesAfter": json_bytes(self._messages),
                    "compaction": summary_compactions(self._transcript),
                    "summaryTargetBytes": summary_target,
                    "summarizerCalls": self._summarizer_calls_used - calls_before,
                }
            )
            await self._checkpoint_ready()
            if force_once or fits.must_met():
                return True
            if summary_compactions(self._transcript) >= self._policy["context"]["maxCompactions"]:
                return False
        return fits.must_met()

    async def _prune_rounds(self, fits: _Fits, reason: str, force_once: bool) -> None:
        """Stub and remove older rounds in one reduction that reaches the goal when it can."""
        chosen = (
            self._policy["context"]["retainToolRounds"]
            if force_once
            else await self._choose_retention(fits, MINIMUM_NOTE_BYTES)
        )
        for retain in range(chosen, -1, -1):
            # 1. Stub large tool outputs in older rounds.
            await self._rebuild()
            prefix, retained = split_retained(self._view_rounds(), retain)
            prefix_items = [item for round_ in prefix for item in round_.items]
            prefix_bytes = await self._message_bytes_of(prefix_items)
            reachable = force_once or json_bytes(self._messages) - prefix_bytes + MINIMUM_NOTE_BYTES <= fits.goal
            stubs: dict[str, list[JsonObject]] = {}
            for item in prefix_items if reachable else []:
                if context_marker(item):
                    continue
                if not any(part["type"] == "tool-result" for part in item["content"]):
                    continue
                if all(
                    part["type"] != "tool-result"
                    or (
                        isinstance(part["result"].get("output"), dict)
                        and part["result"]["output"].get("agentRuntime") == "omitted"
                    )
                    for part in item["content"]
                ):
                    continue
                if await self._message_bytes_of([item]) < STUB_MINIMUM_BYTES:
                    continue
                stubs[item["id"]] = [
                    stub_tool_result_part(part) if part["type"] == "tool-result" else part for part in item["content"]
                ]
            if stubs:
                bytes_before = json_bytes(self._messages)
                self._push_marker({"kind": "rewrite", "strategy": "prune", "reason": reason, "rewrites": stubs})
                await self._rebuild()
                await self._emit_reduced(
                    {
                        "scope": "transcript",
                        "strategy": "prune",
                        "reason": reason,
                        "stubbedResults": len(stubs),
                        "bytesBefore": bytes_before,
                        "bytesAfter": json_bytes(self._messages),
                    }
                )
                if force_once or fits.goal_met():
                    await self._checkpoint_ready()
                    return

            # 2. Remove older rounds, oldest first, until the goal is met.
            prefix, retained = split_retained(self._view_rounds(), retain)
            if prefix:
                sizes = list(await asyncio.gather(*(self._message_bytes_of(round_.items) for round_ in prefix)))
                current = json_bytes(self._messages)
                count = 0
                count_limit = self._thresholds()["maxMessages"]
                message_count = len(self._messages)
                while count < len(prefix):
                    current -= sizes[count]
                    message_count -= sum(1 for item in prefix[count].items if item.get("role"))
                    count += 1
                    if (
                        not force_once
                        and current + MESSAGE_OVERHEAD_BYTES <= fits.goal
                        and (count_limit is None or message_count + 1 <= count_limit)
                    ):
                        break
                following = prefix[count] if count < len(prefix) else (retained[0] if retained else None)
                await self._remove_rounds(prefix[:count], following, reason)
            if force_once or fits.goal_met() or fits.must_met():
                await self._checkpoint_ready()
                return

            # 3. Before giving up a kept round, clip its tool outputs.
            if retained:
                await self._clip_rounds(retained, fits.must, reason)
                if fits.must_met():
                    await self._checkpoint_ready()
                    return
        await self._checkpoint_ready()

    async def _remove_rounds(
        self, rounds: list[TranscriptRound], following: TranscriptRound | None, reason: str
    ) -> None:
        if not rounds:
            return
        bytes_before = json_bytes(self._messages)
        tools: dict[str, int] = {}
        calls: list[str] = []
        removed_rounds = 0
        for round_ in rounds:
            for item in round_.items:
                marker = context_marker(item)  # pyright: ignore[reportAssignmentType]
                if marker and marker.get("kind") == "note" and marker.get("removedRounds"):
                    removed_rounds += marker["removedRounds"]
                    for name, count in js_json.js_entries(marker.get("removedTools") or {}):
                        tools[name] = tools.get(name, 0) + count
                    calls.extend(marker.get("removedCalls") or [])
                for part in item["content"]:
                    if part["type"] != "tool-call":
                        continue
                    name = part["call"]["name"]
                    tools[name] = tools.get(name, 0) + 1
                    calls.append(_describe_call(part["call"]))
            if round_.kind == "tool":
                removed_rounds += 1
        # Keep the newest calls when there are too many to list.
        listed = calls[-MAXIMUM_LISTED_CALLS:]
        had_summary = any((context_marker(round_.items[0]) or {}).get("kind") == "summary" for round_ in rounds)
        tool_list = ", ".join(f"{name} ×{_s(count)}" for name, count in js_json.js_entries(tools))
        marker: JsonObject = {
            "kind": "note",
            "strategy": "prune",
            "reason": reason,
            "replaces": [item["id"] for round_ in rounds for item in round_.items],
            "removedRounds": removed_rounds,
            "removedTools": tools,
            "removedCalls": listed,
        }
        if following is not None and following.items:
            marker["anchor"] = following.items[0]["id"]
        calls_text = ""
        if listed:
            latest = f" (the latest {len(listed)} of {len(calls)})" if len(calls) > len(listed) else ""
            calls_text = f" Calls already made{latest}: {'; '.join(listed)}."
        self._push_marker(
            marker,
            "user",
            f"[Agent Runtime removed {_s(removed_rounds)} earlier tool round{'' if removed_rounds == 1 else 's'}"
            f"{' and an earlier summary' if had_summary else ''} from this conversation to fit the context window"
            f"{f' (tools called: {tool_list})' if tool_list else ''}. Their results are no longer visible; "
            f"call a tool again if you need its output.{calls_text}]",
        )
        await self._rebuild()
        await self._emit_reduced(
            {
                "scope": "transcript",
                "strategy": "prune",
                "reason": reason,
                "removedRounds": removed_rounds,
                "bytesBefore": bytes_before,
                "bytesAfter": json_bytes(self._messages),
            }
        )

    async def _clip_rounds(self, rounds: list[TranscriptRound], target: float, reason: str) -> None:
        if not math.isfinite(target):
            return
        tool_items = [
            item
            for round_ in rounds
            for item in round_.items
            if not context_marker(item) and any(part["type"] == "tool-result" for part in item["content"])
        ]
        if not tool_items:
            return
        tool_bytes = await self._message_bytes_of(tool_items)
        other_bytes = json_bytes(self._messages) - tool_bytes
        per_item = math.floor((target - other_bytes - MESSAGE_OVERHEAD_BYTES) / len(tool_items))
        payload = max(512, per_item - MESSAGE_OVERHEAD_BYTES)
        rewrites: dict[str, list[JsonObject]] = {}
        for item in tool_items:
            if await self._message_bytes_of([item]) <= payload + MESSAGE_OVERHEAD_BYTES:
                continue
            rewrites[item["id"]] = [
                clip_tool_result_part(part, payload) if part["type"] == "tool-result" else part
                for part in item["content"]
            ]
        if not rewrites:
            return
        bytes_before = json_bytes(self._messages)
        self._push_marker({"kind": "rewrite", "strategy": "prune", "reason": reason, "rewrites": rewrites})
        await self._rebuild()
        await self._emit_reduced(
            {
                "scope": "tool-result",
                "strategy": "prune",
                "reason": reason,
                "clippedResults": len(rewrites),
                "bytesBefore": bytes_before,
                "bytesAfter": json_bytes(self._messages),
            }
        )

    async def _cap_tool_result(self, item: JsonObject) -> None:
        """Cap one new tool result so a single large output cannot fill the input."""
        if self._strategy == "fail":
            return
        trigger_bytes = self._thresholds()["triggerBytes"]
        cap = self._policy["context"]["maxToolResultBytes"]
        if cap is None and math.isfinite(trigger_bytes):
            cap = math.floor(trigger_bytes * self._policy["context"]["toolResultShare"])
        if cap is None:
            return
        size = await self._message_bytes_of([item])
        if size <= cap:
            return
        part = next((entry for entry in item["content"] if entry["type"] == "tool-result"), None)
        if part is None:
            return
        payload = max(256, cap - MESSAGE_OVERHEAD_BYTES)
        rewritten: JsonObject | None = None
        strategy = "prune"
        if self._strategy in ("summarize", "summarize-or-prune"):
            try:
                summary = await self._summarize(
                    SummarizeInput(
                        text=_tool_result_text(part["result"]),
                        target_bytes=math.floor(payload * 0.8),
                        kind="tool-result",
                        label=part["result"]["name"],
                        task=self._task,
                    )
                )
                shown = prune_text(summary, payload) if json_text_bytes(summary) > payload else summary
                rewritten = {
                    **part,
                    "result": {
                        "callId": part["result"]["callId"],
                        "name": part["result"]["name"],
                        "output": f"[Agent Runtime summary of a {size}-byte tool output]\n{shown}",
                    },
                }
                strategy = "summarize"
            except Exception as error:
                self._rethrow_control_flow(error)
                if self._strategy == "summarize":
                    raise self._summary_failure(error) from error
                await self._context.emit(
                    "diagnostic",
                    {"code": "CONTEXT_SUMMARY_FAILED", "scope": "tool-result", "message": describe_error(error)},
                )
        if rewritten is None:
            rewritten = clip_tool_result_part(part, payload)
        self._push_marker(
            {
                "kind": "rewrite",
                "strategy": strategy,
                "reason": "tool-result-size",
                "rewrites": {item["id"]: [rewritten if entry is part else entry for entry in item["content"]]},
            }
        )
        self._dirty = True
        await self._emit_reduced(
            {
                "scope": "tool-result",
                "strategy": strategy,
                "reason": "tool-result-size",
                "toolName": part["result"]["name"],
                "bytesBefore": size,
                "bytesAfter": json_bytes(rewritten),
            }
        )

    def _push_marker(
        self,
        marker: JsonObject,
        role: str | None = None,
        text: str | None = None,
        usage: JsonObject | None = None,
    ) -> JsonObject:
        item: JsonObject = {"id": self._deps.generate_transcript_id(), "type": "message"}
        if role:
            item["role"] = role
        item["content"] = [{"type": "text", "text": text}] if text else []
        item["createdAt"] = js_time.to_iso(self._deps.now())
        if usage is not None:
            item["usage"] = usage
        item["metadata"] = marker_metadata({**marker, "sequence": next_marker_sequence(self._transcript)})
        self._transcript.append(item)
        self._dirty = True
        return item

    async def _emit_reduced(self, data: JsonObject) -> None:
        self._reductions += 1
        await self._context.emit("context.reduced", data)

    def _rethrow_control_flow(self, error: BaseException) -> None:
        if is_run_suspended_error(error):
            raise error
        signal = self._context.signal
        if signal is not None and signal.aborted:
            raise abort_reason(signal) from error

    def _summary_failure(self, error: BaseException) -> BaseException:
        return ModelCompletionError(
            f'Prompt step {self._step["id"]} could not summarize its context (context strategy "summarize"): '
            f"{describe_error(error)}"
        )

    # ─── Summarizer ──────────────────────────────────────────────────────────

    async def _summarize(self, input: SummarizeInput) -> str:
        """Condense material through the host summarizer (if any) or the built-in one."""
        request: JsonObject = {
            "runId": self._context.run_id,
            "stepId": self._step["id"],
            "kind": input.kind,
            "label": input.label,
            "task": input.task,
            "text": input.text,
            "targetBytes": input.target_bytes,
            "settings": copy.deepcopy(self._policy["context"]["summarizer"]),
        }
        if self._context.signal is not None:
            request["signal"] = self._context.signal
        keyed = {name: value for name, value in request.items() if name != "signal"}
        key = fingerprint(js_json.stringify([keyed, self._context.variables]))
        journal = next((entry for entry in self._summary_journals if entry.key == key), None)
        if journal is None:
            journal = _SummaryJournal(key)
            self._summary_journals.append(journal)
        if journal.result is not None:
            return journal.result
        self._active_summary = journal
        self._summary_call_cursor = 0
        self._summary_plan_cursor = 0
        try:
            adapter = self._context.summarizer
            if adapter is not None:
                self._suspend_if_exhausted()
                result = await adapter.summarize(request, self._built_in_summarize)
            else:
                result = await self._built_in_summarize(request)
            text = result.get("text")
            valid = isinstance(text, str) and len(js_strings.trim(text)) > 0
            if valid:
                journal.result = js_strings.trim(text)  # pyright: ignore[reportArgumentType]
            if result.get("usage") is not None:
                await self._record_host_summarizer_usage(result["usage"])
            if not valid:
                raise SummarizerError(f"The summarizer returned nothing for {input.label}.")
            await self._checkpoint_ready()
            return journal.result  # type: ignore[return-value]
        finally:
            self._active_summary = None

    async def _built_in_summarize(self, request: JsonObject) -> JsonObject:
        """Agent Runtime's summarizer: chunked calls through the step's ModelAdapter."""
        settings: JsonObject = request["settings"]
        reference = settings.get("model")
        if reference is None:
            reference = step_model_reference(self._step, self._context)
        key = model_key_from_reference(reference, self._step["id"])
        description = self._description if key == self._model_key else await self._describe(key)
        hard_bytes = (self._context.manifest.get("limits") or {}).get("maxInputBytes")
        chunk_bytes = settings.get("chunkBytes")
        if chunk_bytes is None:
            max_input = (description or {}).get("maxInputTokens")
            chunk_bytes = self._estimator.bytes(max_input * 0.5) if max_input else DEFAULT_CHUNK_BYTES
        # Freeze the plan so a resumed operation traverses the same chunk/pass order.
        plan_index = self._summary_plan_cursor
        self._summary_plan_cursor += 1
        assert self._active_summary is not None
        plans = self._active_summary.plans
        if plan_index < len(plans) and plans[plan_index] is not None:
            chunk_bytes = plans[plan_index]
        while len(plans) <= plan_index:
            plans.append(None)  # type: ignore[arg-type]
        plans[plan_index] = chunk_bytes
        max_calls = settings.get("maxCalls")
        if max_calls is None:
            max_calls = self._summarizer_settings()["maxCalls"]
        prompts: dict[str, str] | None = None
        if settings.get("prompts"):
            requested = settings["prompts"]
            prompts = {}
            for kind, name in (
                ("input", "input"),
                ("transcript", "transcript"),
                ("tool-result", "toolResult"),
                ("messages", "messages"),
            ):
                if requested.get(name):
                    prompts[kind] = requested[name]

        async def call(input: SummarizerCallInput) -> str:
            return await self._call_summarizer(key, reference, input, max_calls)

        summarizer = ChunkedSummarizer(
            call=call,
            chunk_bytes=chunk_bytes,
            max_calls=max_calls,
            max_input_bytes=hard_bytes,
            max_passes=settings.get("maxPasses") or None,
            system_prompt=settings.get("systemPrompt") or None,
            prompt=settings.get("prompt") or None,
            prompts=prompts,
            max_output_tokens=settings.get("maxOutputTokens") or None,
            model_max_output_tokens=(description or {}).get("maxOutputTokens") or None,
            variables=self._context.variables,
        )
        text = await summarizer.summarize(
            SummarizeInput(
                text=request["text"],
                target_bytes=request["targetBytes"],
                kind=request["kind"],
                label=request["label"],
                task=request["task"],
            )
        )
        return {"text": text}

    async def _record_host_summarizer_usage(self, usage: JsonObject) -> None:
        """Usage a host summarizer reports counts like the built-in summarizer's."""
        budget = self._context.token_budget
        budget_state = (
            budget.consume(usage) if budget is not None and reported_total_tokens(usage) is not None else None
        )
        self._push_marker({"kind": "usage", "strategy": "none", "reason": "host-summarizer"}, None, None, usage)
        await self._checkpoint_ready()
        await self._context.emit(
            "model.usage",
            {"usage": js_json.to_json_value(usage), "purpose": "summarize", "source": "host", **(budget_state or {})},
        )

    async def _call_summarizer(
        self, model: str, reference: JsonObject | None, input: SummarizerCallInput, max_calls: int
    ) -> str:
        messages = summarizer_messages(input)
        request: JsonObject = {"model": model, "messages": messages, "maxOutputTokens": input["maxOutputTokens"]}
        if reference and reference.get("options"):
            request["providerOptions"] = reference["options"]
        request_bytes = json_bytes(messages)
        hard_bytes = (self._context.manifest.get("limits") or {}).get("maxInputBytes")
        if hard_bytes is not None and request_bytes > hard_bytes:
            raise SummarizerError(
                f"Summarizer input is {request_bytes} bytes, exceeding the {_s(hard_bytes)}-byte input limit."
            )
        journal = self._active_summary
        assert journal is not None
        index = self._summary_call_cursor
        self._summary_call_cursor += 1
        key = fingerprint(js_json.stringify(request))
        saved = journal.calls[index] if index < len(journal.calls) else None
        if saved is not None and saved.get("key") == key:
            if saved.get("error") is not None:
                raise SummarizerError(saved["error"])
            return saved["text"]
        del journal.calls[index:]
        if self._summarizer_calls_used >= max_calls:
            raise SummarizerError(f"Prompt step {self._step['id']} has used its {_s(max_calls)} summarizer calls.")
        self._suspend_if_exhausted()
        self._summarizer_calls_used += 1
        result = await self._invoke(request, stream=False, provider=reference_provider(reference), purpose="summarize")
        usage = await self._record_usage(result, request_bytes, "summarize")
        if usage is not None:
            self._push_marker({"kind": "usage", "strategy": "none", "reason": "summarizer"}, None, None, usage)
        error: str | None = None
        if len(result.get("toolCalls") or []) > 0:
            error = "The summarizer requested tool calls."
        if is_truncated_finish_reason(result.get("finishReason")):
            error = (
                f"The summarizer's output was truncated ({result.get('finishReason')}); "
                "raise the summarizer's maxOutputTokens."
            )
        output = _output_of(result)
        if isinstance(output, str):
            text = output
        elif output is UNDEFINED:
            text = ""
        else:
            text = js_json.stringify(output)
        journal.calls.append({"key": key, **({"error": error} if error else {"text": text})})
        await self._checkpoint_ready()
        if error:
            raise SummarizerError(error)
        return text

    # ─── Model calls ─────────────────────────────────────────────────────────

    async def _request_model(self, finalize: bool) -> JsonObject:
        context = self._context
        reference = step_model_reference(self._step, context)
        overflow_retries = 0
        while True:
            max_output_tokens = (
                self._output_token_override
                if self._output_token_override is not None
                else self._step.get("maxOutputTokens")
            )
            request: JsonObject = {"model": self._model_key, "messages": self._messages}
            if self._tools:
                request["tools"] = self._tools
                if finalize:
                    request["toolChoice"] = "none"
            if self._step.get("outputSchema") is not None:
                request["outputSchema"] = self._step["outputSchema"]
            if max_output_tokens:
                request["maxOutputTokens"] = max_output_tokens
            if reference and reference.get("options"):
                request["providerOptions"] = reference["options"]
            request_bytes = json_bytes(self._messages)
            try:
                result = await self._invoke(request, stream=True, provider=reference_provider(reference))
            except Exception as error:
                if context.signal is not None and context.signal.aborted:
                    raise
                if (
                    is_context_overflow_error(error)
                    and self._strategy != "fail"
                    and overflow_retries < self._policy["context"]["overflowRetries"]
                ):
                    overflow_retries += 1
                    ceiling = math.inf if self._overflow_ceiling_bytes is None else self._overflow_ceiling_bytes
                    self._overflow_ceiling_bytes = math.floor(min(ceiling, request_bytes) * 0.75)
                    await context.emit(
                        "model.retry",
                        {
                            "reason": "context-overflow",
                            "attempt": overflow_retries,
                            "inputBytes": request_bytes,
                            **error_summary(error),
                        },
                    )
                    await self._fit_context("overflow")
                    await self._rebuild()
                    self._enforce_input_limits()
                    continue
                if is_invalid_output_error(error) and self._repairs_used < self._policy["outputRepairAttempts"]:
                    self._repairs_used += 1
                    await context.emit(
                        "model.retry",
                        {"reason": "invalid-output", "attempt": self._repairs_used, **error_summary(error)},
                    )
                    self._push_marker(
                        {"kind": "note", "strategy": "none", "reason": "invalid-output"},
                        "user",
                        "[Agent Runtime] Your previous response could not be used: "
                        f"{prune_text(describe_error(error), 600)} Respond again with only a final answer that "
                        "matches the required output format.",
                    )
                    await self._checkpoint_ready()
                    await self._rebuild()
                    self._enforce_input_limits()
                    continue
                raise

            self._transcript.extend(result.get("transcript") or [])
            self._dirty = True
            await context.emit("model.completed", safe_model_completed_data(result))
            await self._record_usage(result, request_bytes)
            if finalize and len(result.get("toolCalls") or []) > 0:
                # The model ignored toolChoice: none. Answer its calls so the
                # history stays valid, and keep its text as the final answer.
                for call in result.get("toolCalls") or []:
                    if call.get("providerExecuted") or _has_tool_result_for(result.get("transcript") or [], call["id"]):
                        continue
                    self._transcript.append(
                        self._tool_transcript(
                            {
                                "callId": call["id"],
                                "name": call["name"],
                                "error": {
                                    "code": "tool_call_limit_reached",
                                    "message": f"The {_s(self._max_tool_calls)}-call tool limit for this step has been reached.",
                                },
                            }
                        )
                    )
                result = {**result, "toolCalls": []}
            return result

    async def _invoke(
        self, request: JsonObject, *, stream: bool, provider: str, purpose: str | None = None
    ) -> JsonObject:
        """Invoke the model with the retry policy. Streams only for the main request."""
        context = self._context
        retry = self._policy["modelRetry"]
        timeout_ms = (context.manifest.get("limits") or {}).get("providerTimeoutMs")
        attempt = 1
        while True:
            self._suspend_if_exhausted()
            operation = model_operation(context.signal, timeout_ms)
            attempt_request = {**request}
            if operation.signal is not None:
                attempt_request["signal"] = operation.signal
            started: JsonObject = {"model": request["model"], "provider": provider}
            if purpose:
                started["purpose"] = purpose
            await context.emit("model.started", started)
            try:
                if stream:
                    result = await self._stream_model(attempt_request)
                else:
                    result = await race_with_signal(
                        lambda request=attempt_request: context.model.generate(request), attempt_request.get("signal")
                    )
                if purpose:
                    await context.emit("model.completed", {**safe_model_completed_data(result), "purpose": purpose})
                return result
            except Exception as caught:
                error: BaseException = ModelTimeoutError(timeout_ms) if operation.did_time_out() else caught  # pyright: ignore[reportArgumentType]
                if context.signal is not None and context.signal.aborted:
                    if error is caught:
                        raise
                    raise error from caught
                if attempt >= retry["maxAttempts"] or not is_retryable_model_error(error):
                    if error is caught:
                        raise
                    raise error from caught
                delay_ms = min(retry["maxDelayMs"], retry["initialDelayMs"] * 2 ** (attempt - 1))
                retry_data: JsonObject = {
                    "reason": "retryable-error",
                    "attempt": attempt,
                    "maxAttempts": retry["maxAttempts"],
                    "delayMs": delay_ms,
                }
                if purpose:
                    retry_data["purpose"] = purpose
                retry_data.update(error_summary(error))
                await context.emit("model.retry", retry_data)
                await self._deps.sleep(delay_ms, context.signal)
            finally:
                operation.dispose()
            attempt += 1

    async def _stream_model(self, request: JsonObject) -> JsonObject:
        context = self._context
        stream = getattr(context.model, "stream", None)
        signal = request.get("signal")
        if stream is None:
            return await race_with_signal(lambda: context.model.generate(request), signal)
        if signal is not None and signal.aborted:
            raise abort_reason(signal)
        completed: JsonObject | None = None
        iterator = stream(request).__aiter__()
        try:
            while True:
                try:
                    event = await race_with_signal(lambda: iterator.__anext__(), signal)
                except StopAsyncIteration:
                    break
                kind = event.get("type")
                if kind == "text-delta":
                    await context.emit("model.text.delta", {"delta": event["delta"]})
                elif kind == "reasoning-delta":
                    await context.emit("model.reasoning.delta", {"delta": event["delta"]})
                elif kind == "completed":
                    completed = event["result"]
        finally:
            # Ask the adapter to clean up without waiting for it.
            if signal is not None and signal.aborted:
                close = getattr(iterator, "aclose", None)
                if close is not None:
                    task = asyncio.ensure_future(_quietly(close))
                    _BACKGROUND.add(task)
                    task.add_done_callback(_BACKGROUND.discard)
        if completed is None:
            raise Error("Model stream ended without a completed result")
        return completed

    async def _record_usage(
        self, result: JsonObject, request_bytes: int, purpose: str | None = None
    ) -> JsonObject | None:
        """Calibrate token estimates, consume the run budget, and emit usage."""
        context = self._context
        usage = result_usage(result)
        if not purpose and usage is not None and (usage.get("metadata") or {}).get("estimated") is not True:
            self._estimator.observe(request_bytes, usage.get("inputTokens"))
        if context.token_budget is not None and (usage is None or reported_total_tokens(usage) is None):
            input_tokens = self._estimator.tokens(request_bytes)
            output_tokens = self._estimator.tokens(
                json_bytes([item["content"] for item in result.get("transcript") or []])
            )
            usage = {
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalTokens": input_tokens + output_tokens,
                "metadata": {"estimated": True},
            }
            carrier = next(
                (item for item in reversed(result.get("transcript") or []) if item.get("role") == "assistant"), None
            )
            if carrier is not None and not purpose:
                carrier["usage"] = usage
            if not self._usage_estimate_reported:
                self._usage_estimate_reported = True
                await context.emit(
                    "diagnostic",
                    {
                        "code": "USAGE_ESTIMATED",
                        "message": "The model did not report token usage; the run budget uses an estimate.",
                    },
                )
        budget_state = (
            context.token_budget.consume(usage if usage is not None else {})
            if context.token_budget is not None
            else None
        )
        if usage is not None:
            data: JsonObject = {"usage": js_json.to_json_value(usage)}
            if purpose:
                data["purpose"] = purpose
            data.update(budget_state or {})
            await context.emit("model.usage", data)
        return usage

    def _suspend_if_exhausted(self) -> None:
        budget = self._context.token_budget
        if budget is None or budget.consumed_tokens < budget.max_total_tokens:
            return
        raise RunSuspendedError(
            "token-budget",
            {
                "maxTotalTokens": budget.max_total_tokens,
                "consumedTokens": budget.consumed_tokens,
                "stepId": self._step["id"],
            },
        )

    # ─── Repairs ─────────────────────────────────────────────────────────────

    async def _ensure_finalize_notice(self) -> None:
        view = compacted_view(self._transcript)
        last = view[-1] if view else None
        if last is not None and (context_marker(last) or {}).get("reason") == "tool-call-limit":
            return
        self._push_marker(
            {"kind": "note", "strategy": "none", "reason": "tool-call-limit"},
            "user",
            f"[Agent Runtime] This step has used its limit of {_s(self._max_tool_calls)} tool calls. Do not call "
            "any more tools. Using the information gathered so far, give your final answer now.",
        )
        await self._context.emit(
            "diagnostic", {"code": "TOOL_CALL_LIMIT_REACHED", "maxToolCalls": self._max_tool_calls}
        )
        await self._checkpoint_ready()

    async def _repair_truncation(self, result: JsonObject) -> bool:
        """Retry a truncated response once with a larger output budget."""
        if self._repairs_used >= self._policy["outputRepairAttempts"]:
            return False
        model_limit = (self._description or {}).get("maxOutputTokens")
        current = self._output_token_override
        if current is None:
            current = self._step.get("maxOutputTokens")
        if current is None:
            current = (result_usage(result) or {}).get("outputTokens")
        if current is None:
            return False
        next_limit = min(current * 2, model_limit if model_limit is not None else current * 2)
        if next_limit <= current:
            return False
        self._repairs_used += 1
        self._output_token_override = next_limit
        self._push_marker(
            {
                "kind": "rewrite",
                "strategy": "none",
                "reason": "truncated-response",
                "replaces": [item["id"] for item in result.get("transcript") or []],
            }
        )
        await self._context.emit(
            "model.retry",
            {"reason": "truncated-output", "attempt": self._repairs_used, "maxOutputTokens": next_limit},
        )
        await self._checkpoint_ready()
        return True

    async def _repair_empty_output(self) -> bool:
        if self._repairs_used >= self._policy["outputRepairAttempts"]:
            return False
        self._repairs_used += 1
        self._push_marker(
            {"kind": "note", "strategy": "none", "reason": "empty-output"},
            "user",
            "[Agent Runtime] Your previous response was empty. Give your final answer now.",
        )
        await self._context.emit("model.retry", {"reason": "empty-output", "attempt": self._repairs_used})
        await self._checkpoint_ready()
        return True

    # ─── Tools ───────────────────────────────────────────────────────────────

    def _rejection(self, call: JsonObject) -> JsonObject | None:
        """Why a call must not run, or ``None`` when it may."""
        invalid = _invalid_call_error(call)
        if invalid is not None:
            return {"code": "tool_call_invalid", "message": invalid}
        if call["name"] not in self._allowed_tools:
            available = f" Available tools: {', '.join(self._allowed_tools)}." if self._allowed_tools else ""
            return {
                "code": "tool_not_allowed",
                "message": f'Tool "{call["name"]}" is not available in this step.{available}',
            }
        if self._policy["toolCallLimit"] == "finalize" and self._tool_call_count >= self._max_tool_calls:
            return {
                "code": "tool_call_limit_reached",
                "message": f"The {_s(self._max_tool_calls)}-call tool limit for this step has been reached; "
                "answer with the information gathered so far.",
            }
        return None

    async def _execute_tool_calls(self, pending: PendingModelResult) -> None:
        context = self._context
        calls = pending.result.get("toolCalls") or []
        executable = [
            call
            for call in calls[pending.next_tool_index :]
            if not call.get("providerExecuted") and not self._rejection(call)
        ]
        if executable and not context.tools:
            raise Error("Model requested tools but no ToolAdapter is configured")
        if self._policy["toolCallLimit"] == "fail" and self._tool_call_count + len(executable) > self._max_tool_calls:
            raise Error(
                f"Prompt step {self._step['id']} exceeded its {_s(self._max_tool_calls)} tool-call limit across "
                "the prompt step"
            )

        for tool_index in range(pending.next_tool_index, len(calls)):
            call = calls[tool_index]
            # Provider-executed tools already have their results in the response.
            if not call.get("providerExecuted"):
                await context.emit("model.tool.requested", {"toolCallId": call["id"], "toolName": call["name"]})
                rejection = self._rejection(call)
                if rejection:
                    self._tool_call_count += 1
                    # The adapter may already have answered an invalid call.
                    if not _has_tool_result_for(self._transcript, call["id"]):
                        self._transcript.append(
                            self._tool_transcript({"callId": call["id"], "name": call["name"], "error": rejection})
                        )
                        self._dirty = True
                    await context.emit(
                        "model.tool.completed",
                        {
                            "toolCallId": call["id"],
                            "toolName": call["name"],
                            "failed": True,
                            "rejected": True,
                            "errorCode": rejection["code"],
                        },
                    )
                else:
                    await context.emit("model.tool.started", {"toolCallId": call["id"], "toolName": call["name"]})
                    tool_result = await context.tools.execute_tool(
                        call,
                        ToolExecutionContext(
                            run_id=context.run_id,
                            step_id=self._step["id"],
                            variables=context.variables,
                            idempotency_key=pending.tool_idempotency_keys[tool_index],
                            workspaces=context.workspaces,
                            run_sandbox=context.run_sandbox,
                            signal=context.signal,
                        ),
                    )
                    self._tool_call_count += 1
                    item = self._tool_transcript(tool_result)
                    self._transcript.append(item)
                    self._dirty = True
                    pending.next_tool_index = tool_index + 1
                    self._pending_reductions.append(item["id"])
                    await self._checkpoint_pending(pending)
                    completed: JsonObject = {
                        "toolCallId": call["id"],
                        "toolName": call["name"],
                        "failed": tool_result.get("error") is not None,
                    }
                    if tool_result.get("error"):
                        completed["errorCode"] = tool_result["error"]["code"]
                    await context.emit("model.tool.completed", completed)
                    await self._finish_tool_reductions()
            pending.next_tool_index = tool_index + 1
            await self._checkpoint_pending(pending)

    def _tool_transcript(self, result: JsonObject) -> JsonObject:
        return {
            "id": self._deps.generate_transcript_id(),
            "type": "tool-result",
            "role": "tool",
            "content": [{"type": "tool-result", "result": result}],
            "createdAt": js_time.to_iso(self._deps.now()),
        }

    # ─── Checkpoints ─────────────────────────────────────────────────────────

    def _restore_progress(self) -> None:
        value = (self._context.resume or {}).get("continuation")
        if not isinstance(value, dict) or value.get("type") != "prompt" or value.get("stepId") != self._step["id"]:
            return
        pending_reductions = value.get("pendingReductions")
        if isinstance(pending_reductions, list) and all(isinstance(entry, str) for entry in pending_reductions):
            self._pending_reductions = list(pending_reductions)
        used = value.get("summarizerCallsUsed")
        if _is_safe_integer(used) and used >= 0:
            self._summarizer_calls_used = int(used)  # pyright: ignore[reportArgumentType]
        journals = value.get("summaryJournals")
        if isinstance(journals, list) and all(_valid_journal(entry) for entry in journals):
            self._summary_journals = [
                _SummaryJournal(entry["key"], list(entry["plans"]), copy.deepcopy(entry["calls"]), entry.get("result"))
                for entry in journals
            ]
        estimate = value.get("tokenEstimate")
        if (
            isinstance(estimate, dict)
            and estimate.get("calibrated") is True
            and isinstance(estimate.get("bytesPerToken"), (int, float))
            and not isinstance(estimate.get("bytesPerToken"), bool)
        ):
            self._estimator.observe(estimate["bytesPerToken"], 1)
        ceiling = value.get("overflowCeilingBytes")
        if (
            isinstance(ceiling, (int, float))
            and not isinstance(ceiling, bool)
            and math.isfinite(ceiling)
            and ceiling > 0
        ):
            self._overflow_ceiling_bytes = ceiling

    async def _finish_tool_reductions(self) -> None:
        while self._pending_reductions:
            item = next((entry for entry in self._transcript if entry["id"] == self._pending_reductions[0]), None)
            if item is not None:
                await self._cap_tool_result(item)
            self._pending_reductions.pop(0)
            await self._checkpoint_ready()

    async def _checkpoint_pending(self, pending: PendingModelResult) -> None:
        self._pending = pending
        await self._checkpoint_ready()

    async def _checkpoint_ready(self) -> None:
        """Commit transcript changes made between model turns (reductions, notes)."""
        if not self._checkpoint_rounds or self._context.checkpoint is None:
            return
        pending = self._pending
        continuation: JsonObject = {
            "type": "prompt",
            "phase": "model-completed" if pending else "ready",
            "stepId": self._step["id"],
            "toolCallCount": self._tool_call_count,
        }
        if pending is not None:
            output = _output_of(pending.result)
            continuation["hasOutput"] = output is not UNDEFINED
            if output is not UNDEFINED:
                continuation["output"] = copy.deepcopy(output)
            if pending.result.get("finishReason"):
                continuation["finishReason"] = pending.result["finishReason"]
            continuation["toolCalls"] = js_json.to_json_value(pending.result.get("toolCalls") or [])
            continuation["toolIdempotencyKeys"] = pending.tool_idempotency_keys
            continuation["nextToolIndex"] = pending.next_tool_index
        continuation["pendingReductions"] = list(self._pending_reductions)
        continuation["summarizerCallsUsed"] = self._summarizer_calls_used
        continuation["summaryJournals"] = js_json.to_json_value(
            [journal.to_json() for journal in self._summary_journals]
        )
        continuation["tokenEstimate"] = {
            "bytesPerToken": self._estimator.bytes_per_token,
            "calibrated": self._estimator.calibrated,
        }
        if self._overflow_ceiling_bytes is not None:
            continuation["overflowCeilingBytes"] = self._overflow_ceiling_bytes
        await self._context.checkpoint(
            {
                "state": copy.deepcopy(self._context.variables),
                "continuation": continuation,
                "transcript": self._transcript,
            }
        )


def _valid_journal(entry: Any) -> bool:
    if (
        not isinstance(entry, dict)
        or not isinstance(entry.get("key"), str)
        or not isinstance(entry.get("plans"), list)
        or not isinstance(entry.get("calls"), list)
    ):
        return False
    return (
        ("result" not in entry or isinstance(entry["result"], str))
        and all(
            isinstance(size, (int, float)) and not isinstance(size, bool) and math.isfinite(size) and size > 0
            for size in entry["plans"]
        )
        and all(
            isinstance(call, dict)
            and isinstance(call.get("key"), str)
            and (isinstance(call.get("text"), str) or isinstance(call.get("error"), str))
            for call in entry["calls"]
        )
    )


_BACKGROUND: set[asyncio.Future[Any]] = set()


async def _quietly(close: Callable[[], Any]) -> None:
    with contextlib.suppress(BaseException):
        result = close()
        if inspect.isawaitable(result):
            await result
