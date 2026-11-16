"""Low-level helpers shared by the prompt executor (``step-prompt/src/helpers.ts``).

Model-call timeouts and cancellation, media resolution, and result inspection.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import copy
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from ..._js import json as js_json
from ..._js import strings as js_strings
from ..._js.abort import AbortController, AbortSignal
from ..._js.errors import Error
from ..._js.ops import UNDEFINED
from ...core.runtime import StepExecutionContext

JsonObject = dict[str, Any]
T = TypeVar("T")


class ModelTimeoutError(Error):
    name = "ModelTimeoutError"

    def __init__(self, timeout_ms: int | float) -> None:
        super().__init__(f"Model request timed out after {js_json.number_to_string(timeout_ms)}ms")
        self.timeout_ms = timeout_ms


class ModelCompletionError(Error):
    name = "ModelCompletionError"

    def __init__(self, message: str, finish_reason: str | None = None) -> None:
        super().__init__(message)
        self.finish_reason = finish_reason


def abort_reason(signal: AbortSignal) -> BaseException:
    reason = signal.reason
    return reason if isinstance(reason, BaseException) else Error("Model request was aborted")


class ModelOperation:
    """A model call's signal: the parent signal plus an optional timeout."""

    def __init__(self, parent: AbortSignal | None, timeout_ms: float | None) -> None:
        self._timed_out = False
        self._timer: asyncio.TimerHandle | None = None
        self._remove: Callable[[], None] | None = None
        self.signal: AbortSignal | None = None
        if parent is None and timeout_ms is None:
            return
        controller = AbortController()
        self.signal = controller.signal
        if parent is not None:
            if parent.aborted:
                controller.abort(parent.reason)
            else:
                self._remove = parent.add_listener(lambda: controller.abort(parent.reason))
        if timeout_ms is not None:

            def expire() -> None:
                self._timed_out = True
                controller.abort(ModelTimeoutError(timeout_ms))

            self._timer = asyncio.get_running_loop().call_later(timeout_ms / 1000, expire)

    def did_time_out(self) -> bool:
        return self._timed_out

    def dispose(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
        if self._remove is not None:
            self._remove()


def model_operation(parent: AbortSignal | None, timeout_ms: float | None) -> ModelOperation:
    return ModelOperation(parent, timeout_ms)


async def race_with_signal(start: Callable[[], Awaitable[T]], signal: AbortSignal | None = None) -> T:
    """Run ``start`` unless the signal is already aborted; settle with the operation or the abort."""
    if signal is None:
        return await start()
    if signal.aborted:
        raise abort_reason(signal)
    task = asyncio.ensure_future(start())
    if signal.aborted:  # start() may abort synchronously
        task.cancel()
        with contextlib.suppress(BaseException):
            await task
        raise abort_reason(signal)
    waiter = asyncio.ensure_future(signal.wait())
    try:
        done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    except BaseException:
        task.cancel()
        waiter.cancel()
        raise
    if task in done:
        waiter.cancel()
        return task.result()
    task.cancel()
    with contextlib.suppress(BaseException):
        await task
    raise abort_reason(signal)


def model_key_from_reference(reference: JsonObject | None, step_id: str) -> str:
    """A model reference as the request key a ModelAdapter receives."""
    if not reference:
        raise Error(f"Prompt step {step_id} requires a model")
    return f"ref/{reference['ref']}" if "ref" in reference else f"{reference['provider']}/{reference['model']}"


def reference_provider(reference: JsonObject | None) -> str:
    if not reference:
        return ""
    return "profile" if "ref" in reference else reference["provider"]


def step_model_reference(step: JsonObject, context: StepExecutionContext) -> JsonObject | None:
    reference = step.get("model")
    return reference if reference is not None else context.manifest.get("model")


def bytes_to_base64(data: bytes) -> str:
    return base64.b64encode(bytes(data)).decode("ascii")


async def resolve_media_part(part: JsonObject, context: StepExecutionContext) -> JsonObject:
    if (
        part["type"] == "tool-result"
        and part["result"].get("artifacts") is not None
        and len(part["result"]["artifacts"]) > 0
        and context.artifacts is not None
    ):
        artifacts = await asyncio.gather(
            *(_inline_artifact(artifact, context) for artifact in part["result"]["artifacts"])
        )
        return {**part, "result": {**part["result"], "artifacts": list(artifacts)}}
    if part["type"] not in ("image", "file") or part.get("artifact") is None or part.get("data") is not None:
        return part
    if context.artifacts is not None:
        loaded = await context.artifacts.get(part["artifact"])
        resolved = {**part, "data": bytes_to_base64(loaded["data"])}
        media_type = part.get("mediaType") if part.get("mediaType") is not None else loaded["ref"].get("mediaType")
        if media_type is not None:
            resolved["mediaType"] = media_type
        if part["type"] == "file":
            name = part.get("name") if part.get("name") is not None else loaded["ref"].get("name")
            if name is not None:
                resolved["name"] = name
        return resolved
    if part["artifact"].get("uri") is None:
        raise Error(f"Prompt media artifact {part['artifact']['id']} requires an ArtifactStore or URI")
    return part


async def _inline_artifact(artifact: JsonObject, context: StepExecutionContext) -> JsonObject:
    loaded = await context.artifacts.get(artifact)
    media_type = loaded["ref"]["mediaType"]
    return {
        **artifact,
        "uri": f"data:{media_type};base64,{bytes_to_base64(loaded['data'])}",
        "mediaType": media_type,
        "size": len(loaded["data"]),
    }


async def resolve_message_media(message: JsonObject, context: StepExecutionContext) -> JsonObject:
    content = await asyncio.gather(*(resolve_media_part(part, context) for part in message["content"]))
    return {**message, "content": list(content)}


def result_usage(result: JsonObject) -> JsonObject | None:
    for item in reversed(result.get("transcript") or []):
        if item.get("usage") is not None:
            return item["usage"]
    return None


def usage_data(result: JsonObject) -> JsonObject | None:
    usage = result_usage(result)
    if usage is None:
        return None
    return js_json.to_json_value({"usage": usage})


def safe_model_completed_data(result: JsonObject) -> JsonObject:
    data: JsonObject = {}
    if result.get("finishReason"):
        data["finishReason"] = result["finishReason"]
    data.update(usage_data(result) or {})
    return data


def is_truncated_finish_reason(finish_reason: str | None) -> bool:
    if finish_reason is None:
        return False
    normalized = js_strings.lower(js_strings.trim(finish_reason)).replace("-", "_")
    return normalized in ("length", "max_tokens", "max_output_tokens")


def has_output(output: Any) -> bool:
    """``output`` is ``UNDEFINED`` when the result has none."""
    return output is not UNDEFINED and (not isinstance(output, str) or len(js_strings.trim(output)) > 0)


def reported_total_tokens(usage: JsonObject) -> int | float | None:
    if usage.get("totalTokens") is not None:
        return usage["totalTokens"]
    if usage.get("inputTokens") is None and usage.get("outputTokens") is None:
        return None
    return (usage.get("inputTokens") or 0) + (usage.get("outputTokens") or 0)


_USAGE_KEYS = (
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "totalTokens",
    "estimatedCost",
)


def add_usage(left: JsonObject | None, right: JsonObject | None) -> JsonObject | None:
    """Sum usages field by field; ``None`` when nothing was reported."""
    if left is None:
        return copy.deepcopy(right) if right is not None else None
    if right is None:
        return copy.deepcopy(left)
    total: JsonObject = {}
    for key in _USAGE_KEYS:
        a = left.get(key)
        b = right.get(key)
        if a is not None or b is not None:
            total[key] = js_json.normalize((a or 0) + (b or 0))
    if (left.get("metadata") or {}).get("estimated") is True or (right.get("metadata") or {}).get("estimated") is True:
        total["metadata"] = {"estimated": True}
    return total


async def abortable_sleep(delay_ms: float, signal: AbortSignal | None = None) -> None:
    """Exponential-backoff waits that can be cancelled."""
    if signal is not None and signal.aborted:
        raise abort_reason(signal)
    if signal is None:
        await asyncio.sleep(delay_ms / 1000)
        return
    sleeper = asyncio.ensure_future(asyncio.sleep(delay_ms / 1000))
    waiter = asyncio.ensure_future(signal.wait())
    try:
        done, _ = await asyncio.wait({sleeper, waiter}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        sleeper.cancel()
        waiter.cancel()
    if sleeper not in done:
        raise abort_reason(signal)
