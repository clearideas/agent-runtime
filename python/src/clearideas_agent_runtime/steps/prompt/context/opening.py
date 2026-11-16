"""The step's opening prompt as templates with variable slots (``context/opening.ts``).

Messages are rendered from the templates, so replacing a slot's text (a
reduction) changes only that variable's interpolation. Conversation history
inserted by the step's ``history`` setting is literal: never a template.
"""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ....core.messages import media_placeholder
from .template import CompiledTemplate, compile_template, render_template, render_template_outline

JsonObject = dict[str, Any]

CONVERSATION_TASK = "Continue the conversation."


@dataclass
class OpeningHistory:
    """Conversation turns inserted into the opening prompt."""

    messages: list[JsonObject]
    turns: list[int | None]
    dropped: int = 0
    replacement: str | None = None


@dataclass
class OpeningPrompt:
    templates: list[CompiledTemplate]
    history: OpeningHistory | None
    render: Callable[[], list[JsonObject]] = field(repr=False)
    outline: Callable[[], str] = field(repr=False)


def _model_readable(part: JsonObject) -> bool:
    if part["type"] == "image":
        return True
    media_type = part.get("mediaType") or (part.get("artifact") or {}).get("mediaType")
    return media_type is not None and (media_type.startswith("image/") or media_type == "application/pdf")


def history_model_messages(messages: list[JsonObject]) -> list[JsonObject]:
    """Inserted history as model messages; runtime marker metadata stays internal."""
    return [
        {
            "role": message["role"],
            "content": [
                {"type": "text", "text": media_placeholder(part)}
                if part["type"] in ("image", "file") and not _model_readable(part)
                else copy.deepcopy(part)
                for part in message["content"]
            ],
        }
        for message in messages
    ]


def _render_history(history: OpeningHistory | None) -> list[JsonObject]:
    if history is None:
        return []
    rendered: list[JsonObject] = []
    if history.replacement:
        rendered.append({"role": "user", "content": [{"type": "text", "text": history.replacement}]})
    rendered.extend(history.messages[history.dropped :])
    return rendered


def _with_history(rendered: list[JsonObject], history: OpeningHistory | None) -> list[JsonObject]:
    """Place inserted history after the leading system messages."""
    if history is None:
        return rendered
    at = next((index for index, message in enumerate(rendered) if message["role"] != "system"), len(rendered))
    return [*rendered[:at], *_render_history(history), *rendered[at:]]


def build_opening_prompt(
    step: JsonObject,
    variables: JsonObject,
    inserted_history: list[JsonObject] | None = None,
    turns: list[int | None] | None = None,
) -> OpeningPrompt:
    turns = turns or []
    history = (
        OpeningHistory(
            messages=history_model_messages(inserted_history),
            turns=[turns[index] if index < len(turns) else None for index in range(len(inserted_history))],
        )
        if inserted_history is not None
        else None
    )
    step_messages = step.get("messages")
    if step_messages is not None:
        by_location: dict[str, CompiledTemplate] = {}
        for message_index, message in enumerate(step_messages):
            for part_index, part in enumerate(message["content"]):
                if part["type"] != "text":
                    continue
                location = f"messages.{message_index}.content.{part_index}"
                by_location[location] = compile_template(location, part["text"], variables)

        def render_messages() -> list[JsonObject]:
            rendered = [
                {
                    **message,
                    "content": [
                        part
                        if part["type"] != "text"
                        else {
                            **part,
                            "text": render_template(by_location[f"messages.{message_index}.content.{part_index}"]),
                        }
                        for part_index, part in enumerate(message["content"])
                    ],
                }
                for message_index, message in enumerate(step_messages)
            ]
            return _with_history(rendered, history)

        def outline_messages() -> str:
            outlines: list[str] = []
            for message_index, message in enumerate(step_messages):
                for part_index, part in enumerate(message["content"]):
                    if message["role"] != "user" or part["type"] != "text":
                        continue
                    template = by_location.get(f"messages.{message_index}.content.{part_index}")
                    if template is not None:
                        outlines.append(render_template_outline(template))
            outline = "\n".join(outlines)
            return outline or (CONVERSATION_TASK if history is not None else "")

        return OpeningPrompt(list(by_location.values()), history, render_messages, outline_messages)

    system_prompt = step.get("systemPrompt")
    system = compile_template("systemPrompt", system_prompt, variables) if system_prompt else None
    # A step that inserts history may have no prompt of its own.
    prompt = (
        compile_template("prompt", step.get("prompt") or "", variables)
        if step.get("prompt") is not None or history is None
        else None
    )

    def render() -> list[JsonObject]:
        rendered: list[JsonObject] = []
        if system is not None:
            rendered.append({"role": "system", "content": [{"type": "text", "text": render_template(system)}]})
        rendered.extend(_render_history(history))
        if prompt is not None:
            rendered.append({"role": "user", "content": [{"type": "text", "text": render_template(prompt)}]})
        return rendered

    def outline() -> str:
        if prompt is not None:
            return render_template_outline(prompt)
        if system is not None:
            return render_template_outline(system)
        return CONVERSATION_TASK

    templates = [template for template in (system, prompt) if template is not None]
    return OpeningPrompt(templates, history, render, outline)
