"""Cases for the provider-wire parity test (shared by the test and diagnostics)."""

from __future__ import annotations

from typing import Any

PATHS = {
    "openai": "/v1",
    "anthropic": "/v1",
    "google": "/v1beta",
    "xai": "/v1",
    "groq": "/openai/v1",
    "cohere": "/v2",
    "openai-compatible": "/v1",
}
DRIVERS = list(PATHS)
MODELS = {
    "openai": "gpt-5-mini",
    "anthropic": "claude-sonnet-4-6",
    "google": "gemini-2.5-flash",
    "xai": "grok-4",
    "groq": "openai/gpt-oss-20b",
    "cohere": "command-a-03-2025",
    "openai-compatible": "llama3",
}

LOOKUP = {
    "name": "lookup",
    "description": "Look something up.",
    "inputSchema": {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
        "additionalProperties": False,
    },
}
SCHEMA = {
    "type": "object",
    "properties": {"status": {"type": "string"}},
    "required": ["status"],
    "additionalProperties": False,
}
PROVIDER_OPTIONS = {
    "openai": {"openai": {"reasoningEffort": "low", "parallelToolCalls": False}},
    "anthropic": {"anthropic": {"thinking": {"type": "enabled", "budgetTokens": 1024}}},
    "google": {"google": {"thinkingConfig": {"thinkingBudget": 512, "includeThoughts": True}}},
    "xai": {"xai": {"reasoningEffort": "low"}},
    "groq": {"groq": {"reasoningFormat": "parsed", "parallelToolCalls": False}},
    "cohere": {},
    "openai-compatible": {"local": {"top_k": 5}},
}


def system_user(text: str = "Hi") -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": [{"type": "text", "text": "Be brief."}]},
        {"role": "user", "content": [{"type": "text", "text": text}]},
    ]


HISTORY = [
    {"role": "system", "content": [{"type": "text", "text": "Use tools."}]},
    {"role": "user", "content": [{"type": "text", "text": "Find x"}]},
    {
        "role": "assistant",
        "content": [
            {"type": "text", "text": "Looking."},
            {"type": "tool-call", "call": {"id": "call_0", "name": "lookup", "input": {"query": "x"}}},
        ],
    },
    {
        "role": "tool",
        "content": [
            {"type": "tool-result", "result": {"callId": "call_0", "name": "lookup", "output": {"found": True}}}
        ],
    },
    {"role": "user", "content": [{"type": "text", "text": "And y?"}]},
]


TOOL_ERROR_HISTORY = [
    {"role": "user", "content": [{"type": "text", "text": "Find x"}]},
    {
        "role": "assistant",
        "content": [
            {"type": "text", "text": ""},
            {"type": "tool-call", "call": {"id": "call_0", "name": "lookup", "input": {"query": "x"}}},
        ],
    },
    {
        "role": "tool",
        "content": [
            {
                "type": "tool-result",
                "result": {
                    "callId": "call_0",
                    "name": "lookup",
                    "error": {"code": "tool_failed", "message": "Index offline"},
                },
            }
        ],
    },
]

ASSISTANT_PARTS_HISTORY = [
    {"role": "user", "content": [{"type": "text", "text": "Find x and y"}]},
    {
        "role": "assistant",
        "content": [
            {"type": "reasoning", "text": "Two lookups."},
            {"type": "text", "text": "First x."},
            {"type": "tool-call", "call": {"id": "call_0", "name": "lookup", "input": {"query": "x"}}},
            {"type": "text", "text": "Then y."},
            {"type": "tool-call", "call": {"id": "call_1", "name": "lookup", "input": {"query": "y"}}},
        ],
    },
    {
        "role": "tool",
        "content": [
            {"type": "tool-result", "result": {"callId": "call_0", "name": "lookup", "output": "x is 1"}},
            {"type": "tool-result", "result": {"callId": "call_1", "name": "lookup", "output": None}},
        ],
    },
    {"role": "assistant", "content": [{"type": "text", "text": "Found"}, {"type": "text", "text": " both."}]},
    {"role": "user", "content": [{"type": "text", "text": "Thanks"}]},
]

REASONING_HISTORY = [
    {"role": "user", "content": [{"type": "text", "text": "Think"}]},
    {
        "role": "assistant",
        "content": [{"type": "reasoning", "text": "Considering."}, {"type": "text", "text": "Thought."}],
    },
    {"role": "user", "content": [{"type": "text", "text": "Again"}]},
]


#: One case per supported provider option (`option:<label>`): driver → [(label, options, with schema)].
OPTION_CASES: dict[str, list[tuple[str, dict[str, Any], bool]]] = {
    "openai": [
        ("reasoningEffort", {"reasoningEffort": "high"}, False),
        ("reasoningSummary", {"reasoningEffort": "low", "reasoningSummary": "auto"}, False),
        ("reasoningMode", {"reasoningMode": "standard"}, False),
        ("reasoningMode-pro", {"reasoningEffort": "high", "reasoningMode": "pro"}, False),
        ("reasoningContext", {"reasoningContext": "current_turn"}, False),
        ("reasoningContext-all", {"reasoningContext": "all_turns"}, False),
        ("serviceTier", {"serviceTier": "flex"}, False),
        ("parallelToolCalls", {"parallelToolCalls": False}, False),
        ("user", {"user": "user-1"}, False),
        ("store", {"store": False}, False),
        ("textVerbosity", {"textVerbosity": "low"}, False),
        ("promptCacheKey", {"promptCacheKey": "cache-1"}, False),
        ("promptCacheRetention", {"promptCacheRetention": "24h"}, False),
        ("truncation", {"truncation": "auto"}, False),
        ("previousResponseId", {"previousResponseId": "resp_1"}, False),
        ("conversation", {"conversation": "conv_1"}, False),
        ("logprobs", {"logprobs": True}, False),
        ("topLogprobs", {"logprobs": 3}, False),
        ("metadata", {"metadata": {"team": "a"}}, False),
        ("maxToolCalls", {"maxToolCalls": 2}, False),
        ("safetyIdentifier", {"safetyIdentifier": "sid-1"}, False),
        ("include", {"include": ["file_search_call.results"]}, False),
        ("strictJsonSchema", {"strictJsonSchema": False}, True),
    ],
    "anthropic": [
        ("thinking-enabled", {"thinking": {"type": "enabled", "budgetTokens": 2048}}, False),
        ("thinking-disabled", {"thinking": {"type": "disabled"}}, False),
        ("disableParallelToolUse", {"disableParallelToolUse": True}, False),
        ("effort", {"effort": "low"}, False),
        ("serviceTier", {"serviceTier": "auto"}, False),
        ("speed", {"speed": "fast"}, False),
        ("container", {"container": {"id": "container_1"}}, False),
        ("metadata", {"metadata": {"userId": "user-1"}}, False),
        ("cacheControl", {"cacheControl": {"type": "ephemeral"}}, False),
        ("cacheControl-ttl", {"cacheControl": {"type": "ephemeral", "ttl": "1h"}}, False),
        ("sendReasoning", {"sendReasoning": False}, False),
        ("anthropicBeta", {"anthropicBeta": ["context-1m-2025-08-07"]}, False),
    ],
    "google": [
        ("thinkingBudget", {"thinkingConfig": {"thinkingBudget": 0}}, False),
        ("includeThoughts", {"thinkingConfig": {"thinkingBudget": 256, "includeThoughts": True}}, False),
        ("thinkingLevel", {"thinkingConfig": {"thinkingLevel": "low"}}, False),
        (
            "safetySettings",
            {"safetySettings": [{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"}]},
            False,
        ),
        ("cachedContent", {"cachedContent": "cachedContents/abc"}, False),
        ("labels", {"labels": {"team": "a"}}, False),
        ("structuredOutputs", {"structuredOutputs": False}, True),
    ],
    "xai": [
        ("reasoningEffort", {"reasoningEffort": "high"}, False),
        ("parallelToolCalls", {"parallelToolCalls": False}, False),
        ("user", {"user": "user-1"}, False),
        ("store", {"store": False}, False),
        ("previousResponseId", {"previousResponseId": "resp_1"}, False),
        ("include", {"include": ["reasoning.encrypted_content"]}, False),
        ("logprobs", {"logprobs": True}, False),
        ("topLogprobs", {"logprobs": True, "topLogprobs": 2}, False),
        ("topLogprobs-only", {"topLogprobs": 1}, False),
        ("reasoningSummary", {"reasoningEffort": "low", "reasoningSummary": "auto"}, False),
        ("promptCacheKey", {"promptCacheKey": "cache-1"}, False),
        ("serviceTier", {"serviceTier": "priority"}, False),
        ("maxTurns", {"maxTurns": 3}, False),
        ("minP", {"minP": 0.1}, False),
        ("safetyIdentifier", {"safetyIdentifier": "sid-1"}, False),
    ],
    "groq": [
        ("reasoningFormat", {"reasoningFormat": "hidden"}, False),
        ("reasoningEffort", {"reasoningEffort": "low"}, False),
        ("parallelToolCalls", {"parallelToolCalls": False}, False),
        ("user", {"user": "user-1"}, False),
        ("serviceTier", {"serviceTier": "flex"}, False),
        ("structuredOutputs", {"structuredOutputs": False}, True),
        ("strictJsonSchema", {"strictJsonSchema": False}, True),
    ],
    "cohere": [
        ("thinking-enabled", {"thinking": {"type": "enabled"}}, False),
        ("thinking-disabled", {"thinking": {"type": "disabled"}}, False),
        ("thinking-budget", {"thinking": {"type": "enabled", "tokenBudget": 2048}}, False),
    ],
    "openai-compatible": [
        ("user", {"user": "user-1"}, False),
        ("reasoningEffort", {"reasoningEffort": "low"}, False),
        ("textVerbosity", {"textVerbosity": "low"}, False),
        ("strictJsonSchema", {"strictJsonSchema": True}, True),
        ("passthrough", {"top_k": 5, "repetition_penalty": 1.1}, False),
    ],
}


def replay_history(driver: str) -> list[dict[str, Any]]:
    """A prior turn carrying the replay metadata each provider returned (``providerOptions``)."""
    key = "local" if driver == "openai-compatible" else driver
    reasoning: dict[str, Any] = {
        "openai": {"itemId": "rs_1", "reasoningEncryptedContent": "enc-1"},
        "xai": {"itemId": "rs_1", "reasoningEncryptedContent": "enc-1"},
        "anthropic": {"signature": "sig-1"},
        "google": {"thoughtSignature": "c2lnLTE="},
    }.get(driver, {})
    text: dict[str, Any] = {"openai": {"itemId": "msg_1"}, "xai": {"itemId": "msg_1"}}.get(driver, {})
    call: dict[str, Any] = {
        "openai": {"itemId": "fc_1"},
        "xai": {"itemId": "fc_1"},
        "google": {"thoughtSignature": "c2lnLTI="},
    }.get(driver, {})

    def options(values: dict[str, Any]) -> dict[str, Any]:
        return {"providerOptions": {key: values}} if values else {}

    return [
        {"role": "user", "content": [{"type": "text", "text": "Find x"}]},
        {
            "role": "assistant",
            "content": [
                {"type": "reasoning", "text": "Look it up.", **options(reasoning)},
                {"type": "text", "text": "Looking.", **options(text)},
                {
                    "type": "tool-call",
                    "call": {"id": "call_0", "name": "lookup", "input": {"query": "x"}},
                    **options(call),
                },
            ],
        },
        {
            "role": "tool",
            "content": [{"type": "tool-result", "result": {"callId": "call_0", "name": "lookup", "output": 1}}],
        },
    ]


RICH_USAGE = {
    "input_tokens": 20,
    "input_tokens_details": {"cached_tokens": 4, "x_detail": 1},
    "output_tokens": 12,
    "output_tokens_details": {"reasoning_tokens": 6},
    "total_tokens": 32,
    "x_extra": {"nested": True},
}


def _responses_body(output: list[dict[str, Any]], **fields: Any) -> dict[str, Any]:
    return {
        "id": "resp_2",
        "object": "response",
        "created_at": 1767225600,
        "status": "completed",
        "model": "m",
        "output": output,
        "usage": RICH_USAGE,
        **fields,
    }


_REASONING_ITEM = {
    "type": "reasoning",
    "id": "rs_1",
    "status": "completed",
    "summary": [{"type": "summary_text", "text": "Plan A."}, {"type": "summary_text", "text": "Plan B."}],
    "encrypted_content": "enc_1",
}


def _message_item(*parts: dict[str, Any], phase: str | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {"type": "message", "id": "msg_1", "status": "completed", "role": "assistant"}
    if phase is not None:
        item["phase"] = phase
    item["content"] = list(parts)
    return item


def _output_text(text: str, **fields: Any) -> dict[str, Any]:
    return {"type": "output_text", "text": text, "annotations": [], **fields}


def _function_call(call_id: str, name: str, arguments: str, item_id: str = "fc_1") -> dict[str, Any]:
    return {
        "type": "function_call",
        "id": item_id,
        "call_id": call_id,
        "name": name,
        "arguments": arguments,
        "status": "completed",
    }


def rich_cases(driver: str, model: str) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """Replies with reasoning, several text parts, tool calls, and detailed usage (per API)."""
    tools_request = {"model": model, "messages": system_user("Find x"), "tools": [LOOKUP]}
    if driver in ("openai", "xai"):
        return {
            "rich": (
                tools_request,
                {
                    "kind": "body",
                    "body": _responses_body(
                        [
                            _REASONING_ITEM,
                            _message_item(_output_text("Part one"), _output_text(" and two.")),
                            _function_call("call_1", "lookup", '{"query":"x"}'),
                        ],
                        service_tier="default",
                    ),
                },
            ),
            "rich-text": (
                {"model": model, "messages": system_user(), "providerOptions": {driver: {"logprobs": True}}},
                {
                    "kind": "body",
                    "body": _responses_body(
                        [
                            {**_REASONING_ITEM, "summary": []},
                            _message_item(
                                _output_text(
                                    "Answer",
                                    logprobs=[{"token": "Answer", "logprob": -0.1, "bytes": [65], "top_logprobs": []}],
                                ),
                                {"type": "refusal", "refusal": " but no."}
                                if driver == "openai"
                                else _output_text(" and more."),
                                phase="final_answer" if driver == "openai" else None,
                            ),
                        ],
                        status="incomplete",
                        incomplete_details={"reason": "max_output_tokens"},
                    ),
                },
            ),
            "rich-structured": (
                {"model": model, "messages": system_user("Status?"), "outputSchema": SCHEMA},
                {
                    "kind": "body",
                    "body": _responses_body(
                        [_message_item(_output_text('{"status":"ok"}'), phase="final_answer")],
                    ),
                },
            ),
            "invalid-tools": (
                tools_request,
                {
                    "kind": "body",
                    "body": _responses_body(
                        [
                            _function_call("call_1", "lookup", '{"query": '),
                            _function_call("call_2", "missing", "{}", item_id="fc_2"),
                            _function_call("call_3", "lookup", "", item_id="fc_3"),
                        ]
                    ),
                },
            ),
        }
    if driver == "anthropic":
        usage = {
            "input_tokens": 20,
            "cache_creation_input_tokens": 3,
            "cache_read_input_tokens": 4,
            "output_tokens": 12,
            "service_tier": "standard",
            "x_extra": {"nested": True},
        }

        def body(content: list[dict[str, Any]], stop_reason: str, **fields: Any) -> dict[str, Any]:
            return {
                "id": "msg_2",
                "type": "message",
                "role": "assistant",
                "model": "m",
                "content": content,
                "stop_reason": stop_reason,
                "stop_sequence": None,
                "usage": usage,
                **fields,
            }

        thinking = {"type": "thinking", "thinking": "Plan A.", "signature": "sig_1"}
        return {
            "rich": (
                tools_request,
                {
                    "kind": "body",
                    "body": body(
                        [
                            thinking,
                            {"type": "redacted_thinking", "data": "redacted_1"},
                            {"type": "text", "text": "Part one"},
                            {"type": "text", "text": " and two."},
                            {"type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {"query": "x"}},
                        ],
                        "tool_use",
                    ),
                },
            ),
            "rich-text": (
                {"model": model, "messages": system_user()},
                {"kind": "body", "body": body([thinking, {"type": "text", "text": "Answer."}], "max_tokens")},
            ),
            "rich-structured": (
                {"model": model, "messages": system_user("Status?"), "outputSchema": SCHEMA},
                {"kind": "body", "body": body([{"type": "text", "text": '{"status":"ok"}'}], "end_turn")},
            ),
            "rich-json-tool": (
                {
                    "model": "anthropic/claude-3-haiku-20240307",
                    "messages": system_user("Status?"),
                    "outputSchema": SCHEMA,
                },
                {
                    "kind": "body",
                    "body": body(
                        [
                            {"type": "text", "text": "Here it is."},
                            {"type": "tool_use", "id": "toolu_9", "name": "json", "input": {"status": "ok"}},
                        ],
                        "tool_use",
                    ),
                },
            ),
            "invalid-tools": (
                tools_request,
                {
                    "kind": "body",
                    "body": body(
                        [
                            {"type": "tool_use", "id": "toolu_1", "name": "missing", "input": {}},
                            {"type": "tool_use", "id": "toolu_2", "name": "lookup", "input": {"query": 1}},
                        ],
                        "tool_use",
                    ),
                },
            ),
        }
    if driver == "google":
        usage = {
            "promptTokenCount": 20,
            "candidatesTokenCount": 12,
            "totalTokenCount": 38,
            "thoughtsTokenCount": 6,
            "cachedContentTokenCount": 4,
            "promptTokensDetails": [{"modality": "TEXT", "tokenCount": 20, "x_detail": 1}],
            "x_extra": {"nested": True},
        }

        def gemini(parts: list[dict[str, Any]], finish: str, **candidate: Any) -> dict[str, Any]:
            return {
                "candidates": [
                    {"content": {"role": "model", "parts": parts}, "finishReason": finish, "index": 0, **candidate}
                ],
                "usageMetadata": usage,
                "modelVersion": "m",
                "responseId": "g_2",
            }

        return {
            "rich": (
                tools_request,
                {
                    "kind": "body",
                    "body": gemini(
                        [
                            {"text": "Plan A.", "thought": True},
                            {"text": "Part one"},
                            {"text": " and two.", "thoughtSignature": "c2lnMQ=="},
                            {
                                "functionCall": {"name": "lookup", "args": {"query": "x"}},
                                "thoughtSignature": "c2lnMg==",
                            },
                        ],
                        "STOP",
                        safetyRatings=[{"category": "HARM_CATEGORY_HATE_SPEECH", "probability": "NEGLIGIBLE", "x": 1}],
                    ),
                },
            ),
            "rich-text": (
                {"model": model, "messages": system_user()},
                {
                    "kind": "body",
                    "body": gemini(
                        [{"text": "Answer"}, {"text": "", "thoughtSignature": "c2lnMw=="}],
                        "MAX_TOKENS",
                        finishMessage="cut",
                    ),
                },
            ),
            "rich-structured": (
                {"model": model, "messages": system_user("Status?"), "outputSchema": SCHEMA},
                {"kind": "body", "body": gemini([{"text": '{"status":"ok"}'}], "STOP")},
            ),
            "invalid-tools": (
                tools_request,
                {
                    "kind": "body",
                    "body": gemini(
                        [
                            {"functionCall": {"id": "fc_a", "name": "missing", "args": {}}},
                            {"functionCall": {"id": "fc_b", "name": "lookup"}},
                        ],
                        "STOP",
                    ),
                },
            ),
        }
    if driver in ("groq", "openai-compatible"):
        reasoning_key = "reasoning" if driver == "groq" else "reasoning_content"
        usage = {
            "prompt_tokens": 20,
            "completion_tokens": 12,
            "total_tokens": 32,
            "prompt_tokens_details": {"cached_tokens": 4, "x_detail": 1},
            "completion_tokens_details": {"reasoning_tokens": 6, "accepted_prediction_tokens": 2},
            "x_extra": {"nested": True},
        }

        def chat(message: dict[str, Any], finish: str) -> dict[str, Any]:
            return {
                "id": "chatcmpl-2",
                "object": "chat.completion",
                "created": 1767225600,
                "model": "m",
                "choices": [{"index": 0, "message": {"role": "assistant", **message}, "finish_reason": finish}],
                "usage": usage,
            }

        def call(call_id: str, name: str, arguments: str) -> dict[str, Any]:
            return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}

        return {
            "rich": (
                tools_request,
                {
                    "kind": "body",
                    "body": chat(
                        {
                            reasoning_key: "Plan A.",
                            "content": "Part one and two.",
                            "tool_calls": [
                                call("call_1", "lookup", '{"query":"x"}'),
                                call("call_2", "lookup", '{"query":"y"}'),
                            ],
                        },
                        "tool_calls",
                    ),
                },
            ),
            "rich-text": (
                {"model": model, "messages": system_user()},
                {"kind": "body", "body": chat({reasoning_key: "Plan B.", "content": "Answer."}, "length")},
            ),
            "rich-structured": (
                {"model": model, "messages": system_user("Status?"), "outputSchema": SCHEMA},
                {"kind": "body", "body": chat({"content": '{"status":"ok"}'}, "stop")},
            ),
            "invalid-tools": (
                tools_request,
                {
                    "kind": "body",
                    "body": chat(
                        {
                            "content": None,
                            "tool_calls": [call("call_1", "missing", "{}"), call("call_2", "lookup", "{bad")],
                        },
                        "tool_calls",
                    ),
                },
            ),
        }
    if driver == "cohere":
        usage = {
            "billed_units": {"input_tokens": 20, "output_tokens": 12, "x_detail": 1},
            "tokens": {"input_tokens": 24, "output_tokens": 12},
            "cached_tokens": 4,
            "x_extra": {"nested": True},
        }

        def cohere(message: dict[str, Any], finish: str) -> dict[str, Any]:
            return {"id": "c_2", "message": {"role": "assistant", **message}, "finish_reason": finish, "usage": usage}

        def call(call_id: str, name: str, arguments: str) -> dict[str, Any]:
            return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}

        return {
            "rich": (
                tools_request,
                {
                    "kind": "body",
                    "body": cohere(
                        {
                            "content": [{"type": "thinking", "thinking": "Plan A."}],
                            "tool_plan": "I will look it up.",
                            "tool_calls": [call("call_1", "lookup", '{"query": "x"}')],
                        },
                        "TOOL_CALL",
                    ),
                },
            ),
            "rich-text": (
                {"model": model, "messages": system_user()},
                {
                    "kind": "body",
                    "body": cohere(
                        {"content": [{"type": "thinking", "thinking": "Plan B."}, {"type": "text", "text": "Answer."}]},
                        "MAX_TOKENS",
                    ),
                },
            ),
            "rich-structured": (
                {"model": model, "messages": system_user("Status?"), "outputSchema": SCHEMA},
                {
                    "kind": "body",
                    "body": cohere({"content": [{"type": "text", "text": '{"status":"ok"}'}]}, "COMPLETE"),
                },
            ),
            "invalid-tools": (
                tools_request,
                {
                    "kind": "body",
                    "body": cohere(
                        {"tool_calls": [call("call_1", "missing", "null"), call("call_2", "lookup", "{}")]},
                        "TOOL_CALL",
                    ),
                },
            ),
        }
    return {}


def error_body(driver: str, message: str, kind: str = "invalid_request_error", code: int = 400) -> dict[str, Any]:
    """A provider's error response body."""
    if driver == "anthropic":
        return {"type": "error", "error": {"type": kind, "message": message}}
    if driver == "google":
        return {"error": {"code": code, "message": message, "status": "INVALID_ARGUMENT"}}
    if driver == "cohere":
        return {"message": message}
    return {"error": {"message": message, "type": kind}}


def error_cases(driver: str, model: str) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """Failed calls: the error each runtime reports (with the AI SDK's retries)."""
    request = {"model": model, "messages": system_user()}
    immediate = {"retry-after-ms": "0"}
    return {
        "error-400": (request, {"status": 400, "body": error_body(driver, "Invalid request.")}),
        "error-429": (
            request,
            {"status": 429, "body": error_body(driver, "Rate limited.", "rate_limit_error", 429), "headers": immediate},
        ),
        "error-500-empty": (request, {"status": 500, "body": "", "headers": immediate}),
        "error-401-text": (request, {"status": 401, "body": "nope"}),
        "error-403-shape": (request, {"status": 403, "body": {"unexpected": True}}),
    }


def requests_for(driver: str) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """Case name → (ModelRequest, mock reply)."""
    model = f"{driver}/{MODELS[driver]}"
    cases: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
        "text": (
            {"model": model, "messages": system_user(), "maxOutputTokens": 100},
            {"kind": "text", "text": "Hello"},
        ),
        "tool-call": (
            {"model": model, "messages": system_user("Find x"), "tools": [LOOKUP]},
            {"kind": "tool", "tool": {"name": "lookup", "arguments": {"query": "x"}}},
        ),
        "tool-history": ({"model": model, "messages": HISTORY, "tools": [LOOKUP]}, {"kind": "text", "text": "Done."}),
        "tool-choice-none": (
            {"model": model, "messages": system_user(), "tools": [LOOKUP], "toolChoice": "none"},
            {"kind": "text", "text": "Final."},
        ),
        "structured": (
            {"model": model, "messages": system_user("Status?"), "outputSchema": SCHEMA},
            {"kind": "text", "text": '{"status":"ok"}'},
        ),
        "media": (
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Describe"},
                            {"type": "json", "value": {"id": 1}},
                            {"type": "image", "data": "iVBORw0KGgo=", "mediaType": "image/png"},
                        ],
                    }
                ],
            },
            {"kind": "text", "text": "A picture."},
        ),
        "provider-options": (
            {
                "model": model,
                "messages": system_user(),
                "tools": [LOOKUP],
                "providerOptions": PROVIDER_OPTIONS[driver],
                "maxOutputTokens": 2048,
            },
            {"kind": "text", "text": "Hello"},
        ),
        "empty-reply": (
            {"model": model, "messages": system_user()},
            {"kind": "text", "text": ""},
        ),
        "multi-text": (
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "First."},
                            {"type": "text", "text": ""},
                            {"type": "json", "value": {"second": True}},
                        ],
                    }
                ],
            },
            {"kind": "text", "text": "Both."},
        ),
        "tool-choice-required": (
            {"model": model, "messages": system_user("Find x"), "tools": [LOOKUP], "toolChoice": "required"},
            {"kind": "tool", "tool": {"name": "lookup", "arguments": {"query": "x"}}},
        ),
        "tool-choice-auto": (
            {"model": model, "messages": system_user("Find x"), "tools": [LOOKUP], "toolChoice": "auto"},
            {"kind": "text", "text": "No need."},
        ),
        "tool-error-history": (
            {"model": model, "messages": TOOL_ERROR_HISTORY, "tools": [LOOKUP]},
            {"kind": "text", "text": "It failed."},
        ),
        "reasoning-history": (
            {"model": model, "messages": REASONING_HISTORY},
            {"kind": "text", "text": "Again."},
        ),
        "assistant-parts": (
            {"model": model, "messages": ASSISTANT_PARTS_HISTORY, "tools": [LOOKUP]},
            {"kind": "text", "text": "Done."},
        ),
        "replay": (
            {"model": model, "messages": replay_history(driver), "tools": [LOOKUP]},
            {"kind": "text", "text": "x is 1."},
        ),
        "replay-store-false": (
            {
                "model": model,
                "messages": replay_history(driver),
                "tools": [LOOKUP],
                "providerOptions": {driver: {"store": False}} if driver in ("openai", "xai") else {},
            },
            {"kind": "text", "text": "x is 1."},
        ),
        "multi-system": (
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": [{"type": "text", "text": "One."}]},
                    {
                        "role": "system",
                        "content": [{"type": "text", "text": "Two."}, {"type": "text", "text": "Three."}],
                    },
                    {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
                ],
            },
            {"kind": "text", "text": "Hello"},
        ),
        "json-turns": (
            {
                "model": model,
                "messages": [
                    {"role": "user", "content": [{"type": "json", "value": {"ask": [1, "two"]}}]},
                    {"role": "assistant", "content": [{"type": "json", "value": {"answer": None}}]},
                    {"role": "user", "content": [{"type": "text", "text": "More"}]},
                ],
            },
            {"kind": "text", "text": "Done."},
        ),
    }
    cases.update(rich_cases(driver, model))
    cases.update(error_cases(driver, model))
    key = "local" if driver == "openai-compatible" else driver
    for label, options, with_schema in OPTION_CASES[driver]:
        request: dict[str, Any] = {
            "model": model,
            "messages": system_user(),
            "tools": [LOOKUP],
            "providerOptions": {key: options},
            "maxOutputTokens": 4096,
        }
        if with_schema:
            request = {**request, "tools": [], "outputSchema": SCHEMA}
            reply: dict[str, Any] = {"kind": "text", "text": '{"status":"ok"}'}
        else:
            reply = {"kind": "text", "text": "Hello"}
        cases[f"option:{label}"] = (request, reply)
    if driver == "cohere":
        # @ai-sdk/cohere sends non-image files as request documents and image detail from provider options.
        cases["document"] = (
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Summarize"},
                            {
                                "type": "file",
                                "data": "bm90ZXMgYWJvdXQgeA==",
                                "mediaType": "text/plain",
                                "name": "notes.txt",
                            },
                            {"type": "file", "data": "bW9yZQ==", "mediaType": "text/markdown"},
                        ],
                    }
                ],
            },
            {"kind": "text", "text": "Summary."},
        )
        cases["image-detail"] = (
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Describe"},
                            {
                                "type": "image",
                                "data": "iVBORw0KGgo=",
                                "mediaType": "image/png",
                                "providerOptions": {"cohere": {"detail": "high"}},
                            },
                            {"type": "image", "url": "https://example.com/cat.png", "mediaType": "image/png"},
                        ],
                    }
                ],
            },
            {"kind": "text", "text": "Two pictures."},
        )
    return cases
