"""Port of ``packages/step-prompt/src/index.test.ts``."""

from __future__ import annotations

import asyncio
import copy
from datetime import UTC, datetime

import pytest

from clearideas_agent_runtime._js.abort import AbortController
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.steps.prompt import ModelCompletionError, PromptStepExecutor

from .support import AT, Adapter, Events, context, model, never, request_copy, tools, unhandled_during

STEP = {
    "id": "prompt-1",
    "type": "prompt",
    "prompt": "Review {{ Item.Name }}",
    "systemPrompt": "Audience: {{ audience }}",
    "model": {"provider": "openai", "model": "gpt-test"},
    "tools": ["lookup"],
    "outputVariable": "answer",
    "maxOutputTokens": 200,
}
MANIFEST = {"schemaVersion": "1.0", "steps": [STEP], "limits": {"maxToolCallsPerIteration": 3}}
NO_TOOL_STEP = {key: value for key, value in STEP.items() if key not in ("tools", "systemPrompt")}


class ArtifactStub:
    async def put(self, _input: dict) -> dict:
        raise Error("not used")

    async def get(self, ref: dict) -> dict:
        return {"ref": {**ref, "size": 3}, "data": bytes([1, 2, 3])}


async def test_replays_rich_histories_templates_text_only_and_resolves_media() -> None:
    requests: list[dict] = []
    history_step = {
        "id": "history",
        "type": "prompt",
        "model": {"provider": "openai", "model": "gpt-test"},
        "messages": [
            {
                "role": "system",
                "content": [{"type": "text", "text": "Topic: {{ topic }}"}],
                "metadata": {"source": "fixture"},
                "providerOptions": {"anthropic": {"cacheControl": {"type": "ephemeral"}}},
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Inspect {{ imageLabel }}"},
                    {
                        "type": "image",
                        "artifact": {"id": "artifact-1", "name": "diagram.png", "mediaType": "image/png"},
                        "metadata": {"alt": "{{ shouldNotCompile }}"},
                    },
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool-call",
                        "call": {
                            "id": "historical-call",
                            "name": "lookup",
                            "input": {"query": "{{ shouldNotCompile }}"},
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "content": [
                    {
                        "type": "tool-result",
                        "result": {
                            "callId": "historical-call",
                            "name": "lookup",
                            "output": {"answer": "{{ shouldNotCompile }}"},
                            "metadata": {"cached": True},
                            "artifacts": [{"id": "artifact-2", "name": "tool-image.png", "mediaType": "image/png"}],
                        },
                    }
                ],
            },
            {"role": "user", "content": [{"type": "text", "text": "Continue."}]},
        ],
    }

    async def generate(request: dict) -> dict:
        requests.append(request_copy(request))
        return {
            "output": "done",
            "transcript": [
                {
                    "id": "assistant-history",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "done"}],
                    "createdAt": AT,
                }
            ],
        }

    await PromptStepExecutor().execute(
        context(
            run_id="run-history",
            manifest={"schemaVersion": "1.0", "steps": [history_step]},
            step=history_step,
            variables={"topic": "architecture", "imageLabel": "the diagram", "shouldNotCompile": "secret"},
            model=model(generate),
            artifacts=ArtifactStub(),
        )
    )
    assert len(requests) == 1
    messages = requests[0]["messages"]
    assert len(messages) == 5
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == [{"type": "text", "text": "Topic: architecture"}]
    assert messages[0]["metadata"] == {"source": "fixture"}
    assert messages[1]["content"][0] == {"type": "text", "text": "Inspect the diagram"}
    image = messages[1]["content"][1]
    assert image["data"] == "AQID"
    assert image["mediaType"] == "image/png"
    assert image["metadata"] == {"alt": "{{ shouldNotCompile }}"}
    assert messages[2]["content"][0]["call"]["input"] == {"query": "{{ shouldNotCompile }}"}
    result = messages[3]["content"][0]["result"]
    assert result["output"] == {"answer": "{{ shouldNotCompile }}"}
    assert result["metadata"] == {"cached": True}
    assert result["artifacts"] == [
        {
            "id": "artifact-2",
            "name": "tool-image.png",
            "mediaType": "image/png",
            "uri": "data:image/png;base64,AQID",
            "size": 3,
        }
    ]


async def test_enforces_complete_history_input_limits() -> None:
    limited = {
        "id": "limited",
        "type": "prompt",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "one"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "two"}]},
        ],
        "model": {"provider": "openai", "model": "gpt-test"},
    }

    async def generate(_: dict) -> dict:
        return {"output": "should not run", "transcript": []}

    with pytest.raises(Error, match="exceeding the 1-message input limit"):
        await PromptStepExecutor().execute(
            context(
                run_id="run-limited",
                manifest={"schemaVersion": "1.0", "steps": [limited], "limits": {"maxMessagesPerPrompt": 1}},
                step=limited,
                model=model(generate),
            )
        )


async def test_streams_deltas_and_executes_tool_calls_sequentially() -> None:
    requests: list[dict] = []
    order: list[str] = []

    async def generate(_: dict) -> dict:
        raise Error("stream should be used")

    async def stream(request: dict):
        requests.append(request_copy(request))
        if len(requests) == 1:
            yield {"type": "text-delta", "delta": "Checking"}
            yield {
                "type": "completed",
                "result": {
                    "output": "",
                    "transcript": [
                        {
                            "id": "assistant-1",
                            "type": "message",
                            "role": "assistant",
                            "content": [
                                {"type": "tool-call", "call": {"id": "call-1", "name": "lookup", "input": {"id": 1}}}
                            ],
                            "createdAt": AT,
                        }
                    ],
                    "toolCalls": [{"id": "call-1", "name": "lookup", "input": {"id": 1}}],
                    "finishReason": "tool-calls",
                },
            }
            return
        yield {"type": "text-delta", "delta": "Approved"}
        yield {
            "type": "completed",
            "result": {
                "output": "Approved",
                "transcript": [
                    {
                        "id": "assistant-2",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "Approved"}],
                        "createdAt": "2026-07-22T00:00:01.000Z",
                    }
                ],
                "finishReason": "stop",
            },
        }

    async def execute(call: dict, _context: object) -> dict:
        order.append(call["id"])
        return {"callId": call["id"], "name": call["name"], "output": {"found": True}}

    events = Events("run-1")
    result = await PromptStepExecutor(
        now=lambda: datetime(2026, 7, 22, 0, 0, 2, tzinfo=UTC), generate_transcript_id=lambda: "tool-result-1"
    ).execute(
        context(
            run_id="run-1",
            manifest=MANIFEST,
            step=STEP,
            variables={"Item": {"Name": "Proposal"}, "audience": "board"},
            model=model(generate, stream),
            tools=tools(execute),
            emit=events.emit,
        )
    )
    assert order == ["call-1"]
    assert len(requests) == 2
    assert requests[0]["model"] == "openai/gpt-test"
    assert requests[0]["maxOutputTokens"] == 200
    assert requests[0]["messages"] == [
        {"role": "system", "content": [{"type": "text", "text": "Audience: board"}]},
        {"role": "user", "content": [{"type": "text", "text": "Review Proposal"}]},
    ]
    last = requests[1]["messages"][-1]
    assert last["role"] == "tool"
    assert last["content"][0]["result"]["callId"] == "call-1"
    assert last["content"][0]["result"]["output"] == {"found": True}
    assert result["output"] == "Approved"
    assert result["statePatch"] == {"set": {"answer": "Approved"}}
    assert events.types().count("model.text.delta") == 2
    assert "model.tool.completed" in events.types()


class Budget:
    def __init__(self, max_total_tokens: int, consumed: int) -> None:
        self.max_total_tokens = max_total_tokens
        self.consumed_tokens = consumed

    def consume(self, usage: dict) -> dict:
        total = usage.get("totalTokens")
        if total is None:
            total = (usage.get("inputTokens") or 0) + (usage.get("outputTokens") or 0)
        self.consumed_tokens += total
        return {"maxTotalTokens": self.max_total_tokens, "consumedTokens": self.consumed_tokens}


def resume_of(saved: dict | None) -> dict | None:
    if saved is None:
        return None
    resume: dict = {"cursor": {"stepIndex": 0, "stepId": STEP["id"]}}
    if saved.get("continuation") is not None:
        resume["continuation"] = saved["continuation"]
    if saved.get("transcript") is not None:
        resume["transcript"] = saved["transcript"]
    return resume


async def test_suspends_at_token_limit_and_resumes_without_replay() -> None:
    model_requests: list[dict] = []
    tool_calls: list[str] = []
    events: list[str] = []

    def usage_item(id_: str, content: list, usage: dict) -> dict:
        return {"id": id_, "type": "message", "role": "assistant", "content": content, "usage": usage, "createdAt": AT}

    async def generate(request: dict) -> dict:
        model_requests.append(request_copy(request))
        if len(model_requests) == 1:
            call = {"id": "call-1", "name": "lookup", "input": {"id": 1}}
            return {
                "output": "",
                "transcript": [usage_item("assistant-1", [{"type": "tool-call", "call": call}], {"totalTokens": 10})],
                "toolCalls": [call],
                "finishReason": "tool-calls",
            }
        return {
            "output": "done",
            "transcript": [usage_item("assistant-2", [{"type": "text", "text": "done"}], {"totalTokens": 2})],
            "finishReason": "stop",
        }

    async def execute_tool(call: dict, _context: object) -> dict:
        tool_calls.append(call["id"])
        return {"callId": call["id"], "name": call["name"], "output": {"found": True}}

    saved: dict | None = None

    async def checkpoint(value: dict) -> None:
        nonlocal saved
        saved = copy.deepcopy(value)

    async def emit(type: str, data: dict | None = None) -> dict:
        events.append(type)
        return {"id": type, "runId": "run-budget", "sequence": len(events), "timestamp": AT, "type": type}

    def execute(budget: Budget, resume: dict | None = None):
        return PromptStepExecutor(generate_transcript_id=lambda: "tool-result-1").execute(
            context(
                run_id="run-budget",
                manifest=MANIFEST,
                step=STEP,
                variables={"Item": {"Name": "Proposal"}, "audience": "board"},
                model=model(generate),
                tools=tools(execute_tool),
                token_budget=budget,
                resume=resume,
                checkpoint=checkpoint,
                emit=emit,
            )
        )

    with pytest.raises(Exception) as first:
        await execute(Budget(10, 0))
    assert first.value.reason == "token-budget"  # type: ignore[attr-defined]
    assert len(model_requests) == 1
    assert tool_calls == []
    assert saved is not None
    assert saved["continuation"]["type"] == "prompt"
    assert saved["continuation"]["nextToolIndex"] == 0
    assert saved["continuation"]["toolCallCount"] == 0

    with pytest.raises(Exception) as second:
        await execute(Budget(10, 10), resume_of(saved))
    assert second.value.reason == "token-budget"  # type: ignore[attr-defined]
    assert len(model_requests) == 1
    assert tool_calls == []

    result = await execute(Budget(12, 10), resume_of(saved))
    assert result["output"] == "done"
    assert len(model_requests) == 2
    assert tool_calls == ["call-1"]
    assert events.count("model.usage") == 2


async def test_reuses_checkpointed_tool_idempotency_key() -> None:
    model_requests: list[dict] = []
    keys: list[str] = []
    applied: set[str] = set()
    effects = 0

    async def generate(request: dict) -> dict:
        model_requests.append(request_copy(request))
        if len(model_requests) == 1:
            call = {"id": "side-effect-1", "name": "lookup", "input": {}}
            return {
                "transcript": [
                    {
                        "id": "assistant-side-effect",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "tool-call", "call": call}],
                        "createdAt": AT,
                    }
                ],
                "toolCalls": [call],
            }
        return {"output": "done", "transcript": []}

    async def execute_tool(call: dict, tool_context: object) -> dict:
        nonlocal effects
        key = tool_context.idempotency_key  # type: ignore[attr-defined]
        keys.append(key)
        if key not in applied:
            applied.add(key)
            effects += 1
            raise Error("process exited after the external effect")
        return {"callId": call["id"], "name": call["name"], "output": {"applied": True}}

    saved: dict | None = None

    async def checkpoint(value: dict) -> None:
        nonlocal saved
        saved = copy.deepcopy(value)

    def execute(resume: dict | None = None):
        return PromptStepExecutor(
            generate_transcript_id=lambda: "tool-result-side-effect",
            generate_tool_idempotency_key=lambda: "stable-tool-key",
        ).execute(
            context(
                run_id="run-side-effect",
                manifest=MANIFEST,
                step=STEP,
                variables={"Item": {"Name": "Proposal"}, "audience": "board"},
                model=model(generate),
                tools=tools(execute_tool),
                resume=resume,
                checkpoint=checkpoint,
            )
        )

    with pytest.raises(Error, match="process exited after the external effect"):
        await execute()
    assert saved is not None
    assert saved["continuation"]["nextToolIndex"] == 0
    assert saved["continuation"]["toolIdempotencyKeys"] == ["stable-tool-key"]
    result = await execute(resume_of(saved))
    assert result["output"] == "done"
    assert len(model_requests) == 2
    assert len(keys) == 2
    assert keys[1] == keys[0]
    assert effects == 1


async def test_counts_tool_calls_across_turns_and_resumes() -> None:
    turns = 0
    executed = 0
    saved: dict | None = None

    async def generate(_: dict) -> dict:
        nonlocal turns
        turns += 1
        return {"transcript": [], "toolCalls": [{"id": str(turns), "name": "lookup", "input": {}}]}

    async def execute_tool(call: dict, _context: object) -> dict:
        nonlocal executed
        executed += 1
        return {"callId": call["id"], "name": call["name"], "output": {}}

    async def checkpoint(value: dict) -> None:
        nonlocal saved
        saved = copy.deepcopy(value)

    def execute(resume: dict | None = None):
        return PromptStepExecutor().execute(
            context(
                run_id="limit",
                manifest={**MANIFEST, "limits": {"maxToolCallsPerIteration": 2}},
                step=STEP,
                policies={"toolCallLimit": "fail"},
                variables={"Item": {"Name": "test"}, "audience": "test"},
                model=model(generate),
                tools=tools(execute_tool),
                resume=resume,
                checkpoint=checkpoint,
            )
        )

    with pytest.raises(Error, match="tool-call limit across the prompt step"):
        await execute()
    assert turns == 3
    assert executed == 2
    assert saved is not None and saved["continuation"]["toolCallCount"] == 2
    with pytest.raises(Error, match="tool-call limit across the prompt step"):
        await execute(resume_of(saved))
    assert turns == 3
    assert executed == 2


async def test_uses_generation_when_stream_is_unavailable() -> None:
    async def generate(request: dict) -> dict:
        return {"output": "done" if request["messages"][0]["content"][0]["type"] == "text" else "bad", "transcript": []}

    result = await PromptStepExecutor().execute(
        context(
            run_id="run-2",
            manifest={**MANIFEST, "steps": [NO_TOOL_STEP]},
            step=NO_TOOL_STEP,
            variables={"Item": {"Name": "Proposal"}},
            model=model(generate),
        )
    )
    assert result["output"] == "done"


async def test_enforces_provider_timeout_when_adapter_ignores_abort() -> None:
    delays: list[float] = []
    retries: list[dict] = []

    async def sleep(delay_ms: float, _signal: object = None) -> None:
        delays.append(delay_ms)

    async def generate(_: dict) -> dict:
        return await never()

    events = Events("run-timeout", on_emit=lambda type_, data: retries.append(data) if type_ == "model.retry" else None)
    with pytest.raises(Exception) as raised:
        await PromptStepExecutor(sleep=sleep).execute(
            context(
                run_id="run-timeout",
                manifest={**MANIFEST, "steps": [NO_TOOL_STEP], "limits": {"providerTimeoutMs": 5}},
                step=NO_TOOL_STEP,
                model=model(generate),
                emit=events.emit,
            )
        )
    assert raised.value.name == "ModelTimeoutError"  # type: ignore[attr-defined]
    assert raised.value.timeout_ms == 5  # type: ignore[attr-defined]
    assert delays == [1_000, 2_000]
    assert [(entry["reason"], entry["attempt"]) for entry in retries] == [
        ("retryable-error", 1),
        ("retryable-error", 2),
    ]
    assert retries[0]["name"] == "ModelTimeoutError"


class TestCancellation:
    @staticmethod
    def execute(model_adapter: Adapter, controller: AbortController, abort_on: str, limits: dict | None = None):
        def on_emit(type_: str, _data: object) -> None:
            # A host cancels while handling an event, e.g. a user clicks Stop.
            if type_ == abort_on:
                controller.abort(Error("cancelled"))

        async def no_sleep(_delay: float, _signal: object = None) -> None:
            return None

        return PromptStepExecutor(sleep=no_sleep).execute(
            context(
                run_id="run-cancel",
                manifest={**MANIFEST, "steps": [NO_TOOL_STEP], "limits": limits or {}},
                step=NO_TOOL_STEP,
                model=model_adapter,
                signal=controller.signal,
                emit=Events("run-cancel", on_emit).emit,
            )
        )

    async def test_does_not_create_stream_when_cancelled_by_model_started(self) -> None:
        controller = AbortController()
        started = 0

        def stream(_: dict):
            nonlocal started
            started += 1

            async def generator():
                yield {"type": "completed", "result": {"transcript": []}}

            return generator()

        with pytest.raises(Error, match="cancelled"):
            await self.execute(model(stream=stream), controller, "model.started")
        assert started == 0

    @pytest.mark.parametrize("mode", ["generate", "stream"])
    async def test_settles_cancellation_raised_synchronously_during_startup(self, mode: str) -> None:
        controller = AbortController()

        def start() -> asyncio.Future:
            controller.abort(Error("cancelled at startup"))
            return never()

        class Iterator:
            def __aiter__(self) -> Iterator:
                return self

            def __anext__(self) -> asyncio.Future:
                return start()

        adapter = (
            model(generate=lambda _request: start())
            if mode == "generate"
            else model(stream=lambda _request: Iterator())
        )
        with pytest.raises(Error, match="cancelled at startup"):
            await asyncio.wait_for(self.execute(adapter, controller, "none"), 1)

    @pytest.mark.parametrize("cleanup", ["throw", "reject"])
    async def test_preserves_cancellation_when_iterator_cleanup_fails(self, cleanup: str) -> None:
        controller = AbortController()
        cleaned = 0

        class Iterator:
            def __aiter__(self) -> Iterator:
                return self

            async def __anext__(self) -> dict:
                return {"type": "text-delta", "delta": "Working"}

            def aclose(self):
                nonlocal cleaned
                cleaned += 1
                if cleanup == "throw":
                    raise Error("cleanup failure")

                async def reject() -> None:
                    raise Error("cleanup failure")

                return reject()

        async def run() -> None:
            with pytest.raises(Error, match="cancelled"):
                await self.execute(model(stream=lambda _request: Iterator()), controller, "model.text.delta")

        unhandled = await unhandled_during(run)
        assert cleaned == 1
        assert unhandled == []

    async def test_observes_late_rejected_read_after_cancelling(self) -> None:
        controller = AbortController()
        pending: list[asyncio.Future] = []

        class Iterator:
            def __aiter__(self) -> Iterator:
                return self

            def __anext__(self) -> asyncio.Future:
                loop = asyncio.get_running_loop()
                future = loop.create_future()
                loop.call_later(0.005, lambda: controller.abort(Error("cancelled")))
                loop.call_later(0.015, lambda: future.done() or future.set_exception(Error("late provider failure")))
                pending.append(future)
                return future

        async def run() -> None:
            with pytest.raises(Error, match="cancelled"):
                await self.execute(model(stream=lambda _request: Iterator()), controller, "none")

        unhandled = await unhandled_during(run)
        assert pending
        assert unhandled == []

    async def test_does_not_leave_rejected_stream_read_unobserved(self) -> None:
        controller = AbortController()

        async def stream(request: dict):
            yield {"type": "text-delta", "delta": "Working"}
            await asyncio.sleep(0.005)
            if request.get("signal") is not None and request["signal"].aborted:
                raise Error("Model stream aborted.")
            yield {"type": "completed", "result": {"output": "done", "transcript": []}}

        async def run() -> None:
            with pytest.raises(Error, match="cancelled"):
                await self.execute(model(stream=stream), controller, "model.text.delta")

        assert await unhandled_during(run) == []

    async def test_does_not_start_another_turn_when_cancelled_during_tool_call(self) -> None:
        controller = AbortController()
        tool_step = {**NO_TOOL_STEP, "tools": ["lookup"]}
        model_calls = 0

        async def stream(request: dict):
            nonlocal model_calls
            model_calls += 1
            if request.get("signal") is not None and request["signal"].aborted:
                raise Error("Model stream aborted.")
            call = {"id": "call-1", "name": "lookup", "input": {}}
            yield {"type": "tool-call", "call": call}
            yield {"type": "completed", "result": {"toolCalls": [call], "transcript": []}}

        async def execute_tool(call: dict, _context: object) -> dict:
            controller.abort(Error("cancelled"))
            await asyncio.sleep(0.005)
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {"code": "sandbox_unavailable", "message": "cancelled"},
            }

        async def run() -> None:
            with pytest.raises(Error, match="cancelled"):
                await PromptStepExecutor().execute(
                    context(
                        run_id="run-cancel",
                        manifest={**MANIFEST, "steps": [tool_step]},
                        step=tool_step,
                        model=model(stream=stream),
                        tools=tools(execute_tool),
                        signal=controller.signal,
                    )
                )

        assert await unhandled_during(run) == []
        assert model_calls == 1

    async def test_does_not_leave_rejected_generate_unobserved(self) -> None:
        controller = AbortController()

        async def generate(request: dict) -> dict:
            await asyncio.sleep(0.005)
            if request.get("signal") is not None and request["signal"].aborted:
                raise Error("Request aborted.")
            return {"output": "done", "transcript": []}

        async def run() -> None:
            with pytest.raises(Error, match="cancelled"):
                await self.execute(model(generate), controller, "model.started")

        assert await unhandled_during(run) == []

    async def test_enforces_timeout_when_streaming_adapter_ignores_abort(self) -> None:
        async def stream(_: dict):
            yield {"type": "text-delta", "delta": "Working"}
            await never()

        async def generate(_: dict) -> dict:
            return await never()

        with pytest.raises(Exception) as raised:
            await asyncio.wait_for(
                self.execute(model(generate, stream), AbortController(), "none", {"providerTimeoutMs": 20}), 2
            )
        assert raised.value.name == "ModelTimeoutError"  # type: ignore[attr-defined]
        assert raised.value.timeout_ms == 20  # type: ignore[attr-defined]


async def test_fails_truncated_output_by_default_and_accepts_with_policy() -> None:
    async def generate(_: dict) -> dict:
        return {"output": "", "transcript": [], "finishReason": "length"}

    truncated = {
        "id": "truncated",
        "type": "prompt",
        "prompt": "Answer.",
        "model": {"provider": "local", "model": "reasoning-model"},
    }
    with pytest.raises(ModelCompletionError) as raised:
        await PromptStepExecutor().execute(
            context(
                run_id="run-truncated",
                manifest={"schemaVersion": "1.0", "steps": [truncated]},
                step=truncated,
                model=model(generate),
            )
        )
    assert raised.value.name == "ModelCompletionError"
    assert raised.value.finish_reason == "length"
    accepted = {**truncated, "completionPolicy": {"onTruncation": "accept"}}
    result = await PromptStepExecutor().execute(
        context(
            run_id="run-truncated",
            manifest={"schemaVersion": "1.0", "steps": [accepted]},
            step=accepted,
            model=model(generate),
        )
    )
    assert result["output"] == ""


async def test_can_require_non_empty_final_output() -> None:
    required = {
        "id": "required-output",
        "type": "prompt",
        "prompt": "Answer.",
        "model": {"provider": "local", "model": "test"},
        "completionPolicy": {"requireOutput": True},
    }

    async def generate(_: dict) -> dict:
        return {"output": "   ", "transcript": [], "finishReason": "stop"}

    with pytest.raises(ModelCompletionError, match="did not contain required output"):
        await PromptStepExecutor().execute(
            context(
                run_id="run-required-output",
                manifest={"schemaVersion": "1.0", "steps": [required]},
                step=required,
                model=model(generate),
            )
        )
