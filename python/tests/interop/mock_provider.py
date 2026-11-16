"""A local HTTP server that speaks the model APIs both runtimes' adapters use.

It records every request (path and JSON body) under the request's ``x-case``
header and answers with a canned reply in the matching API's format: OpenAI
Responses, Chat Completions (OpenAI-compatible, Groq), Anthropic Messages,
Gemini ``generateContent``, and Cohere v2 chat.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class MockProvider:
    def __init__(self) -> None:
        self.requests: dict[str, list[dict[str, Any]]] = {}
        self.replies: dict[str, Any] = {}
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # silence
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = {"raw": raw.decode("utf-8", "replace")}
                case = self.headers.get("x-case") or "unknown"
                recorded = provider.requests.setdefault(case, [])
                recorded.append({"path": self.path, "body": body})
                reply = provider.replies.get(case.split(":", 1)[-1], {"kind": "text", "text": "Hello"})
                if isinstance(reply, list):
                    # A sequence of replies, per caller (the x-case header): the n-th request gets the n-th.
                    reply = reply[min(len(recorded), len(reply)) - 1]
                status, payload = provider.respond(self.path, body or {}, reply)
                streaming = (
                    isinstance(body, dict) and body.get("stream") is True
                ) or ":streamGenerateContent" in self.path
                if status == 200 and streaming:
                    events = provider.stream_events(self.path, payload)
                    if events is not None:
                        self.send_response(200)
                        self.send_header("content-type", "text/event-stream")
                        self.end_headers()
                        for event, data in events:
                            prefix = f"event: {event}\n" if event else ""
                            self.wfile.write(
                                f"{prefix}data: {data if isinstance(data, str) else json.dumps(data)}\n\n".encode()
                            )
                        self.wfile.flush()
                        return
                if isinstance(payload, bytes):
                    data, content_type = payload, "text/plain"
                else:
                    data, content_type = json.dumps(payload).encode(), "application/json"
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(data)))
                for name, value in (reply.get("headers") or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> MockProvider:
        self.thread.start()
        return self

    def __exit__(self, *args: Any) -> None:
        self.server.shutdown()
        self.server.server_close()

    def respond(self, path: str, body: dict[str, Any], reply: dict[str, Any]) -> tuple[int, Any]:
        if reply.get("status"):
            if "body" in reply:
                body_value = reply["body"]
                return reply["status"], body_value.encode() if isinstance(body_value, str) else body_value
            return reply["status"], {
                "error": {"message": reply.get("message", "error"), "type": "invalid_request_error"}
            }
        kind = reply.get("kind", "text")
        if kind == "body":
            return 200, reply["body"]
        text = reply.get("text", "Hello")
        tool = reply.get("tool", {"name": "lookup", "arguments": {"query": "x"}})
        arguments = json.dumps(tool["arguments"])
        if path.endswith("/responses"):
            output: list[dict[str, Any]] = []
            if kind == "tool":
                output.append(
                    {
                        "type": "function_call",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "name": tool["name"],
                        "arguments": arguments,
                        "status": "completed",
                    }
                )
            else:
                output.append(
                    {
                        "type": "message",
                        "id": "msg_1",
                        "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text, "annotations": []}],
                    }
                )
            return 200, {
                "id": "resp_1",
                "object": "response",
                "created_at": 1767225600,
                "status": "completed",
                "model": body.get("model", "m"),
                "output": output,
                "parallel_tool_calls": True,
                "tool_choice": "auto",
                "tools": [],
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 15,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0},
                },
            }
        if path.endswith("/chat/completions"):
            message: dict[str, Any] = {"role": "assistant", "content": None if kind == "tool" else text}
            if kind == "tool":
                message["tool_calls"] = [
                    {"id": "call_1", "type": "function", "function": {"name": tool["name"], "arguments": arguments}}
                ]
            return 200, {
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "created": 1767225600,
                "model": body.get("model", "m"),
                "choices": [
                    {"index": 0, "message": message, "finish_reason": "tool_calls" if kind == "tool" else "stop"}
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }
        if path.endswith("/messages"):
            content: list[dict[str, Any]] = (
                [{"type": "tool_use", "id": "toolu_1", "name": tool["name"], "input": tool["arguments"]}]
                if kind == "tool"
                else [{"type": "text", "text": text}]
            )
            return 200, {
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": body.get("model", "m"),
                "content": content,
                "stop_reason": "tool_use" if kind == "tool" else "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 5},
            }
        if ":generateContent" in path or ":streamGenerateContent" in path:
            part = (
                {"functionCall": {"name": tool["name"], "args": tool["arguments"]}}
                if kind == "tool"
                else {"text": text}
            )
            return 200, {
                "candidates": [{"content": {"role": "model", "parts": [part]}, "finishReason": "STOP", "index": 0}],
                "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15},
                "modelVersion": "m",
                "responseId": "g_1",
            }
        if path.endswith("/chat"):
            message = {"role": "assistant", "content": [{"type": "text", "text": text}]}
            if kind == "tool":
                message = {
                    "role": "assistant",
                    "tool_calls": [
                        {"id": "call_1", "type": "function", "function": {"name": tool["name"], "arguments": arguments}}
                    ],
                }
            return 200, {
                "id": "c_1",
                "finish_reason": "TOOL_CALL" if kind == "tool" else "COMPLETE",
                "message": message,
                "usage": {
                    "billed_units": {"input_tokens": 10, "output_tokens": 5},
                    "tokens": {"input_tokens": 10, "output_tokens": 5},
                },
            }
        return 404, {"error": {"message": f"unknown path {path}"}}

    def stream_events(self, path: str, payload: Any) -> list[tuple[str | None, Any]] | None:
        """The JSON reply as the API's server-sent events."""
        if path.endswith("/messages"):
            return _anthropic_events(payload)
        if path.endswith("/chat/completions"):
            return _chat_events(payload, groq="/openai/v1/" in path)
        if path.endswith("/responses"):
            return _responses_events(payload)
        if ":streamGenerateContent" in path:
            return _gemini_events(payload)
        if path.endswith("/chat"):
            return _cohere_events(payload)
        return None


def _responses_events(payload: dict[str, Any]) -> list[tuple[str | None, Any]]:
    """A Responses API body as the events the API streams."""
    events: list[tuple[str | None, Any]] = []
    sequence = 0

    def emit(kind: str, **fields: Any) -> None:
        nonlocal sequence
        events.append((kind, {"type": kind, "sequence_number": sequence, **fields}))
        sequence += 1

    emit("response.created", response={**payload, "status": "in_progress", "output": [], "usage": None})
    for index, item in enumerate(payload["output"]):
        added = {**item, "status": "in_progress"}
        if item["type"] == "message":
            added["content"] = []
        if item["type"] == "function_call":
            added["arguments"] = ""
        if item["type"] == "reasoning":
            added["summary"] = []
        emit("response.output_item.added", output_index=index, item=added)
        if item["type"] == "reasoning":
            for summary_index, summary in enumerate(item.get("summary") or []):
                emit(
                    "response.reasoning_summary_part.added",
                    item_id=item["id"],
                    output_index=index,
                    summary_index=summary_index,
                    part={"type": "summary_text", "text": ""},
                )
                emit(
                    "response.reasoning_summary_text.delta",
                    item_id=item["id"],
                    output_index=index,
                    summary_index=summary_index,
                    delta=summary["text"],
                )
                emit(
                    "response.reasoning_summary_text.done",
                    item_id=item["id"],
                    output_index=index,
                    summary_index=summary_index,
                    text=summary["text"],
                )
                emit(
                    "response.reasoning_summary_part.done",
                    item_id=item["id"],
                    output_index=index,
                    summary_index=summary_index,
                    part=summary,
                )
        elif item["type"] == "message":
            for content_index, part in enumerate(item["content"]):
                empty = (
                    {"type": part["type"], "annotations": []}
                    if part["type"] == "output_text"
                    else {"type": part["type"]}
                )
                empty["text" if part["type"] == "output_text" else "refusal"] = ""
                emit(
                    "response.content_part.added",
                    item_id=item["id"],
                    output_index=index,
                    content_index=content_index,
                    part=empty,
                )
                if part["type"] == "output_text":
                    for word in _pieces(part["text"]):
                        emit(
                            "response.output_text.delta",
                            item_id=item["id"],
                            output_index=index,
                            content_index=content_index,
                            delta=word,
                            logprobs=part.get("logprobs") or [],
                        )
                    emit(
                        "response.output_text.done",
                        item_id=item["id"],
                        output_index=index,
                        content_index=content_index,
                        text=part["text"],
                        logprobs=part.get("logprobs") or [],
                    )
                else:
                    emit(
                        "response.refusal.delta",
                        item_id=item["id"],
                        output_index=index,
                        content_index=content_index,
                        delta=part["refusal"],
                    )
                    emit(
                        "response.refusal.done",
                        item_id=item["id"],
                        output_index=index,
                        content_index=content_index,
                        refusal=part["refusal"],
                    )
                emit(
                    "response.content_part.done",
                    item_id=item["id"],
                    output_index=index,
                    content_index=content_index,
                    part=part,
                )
        elif item["type"] == "function_call":
            for piece in _pieces(item["arguments"]):
                emit("response.function_call_arguments.delta", item_id=item["id"], output_index=index, delta=piece)
            emit(
                "response.function_call_arguments.done",
                item_id=item["id"],
                output_index=index,
                arguments=item["arguments"],
            )
        emit("response.output_item.done", output_index=index, item=item)
    final = "response.incomplete" if payload.get("status") == "incomplete" else "response.completed"
    emit(final, response=payload)
    return events


def _pieces(text: str) -> list[str]:
    """A string split into two deltas (one when short)."""
    if len(text) < 2:
        return [text] if text else []
    middle = len(text) // 2
    return [text[:middle], text[middle:]]


def _anthropic_events(payload: dict[str, Any]) -> list[tuple[str | None, Any]]:
    """A Messages API body as the events the API streams."""
    usage = payload.get("usage") or {}
    start_usage = {key: value for key, value in usage.items() if key != "output_tokens"}
    start_usage["output_tokens"] = 1
    message = {**payload, "content": [], "stop_reason": None, "stop_sequence": None, "usage": start_usage}
    events: list[tuple[str | None, Any]] = [("message_start", {"type": "message_start", "message": message})]

    def event(kind: str, **fields: Any) -> None:
        events.append((kind, {"type": kind, **fields}))

    for index, block in enumerate(payload["content"]):
        kind = block["type"]
        if kind == "text":
            event("content_block_start", index=index, content_block={"type": "text", "text": ""})
            for piece in _pieces(block["text"]):
                event("content_block_delta", index=index, delta={"type": "text_delta", "text": piece})
        elif kind == "thinking":
            event(
                "content_block_start", index=index, content_block={"type": "thinking", "thinking": "", "signature": ""}
            )
            for piece in _pieces(block["thinking"]):
                event("content_block_delta", index=index, delta={"type": "thinking_delta", "thinking": piece})
            event(
                "content_block_delta", index=index, delta={"type": "signature_delta", "signature": block["signature"]}
            )
        elif kind == "redacted_thinking":
            event("content_block_start", index=index, content_block=block)
        else:
            event("content_block_start", index=index, content_block={**block, "input": {}})
            for piece in _pieces(json.dumps(block["input"])):
                event("content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": piece})
        event("content_block_stop", index=index)
    delta_usage = {"output_tokens": usage.get("output_tokens", 5)}
    for key in ("output_tokens_details", "x_extra"):
        if key in usage:
            delta_usage[key] = usage[key]
    event(
        "message_delta",
        delta={"stop_reason": payload["stop_reason"], "stop_sequence": payload.get("stop_sequence")},
        usage=delta_usage,
    )
    event("message_stop")
    return events


def _gemini_events(payload: dict[str, Any]) -> list[tuple[str | None, Any]]:
    """A ``generateContent`` body as ``streamGenerateContent?alt=sse`` chunks: one part per chunk."""
    candidate = (payload.get("candidates") or [{}])[0]
    parts = (candidate.get("content") or {}).get("parts") or []
    base = {key: value for key, value in payload.items() if key not in ("candidates", "usageMetadata")}
    usage = payload.get("usageMetadata") or {}
    partial_usage = {key: value for key, value in usage.items() if key == "promptTokenCount"}
    events: list[tuple[str | None, Any]] = []
    for index, part in enumerate(parts):
        chunk_candidate: dict[str, Any] = {"content": {"role": "model", "parts": [part]}, "index": 0}
        last = index == len(parts) - 1
        if last:
            chunk_candidate.update({key: value for key, value in candidate.items() if key not in ("content", "index")})
        events.append(
            (None, {"candidates": [chunk_candidate], "usageMetadata": usage if last else partial_usage, **base})
        )
    if not parts:
        events.append((None, {"candidates": [candidate], "usageMetadata": usage, **base}))
    return events


def _chat_events(payload: dict[str, Any], groq: bool) -> list[tuple[str | None, Any]]:
    """A Chat Completions body as streamed chunks (reasoning, content, and tool-call deltas)."""
    choice = payload["choices"][0]
    message = choice["message"]
    base = {key: payload[key] for key in ("id", "created", "model") if key in payload}
    base["object"] = "chat.completion.chunk"
    events: list[tuple[str | None, Any]] = []

    def chunk(delta: dict[str, Any], **fields: Any) -> None:
        events.append((None, {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}], **fields}))

    chunk({"role": "assistant", "content": ""})
    for key in ("reasoning", "reasoning_content"):
        for piece in _pieces(message.get(key) or ""):
            chunk({key: piece})
    for piece in _pieces(message.get("content") or ""):
        chunk({"content": piece})
    for index, call in enumerate(message.get("tool_calls") or []):
        chunk(
            {
                "tool_calls": [
                    {
                        "index": index,
                        "id": call["id"],
                        "type": "function",
                        "function": {"name": call["function"]["name"], "arguments": ""},
                    }
                ]
            }
        )
        for piece in _pieces(call["function"]["arguments"]):
            chunk({"tool_calls": [{"index": index, "function": {"arguments": piece}}]})
    final: dict[str, Any] = {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}]}
    if groq:
        final["x_groq"] = {"id": "req_1", "usage": payload.get("usage")}
    else:
        final["usage"] = payload.get("usage")
    events.append((None, final))
    events.append((None, "[DONE]"))
    return events


def _cohere_events(payload: dict[str, Any]) -> list[tuple[str | None, Any]]:
    """A Cohere v2 chat body as its streamed events."""
    message = payload.get("message") or {}
    events: list[tuple[str | None, Any]] = []

    def event(kind: str, **fields: Any) -> None:
        events.append((kind, {"type": kind, **fields}))

    event(
        "message-start",
        id=payload.get("id"),
        delta={"message": {"role": "assistant", "content": [], "tool_plan": "", "tool_calls": [], "citations": []}},
    )
    for index, item in enumerate(message.get("content") or []):
        key = "thinking" if item["type"] == "thinking" else "text"
        event("content-start", index=index, delta={"message": {"content": {"type": item["type"], key: ""}}})
        for piece in _pieces(item[key]):
            event("content-delta", index=index, delta={"message": {"content": {key: piece}}})
        event("content-end", index=index)
    if message.get("tool_plan"):
        event("tool-plan-delta", delta={"message": {"tool_plan": message["tool_plan"]}})
    for index, call in enumerate(message.get("tool_calls") or []):
        event(
            "tool-call-start",
            index=index,
            delta={
                "message": {
                    "tool_calls": {
                        "id": call["id"],
                        "type": "function",
                        "function": {"name": call["function"]["name"], "arguments": ""},
                    }
                }
            },
        )
        for piece in _pieces(call["function"]["arguments"]):
            event("tool-call-delta", index=index, delta={"message": {"tool_calls": {"function": {"arguments": piece}}}})
        event("tool-call-end", index=index)
    event("message-end", delta={"finish_reason": payload.get("finish_reason"), "usage": payload.get("usage")})
    return events
