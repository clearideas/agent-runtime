"""Prompt step executor (``@clearideas/agent-runtime-step-prompt``)."""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from ..._js import time as js_time
from ..._js.errors import Error
from ...core.runtime import StepExecutionContext, StepPreflightContext
from ...core.templates import compile_prompt_template
from .context.errors import (
    is_context_overflow_error,
    is_invalid_output_error,
    is_retryable_model_error,
)
from .context.prune import prune_json, prune_text
from .context.summarize import (
    DEFAULT_SUMMARIZER_INSTRUCTIONS,
    DEFAULT_SUMMARIZER_MAX_PASSES,
    DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    ChunkedSummarizer,
    SummarizeInput,
    SummarizerError,
    split_into_chunks,
)
from .context.transcript import ContextMarker, compacted_view, context_marker, derive_rounds
from .execution import (
    PROMPT_POLICY_DEFAULTS,
    SUMMARIZER_DEFAULTS,
    PromptExecution,
    PromptExecutionDependencies,
    resolve_prompt_policies,
)
from .helpers import ModelCompletionError, ModelTimeoutError, abortable_sleep
from .history_compactor import PromptMessageHistoryCompactor

JsonObject = dict[str, Any]

__all__ = [
    "DEFAULT_SUMMARIZER_INSTRUCTIONS",
    "DEFAULT_SUMMARIZER_MAX_PASSES",
    "DEFAULT_SUMMARIZER_SYSTEM_PROMPT",
    "PROMPT_POLICY_DEFAULTS",
    "SUMMARIZER_DEFAULTS",
    "ChunkedSummarizer",
    "ContextMarker",
    "ModelCompletionError",
    "ModelTimeoutError",
    "PromptMessageHistoryCompactor",
    "PromptStepExecutor",
    "SummarizeInput",
    "SummarizerError",
    "compacted_view",
    "compile_prompt_template",
    "context_marker",
    "derive_rounds",
    "is_context_overflow_error",
    "is_invalid_output_error",
    "is_retryable_model_error",
    "prune_json",
    "prune_text",
    "resolve_prompt_policies",
    "split_into_chunks",
]


class PromptStepExecutor:
    type = "prompt"

    def __init__(
        self,
        *,
        now: Callable[[], datetime] | None = None,
        generate_transcript_id: Callable[[], str] | None = None,
        generate_tool_idempotency_key: Callable[[], str] | None = None,
        default_max_tool_calls: int | None = None,
        sleep: Callable[[float, Any], Awaitable[None]] | None = None,
    ) -> None:
        self._now = now or js_time.now
        self._generate_transcript_id = generate_transcript_id or (lambda: str(uuid.uuid4()))
        self._generate_tool_idempotency_key = generate_tool_idempotency_key or (lambda: f"agent-runtime:{uuid.uuid4()}")
        self._default_max_tool_calls = 25 if default_max_tool_calls is None else default_max_tool_calls
        self._sleep = sleep or abortable_sleep

    def preflight(self, step: JsonObject, context: StepPreflightContext) -> list[str]:
        problems: list[str] = []
        if not context.model:
            problems.append(f"Prompt step {step['id']} requires a ModelAdapter.")
        if not (step.get("model") if step.get("model") is not None else context.manifest.get("model")):
            problems.append(f"Prompt step {step['id']} requires a model.")
        if len(step.get("tools") or []) > 0 and not context.tools:
            problems.append(f"Prompt step {step['id']} names tools, but no ToolAdapter is configured.")
        return problems

    async def execute(self, context: StepExecutionContext) -> JsonObject:
        if not context.model:
            raise Error(f"Prompt step {context.step['id']} requires a ModelAdapter")
        return await PromptExecution(
            context,
            PromptExecutionDependencies(
                now=self._now,
                generate_transcript_id=self._generate_transcript_id,
                generate_tool_idempotency_key=self._generate_tool_idempotency_key,
                default_max_tool_calls=self._default_max_tool_calls,
                sleep=self._sleep,
            ),
        ).run()
