"""Port of ``packages/step-prompt/src/messages.test.ts``."""

from __future__ import annotations

import base64
import copy
import random
import re

import pytest

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core import RunSuspendedError, select_history, with_messages_view
from clearideas_agent_runtime.core.messages import MessageHistoryCompactionRequest
from clearideas_agent_runtime.core.runtime import StepExecutionContext, StepHistoryContext
from clearideas_agent_runtime.steps.prompt import PromptMessageHistoryCompactor, PromptStepExecutor

from .support import AT, Adapter, Events, model, request_copy


def user(text: str) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def assistant(text: str) -> dict:
    return {"role": "assistant", "content": [{"type": "text", "text": text}]}


def reply(text: str) -> dict:
    return {
        "output": text,
        "transcript": [
            {
                "id": f"assistant-{len(text)}-{random.random()}",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
                "createdAt": AT,
            }
        ],
    }


def recording_model(requests: list[dict], answer=lambda _request: "done") -> Adapter:
    async def generate(request: dict) -> dict:
        requests.append(request_copy(request))
        return reply(answer(request))

    return model(generate)


def history_context(messages: list[dict], setting: object) -> StepHistoryContext:
    selection = select_history(messages, setting)

    async def sign(_messages: list[dict]) -> None:
        return None

    return StepHistoryContext(
        messages=selection.messages,
        places=selection.places,
        turn=selection.current_turn,
        explicit=selection.explicit,
        insert=selection.insert,
        media=selection.media,
        sign=sign,
    )


class Artifacts:
    def __init__(self, data: bytes) -> None:
        self.data = data

    async def put(self, _input: dict) -> dict:
        raise Error("not used")

    async def get(self, ref: dict) -> dict:
        return {"ref": ref, "data": self.data}


async def run(
    step: dict,
    history: list[dict],
    *,
    model: Adapter,
    manifest: dict | None = None,
    variables: dict | None = None,
    events: Events | None = None,
    resume: dict | None = None,
    checkpoints: list[list[dict]] | None = None,
    policies: dict | None = None,
    artifacts: object = None,
) -> dict:
    full_manifest = {
        "schemaVersion": "1.0",
        "model": {"provider": "openai", "model": "gpt-test"},
        "messages": {},
        "steps": [step],
        **(manifest or {}),
    }
    selection = select_history(history, step.get("history"))

    async def checkpoint(value: dict) -> None:
        if checkpoints is not None:
            checkpoints.append(copy.deepcopy(value.get("transcript") or []))

    return await PromptStepExecutor().execute(
        StepExecutionContext(
            run_id="run-1",
            manifest=full_manifest,
            step=step,
            step_index=0,
            variables=with_messages_view(full_manifest, variables or {}, selection),
            history=history_context(history, step.get("history")),
            model=model,
            artifacts=artifacts,
            policies=policies,
            resume=resume,
            checkpoint=checkpoint,
            emit=(events or Events("run-1")).emit,
        )
    )


def texts(request: dict) -> list[str]:
    return [
        f"{message['role']}: "
        + " ".join(part["text"] if part["type"] == "text" else f"[{part['type']}]" for part in message["content"])
        for message in request["messages"]
    ]


HISTORY = [user("My name is {{ secret }}"), assistant("Hello."), user("What is my order status?")]


class TestConversationHistory:
    async def test_inserts_selection_literally(self) -> None:
        requests: list[dict] = []
        await run(
            {
                "id": "answer",
                "type": "prompt",
                "systemPrompt": "Support for {{ product }}.",
                "history": "all",
                "prompt": "Answer {{ messages.lastUser.text }} briefly.",
            },
            HISTORY,
            model=recording_model(requests),
            variables={"product": "Widgets", "secret": "S3CRET"},
        )
        assert texts(requests[0]) == [
            "system: Support for Widgets.",
            "user: My name is {{ secret }}",
            "assistant: Hello.",
            "user: What is my order status?",
            "user: Answer What is my order status? briefly.",
        ]
        assert "S3CRET" not in js_json.stringify(requests[0])

    async def test_system_prompt_plus_conversation(self) -> None:
        requests: list[dict] = []
        await run(
            {"id": "answer", "type": "prompt", "systemPrompt": "Answer.", "history": {"last": 1}},
            HISTORY,
            model=recording_model(requests),
        )
        assert texts(requests[0]) == ["system: Answer.", "user: What is my order status?"]

    async def test_inserts_after_leading_system_messages(self) -> None:
        requests: list[dict] = []
        await run(
            {
                "id": "answer",
                "type": "prompt",
                "history": {"last": 2},
                "messages": [
                    {"role": "system", "content": [{"type": "text", "text": "Be brief."}]},
                    {"role": "user", "content": [{"type": "text", "text": "Now answer."}]},
                ],
            },
            HISTORY,
            model=recording_model(requests),
        )
        assert texts(requests[0]) == [
            "system: Be brief.",
            "assistant: Hello.",
            "user: What is my order status?",
            "user: Now answer.",
        ]

    async def test_does_not_insert_when_insert_false(self) -> None:
        requests: list[dict] = []
        await run(
            {
                "id": "check",
                "type": "prompt",
                "history": {"last": 2, "insert": False},
                "prompt": "Check: {{ messages.text }}",
            },
            HISTORY,
            model=recording_model(requests),
        )
        assert texts(requests[0]) == [
            "user: Check: assistant (turn 1): Hello.\n\nuser (turn 2): What is my order status?"
        ]

    async def test_resolves_artifact_media_in_inserted_turns(self) -> None:
        requests: list[dict] = []
        await run(
            {"id": "answer", "type": "prompt", "history": "all", "systemPrompt": "Look."},
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "This chart"},
                        {
                            "type": "image",
                            "artifact": {
                                "id": "chart",
                                "name": "chart.png",
                                "mediaType": "image/png",
                                "sha256": "a" * 64,
                            },
                        },
                    ],
                }
            ],
            model=recording_model(requests),
            artifacts=Artifacts(b"png"),
        )
        part = requests[0]["messages"][1]["content"][1]
        assert part["type"] == "image"
        assert part["data"] == base64.b64encode(b"png").decode()
        assert part["mediaType"] == "image/png"

    async def test_sends_only_images_and_pdfs(self) -> None:
        requests: list[dict] = []

        def artifact(name: str, media_type: str) -> dict:
            return {"id": name, "name": name, "mediaType": media_type, "sha256": "a" * 64}

        docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        await run(
            {"id": "answer", "type": "prompt", "history": "all", "systemPrompt": "Look."},
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Edit these."},
                        {"type": "file", "artifact": artifact("report.docx", docx)},
                        {"type": "file", "artifact": artifact("brief.pdf", "application/pdf")},
                        {"type": "image", "artifact": artifact("chart.png", "image/png")},
                        {"type": "image", "url": "https://example.test/photo"},
                    ],
                }
            ],
            model=recording_model(requests),
            artifacts=Artifacts(b"bytes"),
        )
        parts = requests[0]["messages"][1]["content"]
        assert [part["type"] for part in parts] == ["text", "text", "file", "image", "image"]
        assert parts[1] == {"type": "text", "text": f"[file: report.docx ({docx})]"}

    async def test_counts_inserted_turns_toward_max_messages(self) -> None:
        with pytest.raises(Error, match=r"4 messages, exceeding the 3-message input limit"):
            await run(
                {"id": "answer", "type": "prompt", "history": "all", "prompt": "Go."},
                HISTORY,
                model=recording_model([]),
                manifest={"limits": {"maxMessagesPerPrompt": 3}},
                policies={"context": {"strategy": "fail"}},
            )


def long(label: str) -> str:
    return f"{label} {'detail ' * 150}"


SAFETY_HISTORY = [
    user(long("first")),
    assistant(long("second")),
    user(long("third")),
    assistant(long("fourth")),
    user("Newest question?"),
]


class TestHistorySafetyNet:
    async def test_prunes_oldest_inserted_messages_with_note(self) -> None:
        requests: list[dict] = []
        events = Events("run-1")
        result = await run(
            {"id": "answer", "type": "prompt", "history": "all", "systemPrompt": "Answer."},
            SAFETY_HISTORY,
            model=recording_model(requests),
            manifest={"limits": {"maxInputBytes": 3_000}},
            events=events,
        )
        sent = texts(requests[0])
        assert sent[0] == "system: Answer."
        assert re.fullmatch(
            r"user: \[Agent Runtime removed \d earlier messages of this conversation to fit this step's context window\.\]",
            sent[1],
        )
        assert sent[-1] == "user: Newest question?"
        reduced = events.data("context.reduced")[0]
        assert reduced["scope"] == "messages"
        assert reduced["strategy"] == "prune"
        assert any(
            ((item.get("metadata") or {}).get("agentRuntime") or {}).get("context") is not None
            for item in result["transcript"]
        )

    async def test_summarizes_and_resumes_without_summarizing_again(self) -> None:
        requests: list[dict] = []

        def answer(request: dict) -> str:
            first = request["messages"][0]["content"]
            return (
                "They discussed first and second."
                if any(part["type"] == "text" and "condense material" in part["text"] for part in first)
                else "Answer."
            )

        checkpoints: list[list[dict]] = []
        step = {"id": "answer", "type": "prompt", "history": "all", "systemPrompt": "Answer."}
        options = {
            "manifest": {"limits": {"maxInputBytes": 3_000}},
            "policies": {"context": {"strategy": "summarize"}},
            "checkpoints": checkpoints,
        }
        await run(step, SAFETY_HISTORY, model=recording_model(requests, answer), **options)
        assert any("labeled with its turn number" in js_json.stringify(request) for request in requests)
        main = requests[-1]
        assert "[Summary of earlier messages in this conversation" in texts(main)[1]
        assert "They discussed first and second." in texts(main)[1]

        resumed: list[dict] = []
        transcript = next(
            entry
            for entry in reversed(checkpoints)
            if any('"history"' in js_json.stringify(item.get("metadata") or {}) for item in entry)
            and not any(item.get("role") == "assistant" for item in entry)
        )
        await run(
            step,
            SAFETY_HISTORY,
            model=recording_model(resumed),
            resume={"cursor": {"stepIndex": 0}, "transcript": transcript},
            **options,
        )
        assert len(resumed) == 1
        assert resumed[0]["messages"] == main["messages"]


COMPACTOR_MANIFEST = {
    "schemaVersion": "1.0",
    "model": {"provider": "openai", "model": "gpt-test"},
    "messages": {"maxMessages": 4},
    "steps": [],
}


class CompactionRequest:
    def __init__(self, **overrides: object) -> None:
        self.saved: list[dict] = []
        self.events: list[dict] = []

        async def checkpoint(journal: dict, transcript: list[dict]) -> None:
            self.saved.append(copy.deepcopy({"journal": journal, "transcript": transcript}))

        async def emit(type: str, data: dict | None = None) -> dict:
            self.events.append({"type": type, **({"data": data} if data is not None else {})})
            return {}

        fields: dict = {
            "run_id": "run-1",
            "manifest": COMPACTOR_MANIFEST,
            "text": "user: a\n\nassistant: b",
            "label": "2 earlier messages",
            "task": "Customer support",
            "segment_bytes": 5_000,
            "max_target_bytes": 2_000,
            "policies": {},
            "checkpoint": checkpoint,
            "emit": emit,
            **overrides,
        }
        self.request = MessageHistoryCompactionRequest(**fields)


class TestPromptMessageHistoryCompactor:
    async def test_summarizes_with_messages_instruction_and_records_usage(self) -> None:
        requests: list[dict] = []

        async def generate(request: dict) -> dict:
            requests.append(request_copy(request))
            item = {**reply("x")["transcript"][0], "usage": {"inputTokens": 20, "outputTokens": 10, "totalTokens": 30}}
            return {**reply("They agreed on a refund."), "transcript": [item]}

        input = CompactionRequest(model=model(generate))
        result = await PromptMessageHistoryCompactor().summarize(input.request)
        assert result["text"] == "They agreed on a refund."
        assert result["summarizerCalls"] == 1
        assert result["transcript"][0]["usage"]["totalTokens"] == 30
        part = requests[0]["messages"][1]["content"][0]
        assert part["type"] == "text"
        assert (
            "The material above is 2 earlier messages, between a user and an assistant about: Customer support"
            in part["text"]
        )
        assert [event["type"] for event in input.events] == ["model.started", "model.completed", "model.usage"]
        assert input.events[0]["data"]["purpose"] == "summarize"
        assert input.saved[-1]["journal"]["calls"][0]["text"] == "They agreed on a refund."

    async def test_replays_journal_without_calling_model_again(self) -> None:
        calls = 0

        async def generate(_: dict) -> dict:
            nonlocal calls
            calls += 1
            return reply("Summary.")

        first = CompactionRequest(model=model(generate))
        await PromptMessageHistoryCompactor().summarize(first.request)
        second = await PromptMessageHistoryCompactor().summarize(
            CompactionRequest(model=model(generate), journal=first.saved[-1]["journal"]).request
        )
        assert second["text"] == "Summary."
        assert calls == 1

    async def test_host_summarizer_sees_kind_messages_and_reports_usage(self) -> None:
        seen: list[dict] = []

        async def summarize(request: dict, _next: object) -> dict:
            seen.append(request)
            return {"text": "Host summary.", "usage": {"totalTokens": 7}}

        input = CompactionRequest(summarizer=Adapter(summarize=summarize))
        result = await PromptMessageHistoryCompactor().summarize(input.request)
        assert result["text"] == "Host summary."
        assert seen[0]["runId"] == "run-1"
        assert seen[0]["kind"] == "messages"
        assert seen[0]["label"] == "2 earlier messages"
        assert seen[0]["task"] == "Customer support"
        assert seen[0]["stepId"] == ""
        assert result["transcript"][0]["usage"] == {"totalTokens": 7}

    async def test_suspends_when_budget_exhausted(self) -> None:
        budget = Adapter(
            max_total_tokens=10,
            consumed_tokens=10,
            consume=lambda _usage: {"maxTotalTokens": 10, "consumedTokens": 10},
        )
        with pytest.raises(RunSuspendedError):
            await PromptMessageHistoryCompactor().summarize(
                CompactionRequest(model=recording_model([]), token_budget=budget).request
            )

    async def test_rejects_truncated_summaries(self) -> None:
        async def generate(_: dict) -> dict:
            return {**reply("partial"), "finishReason": "length"}

        with pytest.raises(Exception, match="truncated"):
            await PromptMessageHistoryCompactor().summarize(CompactionRequest(model=model(generate)).request)
