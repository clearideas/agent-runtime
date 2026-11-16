"""Port of packages/step-standard/src/index.test.ts."""

from __future__ import annotations

import asyncio
import copy

import pytest

from clearideas_agent_runtime._js.abort import AbortController
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime._js.json import stringify
from clearideas_agent_runtime.core import (
    RunCancelledError,
    RunSuspendedError,
    StepExecutionContext,
    StepHistoryContext,
    StepPreflightContext,
)
from clearideas_agent_runtime.core.ports import ResolvedWorkspace
from clearideas_agent_runtime.steps.standard import (
    ApprovalRejectedError,
    ApprovalStepExecutor,
    ApprovalTimeoutError,
    CodeStepExecutor,
    Headers,
    Response,
    SandboxExecutionError,
    SandboxTimeoutError,
    SubRunStepExecutor,
    WebhookHttpError,
    WebhookResponseError,
    WebhookStepExecutor,
    WebhookTimeoutError,
)


def manifest_for(step):
    return {"schemaVersion": "1.0", "steps": [step]}


class EventCollector:
    def __init__(self, run_id="run-1"):
        self.run_id = run_id
        self.events = []

    async def emit(self, event_type, data=None):
        event = {
            "id": f"event-{len(self.events) + 1}",
            "runId": self.run_id,
            "sequence": len(self.events) + 1,
            "timestamp": "2026-07-22T00:00:00.000Z",
            "type": event_type,
        }
        if data is not None:
            event["data"] = data
        self.events.append(event)
        return event


def context(step, **extra):
    defaults = {
        "run_id": "run-1",
        "manifest": manifest_for(step),
        "step": step,
        "step_index": 0,
        "variables": {},
        "emit": EventCollector().emit,
    }
    return StepExecutionContext(**{**defaults, **extra})


class Approvals:
    def __init__(self, handler):
        self.handler = handler

    async def request_approval(self, request, signal=None):
        result = self.handler(request, signal)
        return await result if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future) else result


# ─── Approval ───────────────────────────────────────────────────────────────


async def test_passes_approval_details_to_the_adapter_but_keeps_secrets_out_of_events_and_metadata():
    step = {
        "id": "approval-1",
        "type": "approval",
        "prompt": "Approve {{ Quarter }} secret acquisition for {{ deal.Name }}?",
        "metadata": {"privateContext": "board-eyes-only"},
        "outputVariable": "approval",
        "action": "pause",
    }
    requests = []

    def handler(request, signal):
        requests.append(copy.deepcopy(request))
        return {
            "approved": True,
            "response": {"comment": "private approval response"},
            "respondedAt": "2026-07-22T00:01:00.000Z",
        }

    collector = EventCollector()
    result = await ApprovalStepExecutor().execute(
        context(
            step,
            variables={"quarter": "Q4", "Deal": {"name": "private target"}},
            approvals=Approvals(handler),
            emit=collector.emit,
        )
    )
    assert requests == [
        {
            "runId": "run-1",
            "stepId": "approval-1",
            "prompt": "Approve Q4 secret acquisition for private target?",
            "details": {"privateContext": "board-eyes-only"},
        }
    ]
    assert result["output"] == {
        "approved": True,
        "response": {"comment": "private approval response"},
        "respondedAt": "2026-07-22T00:01:00.000Z",
    }
    assert result["statePatch"] == {"set": {"approval": result["output"]}}
    events = stringify(collector.events)
    for secret in ["secret acquisition", "board-eyes-only", "private target", "private approval response"]:
        assert secret not in events
    assert "private target" not in stringify(result["metadata"])
    assert "private approval response" not in stringify(result["metadata"])


@pytest.mark.parametrize(("on_reject", "end_run"), [("continue", None), ("complete", True)])
async def test_records_a_rejection_and_keeps_going_with_on_reject(on_reject, end_run):
    step = {
        "id": "approval-choice",
        "type": "approval",
        "prompt": "Publish?",
        "outputVariable": "decision",
        "onReject": on_reject,
    }
    approvals = Approvals(
        lambda request, signal: {
            "approved": False,
            "response": {"reviewer": "ana"},
            "respondedAt": "2026-07-22T00:01:00.000Z",
        }
    )
    result = await ApprovalStepExecutor().execute(context(step, approvals=approvals))
    assert result["output"] == {
        "approved": False,
        "respondedAt": "2026-07-22T00:01:00.000Z",
        "response": {"reviewer": "ana"},
    }
    assert result["statePatch"]["set"]["decision"]["approved"] is False
    assert result.get("endRun") == end_run


async def test_cancels_the_run_on_a_rejection_with_on_reject_cancel():
    step = {"id": "approval-cancel", "type": "approval", "prompt": "Continue?", "onReject": "cancel"}
    with pytest.raises(RunCancelledError) as raised:
        await ApprovalStepExecutor().execute(
            context(
                step, approvals=Approvals(lambda r, s: {"approved": False, "respondedAt": "2026-07-22T00:01:00.000Z"})
            )
        )
    assert raised.value.code == "RUN_CANCELLED"


def test_reports_missing_adapters_before_a_run_starts():
    approval = {"id": "approve", "type": "approval", "prompt": "?"}
    code = {"id": "code", "type": "code", "language": "python", "code": ""}
    run_code = {**code, "id": "run-code", "sandbox": "run"}
    sub_run = {"id": "child", "type": "sub-run", "manifestRef": "x"}
    host = StepPreflightContext(manifest=manifest_for(approval))
    assert ApprovalStepExecutor().preflight(approval, host) == ["Approval step approve requires an ApprovalAdapter."]
    assert CodeStepExecutor().preflight(code, host) == ["Code step code requires a SandboxAdapter."]
    assert CodeStepExecutor().preflight(run_code, host) == ["Code step run-code requires a RunSandboxProvider."]
    assert SubRunStepExecutor().preflight(sub_run, host) == ["Sub-run step child requires a SubRunAdapter."]


async def test_stops_the_step_when_approval_is_rejected():
    step = {"id": "approval-rejected", "type": "approval", "prompt": "Continue?", "action": "cancel"}
    collector = EventCollector()
    approvals = Approvals(
        lambda r, s: {
            "approved": False,
            "response": "private rejection reason",
            "respondedAt": "2026-07-22T00:01:00.000Z",
        }
    )
    with pytest.raises(ApprovalRejectedError) as raised:
        await ApprovalStepExecutor().execute(context(step, approvals=approvals, emit=collector.emit))
    assert raised.value.name == "ApprovalRejectedError"
    assert raised.value.action == "cancel"
    assert "private rejection reason" not in stringify(collector.events)


async def test_enforces_an_optional_wait_timeout_even_when_the_adapter_does_not_support_signals():
    step = {"id": "approval-timeout", "type": "approval", "prompt": "Continue?"}
    never = asyncio.get_running_loop().create_future()
    with pytest.raises(ApprovalTimeoutError):
        await ApprovalStepExecutor(timeout_ms=25).execute(context(step, approvals=Approvals(lambda r, s: never)))


async def test_settles_cancellation_raised_synchronously_by_an_approval_adapter():
    step = {"id": "approval-startup", "type": "approval", "prompt": "Approve {{ quarter }}?"}
    controller = AbortController()

    def handler(request, signal):
        assert request["prompt"] == "Approve Q4?"
        controller.abort(Error("cancelled at startup"))
        return asyncio.get_running_loop().create_future()

    with pytest.raises(Error, match="cancelled at startup"):
        await asyncio.wait_for(
            ApprovalStepExecutor().execute(
                context(step, variables={"quarter": "Q4"}, signal=controller.signal, approvals=Approvals(handler))
            ),
            1,
        )


async def test_does_not_start_an_approval_request_once_the_run_is_cancelled():
    step = {"id": "approval-cancelled", "type": "approval", "prompt": "Continue?"}
    controller = AbortController()
    calls = []

    async def handler(request, signal):
        calls.append(request)
        raise Error("suspended")

    async def emit(event_type, data=None):
        if event_type == "approval.requested":
            controller.abort(Error("cancelled"))
        return await EventCollector().emit(event_type, data)

    with pytest.raises(Error, match="cancelled"):
        await ApprovalStepExecutor().execute(
            context(step, approvals=Approvals(handler), signal=controller.signal, emit=emit)
        )
    await asyncio.sleep(0.02)
    assert calls == []


# ─── Webhook ────────────────────────────────────────────────────────────────


def test_requires_an_explicit_destination_policy_unless_the_manifest_is_trusted_locally():
    with pytest.raises(Error, match="authorizeDestination"):
        WebhookStepExecutor()
    WebhookStepExecutor(allow_unsafe_destinations=True)


async def test_authorizes_the_destination_before_issuing_the_request():
    step = {"id": "webhook-policy", "type": "webhook", "url": "http://169.254.169.254/latest/meta-data/"}
    fetched = []

    async def fetch(url, init):
        fetched.append(url)

    async def authorize(url, details):
        if url.hostname == "169.254.169.254":
            raise Error("Destination is not allowed.")

    with pytest.raises(Error, match=r"Destination is not allowed\."):
        await WebhookStepExecutor(fetch=fetch, authorize_destination=authorize).execute(context(step))
    assert fetched == []


async def test_retries_sequentially_with_one_stable_idempotency_key_and_redacted_lifecycle_data():
    step = {
        "id": "webhook-1",
        "type": "webhook",
        "url": "https://hooks.example.test/private-token",
        "method": "POST",
        "headers": {"Authorization": "Bearer private-token"},
        "body": {"document": "private-body"},
        "retries": 2,
        "idempotencyKey": "stable-secret-key",
        "outputVariable": "webhookResult",
    }
    requests = []
    active = 0
    maximum_active = 0

    async def fetch(url, init):
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        requests.append({"headers": Headers(init["headers"]), "body": init.get("body")})
        active -= 1
        if len(requests) == 1:
            return Response("private failure body", status=503, headers={"Retry-After": "0"})
        return Response(
            stringify({"received": "private response"}), status=200, headers={"Content-Type": "application/json"}
        )

    delays = []

    async def sleep(delay, signal=None):
        delays.append(delay)

    collector = EventCollector()
    result = await WebhookStepExecutor(fetch=fetch, allow_unsafe_destinations=True, sleep=sleep).execute(
        context(step, emit=collector.emit)
    )
    assert len(requests) == 2
    assert maximum_active == 1
    assert [request["headers"].get("idempotency-key") for request in requests] == [
        "stable-secret-key",
        "stable-secret-key",
    ]
    assert requests[0]["headers"].get("authorization") == "Bearer private-token"
    assert requests[0]["body"] == '{"document":"private-body"}'
    assert delays == [0]
    assert result["output"] == {"received": "private response"}
    assert result["statePatch"] == {"set": {"webhookResult": {"received": "private response"}}}
    lifecycle = stringify({"events": collector.events, "metadata": result["metadata"]})
    for secret in ["private-token", "private-body", "private response", "stable-secret-key"]:
        assert secret not in lifecycle


async def test_does_not_retry_non_retryable_http_failures_or_expose_their_body():
    step = {"id": "webhook-400", "type": "webhook", "url": "https://hooks.example.test/", "retries": 3}
    attempts = 0

    async def fetch(url, init):
        nonlocal attempts
        attempts += 1
        return Response("private validation details", status=400)

    async def sleep(delay, signal=None):
        return None

    with pytest.raises(WebhookHttpError) as raised:
        await WebhookStepExecutor(allow_unsafe_destinations=True, fetch=fetch, sleep=sleep).execute(context(step))
    assert (raised.value.status, raised.value.attempts, str(raised.value)) == (
        400,
        1,
        "Webhook returned HTTP 400 after 1 attempt(s)",
    )
    assert attempts == 1


async def test_aborts_a_timed_out_request_and_reports_no_underlying_network_details():
    step = {"id": "webhook-timeout", "type": "webhook", "url": "https://hooks.example.test/", "timeoutMs": 20}
    observed = {}

    async def fetch(url, init):
        observed["signal"] = init["signal"]
        await init["signal"].wait()
        raise Error("private network diagnostics")

    with pytest.raises(WebhookTimeoutError) as raised:
        await WebhookStepExecutor(allow_unsafe_destinations=True, fetch=fetch).execute(context(step))
    assert raised.value.name == "WebhookTimeoutError"
    assert "private network diagnostics" not in str(raised.value)
    assert observed["signal"].aborted is True


async def test_stops_reading_a_response_stream_as_soon_as_the_byte_limit_is_exceeded():
    step = {"id": "webhook-response-limit", "type": "webhook", "url": "https://hooks.example.test/"}
    cancelled = False

    async def body():
        yield bytes(6)
        yield bytes(6)

    async def on_close():
        nonlocal cancelled
        cancelled = True

    async def fetch(url, init):
        return Response(status=200, stream=body(), on_close=on_close)

    with pytest.raises(WebhookResponseError):
        await WebhookStepExecutor(allow_unsafe_destinations=True, maximum_response_bytes=10, fetch=fetch).execute(
            context(step)
        )
    assert cancelled is True


# ─── Code ───────────────────────────────────────────────────────────────────


class Sandbox:
    def __init__(self, handler):
        self.handler = handler
        self.calls = 0

    async def execute(self, request, signal=None):
        self.calls += 1
        result = self.handler(request, signal)
        return await result if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future) else result


async def test_does_not_start_the_sandbox_after_cancellation_in_code_execution_started():
    step = {"id": "cancel-code", "type": "code", "language": "python", "code": "print('hello')"}
    controller = AbortController()

    def handler(request, signal):
        raise Error("should not start")

    sandbox = Sandbox(handler)

    async def emit(event_type, data=None):
        if event_type == "code.execution.started":
            controller.abort(Error("cancelled"))
        return await EventCollector().emit(event_type, data)

    with pytest.raises(Error, match="cancelled"):
        await CodeStepExecutor().execute(
            context(step, run_id="r", signal=controller.signal, sandbox=sandbox, emit=emit)
        )
    assert sandbox.calls == 0


async def test_uses_the_sandbox_port_and_persists_only_output_artifacts_and_safe_metrics():
    step = {
        "id": "code-1",
        "type": "code",
        "language": "python",
        "code": 'print("private stdout")',
        "outputVariable": "calculation",
        "timeoutMs": 2000,
    }
    requests = []

    def handler(request, signal):
        requests.append(copy.deepcopy(request))
        return {
            "exitCode": 0,
            "stdout": "private stdout",
            "stderr": "private warning",
            "output": {"answer": 42},
            "artifacts": [{"id": "artifact-1", "name": "result.json", "mediaType": "application/json"}],
        }

    collector = EventCollector()
    result = await CodeStepExecutor().execute(
        context(step, variables={"input": 21}, sandbox=Sandbox(handler), emit=collector.emit)
    )
    assert requests == [
        {
            "runId": "run-1",
            "stepId": "code-1",
            "language": "python",
            "code": 'print("private stdout")',
            "variables": {"input": 21},
            "timeoutMs": 2000,
        }
    ]
    assert result["output"] == {"answer": 42}
    assert result["statePatch"] == {"set": {"calculation": {"answer": 42}}}
    assert len(result["artifacts"]) == 1
    lifecycle = stringify({"events": collector.events, "metadata": result["metadata"]})
    assert "private stdout" not in lifecycle
    assert "private warning" not in lifecycle


RECORD = {
    "id": "cmd-1-1",
    "runId": "run-1",
    "attempt": 1,
    "stepId": "code-run",
    "kind": "code",
    "name": "code-run",
    "argv": ["python3", "/workspace/steps/cmd-1-1/main.py"],
    "cwd": "/workspace/steps/cmd-1-1",
    "startedAt": "2026-01-01T00:00:00.000Z",
    "completedAt": "2026-01-01T00:00:01.000Z",
    "durationMs": 1000,
    "exitCode": 0,
    "timedOut": False,
    "stdoutBytes": 3,
    "stderrBytes": 0,
    "stdoutTruncated": False,
    "stderrTruncated": False,
    "filesChanged": [],
    "ignoredPaths": [],
    "budget": {"commandsUsed": 1, "commandsLimit": 200, "sandboxSecondsUsed": 1, "sandboxSecondsLimit": 900},
}


class Session:
    id = "sb-1"

    def __init__(self, result):
        self.result = result
        self.executed = []

    async def execute(self, request):
        self.executed.append(request)
        return self.result

    def budget(self):
        return {"commandsUsed": 1, "sandboxSecondsUsed": 1}

    async def close(self, reason):
        return None


class ReadStore:
    mode = "read"

    async def entries(self, signal=None):
        return []

    async def read(self, path, signal=None):
        return b""


async def test_executes_in_the_run_sandbox_when_workspaces_are_declared_and_records_the_command():
    step = {
        "id": "code-run",
        "type": "code",
        "language": "python",
        "code": "print('ok')",
        "workspaces": ["code"],
        "outputVariable": "result",
    }
    session = Session({"record": RECORD, "output": "ok\n", "stdout": "ok\n", "stderr": ""})
    workspace = ResolvedWorkspace(
        binding={"ref": "repo", "alias": "code"}, alias="code", mode="read", store=ReadStore()
    )
    collector = EventCollector()

    async def run_sandbox():
        return session

    result = await CodeStepExecutor().execute(
        context(step, variables={"input": 21}, workspaces=[workspace], run_sandbox=run_sandbox, emit=collector.emit)
    )
    assert session.executed == [
        {
            "stepId": "code-run",
            "kind": "code",
            "name": "code-run",
            "arguments": {
                "language": "python",
                "code": "print('ok')",
                "variables": {"input": 21},
                "timeoutMs": 60000,
                "workspaces": ["code"],
            },
        }
    ]
    assert result["output"] == "ok\n"
    assert result["statePatch"] == {"set": {"result": "ok\n"}}
    assert (result["metadata"]["sandbox"], result["metadata"]["exitCode"], result["metadata"]["command"]["id"]) == (
        "run",
        0,
        "cmd-1-1",
    )
    assert [[event["type"], event["data"].get("sandbox")] for event in collector.events] == [
        ["code.execution.started", "run"],
        ["code.execution.completed", "run"],
    ]
    with pytest.raises(Error, match="requires workspace code, which is not available"):
        await CodeStepExecutor().execute(context(step, workspaces=[], run_sandbox=run_sandbox, emit=collector.emit))
    no_workspaces = {key: value for key, value in step.items() if key != "workspaces"} | {"sandbox": "run"}
    with pytest.raises(Error, match="requires the run sandbox"):
        await CodeStepExecutor().execute(context(no_workspaces, emit=collector.emit))
    failing = Session({"record": {**RECORD, "exitCode": 3}, "stdout": "", "stderr": "boom"})

    async def failing_sandbox():
        return failing

    with pytest.raises(SandboxExecutionError):
        await CodeStepExecutor().execute(
            context(step, workspaces=[workspace], run_sandbox=failing_sandbox, emit=collector.emit)
        )


async def test_forwards_explicit_environment_values_only_to_the_sandbox():
    step = {
        "id": "code-environment",
        "type": "code",
        "language": "python",
        "code": 'print("hello")',
        "environment": {"PRIVATE_TOKEN": "secret"},
    }
    requests = []

    def handler(request, signal):
        requests.append(copy.deepcopy(request))
        return {"exitCode": 0, "stdout": "", "stderr": ""}

    collector = EventCollector()
    await CodeStepExecutor().execute(context(step, sandbox=Sandbox(handler), emit=collector.emit))
    assert requests[0]["environment"] == {"PRIVATE_TOKEN": "secret"}
    assert "PRIVATE_TOKEN" not in stringify(collector.events)
    assert "secret" not in stringify(collector.events)


async def test_rejects_a_non_zero_exit_without_exposing_stderr():
    step = {"id": "code-failed", "type": "code", "language": "python", "code": 'raise RuntimeError("private")'}
    collector = EventCollector()
    with pytest.raises(SandboxExecutionError):
        await CodeStepExecutor().execute(
            context(
                step,
                sandbox=Sandbox(lambda r, s: {"exitCode": 7, "stdout": "", "stderr": "private stack trace"}),
                emit=collector.emit,
            )
        )
    assert "private stack trace" not in stringify(collector.events)


async def test_enforces_a_timeout_even_when_a_sandbox_ignores_the_abort_signal():
    step = {"id": "code-timeout", "type": "code", "language": "python", "code": "while True: pass", "timeoutMs": 10}
    observed = {}

    def handler(request, signal):
        observed["signal"] = signal
        return asyncio.get_running_loop().create_future()

    with pytest.raises(SandboxTimeoutError):
        await CodeStepExecutor().execute(context(step, sandbox=Sandbox(handler)))
    assert observed["signal"].aborted is True


# ─── Sub-run ────────────────────────────────────────────────────────────────


class SubRuns:
    def __init__(self, handler):
        self.handler = handler
        self.requests = []

    async def execute(self, request, signal=None):
        self.requests.append(copy.deepcopy(request))
        return self.handler(request)


async def test_maps_selected_parent_variables_and_returns_child_output_and_artifacts():
    step = {
        "id": "sub-run-1",
        "type": "sub-run",
        "manifestRef": "agent://review",
        "variableMappings": {"documentId": "document.id", "audience": "Audience"},
        "outputVariable": "review",
    }
    sub_runs = SubRuns(
        lambda request: {
            "runId": "child-run-1",
            "output": {"accepted": True},
            "artifacts": [{"id": "artifact-1", "name": "review.json", "mediaType": "application/json"}],
        }
    )
    collector = EventCollector()
    result = await SubRunStepExecutor().execute(
        context(
            step,
            run_id="parent-run-1",
            variables={"document": {"id": "doc-1", "privateText": "not forwarded"}, "audience": "board"},
            sub_runs=sub_runs,
            emit=collector.emit,
        )
    )
    assert sub_runs.requests == [
        {
            "parentRunId": "parent-run-1",
            "stepId": "sub-run-1",
            "manifestReference": "agent://review",
            "variables": [{"key": "documentId", "value": "doc-1"}, {"key": "audience", "value": "board"}],
        }
    ]
    assert result["output"] == {"accepted": True}
    assert result["statePatch"] == {"set": {"review": {"accepted": True}}}
    assert len(result["artifacts"]) == 1
    assert "not forwarded" not in stringify(collector.events)


async def test_checkpoints_an_asynchronous_child_and_resumes_without_relaunching_it():
    step = {"id": "sub-run-1", "type": "sub-run", "manifestRef": "agent://review", "outputVariable": "review"}
    checkpoints = []

    def handler(request):
        if not request.get("continuation"):
            return {
                "runId": "child-job-1",
                "status": "suspended",
                "continuation": {"childWorkflowJobId": "child-job-1"},
            }
        return {"runId": "child-job-1", "status": "completed", "output": "child result"}

    sub_runs = SubRuns(handler)

    async def checkpoint(nested):
        if nested.get("continuation"):
            checkpoints.append(copy.deepcopy(nested["continuation"]))

    executor = SubRunStepExecutor()
    base = {
        "run_id": "parent-run-1",
        "variables": {"accountName": "Acme"},
        "sub_runs": sub_runs,
        "checkpoint": checkpoint,
    }
    with pytest.raises(RunSuspendedError) as raised:
        await executor.execute(context(step, **base))
    assert (raised.value.name, raised.value.code, raised.value.reason) == (
        "RunSuspendedError",
        "RUN_SUSPENDED",
        "sub-run",
    )
    assert checkpoints[-1] == {
        "type": "sub-run",
        "phase": "waiting",
        "stepId": "sub-run-1",
        "childRunId": "child-job-1",
        "adapter": {"childWorkflowJobId": "child-job-1"},
    }
    resumed = await executor.execute(
        context(
            step, **base, resume={"cursor": {"stepIndex": 0, "stepId": step["id"]}, "continuation": checkpoints[-1]}
        )
    )
    assert resumed["output"] == "child result"
    assert resumed["statePatch"] == {"set": {"review": "child result"}}
    assert len(sub_runs.requests) == 2
    assert sub_runs.requests[1]["continuation"] == {"childWorkflowJobId": "child-job-1"}


async def test_forwards_a_signed_history_selection_only_when_the_step_sets_history():
    user = {"role": "user", "content": [{"type": "text", "text": "Hi"}]}
    sub_runs = SubRuns(lambda request: {"runId": "child-1", "output": "ok"})
    signature = {"version": "1", "algorithm": "HMAC-SHA256", "keyId": "k1", "count": 1, "value": "mac"}

    def declaring(step):
        return {"schemaVersion": "1.0", "messages": {}, "steps": [step]}

    async def sign(messages):
        return signature

    forwarding = {"id": "delegate", "type": "sub-run", "manifestRef": "agent://child", "history": {"last": 1}}
    collector = EventCollector()
    await SubRunStepExecutor().execute(
        context(
            forwarding,
            run_id="parent",
            manifest=declaring(forwarding),
            variables={"topic": "refunds", "messages": {"count": 1}},
            history=StepHistoryContext(
                messages=[user],
                places=[{"turn": 1, "position": 1}],
                turn=1,
                explicit=True,
                insert=True,
                media="include",
                scope="tenant:1",
                sign=sign,
            ),
            sub_runs=sub_runs,
            emit=collector.emit,
        )
    )
    request = sub_runs.requests[0]
    assert request["variables"] == [{"key": "topic", "value": "refunds"}]
    assert (request["messages"], request["messagesSignature"], request["messagesScope"]) == (
        [user],
        signature,
        "tenant:1",
    )
    assert collector.events[0]["data"]["forwardedMessages"] == 1
    silent = {"id": "silent", "type": "sub-run", "manifestRef": "agent://child"}
    await SubRunStepExecutor().execute(
        context(
            silent,
            run_id="parent",
            manifest=declaring(silent),
            variables={"topic": "refunds", "messages": {"count": 1}},
            history=StepHistoryContext(
                messages=[user],
                places=[{"turn": 1, "position": 1}],
                turn=1,
                explicit=False,
                insert=False,
                media="include",
                sign=sign,
            ),
            sub_runs=sub_runs,
        )
    )
    assert "messages" not in sub_runs.requests[1]
    assert sub_runs.requests[1]["variables"] == [{"key": "topic", "value": "refunds"}]
