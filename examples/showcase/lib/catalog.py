"""The showcase gallery, in the order the demos are best explored (``lib/catalog.ts``)."""

from __future__ import annotations

from typing import Any

from .demo import ShowcaseDemo
from .loader import DEMOS_DIRECTORY, load_demo_module

DEMO_ORDER = [
    "repo-mechanic",
    "durable-runs",
    "guardrails",
    "document-library",
    "orchestration",
    "long-investigation",
    "data-chat",
    "document-chat",
]


def _load(folder: str) -> ShowcaseDemo:
    demo = load_demo_module(folder).demo
    if not isinstance(demo, ShowcaseDemo):
        raise TypeError(f"demos/{folder}/host.py must define `demo`, a ShowcaseDemo.")
    return demo


demos: list[ShowcaseDemo] = [_load(folder) for folder in DEMO_ORDER if (DEMOS_DIRECTORY / folder / "host.py").exists()]


def catalog() -> list[dict[str, Any]]:
    entries = []
    for demo in demos:
        entry: dict[str, Any] = {
            "id": demo.id,
            "title": demo.title,
            "summary": demo.summary,
            "tagline": demo.tagline,
            "features": demo.features,
            "status": "unavailable" if demo.unavailable else "ready",
        }
        if demo.unavailable:
            entry["unavailable"] = demo.unavailable
        entries.append(entry)
    return entries
