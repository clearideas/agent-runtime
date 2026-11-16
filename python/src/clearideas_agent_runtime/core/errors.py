"""Run control-flow errors and ``RunError`` classification (from ``agent-runtime.ts``)."""

from __future__ import annotations

import re
from typing import Any, TypeGuard

from .._js.errors import Error, error_message, error_name


class AgentRuntimeError(Error):
    """A classified adapter failure. Retrying still requires an idempotent operation."""

    name = "AgentRuntimeError"

    def __init__(self, message: str, code: str, retryable: bool = False, suggested_action: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.suggested_action = suggested_action


class RunSuspendedError(Error):
    """Cooperative signal used after committing a resumable checkpoint."""

    name = "RunSuspendedError"
    code = "RUN_SUSPENDED"

    def __init__(self, reason: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(f"Run suspended: {reason}")
        self.reason = reason
        self.details = details


def is_run_suspended_error(error: Any) -> TypeGuard[RunSuspendedError]:
    return isinstance(error, RunSuspendedError) or (
        isinstance(error, BaseException)
        and error_name(error) == "RunSuspendedError"
        and getattr(error, "code", None) == "RUN_SUSPENDED"
    )


RUN_PAUSED_REASON = "paused"


def create_run_pause_request(details: dict[str, Any] | None = None) -> RunSuspendedError:
    """Abort a run's signal with this reason to suspend it at its latest checkpoint."""
    return RunSuspendedError(RUN_PAUSED_REASON, details)


def suspension_kind(reason: str) -> str:
    return {
        "approval": "awaiting-input",
        "sub-run": "awaiting-child",
        "token-budget": "awaiting-budget",
        RUN_PAUSED_REASON: "paused",
    }.get(reason, "other")


class RunInterruptedError(Error):
    """Infrastructure stopped the attempt; the run stays resumable."""

    name = "RunInterruptedError"
    code = "RUN_INTERRUPTED"
    retryable = True

    def __init__(self, reason: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(f"Run interrupted: {reason}")
        self.reason = reason
        self.details = details


def is_run_interrupted_error(error: Any) -> TypeGuard[RunInterruptedError]:
    return isinstance(error, RunInterruptedError) or (
        isinstance(error, BaseException)
        and (getattr(error, "code", None) == "RUN_INTERRUPTED" or isinstance(getattr(error, "interruption", None), str))
    )


def interruption_reason(error: BaseException) -> str:
    reason = getattr(error, "reason", None)
    if isinstance(reason, str):
        return reason
    interruption = getattr(error, "interruption", None)
    if isinstance(interruption, str):
        return interruption
    return "interrupted"


class RunCancelledError(Error):
    """A step ended the run as cancelled."""

    name = "RunCancelledError"
    code = "RUN_CANCELLED"

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.details = details


def is_run_cancelled_error(error: Any) -> bool:
    return isinstance(error, RunCancelledError) or (
        isinstance(error, BaseException) and getattr(error, "code", None) == "RUN_CANCELLED"
    )


_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,79}$")


def to_run_error(error: Any) -> dict[str, Any]:
    """``toRunError``: a stable, redacted ``RunError`` for any thrown value."""
    source = error if isinstance(error, BaseException) else Error(_string(error))
    code_value = getattr(source, "code", None)
    code = code_value if isinstance(code_value, str) and _CODE.fullmatch(code_value) else "AGENT_EXECUTION_FAILED"
    name = error_name(source)
    result: dict[str, Any] = {
        "code": code,
        "message": error_message(source),
        "retryable": code != "AGENT_EXECUTION_FAILED" and getattr(source, "retryable", None) is True,
    }
    if name != "Error" or isinstance(source, AgentRuntimeError):
        details: dict[str, Any] = {}
        if name != "Error":
            details["name"] = name
        if isinstance(source, AgentRuntimeError) and source.suggested_action:
            details["suggestedAction"] = source.suggested_action
        result["details"] = details
    return result


def _string(value: Any) -> str:
    from .._js.ops import to_string

    return to_string(value)


def is_control_flow_error(error: Any, signal: Any) -> bool:
    """Errors that always end the attempt, whatever a step's onError policy says."""
    return (
        (signal is not None and signal.aborted)
        or is_run_suspended_error(error)
        or is_run_interrupted_error(error)
        or is_run_cancelled_error(error)
    )
