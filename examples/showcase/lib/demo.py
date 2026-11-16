"""
The small contract every showcase demo implements (``lib/demo.ts``).
server.py turns it into HTTP routes; each demo's host.py is the part worth
reading.

Messages streamed to the browser are plain dictionaries with the same keys as
the TypeScript ``ShowcaseMessage`` union:

    accepted              {kind, runId, mode, sandbox, resumed?}
    event                 {kind, event}  — an Agent Runtime event, unchanged
    tool-io               {kind, stepId, toolCallId, name, input, output? | error?, artifacts?}
    preflight             {kind, title, outcome, label, detail, removedTool?}
    engine                {kind, engine, providerData?}
    canary                {kind, hit, url, path?}
    model-input           {kind, stepId, purpose, bytes, limit, segments}
    summarizer            {kind, stepId, summaryKind, label, inputBytes, targetBytes, outputBytes}
    conversation          {kind, conversationId, scope, messages, signature, moderation?, artifacts?, files?}
    conversation-rejected {kind, code, reason?, message}
    result                {kind, result}
    error                 {kind, error: {message, cancelled}}
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict
from urllib.parse import parse_qsl

from clearideas_agent_runtime import AbortSignal

JsonValue = Any
ShowcaseMessage = dict[str, Any]
Emit = Callable[[ShowcaseMessage], None]
ModelMode = Literal["scripted", "live"]


@dataclass
class DemoRunRequest:
    mode: ModelMode
    #: Pace multiplier for the scripted model; 0 in tests.
    pace: float
    #: Demo-specific options from the browser, validated by the demo.
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class DemoContext:
    environment: dict[str, Any]
    #: Private, writable directory for this demo's stores and workspaces.
    data_directory: str
    #: This server's base URL, e.g. for worker callbacks.
    server_url: Callable[[], str]
    #: Tests only: a model to use in Live mode instead of the configured
    #: provider, so the live code path runs without a real provider.
    live_model: Callable[[], Any] | None = None


@dataclass
class RequestUrl:
    """The parts of a request URL the demos read (``URL`` in server.ts)."""

    pathname: str
    query: str = ""

    def param(self, name: str) -> str | None:
        """``url.searchParams.get(name)``: the first value, or None."""
        return next((value for key, value in parse_qsl(self.query, keep_blank_values=True) if key == name), None)


class SourceFile(TypedDict):
    #: Tab label and path relative to the showcase directory.
    path: str
    language: Literal["yaml", "typescript", "python", "plaintext"]
    #: One sentence explaining why this file matters.
    caption: str


class ShowcaseDemo:
    """A demo. Subclasses set the class attributes and implement ``describe``
    and ``run``; the optional hooks below are looked up with ``getattr``:

    - ``async state(context, url) -> JsonValue``: live host-side state.
    - ``async reset(context) -> None``
    - ``async route(context, request, url) -> Response | None``: extra HTTP
      routes (e.g. worker callbacks); return a response when handled.
    - ``async close() -> None``: release resources when the server stops.
    - ``async artifact(context, artifact_id) -> (media_type, bytes) | None``
    - ``async resume(context, run_id, request, emit, signal) -> None``
    """

    id: str
    title: str
    #: One short sentence for the gallery card.
    summary: str
    tagline: str
    features: list[str]
    #: Source files shown under "How it's built".
    sources: list[SourceFile]
    #: Set when the installed Agent Runtime cannot run this demo.
    unavailable: str | None = None
    #: Largest run request body; defaults to 256 KiB.
    max_request_bytes: int | None = None

    async def describe(self, context: DemoContext) -> JsonValue:
        raise NotImplementedError

    async def run(self, context: DemoContext, request: DemoRunRequest, emit: Emit, signal: AbortSignal) -> None:
        raise NotImplementedError
