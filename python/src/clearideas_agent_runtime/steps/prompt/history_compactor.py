"""Run-level compaction of a conversation history (``step-prompt/src/history-compactor.ts``).

Summarizes the oldest part of the history once per run, before the first
step, with the same summarizer, policies, host adapter, retries, budget, and
journaling that prompt steps use for their own context.
"""

from __future__ import annotations

import copy
import math
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from ..._js import json as js_json
from ..._js import strings as js_strings
from ..._js import time as js_time
from ...core.errors import RunSuspendedError
from ...core.messages import MessageHistoryCompactionRequest
from ...core.runtime import maybe_await
from .context.errors import error_summary, is_retryable_model_error
from .context.measure import json_bytes, json_text_bytes
from .context.prune import prune_text
from .context.summarize import (
    ChunkedSummarizer,
    SummarizeInput,
    SummarizerCallInput,
    SummarizerError,
    summarizer_messages,
)
from .context.transcript import fingerprint
from .execution import PROMPT_POLICY_DEFAULTS, SUMMARIZER_DEFAULTS
from .helpers import (
    ModelTimeoutError,
    abortable_sleep,
    is_truncated_finish_reason,
    model_key_from_reference,
    model_operation,
    race_with_signal,
    reference_provider,
    reported_total_tokens,
    result_usage,
    safe_model_completed_data,
)

JsonObject = dict[str, Any]
BYTES_PER_TOKEN = 4


def _parse_journal(value: JsonObject | None) -> JsonObject:
    plans_value = (value or {}).get("plans")
    calls_value = (value or {}).get("calls")
    plans = (
        [plan for plan in plans_value if isinstance(plan, (int, float)) and not isinstance(plan, bool)]
        if isinstance(plans_value, list)
        else []
    )
    calls: list[JsonObject] = []
    if isinstance(calls_value, list):
        for call in calls_value:
            if isinstance(call, dict) and isinstance(call.get("key"), str):
                entry: JsonObject = {"key": call["key"]}
                if isinstance(call.get("text"), str):
                    entry["text"] = call["text"]
                if isinstance(call.get("error"), str):
                    entry["error"] = call["error"]
                calls.append(entry)
    return {"plans": plans, "calls": calls}


def _s(value: Any) -> str:
    from ..._js.ops import to_string

    return to_string(value)


class PromptMessageHistoryCompactor:
    """Summarizes conversation histories for AgentRuntime's run-level compaction."""

    def __init__(
        self,
        *,
        now: Callable[[], datetime] | None = None,
        generate_transcript_id: Callable[[], str] | None = None,
        sleep: Callable[[float, Any], Awaitable[None]] | None = None,
    ) -> None:
        self._now = now or js_time.now
        self._generate_transcript_id = generate_transcript_id or (lambda: str(uuid.uuid4()))
        self._sleep = sleep or abortable_sleep

    async def summarize(self, request: MessageHistoryCompactionRequest) -> JsonObject:
        policies = request.policies or {}
        context_policy = policies.get("context") or {}
        settings: JsonObject = context_policy.get("summarizer") or {}
        journal = _parse_journal(request.journal)
        transcript: list[JsonObject] = []
        state = {"calls": 0, "call_cursor": 0, "plan_cursor": 0}

        share = settings.get("summaryShare")
        share = SUMMARIZER_DEFAULTS["summaryShare"] if share is None else share
        minimum = settings.get("minSummaryBytes")
        minimum = SUMMARIZER_DEFAULTS["minSummaryBytes"] if minimum is None else minimum
        maximum = settings.get("maxSummaryBytes")
        maximum = SUMMARIZER_DEFAULTS["maxSummaryBytes"] if maximum is None else maximum
        target_bytes = max(
            256, min(request.max_target_bytes, min(maximum, max(minimum, request.segment_bytes * share)))
        )
        max_calls = settings.get("maxCalls")
        if max_calls is None:
            max_compactions = context_policy.get("maxCompactions")
            if max_compactions is None:
                max_compactions = PROMPT_POLICY_DEFAULTS["maxCompactions"]
            max_calls = max(
                SUMMARIZER_DEFAULTS["minimumMaxCalls"], max_compactions * SUMMARIZER_DEFAULTS["callsPerCompaction"]
            )
        model_retry = policies.get("modelRetry") or {}
        defaults = PROMPT_POLICY_DEFAULTS["modelRetry"]
        retry = {
            name: model_retry.get(name) if model_retry.get(name) is not None else defaults[name]
            for name in ("maxAttempts", "initialDelayMs", "maxDelayMs")
        }

        def suspend_if_exhausted() -> None:
            budget = request.token_budget
            if budget is None or budget.consumed_tokens < budget.max_total_tokens:
                return
            raise RunSuspendedError(
                "token-budget",
                {
                    "maxTotalTokens": budget.max_total_tokens,
                    "consumedTokens": budget.consumed_tokens,
                    "scope": "messages",
                },
            )

        async def record_usage(usage: JsonObject, source: str | None = None) -> None:
            budget = request.token_budget
            budget_state = (
                budget.consume(usage) if budget is not None and reported_total_tokens(usage) is not None else None
            )
            transcript.append(
                {
                    "id": self._generate_transcript_id(),
                    "type": "message",
                    "content": [],
                    "createdAt": js_time.to_iso(self._now()),
                    "usage": usage,
                    "metadata": {
                        "agentRuntime": {
                            "context": {"kind": "usage", "strategy": "none", "reason": "messages-summarizer"}
                        }
                    },
                }
            )
            data: JsonObject = {"usage": js_json.to_json_value(usage), "purpose": "summarize"}
            if source:
                data["source"] = source
            data.update(budget_state or {})
            await request.emit("model.usage", data)

        async def save() -> None:
            await request.checkpoint(copy.deepcopy(journal), copy.deepcopy(transcript))

        async def invoke(model_request: JsonObject, provider: str) -> JsonObject:
            model = request.model
            if not model:
                raise SummarizerError("Summarizing the conversation requires a ModelAdapter.")
            timeout_ms = (request.manifest.get("limits") or {}).get("providerTimeoutMs")
            attempt = 1
            while True:
                suspend_if_exhausted()
                operation = model_operation(request.signal, timeout_ms)
                try:
                    await request.emit(
                        "model.started", {"model": model_request["model"], "provider": provider, "purpose": "summarize"}
                    )
                    attempt_request = dict(model_request)
                    if operation.signal is not None:
                        attempt_request["signal"] = operation.signal
                    result = await race_with_signal(
                        lambda request=attempt_request: model.generate(request), operation.signal
                    )
                    await request.emit("model.completed", {**safe_model_completed_data(result), "purpose": "summarize"})
                    return result
                except Exception as caught:
                    error: BaseException = ModelTimeoutError(timeout_ms) if operation.did_time_out() else caught  # pyright: ignore[reportArgumentType]
                    if request.signal is not None and request.signal.aborted:
                        raise error from (caught if error is not caught else None)
                    if attempt >= retry["maxAttempts"] or not is_retryable_model_error(error):  # pyright: ignore[reportOperatorIssue]
                        raise error from (caught if error is not caught else None)
                    delay_ms = min(retry["maxDelayMs"], retry["initialDelayMs"] * 2 ** (attempt - 1))  # pyright: ignore[reportArgumentType]
                    await request.emit(
                        "model.retry",
                        {
                            "reason": "retryable-error",
                            "attempt": attempt,
                            "maxAttempts": retry["maxAttempts"],
                            "delayMs": delay_ms,
                            "purpose": "summarize",
                            **error_summary(error),
                        },
                    )
                    await self._sleep(delay_ms, request.signal)
                finally:
                    operation.dispose()
                attempt += 1

        async def built_in(summarize_request: JsonObject) -> JsonObject:
            requested: JsonObject = summarize_request["settings"]
            reference = requested.get("model")
            if reference is None:
                reference = request.manifest.get("model")
            key = model_key_from_reference(reference, "messages")
            description: JsonObject | None = None
            describe = getattr(request.model, "describe_model", None)
            if describe is not None:
                try:
                    description = await maybe_await(describe(key))
                except Exception:
                    description = None
            hard_bytes = (request.manifest.get("limits") or {}).get("maxInputBytes")
            plan_index = state["plan_cursor"]
            state["plan_cursor"] += 1
            plans: list[Any] = journal["plans"]
            chunk_bytes = plans[plan_index] if plan_index < len(plans) else None
            if chunk_bytes is None:
                chunk_bytes = requested.get("chunkBytes")
            if chunk_bytes is None:
                max_input = (description or {}).get("maxInputTokens")
                chunk_bytes = (
                    math.floor(max_input * 0.5 * BYTES_PER_TOKEN) if max_input else SUMMARIZER_DEFAULTS["chunkBytes"]
                )
            while len(plans) <= plan_index:
                plans.append(None)
            plans[plan_index] = chunk_bytes

            async def call(input: SummarizerCallInput) -> str:
                messages = summarizer_messages(input)
                model_request: JsonObject = {
                    "model": key,
                    "messages": messages,
                    "maxOutputTokens": input["maxOutputTokens"],
                }
                if reference and reference.get("options"):
                    model_request["providerOptions"] = reference["options"]
                request_bytes = json_bytes(messages)
                if hard_bytes is not None and request_bytes > hard_bytes:
                    raise SummarizerError(
                        f"Summarizer input is {request_bytes} bytes, exceeding the {_s(hard_bytes)}-byte input limit."
                    )
                index = state["call_cursor"]
                state["call_cursor"] += 1
                call_key = fingerprint(js_json.stringify(model_request))
                saved = journal["calls"][index] if index < len(journal["calls"]) else None
                if saved is not None and saved.get("key") == call_key:
                    if saved.get("error") is not None:
                        raise SummarizerError(saved["error"])
                    return saved["text"]
                del journal["calls"][index:]
                if state["calls"] >= max_calls:
                    raise SummarizerError(
                        f"Summarizing the conversation needs more than {_s(max_calls)} summarizer calls."
                    )
                state["calls"] += 1
                result = await invoke(model_request, reference_provider(reference))
                usage = result_usage(result)
                if request.token_budget is not None and (usage is None or reported_total_tokens(usage) is None):
                    input_tokens = math.ceil(request_bytes / BYTES_PER_TOKEN)
                    output_tokens = math.ceil(
                        json_bytes([item["content"] for item in result.get("transcript") or []]) / BYTES_PER_TOKEN
                    )
                    usage = {
                        "inputTokens": input_tokens,
                        "outputTokens": output_tokens,
                        "totalTokens": input_tokens + output_tokens,
                        "metadata": {"estimated": True},
                    }
                if usage is not None:
                    await record_usage(usage)
                error: str | None = None
                if len(result.get("toolCalls") or []) > 0:
                    error = "The summarizer requested tool calls."
                if is_truncated_finish_reason(result.get("finishReason")):
                    error = (
                        f"The summarizer's output was truncated ({result.get('finishReason')}); "
                        "raise the summarizer's maxOutputTokens."
                    )
                output = result.get("output")
                if isinstance(output, str):
                    text = output
                elif "output" not in result:
                    text = ""
                else:
                    text = js_json.stringify(output)
                journal["calls"].append({"key": call_key, **({"error": error} if error else {"text": text})})
                await save()
                if error:
                    raise SummarizerError(error)
                return text

            prompts = requested.get("prompts") or {}
            summarizer = ChunkedSummarizer(
                call=call,
                chunk_bytes=chunk_bytes,
                max_calls=max_calls,
                max_input_bytes=hard_bytes,
                max_passes=requested.get("maxPasses") or None,
                system_prompt=requested.get("systemPrompt") or None,
                prompt=requested.get("prompt") or None,
                prompts={"messages": prompts["messages"]} if prompts.get("messages") else None,
                max_output_tokens=requested.get("maxOutputTokens") or None,
                model_max_output_tokens=(description or {}).get("maxOutputTokens") or None,
                variables={},
            )
            text = await summarizer.summarize(
                SummarizeInput(
                    text=summarize_request["text"],
                    target_bytes=summarize_request["targetBytes"],
                    kind="messages",
                    label=summarize_request["label"],
                    task=summarize_request["task"],
                )
            )
            return {"text": text}

        summarize_request: JsonObject = {
            "runId": request.run_id,
            # History compaction belongs to the run, not a step.
            "stepId": "",
            "kind": "messages",
            "label": request.label,
            "task": request.task,
            "text": request.text,
            "targetBytes": math.floor(target_bytes),
            "settings": copy.deepcopy(settings),
        }
        if request.signal is not None:
            summarize_request["signal"] = request.signal
        if request.summarizer is not None:
            suspend_if_exhausted()
            result = await request.summarizer.summarize(summarize_request, built_in)
            if result.get("usage") is not None:
                await record_usage(result["usage"], "host")
                await save()
        else:
            result = await built_in(summarize_request)
        raw = result.get("text")
        text = js_strings.trim(raw) if isinstance(raw, str) else ""
        if not text:
            raise SummarizerError(f"The summarizer returned nothing for {request.label}.")
        return {
            "text": prune_text(text, request.max_target_bytes)
            if json_text_bytes(text) > request.max_target_bytes
            else text,
            "transcript": transcript,
            "summarizerCalls": state["calls"],
        }
