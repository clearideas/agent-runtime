"""Prompt templates compiled into literal text and variable slots (``context/template.ts``)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ...._js import json as js_json
from ...._js import ops as js_ops
from ...._js import strings as js_strings
from ....core.templates import TEMPLATE_PATTERN, get_nested_value


def template_value_text(value: Any) -> str:
    """Same stringification as ``compile_prompt_template``."""
    if value is None or value is js_ops.UNDEFINED:
        return ""
    if isinstance(value, (dict, list)):
        return js_json.stringify(value)
    return js_ops.to_string(value)


@dataclass
class TemplateSlot:
    path: str
    value: Any
    original_text: str
    text: str


@dataclass
class TemplateSegment:
    literal: str | None = None
    slot: TemplateSlot | None = None


@dataclass
class CompiledTemplate:
    location: str
    segments: list[TemplateSegment] = field(default_factory=list)


def compile_template(location: str, template: str, variables: dict[str, Any]) -> CompiledTemplate:
    segments: list[TemplateSegment] = []
    cursor = 0
    for match in TEMPLATE_PATTERN.finditer(template):
        index = match.start()
        if index > cursor:
            segments.append(TemplateSegment(literal=template[cursor:index]))
        path = js_strings.trim(match.group(1) or "")
        value = get_nested_value(variables, path)
        text = template_value_text(value)
        segments.append(TemplateSegment(slot=TemplateSlot(path, value, text, text)))
        cursor = match.end()
    if cursor < len(template):
        segments.append(TemplateSegment(literal=template[cursor:]))
    return CompiledTemplate(location, segments)


def render_template(template: CompiledTemplate) -> str:
    return "".join(
        segment.literal if segment.slot is None else segment.slot.text  # type: ignore[misc]
        for segment in template.segments
    )


def render_template_outline(template: CompiledTemplate) -> str:
    """The template text with each slot shown as its ``{{ path }}`` placeholder."""
    return "".join(
        segment.literal if segment.slot is None else f"{{{{ {segment.slot.path} }}}}"  # type: ignore[misc]
        for segment in template.segments
    )


@dataclass
class SlotEntry:
    template: CompiledTemplate
    index: int
    slot: TemplateSlot


def template_slots(templates: list[CompiledTemplate]) -> list[SlotEntry]:
    return [
        SlotEntry(template, index, segment.slot)
        for template in templates
        for index, segment in enumerate(template.segments)
        if segment.slot is not None
    ]
