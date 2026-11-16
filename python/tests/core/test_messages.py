"""Port of packages/core/src/messages.test.ts."""

from __future__ import annotations

import base64
import json

import pytest

from clearideas_agent_runtime._js.ops import UNDEFINED
from clearideas_agent_runtime.core import (
    MessagesOptions,
    MessagesValidationError,
    canonical_json,
    conversation_turns,
    create_hmac_message_signer,
    history_marker,
    messages_signing_payload,
    messages_view,
    new_turn_start,
    output_history,
    parse_message_signing_key,
    plan_history_compaction,
    prepare_supplied_history,
    prune_marker_message,
    render_history_text,
    select_history,
    summary_marker_message,
    with_messages_view,
    without_messages_patch,
)

KEY_1 = f"hex:{'11' * 32}"
KEY_2 = f"hex:{'22' * 32}"


def user(text):
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def assistant(text):
    return {"role": "assistant", "content": [{"type": "text", "text": text}]}


def chat(declaration=None, steps=None):
    return {
        "schemaVersion": "1.0",
        "id": "chat",
        "model": {"provider": "openai", "model": "gpt-test"},
        "messages": declaration if declaration is not None else {},
        "steps": steps
        if steps is not None
        else [{"id": "answer", "type": "prompt", "history": "all", "systemPrompt": "Answer."}],
    }


async def prepare(messages=None, **overrides):
    options = overrides.pop("options", {})
    return await prepare_supplied_history(
        run_id="run-1",
        manifest=overrides.pop("manifest", chat()),
        messages=messages,
        options=MessagesOptions(**options),
        strategy=overrides.pop("strategy", "prune"),
        **overrides,
    )


async def rejection(awaitable):
    with pytest.raises(MessagesValidationError) as raised:
        await awaitable
    result = {"code": raised.value.code, "message": str(raised.value)}
    if raised.value.reason:
        result["reason"] = raised.value.reason
    return result


class MemoryArtifacts:
    def __init__(self):
        self.puts = []

    async def put(self, input):
        self.puts.append(input)
        return {
            "id": f"artifact-{len(self.puts)}",
            "name": input["name"],
            "mediaType": input["mediaType"],
            "sha256": "f" * 64,
        }

    async def get(self, ref):
        raise NotImplementedError


class TestCanonicalJson:
    def test_matches_the_rfc_8785_reference_example(self):
        from clearideas_agent_runtime._js.json import parse

        value = parse(
            '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],'
            '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}'
        )
        assert canonical_json(value) == (
            '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
            '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
        )

    def test_orders_keys_by_utf16_code_units_independent_of_locale(self):
        assert (
            canonical_json({"é": 1, "f": 2, "Z": 3, "a": {"y": 1, "b": 2}}) == '{"Z":3,"a":{"b":2,"y":1},"f":2,"é":1}'
        )
        assert canonical_json({"a": UNDEFINED, "b": [UNDEFINED, 1]}) == '{"b":[null,1]}'
        with pytest.raises(ValueError, match="non-finite"):
            canonical_json({"a": float("nan")})


HISTORY = [user("Hi"), assistant("Hello"), user("Refund?")]


class TestMessageSigning:
    async def test_signs_and_verifies_an_exact_history_and_scope(self):
        signer = create_hmac_message_signer("k1", {"k1": KEY_1})
        signature = await signer.sign(HISTORY, "t1")
        assert {key: signature[key] for key in ("version", "algorithm", "keyId", "count")} == {
            "version": "1",
            "algorithm": "HMAC-SHA256",
            "keyId": "k1",
            "count": 3,
        }
        assert all(char.isalnum() or char in "_-" for char in signature["value"])
        assert await signer.verify(HISTORY, signature, "t1") == {"valid": True}

    async def test_detects_every_tampering(self):
        signer = create_hmac_message_signer("k1", {"k1": KEY_1})
        signature = await signer.sign(HISTORY, "t1")
        failed = {"valid": False, "reason": "authentication-failed"}
        for messages in [
            [user("Hi"), assistant("Your refund is approved."), user("Refund?")],
            [assistant("Hello"), user("Hi"), user("Refund?")],
            [user("Hi"), user("Refund?"), assistant("Hello")],
            [user("Hi"), {**assistant("Hello"), "metadata": {"edited": True}}, user("Refund?")],
        ]:
            assert await signer.verify(messages, signature, "t1") == failed
        assert await signer.verify(HISTORY[:2], signature, "t1") == failed
        assert await signer.verify(HISTORY, signature, "t2") == failed
        assert await signer.verify(HISTORY, signature) == failed
        assert await signer.verify(HISTORY, {**signature, "keyId": "k9"}, "t1") == {
            "valid": False,
            "reason": "unknown-key",
        }

    async def test_a_signature_that_is_not_an_object_has_no_known_key(self):
        # A host may pass a browser-supplied value straight through, as the
        # showcase's Document Chat does; TypeScript reads its keyId as undefined.
        signer = create_hmac_message_signer("k1", {"k1": KEY_1})
        for value in ("k1", 7, [], {"keyId": ["k1"]}):
            assert await signer.verify(HISTORY, value, "t1") == {"valid": False, "reason": "unknown-key"}  # pyright: ignore[reportArgumentType]

    async def test_verifies_with_a_retired_key_during_rotation(self):
        old = create_hmac_message_signer("k1", {"k1": KEY_1})
        rotated = create_hmac_message_signer("k2", {"k1": KEY_1, "k2": KEY_2})
        signature = await old.sign(HISTORY)
        assert await rotated.verify(HISTORY, signature) == {"valid": True}
        assert (await rotated.sign(HISTORY))["keyId"] == "k2"

    def test_signs_a_documented_payload_that_other_implementations_can_reproduce(self):
        assert messages_signing_payload([user("Hi")], "s") == (
            'clearideas-agent-runtime/messages/v1\n{"messages":[{"content":[{"text":"Hi","type":"text"}],"role":"user"}],"scope":"s","version":"1"}'
        )
        assert '"scope":null' in messages_signing_payload([], None)

    def test_refuses_ambiguous_or_short_keys(self):
        with pytest.raises(Exception, match="base64: or hex:"):
            parse_message_signing_key("a" * 64)
        with pytest.raises(Exception, match="at least 32 bytes"):
            parse_message_signing_key(f"hex:{'11' * 16}")
        assert len(parse_message_signing_key(f"base64:{'A' * 43}")) == 32
        with pytest.raises(Exception, match="not configured"):
            create_hmac_message_signer("k2", {"k1": KEY_1})


PLAN = plan_history_compaction(
    [user("a"), assistant("b"), user("c"), assistant("d"), user("e")], chat({"maxMessages": 4}), 0.5
)
MARKED = [summary_marker_message(PLAN, "They discussed a and b."), *PLAN.retained]


class TestHistorySelectionAndTheMessagesVariable:
    def test_selects_all_the_newest_n_and_the_marker(self):
        assert len(select_history(MARKED, "all").messages) == len(MARKED)
        last = select_history(MARKED, {"last": 1})
        assert last.messages == [user("e")]
        assert last.insert is True
        assert len(select_history(MARKED, {"last": 1, "summary": True}).messages) == 2
        omitted = select_history(MARKED, None)
        assert omitted.explicit is False
        assert omitted.insert is False
        assert len(omitted.messages) == len(MARKED)

    def test_builds_the_read_only_view_with_a_separate_summary(self):
        view = messages_view(select_history(MARKED, "all"))
        assert view["count"] == len(MARKED) - 1
        assert (view["last"]["role"], view["last"]["text"]) == ("user", "e")
        assert (view["lastUser"]["role"], view["lastUser"]["text"]) == ("user", "e")
        assert view["summary"] == "They discussed a and b."
        assert view["text"] == "[Summary of turns 1–2]\nThey discussed a and b.\n\nuser (turn 3): e"
        empty = messages_view(select_history([], "all"))
        assert {key: empty[key] for key in ("count", "last", "lastUser", "summary", "text")} == {
            "count": 0,
            "last": None,
            "lastUser": None,
            "summary": None,
            "text": "",
        }

    def test_replaces_media_with_placeholders_by_mode(self):
        def image(name):
            return {
                "role": "user",
                "content": [
                    {"type": "text", "text": name},
                    {"type": "image", "artifact": {"id": name, "name": f"{name}.png", "mediaType": "image/png"}},
                ],
            }

        history = [image("first"), assistant("ok"), image("second")]
        latest = select_history(history, {"media": "latest"}).messages
        assert latest[0]["content"][1] == {"type": "text", "text": "[image: first.png (image/png)]"}
        assert latest[2]["content"][1]["type"] == "image"
        omit = select_history(history, {"media": "omit"}).messages
        assert "image" not in [part["type"] for message in omit for part in message["content"]]

    def test_injects_and_strips_the_view_only_for_declaring_manifests(self):
        selection = select_history([user("hi")], "all")
        injected = with_messages_view(chat(), {"a": 1, "Messages": "x"}, selection)
        assert injected["a"] == 1 and injected["messages"]["count"] == 1
        assert list(with_messages_view(chat(), {"Messages": "x"}, selection)) == ["messages"]
        assert with_messages_view({"schemaVersion": "1.0", "steps": []}, {"messages": [1]}, selection) == {
            "messages": [1]
        }
        assert without_messages_patch(
            chat(), {"set": {"answer": 1, "messages": {}}, "unset": ["messages.all", "other"]}
        ) == {"set": {"answer": 1}, "unset": ["other"]}

    def test_appends_the_final_output_as_assistant_text(self):
        assert output_history([user("hi")], {"ok": True})[-1] == {
            "role": "assistant",
            "content": [{"type": "text", "text": '{"ok":true}'}],
        }
        assert output_history([user("hi")], UNDEFINED) == [user("hi")]


class TestTurnNumbers:
    def test_numbers_turns_by_replies_with_absolute_positions(self):
        turns = conversation_turns(
            [
                user("Hi"),
                assistant("Hello"),
                user("Here is the report."),
                user("Please edit it."),
                assistant("Edited."),
                user("Now shorten it."),
            ]
        )
        assert [place["turn"] for place in turns.places] == [1, 1, 2, 2, 2, 3]
        assert [place["position"] for place in turns.places] == [1, 2, 3, 4, 5, 6]
        assert turns.current_turn == 3
        assert turns.summarized is None

    def test_keeps_turn_numbers_across_repeated_compactions(self):
        history = []
        for turn in range(1, 13):
            history += [user(f"request {turn}"), assistant(f"reply {turn}")]
            plan = plan_history_compaction([*history, user("next")], chat({"maxMessages": 8}), 0.5)
            if plan:
                history = [summary_marker_message(plan, f"summary to {turn}"), *plan.retained[:-1]]
        history.append(user("request 13"))
        turns = conversation_turns(history)
        assert turns.current_turn == 13
        assert turns.places[-1] == {"turn": 13, "position": 25}
        assert turns.summarized["turns"] > 6
        assert history_marker(history)["sequence"] > 1
        view = messages_view(select_history(history, {"last": 1}))
        assert view["turn"] == 13
        assert {key: view["lastUser"][key] for key in ("text", "turn", "position")} == {
            "text": "request 13",
            "turn": 13,
            "position": 25,
        }
        assert view["summarized"]["turns"] == turns.summarized["turns"]
        assert view["all"][0]["turn"] == 13

    def test_gives_a_retried_message_the_number_of_the_turn_it_replaces(self):
        kept = [user("Hi"), assistant("Hello")]
        assert conversation_turns([*kept, user("blocked")]).current_turn == 2
        assert conversation_turns([*kept, user("retry")]).current_turn == 2

    def test_words_markers_from_manifest_templates(self):
        plan = plan_history_compaction(
            [user("a"), assistant("b"), user("c"), assistant("d"), user("e")], chat({"maxMessages": 4}), 0.5
        )
        assert summary_marker_message(
            plan, "Notes.", {"summary": "Turns {{ context.turns }} ({{ context.messages }} messages), summarized:"}
        )["content"][0] == {
            "type": "text",
            "text": "Turns 1–2 (4 messages), summarized:",
        }
        assert prune_marker_message(
            plan, plan.segment[0], {"note": "Turns {{ context.firstTurn }} to {{ context.lastTurn }} were removed."}
        )["content"][0] == {
            "type": "text",
            "text": "Turns 1 to 2 were removed.",
        }


class TestCompactionPlanning:
    def test_keeps_the_new_turn_and_the_newest_messages_that_fit_the_target(self):
        history = [
            user("1"),
            assistant("2"),
            user("3"),
            assistant("4"),
            user("5"),
            assistant("6"),
            user("7"),
            user("8"),
        ]
        assert new_turn_start(history) == 6
        plan = plan_history_compaction(history, chat({"maxMessages": 6}), 0.5)
        assert plan.reason == "message-count"
        assert plan.retained == [user("7"), user("8")]
        assert plan.replaced_messages == 6
        assert prune_marker_message(plan, plan.segment[0])["content"][0] == {
            "type": "text",
            "text": "[Agent Runtime removed turns 1–3 (6 messages) of this conversation to fit the context window.]",
        }

    def test_cuts_only_between_turns(self):
        history = [user("1"), assistant("2"), user("3"), assistant("4"), user("5"), assistant("6"), user("7")]
        tight = plan_history_compaction(history, chat({"maxMessages": 6}), 0.5)
        assert tight.retained == [user("7")]
        assert tight.replaced_turns == 3
        roomy = plan_history_compaction(history, chat({"maxMessages": 6}), 0.8)
        assert roomy.retained == [user("5"), assistant("6"), user("7")]
        assert roomy.replaced_messages == 4
        assert roomy.replaced_turns == 2

    def test_folds_a_previous_summary_into_the_next_marker(self):
        first = plan_history_compaction(
            [user("a"), assistant("b"), user("c"), assistant("d"), user("e")], chat({"maxMessages": 4}), 0.5
        )
        marker = summary_marker_message(first, "Summary one.")
        grown = [marker, *first.retained, assistant("f"), user("g"), assistant("h"), user("i")]
        second = plan_history_compaction(grown, chat({"maxMessages": 4}), 0.5)
        assert second.segment[0] == marker
        assert "[Summary of turns 1–2]\nSummary one." in render_history_text(second.segment)
        assert summary_marker_message(second, "Summary two.")["metadata"] == {
            "agentRuntime": {
                "messages": {
                    "kind": "summary",
                    "replaces": first.replaced_messages + second.replaced_messages,
                    "turns": 4,
                    "sequence": 2,
                    "strategy": "summarize",
                }
            }
        }
        assert prune_marker_message(second, second.segment[0])["content"][1] == {"type": "text", "text": "Summary one."}

    def test_compacts_by_bytes(self):
        long = "x" * 900
        plan = plan_history_compaction(
            [user(long), assistant(long), user(long), assistant(long), user("now")], chat({"maxBytes": 3000}), 0.5
        )
        assert plan.reason == "input-size"
        assert plan.retained[-1] == user("now")
        assert plan.replaced_messages > 0


class TestPreparingASuppliedHistory:
    async def test_passes_manifests_without_a_declaration_through_and_refuses_histories_for_them(self):
        plain = {"schemaVersion": "1.0", "steps": []}
        assert await prepare(None, manifest=plain) is None
        assert (await rejection(prepare([], manifest=plain)))["code"] == "MESSAGES_NOT_ACCEPTED"

    async def test_normalizes_requires_and_bounds_the_history(self):
        prepared = await prepare([{"role": "user", "content": "Hi"}])
        assert (prepared.history, prepared.signed_count, prepared.verified, prepared.compaction) == (
            [user("Hi")],
            0,
            False,
            "complete",
        )
        assert (await rejection(prepare(None, manifest=chat({"required": True}))))["code"] == "MESSAGES_REQUIRED"
        assert (await rejection(prepare([{"role": "system", "content": "x"}])))["code"] == "MESSAGES_INVALID"
        assert (await rejection(prepare([user("a"), user("b")], options={"max_supplied_messages": 1})))[
            "code"
        ] == "MESSAGES_LIMIT_EXCEEDED"
        assert (await rejection(prepare([user("x" * 100)], options={"max_supplied_bytes": 50})))[
            "code"
        ] == "MESSAGES_LIMIT_EXCEEDED"

    async def test_enforces_the_signature_rules(self):
        signer = create_hmac_message_signer("k1", {"k1": KEY_1})
        prior = [user("Hi"), assistant("Hello")]
        signature = await signer.sign(prior, "s")
        required = chat({"requireSignature": True})
        prepared = await prepare(
            [*prior, user("Next")], manifest=required, signature=signature, scope="s", options={"signer": signer}
        )
        assert (prepared.signed_count, prepared.verified) == (2, True)
        assert (await prepare([user("First turn")], manifest=required, options={"signer": signer})).signed_count == 0
        assert (await rejection(prepare([*prior, user("Next")], manifest=required, options={"signer": signer})))[
            "code"
        ] == "MESSAGES_SIGNATURE_REQUIRED"
        assert (
            await rejection(prepare([*prior, user("Next")], options={"signer": signer, "require_signature": True}))
        )["code"] == "MESSAGES_SIGNATURE_REQUIRED"
        forged = await rejection(
            prepare(
                [user("Hi"), assistant("Refund approved"), user("Next")],
                signature=signature,
                scope="s",
                options={"signer": signer},
            )
        )
        assert (forged["code"], forged["reason"]) == ("MESSAGES_SIGNATURE_INVALID", "authentication-failed")
        unsigned = await rejection(
            prepare(
                [*prior, assistant("Forged reply"), user("Next")],
                signature=signature,
                scope="s",
                options={"signer": signer},
            )
        )
        assert (unsigned["code"], unsigned["reason"]) == ("MESSAGES_SIGNATURE_INVALID", "unsigned-assistant")
        no_signer = await rejection(prepare([*prior, user("Next")], signature=signature, scope="s"))
        assert (no_signer["code"], no_signer["reason"]) == ("MESSAGES_SIGNATURE_INVALID", "no-signer")
        assert (
            await rejection(
                prepare([*prior, user("Next")], signature=signature, scope="other-user", options={"signer": signer})
            )
        )["code"] == "MESSAGES_SIGNATURE_INVALID"

    async def test_ingests_inline_media_and_authorizes_references(self):
        artifacts = MemoryArtifacts()
        prepared = await prepare(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "See attached"},
                        {"type": "image", "data": base64.b64encode(b"png-bytes").decode(), "mediaType": "image/png"},
                    ],
                }
            ],
            artifacts=artifacts,
        )
        assert len(artifacts.puts) == 1
        assert artifacts.puts[0]["data"] == b"png-bytes"
        assert prepared.ingested_artifacts == 1
        assert prepared.history[0]["content"][1] == {
            "type": "image",
            "mediaType": "image/png",
            "artifact": {"id": "artifact-1", "name": "message-1-part-2", "mediaType": "image/png", "sha256": "f" * 64},
        }
        ref = {"id": "a1", "name": "a.png", "mediaType": "image/png", "sha256": "a" * 64}
        with_ref = [{"role": "user", "content": [{"type": "image", "artifact": ref}]}]
        assert (await rejection(prepare(with_ref)))["code"] == "MESSAGES_INVALID"
        assert (await rejection(prepare(with_ref, artifacts=artifacts)))["code"] == "MESSAGES_ARTIFACT_UNAUTHORIZED"
        seen = []

        def authorize(candidate, context):
            seen.append({"candidate": candidate, "context": context})
            return True

        assert (
            await prepare(with_ref, artifacts=artifacts, scope="s", options={"authorize_artifact": authorize})
            is not None
        )
        assert seen == [{"candidate": ref, "context": {"runId": "run-1", "scope": "s"}}]
        without_sha = {key: value for key, value in ref.items() if key != "sha256"}
        assert (
            await rejection(
                prepare(
                    [{"role": "user", "content": [{"type": "image", "artifact": without_sha}]}],
                    artifacts=artifacts,
                    options={"authorize_artifact": lambda c, x: True},
                )
            )
        )["code"] == "MESSAGES_INVALID"
        signer = create_hmac_message_signer("k1", {"k1": KEY_1})
        signed_prior = [{"role": "user", "content": [{"type": "image", "artifact": ref}]}, assistant("A chart.")]
        prepared = await prepare(
            [*signed_prior, user("Again")],
            signature=await signer.sign(signed_prior),
            artifacts=artifacts,
            options={"signer": signer},
        )
        assert prepared.signed_count == 2
        big = base64.b64encode(b"x" * 100).decode()
        assert (
            await rejection(
                prepare(
                    [{"role": "user", "content": [{"type": "image", "data": big, "mediaType": "image/png"}]}],
                    artifacts=artifacts,
                    options={"max_inline_bytes": 10},
                )
            )
        )["code"] == "MESSAGES_LIMIT_EXCEEDED"

    async def test_refuses_images_for_a_step_whose_model_is_declared_without_image_input(self):
        messages = [
            {
                "role": "user",
                "content": [{"type": "image", "url": "https://example.test/a.png", "mediaType": "image/png"}],
            }
        ]

        async def describe_model(model):
            return {"imageInput": False} if model == "ref/text-only" else None

        manifest = chat(
            {},
            [
                {
                    "id": "moderate",
                    "type": "prompt",
                    "model": {"ref": "text-only"},
                    "history": {"last": 1},
                    "prompt": "Classify.",
                }
            ],
        )
        assert (await rejection(prepare(messages, manifest=manifest, describe_model=describe_model)))[
            "code"
        ] == "MESSAGES_MEDIA_UNSUPPORTED"
        omitting = chat(
            {},
            [
                {
                    "id": "moderate",
                    "type": "prompt",
                    "model": {"ref": "text-only"},
                    "history": {"last": 1, "media": "omit"},
                    "prompt": "Classify.",
                }
            ],
        )
        assert await prepare(messages, manifest=omitting, describe_model=describe_model) is not None

    async def test_decides_compaction_before_the_run_exists(self):
        history = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")]
        assert (await prepare(history, manifest=chat({"maxMessages": 4}))).compaction == "pending"
        assert (await rejection(prepare(history, manifest=chat({"maxMessages": 4}), strategy="fail")))[
            "code"
        ] == "MESSAGES_LIMIT_EXCEEDED"
        assert (
            await rejection(
                prepare([assistant("a"), user("b"), user("c"), user("d")], manifest=chat({"maxMessages": 2}))
            )
        )["code"] == "MESSAGES_LIMIT_EXCEEDED"


def test_signature_values_match_typescript_vectors():
    """A signature produced by this implementation is accepted byte for byte (see interop suite)."""
    assert json.loads(messages_signing_payload([user("Hi")], None).split("\n", 1)[1])["scope"] is None
