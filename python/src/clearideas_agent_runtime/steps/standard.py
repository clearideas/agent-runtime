"""Approval, webhook, code, and sub-run executors (``@clearideas/agent-runtime-step-standard``)."""

from __future__ import annotations

import asyncio
import copy
import math
from collections.abc import Awaitable, Callable
from typing import Any

from .._js import json as js_json
from .._js import ops as js_ops
from .._js import strings as js_strings
from .._js import time as js_time
from .._js.abort import AbortController, AbortSignal, race_abort
from .._js.errors import Error
from .._js.fetch import Headers, Response
from .._js.fetch import fetch as default_fetch
from .._js.ops import UNDEFINED
from .._js.url import URL
from ..core import (
    RunCancelledError,
    RunSuspendedError,
    compile_prompt_template,
    without_messages_view,
)
from ..core.errors import create_error_suspension, create_limit_suspension

JsonObject = dict[str, Any]
FetchLike = Callable[[str, JsonObject], Awaitable[Any]]
Sleep = Callable[[float, AbortSignal | None], Awaitable[None]]
MAX_SAFE_INTEGER = 2**53 - 1


def _get_mapped_variable(variables: JsonObject, path: str) -> Any:
    current: Any = variables
    for segment in path.split("."):
        if not isinstance(current, dict):
            return UNDEFINED
        lower = js_strings.lower(segment)
        key = next((candidate for candidate in js_json.js_keys(current) if js_strings.lower(candidate) == lower), None)
        if key is None:
            return UNDEFINED
        current = current[key]
    return current


def _abort_reason(signal: AbortSignal) -> BaseException:
    reason = signal.reason
    return reason if isinstance(reason, BaseException) else Error("Operation aborted")


def _state_patch(output_variable: str | None, output: Any) -> JsonObject | None:
    if output_variable and output is not UNDEFINED:
        return {"set": {output_variable: output}}
    return None


class _OperationSignal:
    """A child signal that follows ``parent`` and aborts after ``timeout_ms``."""

    def __init__(self, parent: AbortSignal | None, timeout_ms: float | None) -> None:
        self._controller = AbortController()
        self.timed_out = False
        self._timer: asyncio.TimerHandle | None = None
        self._remove: Callable[[], None] | None = None
        if parent is not None and parent.aborted:
            self._controller.abort(parent.reason)
        elif parent is not None:
            self._remove = parent.add_listener(lambda: self._controller.abort(parent.reason))
        if timeout_ms is not None:

            def on_timeout() -> None:
                self.timed_out = True
                self._controller.abort(Error("Operation timed out"))

            self._timer = asyncio.get_running_loop().call_later(timeout_ms / 1000, on_timeout)

    @property
    def signal(self) -> AbortSignal:
        return self._controller.signal

    def dispose(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
        if self._remove is not None:
            self._remove()


async def _race(start: Callable[[], Awaitable[Any]], signal: AbortSignal) -> Any:
    if signal.aborted:
        raise _abort_reason(signal)
    try:
        return await race_abort(start(), signal)
    except BaseException:
        if signal.aborted:
            raise _abort_reason(signal) from None
        raise


def _positive_integer(value: Any, fallback: int, maximum: int, label: str) -> int:
    selected = fallback if value is None else value
    if not _is_integer(selected) or selected <= 0 or selected > maximum:
        raise Error(f"{label} must be an integer between 1 and {js_ops.to_string(maximum)}")
    return selected


def _non_negative_integer(value: Any, maximum: int, label: str) -> int:
    if not _is_integer(value) or value < 0 or value > maximum:
        raise Error(f"{label} must be an integer between 0 and {js_ops.to_string(maximum)}")
    return value


def _is_integer(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and float(value).is_integer()
    )


async def _default_sleep(delay_ms: float, signal: AbortSignal | None = None) -> None:
    if signal is not None and signal.aborted:
        raise _abort_reason(signal)
    await race_abort(asyncio.sleep(max(0, delay_ms) / 1000), signal)


# ─── Errors ─────────────────────────────────────────────────────────────────


class ApprovalRejectedError(Error):
    name = "ApprovalRejectedError"

    def __init__(self, step_id: str, action: str | None) -> None:
        super().__init__(f"Approval was rejected for step {step_id}")
        self.action = action


class ApprovalTimeoutError(Error):
    name = "ApprovalTimeoutError"

    def __init__(self, timeout_ms: int) -> None:
        super().__init__(f"Approval did not resolve within {timeout_ms}ms")
        self.timeout_ms = timeout_ms


class WebhookHttpError(Error):
    name = "WebhookHttpError"

    def __init__(self, status: int, attempts: int) -> None:
        super().__init__(f"Webhook returned HTTP {status} after {attempts} attempt(s)")
        self.status = status
        self.attempts = attempts


class WebhookTimeoutError(Error):
    name = "WebhookTimeoutError"

    def __init__(self, timeout_ms: int, attempts: int) -> None:
        super().__init__(f"Webhook timed out after {timeout_ms}ms on attempt {attempts}")
        self.timeout_ms = timeout_ms
        self.attempts = attempts


class WebhookNetworkError(Error):
    name = "WebhookNetworkError"

    def __init__(self, attempts: int) -> None:
        super().__init__(f"Webhook request failed after {attempts} attempt(s)")
        self.attempts = attempts


class WebhookResponseError(Error):
    name = "WebhookResponseError"

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(
            f"Webhook response exceeded the configured size limit (HTTP {status})"
            if reason == "too-large"
            else f"Webhook returned invalid JSON (HTTP {status})"
        )
        self.status = status


class SandboxExecutionError(Error):
    name = "SandboxExecutionError"

    def __init__(self, step_id: str, exit_code: int) -> None:
        super().__init__(f"Sandbox execution failed for step {step_id} with exit code {exit_code}")
        self.exit_code = exit_code


class SandboxTimeoutError(Error):
    name = "SandboxTimeoutError"

    def __init__(self, timeout_ms: int) -> None:
        super().__init__(f"Sandbox execution timed out after {timeout_ms}ms")
        self.timeout_ms = timeout_ms


# ─── Sub-run ────────────────────────────────────────────────────────────────


class SubRunStepExecutor:
    """Executes an isolated nested run through the host ``SubRunAdapter``."""

    type = "sub-run"

    def preflight(self, step: JsonObject, context: Any) -> list[str]:
        return [] if context.sub_runs is not None else [f"Sub-run step {step['id']} requires a SubRunAdapter."]

    async def execute(self, context: Any) -> JsonObject:
        step = context.step
        if context.sub_runs is None:
            raise Error(f"Sub-run step {step['id']} requires a SubRunAdapter")
        if context.signal is not None and context.signal.aborted:
            raise _abort_reason(context.signal)
        if step.get("variableMappings") is not None:
            variable_state: JsonObject = {}
            for target, source in step["variableMappings"].items():
                value = _get_mapped_variable(context.variables, source)
                if value is not UNDEFINED:
                    variable_state[target] = copy.deepcopy(value)
        else:
            variable_state = without_messages_view(context.manifest, copy.deepcopy(context.variables))
        variables = [{"key": key, "value": value} for key, value in js_json.js_entries(variable_state)]
        forwarded = context.history.messages if context.history is not None and context.history.explicit else None
        forwarded_signature = await context.history.sign(forwarded) if forwarded is not None else None
        started: JsonObject = {
            "hasInlineManifest": step.get("manifest") is not None,
            "hasManifestReference": step.get("manifestRef") is not None,
            "mappedVariableCount": len(variables),
        }
        if forwarded is not None:
            started["forwardedMessages"] = len(forwarded)
        await context.emit("sub-run.started", started)
        resume_continuation = (context.resume or {}).get("continuation")
        adapter_state = None
        if (
            isinstance(resume_continuation, dict)
            and resume_continuation.get("type") == "sub-run"
            and resume_continuation.get("stepId") == step["id"]
            and isinstance(resume_continuation.get("adapter"), dict)
        ):
            adapter_state = resume_continuation["adapter"]
        if context.checkpoint is not None:
            launching: JsonObject = {"type": "sub-run", "phase": "launching", "stepId": step["id"]}
            if adapter_state is not None:
                launching["adapter"] = copy.deepcopy(adapter_state)
            await context.checkpoint({"state": copy.deepcopy(context.variables), "continuation": launching})
        request: JsonObject = {"parentRunId": context.run_id, "stepId": step["id"]}
        if step.get("manifest"):
            request["manifest"] = step["manifest"]
        if step.get("manifestRef"):
            request["manifestReference"] = step["manifestRef"]
        request["variables"] = variables
        if forwarded is not None:
            request["messages"] = copy.deepcopy(forwarded)
        if forwarded_signature:
            request["messagesSignature"] = forwarded_signature
        if forwarded is not None and context.history.scope is not None:
            request["messagesScope"] = context.history.scope
        if adapter_state is not None:
            request["continuation"] = copy.deepcopy(adapter_state)
        result = await context.sub_runs.execute(request, signal=context.signal)
        if result.get("status") == "suspended":
            if context.checkpoint is None:
                raise Error(f"Sub-run step {step['id']} cannot suspend without checkpoint support")
            continuation = (
                result.get("continuation")
                if result.get("continuation") is not None
                else {"childRunId": result["runId"]}
            )
            await context.checkpoint(
                {
                    "state": copy.deepcopy(context.variables),
                    "continuation": {
                        "type": "sub-run",
                        "phase": "waiting",
                        "stepId": step["id"],
                        "childRunId": result["runId"],
                        "adapter": copy.deepcopy(continuation),
                    },
                }
            )
            raise RunSuspendedError("sub-run", {"stepId": step["id"], "childRunId": result["runId"]})
        has_output = "output" in result
        artifact_count = len(result.get("artifacts") or [])
        await context.emit(
            "sub-run.completed",
            {"childRunId": result["runId"], "hasOutput": has_output, "artifactCount": artifact_count},
        )
        patch = _state_patch(step.get("outputVariable"), result.get("output", UNDEFINED))
        executed: JsonObject = {}
        if has_output:
            executed["output"] = result["output"]
        if patch:
            executed["statePatch"] = patch
        if result.get("transcript") is not None:
            executed["transcript"] = result["transcript"]
        if result.get("artifacts") is not None:
            executed["artifacts"] = result["artifacts"]
        executed["metadata"] = {"childRunId": result["runId"], "hasOutput": has_output, "artifactCount": artifact_count}
        return executed


# ─── Approval ───────────────────────────────────────────────────────────────


class ApprovalStepExecutor:
    type = "approval"

    def __init__(self, *, timeout_ms: int | None = None) -> None:
        if timeout_ms is not None and (not _is_integer(timeout_ms) or timeout_ms <= 0):
            raise Error("Approval timeoutMs must be a positive integer")
        self._timeout_ms = timeout_ms

    def preflight(self, step: JsonObject, context: Any) -> list[str]:
        return [] if context.approvals is not None else [f"Approval step {step['id']} requires an ApprovalAdapter."]

    async def execute(self, context: Any) -> JsonObject:
        step = context.step
        if context.approvals is None:
            raise Error(f"Approval step {step['id']} requires an ApprovalAdapter")
        approvals = context.approvals
        if context.signal is not None and context.signal.aborted:
            raise _abort_reason(context.signal)
        action = step.get("action") or "pause"
        await context.emit("approval.requested", {"action": action})
        operation = _OperationSignal(context.signal, self._timeout_ms)
        request: JsonObject = {
            "runId": context.run_id,
            "stepId": step["id"],
            "prompt": compile_prompt_template(step["prompt"], context.variables),
        }
        if step.get("metadata"):
            request["details"] = step["metadata"]
        try:
            result = await _race(lambda: approvals.request_approval(request, signal=operation.signal), operation.signal)
        except BaseException:
            if operation.timed_out and self._timeout_ms is not None:
                raise ApprovalTimeoutError(self._timeout_ms) from None
            raise
        finally:
            operation.dispose()
        has_response = "response" in result
        await context.emit(
            "approval.resolved",
            {"approved": result["approved"], "respondedAt": result["respondedAt"], "hasResponse": has_response},
        )
        if not result["approved"]:
            on_reject = step.get("onReject") or "fail"
            if on_reject == "cancel":
                raise RunCancelledError(
                    f"Approval was rejected for step {step['id']}; the run was cancelled.", {"stepId": step["id"]}
                )
            if on_reject in ("continue", "complete"):
                rejected: JsonObject = {"approved": False, "respondedAt": result["respondedAt"]}
                if has_response:
                    rejected["response"] = result["response"]
                rejected_result: JsonObject = {"output": rejected}
                patch = _state_patch(step.get("outputVariable"), rejected)
                if patch:
                    rejected_result["statePatch"] = patch
                if on_reject == "complete":
                    rejected_result["endRun"] = True
                rejected_result["metadata"] = {
                    "approved": False,
                    "hasResponse": has_response,
                    "action": action,
                    "onReject": on_reject,
                }
                return rejected_result
            raise ApprovalRejectedError(step["id"], step.get("action"))
        output: JsonObject = {"approved": True, "respondedAt": result["respondedAt"]}
        if has_response:
            output["response"] = result["response"]
        approved: JsonObject = {"output": output}
        patch = _state_patch(step.get("outputVariable"), output)
        if patch:
            approved["statePatch"] = patch
        approved["metadata"] = {"approved": True, "hasResponse": has_response, "action": action}
        return approved


# ─── Webhook ────────────────────────────────────────────────────────────────

DEFAULT_RETRYABLE_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


def _response_delay_ms(response: Any, calculated: float, maximum: float, now: Callable[[], float]) -> float:
    retry_after = response.headers.get("retry-after")
    retry_after = js_strings.trim(retry_after) if retry_after is not None else None
    if not retry_after:
        return calculated
    seconds = js_ops.to_number(retry_after)
    if isinstance(seconds, (int, float)) and math.isfinite(seconds) and seconds >= 0:
        return js_json.normalize(min(seconds * 1000, maximum))
    date = js_time.parse_ms(retry_after)
    if math.isnan(date):
        return calculated
    return js_json.normalize(min(max(0, date - now()), maximum))


async def _read_webhook_output(response: Any, maximum_bytes: int) -> Any:
    declared = (
        js_ops.to_number(response.headers.get("content-length"))
        if response.headers.get("content-length") is not None
        else math.nan
    )
    if isinstance(declared, (int, float)) and math.isfinite(declared) and declared > maximum_bytes:
        await response.cancel()
        raise WebhookResponseError(response.status, "too-large")
    received = bytearray()
    async for chunk in response.iter_bytes():
        received.extend(chunk)
        if len(received) > maximum_bytes:
            await response.cancel()
            raise WebhookResponseError(response.status, "too-large")
    if hasattr(response, "aclose"):
        await response.aclose()
    text = received.decode("utf-8", "replace")
    if js_strings.length(text) == 0:
        return UNDEFINED
    content_type = response.headers.get("content-type")
    if not content_type or "json" not in js_strings.lower(content_type):
        return text
    try:
        return js_json.parse(text)
    except ValueError:
        raise WebhookResponseError(response.status, "invalid-json") from None


class WebhookStepExecutor:
    type = "webhook"

    def __init__(
        self,
        *,
        fetch: FetchLike | None = None,
        authorize_destination: Callable[[URL, JsonObject], Any] | None = None,
        allow_unsafe_destinations: bool = False,
        sleep: Sleep | None = None,
        default_timeout_ms: int = 30_000,
        maximum_timeout_ms: int = 300_000,
        maximum_retries: int = 10,
        maximum_request_bytes: int = 1_048_576,
        maximum_response_bytes: int = 1_048_576,
        retry_base_delay_ms: int = 250,
        retry_maximum_delay_ms: int = 30_000,
        retryable_statuses: frozenset[int] | set[int] | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        if authorize_destination is None and allow_unsafe_destinations is not True:
            raise Error(
                "WebhookStepExecutor requires authorizeDestination. Use allowUnsafeDestinations only for trusted local manifests."
            )
        self._fetch = fetch or default_fetch
        self._authorize = authorize_destination
        self._allow_unsafe = allow_unsafe_destinations is True
        self._sleep = sleep or _default_sleep
        self._default_timeout_ms = default_timeout_ms
        self._maximum_timeout_ms = maximum_timeout_ms
        self._maximum_retries = maximum_retries
        self._maximum_request_bytes = maximum_request_bytes
        self._maximum_response_bytes = maximum_response_bytes
        self._retry_base_delay_ms = retry_base_delay_ms
        self._retry_maximum_delay_ms = retry_maximum_delay_ms
        self._retryable_statuses = retryable_statuses if retryable_statuses is not None else DEFAULT_RETRYABLE_STATUSES
        self._now = now or js_time.now_ms
        _positive_integer(default_timeout_ms, default_timeout_ms, maximum_timeout_ms, "Default webhook timeoutMs")
        _non_negative_integer(maximum_retries, 100, "Maximum webhook retries")
        _positive_integer(
            maximum_request_bytes, maximum_request_bytes, MAX_SAFE_INTEGER, "Maximum webhook request bytes"
        )
        _positive_integer(
            maximum_response_bytes, maximum_response_bytes, MAX_SAFE_INTEGER, "Maximum webhook response bytes"
        )
        _non_negative_integer(retry_base_delay_ms, MAX_SAFE_INTEGER, "Webhook retry base delayMs")
        _non_negative_integer(retry_maximum_delay_ms, MAX_SAFE_INTEGER, "Webhook maximum retry delayMs")

    def _retry_delay(self, failed_attempt: int) -> float:
        return min(self._retry_base_delay_ms * 2 ** (failed_attempt - 1), self._retry_maximum_delay_ms)

    async def execute(self, context: Any) -> JsonObject:
        step = context.step
        signal = context.signal
        if signal is not None and signal.aborted:
            raise _abort_reason(signal)
        url = URL(step["url"])
        if url.protocol not in ("https:", "http:"):
            raise Error("Webhook URL must use HTTP or HTTPS")
        if url.username or url.password:
            raise Error("Webhook URL must not contain credentials")
        retries = step.get("retries", 0)
        _non_negative_integer(retries, self._maximum_retries, "Webhook retries")
        timeout_ms = _positive_integer(
            step.get("timeoutMs"), self._default_timeout_ms, self._maximum_timeout_ms, "Webhook timeoutMs"
        )
        method = step.get("method") or "POST"
        maximum_attempts = retries + 1
        headers = Headers(step.get("headers") or {})
        if "idempotencyKey" in step:
            headers.set("Idempotency-Key", step["idempotencyKey"])
        elif not headers.has("Idempotency-Key"):
            headers.set("Idempotency-Key", f"{context.run_id}:{step['id']}")
        body: str | None = None
        if "body" in step and method == "GET":
            raise Error("GET webhook steps cannot include a body")
        if "body" in step:
            body = js_json.stringify(step["body"])
            if js_strings.utf8_length(body) > self._maximum_request_bytes:
                raise Error("Webhook request body exceeded the configured size limit")
            if not headers.has("Content-Type"):
                headers.set("Content-Type", "application/json")

        for attempt in range(1, maximum_attempts + 1):
            await context.emit(
                "webhook.attempt.started", {"attempt": attempt, "maximumAttempts": maximum_attempts, "method": method}
            )
            if not self._allow_unsafe:
                authorization: JsonObject = {
                    "runId": context.run_id,
                    "stepId": step["id"],
                    "method": method,
                    "attempt": attempt,
                }
                if signal is not None:
                    authorization["signal"] = signal
                result = self._authorize(url, authorization)  # type: ignore[misc]
                if asyncio.iscoroutine(result):
                    await result
            operation = _OperationSignal(signal, timeout_ms)
            init: JsonObject = {"method": method, "headers": headers}
            if body is not None:
                init["body"] = body
            init["redirect"] = "manual"
            init["signal"] = operation.signal
            try:
                response = await race_abort(self._fetch(step["url"], init), operation.signal)
            except Exception:
                timed_out = operation.timed_out
                operation.dispose()
                if signal is not None and signal.aborted:
                    raise _abort_reason(signal) from None
                if attempt >= maximum_attempts:
                    if timed_out:
                        raise WebhookTimeoutError(timeout_ms, attempt) from None
                    raise WebhookNetworkError(attempt) from None
                delay_ms = self._retry_delay(attempt)
                await context.emit(
                    "webhook.retry.scheduled",
                    {
                        "attempt": attempt,
                        "nextAttempt": attempt + 1,
                        "delayMs": delay_ms,
                        "reason": "timeout" if timed_out else "network",
                    },
                )
                await self._sleep(delay_ms, signal)
                continue
            if not response.ok:
                operation.dispose()
                retry = attempt < maximum_attempts and response.status in self._retryable_statuses
                if not retry:
                    await response.cancel()
                    raise WebhookHttpError(response.status, attempt)
                delay_ms = _response_delay_ms(
                    response, self._retry_delay(attempt), self._retry_maximum_delay_ms, self._now
                )
                await response.cancel()
                await context.emit(
                    "webhook.retry.scheduled",
                    {
                        "attempt": attempt,
                        "nextAttempt": attempt + 1,
                        "delayMs": delay_ms,
                        "reason": "http-status",
                        "status": response.status,
                    },
                )
                await self._sleep(delay_ms, signal)
                continue
            try:
                output = await _race(
                    lambda response=response: _read_webhook_output(response, self._maximum_response_bytes),
                    operation.signal,
                )
            except Exception:
                timed_out = operation.timed_out
                operation.dispose()
                if signal is not None and signal.aborted:
                    raise _abort_reason(signal) from None
                if timed_out:
                    if attempt >= maximum_attempts:
                        raise WebhookTimeoutError(timeout_ms, attempt) from None
                    delay_ms = self._retry_delay(attempt)
                    await context.emit(
                        "webhook.retry.scheduled",
                        {"attempt": attempt, "nextAttempt": attempt + 1, "delayMs": delay_ms, "reason": "timeout"},
                    )
                    await self._sleep(delay_ms, signal)
                    continue
                raise
            operation.dispose()
            patch = _state_patch(step.get("outputVariable"), output)
            has_output = output is not UNDEFINED
            await context.emit(
                "webhook.attempt.completed",
                {"attempt": attempt, "method": method, "status": response.status, "hasOutput": has_output},
            )
            executed: JsonObject = {}
            if has_output:
                executed["output"] = output
            if patch:
                executed["statePatch"] = patch
            executed["metadata"] = {
                "attempts": attempt,
                "method": method,
                "status": response.status,
                "hasOutput": has_output,
            }
            return executed
        raise Error("Webhook exhausted attempts without a result")


# ─── Code ───────────────────────────────────────────────────────────────────


class CodeStepExecutor:
    type = "code"

    def __init__(self, *, default_timeout_ms: int = 60_000, maximum_timeout_ms: int = 900_000) -> None:
        self._default_timeout_ms = default_timeout_ms
        self._maximum_timeout_ms = maximum_timeout_ms

    @staticmethod
    def _uses_run_sandbox(step: JsonObject) -> bool:
        return step.get("sandbox") == "run" or (step.get("sandbox") != "step" and len(step.get("workspaces") or []) > 0)

    def preflight(self, step: JsonObject, context: Any) -> list[str]:
        if self._uses_run_sandbox(step):
            return [] if context.run_sandbox is not None else [f"Code step {step['id']} requires a RunSandboxProvider."]
        return [] if context.sandbox is not None else [f"Code step {step['id']} requires a SandboxAdapter."]

    async def execute(self, context: Any) -> JsonObject:
        step = context.step
        if self._uses_run_sandbox(step):
            return await self._execute_in_run_sandbox(context)
        if context.sandbox is None:
            raise Error(f"Code step {step['id']} requires a SandboxAdapter")
        sandbox = context.sandbox
        if context.signal is not None and context.signal.aborted:
            raise _abort_reason(context.signal)
        timeout_ms = _positive_integer(
            step.get("timeoutMs"), self._default_timeout_ms, self._maximum_timeout_ms, "Code timeoutMs"
        )
        await context.emit(
            "code.execution.started", {"language": step["language"], "timeoutMs": timeout_ms, "sandbox": "step"}
        )
        operation = _OperationSignal(context.signal, timeout_ms)
        request: JsonObject = {
            "runId": context.run_id,
            "stepId": step["id"],
            "language": step["language"],
            "code": step["code"],
            "variables": context.variables,
        }
        if step.get("environment"):
            request["environment"] = step["environment"]
        request["timeoutMs"] = timeout_ms
        try:
            result = await _race(lambda: sandbox.execute(request, signal=operation.signal), operation.signal)
        except BaseException:
            if operation.timed_out:
                raise SandboxTimeoutError(timeout_ms) from None
            raise
        finally:
            operation.dispose()
        artifact_count = len(result.get("artifacts") or [])
        await context.emit(
            "code.execution.completed",
            {
                "exitCode": result["exitCode"],
                "succeeded": result["exitCode"] == 0,
                "artifactCount": artifact_count,
                "hasOutput": "output" in result or js_strings.length(result["stdout"]) > 0,
            },
        )
        if result["exitCode"] != 0:
            raise SandboxExecutionError(step["id"], result["exitCode"])
        if result.get("output") is not None:
            output: Any = result["output"]
        else:
            output = result["stdout"] if js_strings.length(result["stdout"]) > 0 else UNDEFINED
        patch = _state_patch(step.get("outputVariable"), output)
        executed: JsonObject = {}
        if output is not UNDEFINED:
            executed["output"] = output
        if patch:
            executed["statePatch"] = patch
        if result.get("artifacts") is not None:
            executed["artifacts"] = result["artifacts"]
        executed["metadata"] = {
            "exitCode": result["exitCode"],
            "stdoutBytes": js_strings.utf8_length(result["stdout"]),
            "stderrBytes": js_strings.utf8_length(result["stderr"]),
            "artifactCount": artifact_count,
            "hasOutput": output is not UNDEFINED,
        }
        return executed

    async def _execute_in_run_sandbox(self, context: Any) -> JsonObject:
        step = context.step
        if context.run_sandbox is None:
            raise Error(f"Code step {step['id']} requires the run sandbox; configure a RunSandboxProvider")
        if context.signal is not None and context.signal.aborted:
            raise _abort_reason(context.signal)
        available = {workspace.alias for workspace in context.workspaces or []}
        for alias in step.get("workspaces") or []:
            if alias not in available:
                raise Error(f"Code step {step['id']} requires workspace {alias}, which is not available for this run")
        timeout_ms = _positive_integer(
            step.get("timeoutMs"), self._default_timeout_ms, self._maximum_timeout_ms, "Code timeoutMs"
        )
        await context.emit(
            "code.execution.started",
            {
                "language": step["language"],
                "timeoutMs": timeout_ms,
                "sandbox": "run",
                "workspaces": list(step.get("workspaces") or []),
            },
        )
        checkpoint = context.checkpoint
        report_interruption = (context.policies or {}).get("onFailure") != "fail" and checkpoint is not None
        saved = (context.resume or {}).get("continuation") or {}
        own_saved = saved.get("phase") if saved.get("type") == "code" and saved.get("stepId") == step["id"] else None
        if report_interruption and checkpoint is not None and own_saved == "started":
            await checkpoint(
                {
                    "state": {**context.variables},
                    "continuation": {"type": "code", "stepId": step["id"], "phase": "reported"},
                }
            )
            raise create_error_suspension(
                error={
                    "code": "STEP_INTERRUPTED_IN_DOUBT",
                    "message": f"Code step {step['id']} was interrupted while it ran in the run sandbox; its workspace changes may be partly applied. Inspect the workspace, then resume to run it again, or restart the run from the previous step.",
                    "retryable": True,
                },
                step_id=step["id"],
            )
        if report_interruption and checkpoint is not None:
            await checkpoint(
                {
                    "state": {**context.variables},
                    "continuation": {"type": "code", "stepId": step["id"], "phase": "started"},
                }
            )
        session = await context.run_sandbox()
        arguments: JsonObject = {"language": step["language"], "code": step["code"], "variables": {**context.variables}}
        if step.get("environment"):
            arguments["environment"] = step["environment"]
        arguments["timeoutMs"] = timeout_ms
        arguments["workspaces"] = list(step.get("workspaces") or [])
        request: JsonObject = {"stepId": step["id"], "kind": "code", "name": step["id"], "arguments": arguments}
        if context.signal is not None:
            request["signal"] = context.signal
        try:
            result = await session.execute(request)
        except Exception as error:
            if getattr(error, "code", None) == "sandbox_command_timeout":
                raise SandboxTimeoutError(timeout_ms) from error
            limit = getattr(error, "limit", None)
            if isinstance(limit, dict) and isinstance(limit.get("name"), str):
                raise create_limit_suspension(
                    limit=limit["name"], used=limit["used"], value=limit["value"], step_id=step["id"]
                ) from error
            raise
        record = result["record"]
        artifact_count = len(result.get("artifacts") or [])
        not_persisted = js_json.to_json_value(result["notPersisted"]) if result.get("notPersisted") else None
        await context.emit(
            "code.execution.completed",
            {
                "exitCode": record["exitCode"],
                "succeeded": record["exitCode"] == 0,
                "artifactCount": artifact_count,
                "hasOutput": "output" in result,
                "sandbox": "run",
                "commandId": record["id"],
            },
        )
        if not_persisted is not None:
            await context.emit(
                "diagnostic",
                {
                    "code": "WORKSPACE_CHANGES_NOT_SAVED",
                    "message": f"Code step {step['id']} changed workspace files that were not saved.",
                    "notPersisted": not_persisted,
                },
            )
        if record["exitCode"] != 0:
            raise SandboxExecutionError(step["id"], record["exitCode"])
        output = result.get("output", UNDEFINED)
        patch = _state_patch(step.get("outputVariable"), output)
        executed: JsonObject = {}
        if output is not UNDEFINED:
            executed["output"] = output
        if patch:
            executed["statePatch"] = patch
        if result.get("artifacts") is not None:
            executed["artifacts"] = result["artifacts"]
        executed["metadata"] = {
            "exitCode": record["exitCode"],
            "stdoutBytes": record["stdoutBytes"],
            "stderrBytes": record["stderrBytes"],
            "artifactCount": artifact_count,
            "hasOutput": output is not UNDEFINED,
            "sandbox": "run",
            "command": js_json.to_json_value(record),
            **({"notPersisted": not_persisted} if not_persisted is not None else {}),
        }
        return executed


__all__ = [
    "ApprovalRejectedError",
    "ApprovalStepExecutor",
    "ApprovalTimeoutError",
    "CodeStepExecutor",
    "Headers",
    "Response",
    "SandboxExecutionError",
    "SandboxTimeoutError",
    "SubRunStepExecutor",
    "WebhookHttpError",
    "WebhookNetworkError",
    "WebhookResponseError",
    "WebhookStepExecutor",
    "WebhookTimeoutError",
]
