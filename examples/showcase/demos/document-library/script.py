"""
Scripted model decisions for Document Library (Python edition of script.ts).
Each move depends on what the library actually returned: search matches,
folder listings, document text, and whether an image arrived as an artifact.
"""

from __future__ import annotations

import re
from typing import Any

from lib import js
from lib.js import json_or
from lib.scripted_model import ScriptRequest, ScriptTurn, output_of


def keywords_for(question: str) -> list[str]:
    """Search terms for the questions this demo offers."""
    text = question.lower()
    if "leave" in text:
        return ["annual leave"]
    if "expense" in text or "approval" in text:
        return ["approval"]
    if "stipend" in text or "home" in text:
        return ["stipend", "home-office"]
    words = sorted(re.split(r"\s+", text), key=lambda word: -js.length(word))
    return [words[0] if words else text]


def named(request: ScriptRequest, tool: str) -> list[dict[str, Any]]:
    return [result for result in request.results if result["name"] == tool]


def research(request: ScriptRequest) -> ScriptTurn:
    found = re.search(r"Question: (.*)", request.prompt)
    question = found[1] if found else ""
    keywords = keywords_for(question)
    searches = named(request, "library__search_files")
    matches = [match for result in searches for match in (output_of(result) or {}).get("matches") or []]

    # Nothing found yet: try the next search term, then file a ticket.
    if not matches:
        if len(searches) < len(keywords):
            keyword = keywords[len(searches)]
            return {
                "say": f"Searching the policy library for “{keyword}”."
                if not searches
                else f"Nothing yet. Trying “{keyword}”.",
                "call": {"name": "library__search_files", "input": {"query": keyword, "glob": "policies/**"}},
            }
        tickets = named(request, "tickets__create")
        if not tickets:
            return {
                "say": "No published policy covers this. Filing a ticket so People Operations can answer.",
                "call": {
                    "name": "tickets__create",
                    "input": {
                        "title": f"Policy question: {question}",
                        "details": f"No published policy answers: “{question}”",
                    },
                },
            }
        ticket = tickets[0]
        # MCP results carry structured content beside the text content.
        if ticket.get("error"):
            identifier = f"not filed ({ticket['error']['code']})"
        else:
            structured = (output_of(ticket) or {}).get("structuredContent") or {}
            identifier = structured.get("id") or "filed"
        return {
            "output": {
                "found": False,
                "answer": "No published policy answers this question.",
                "sources": [],
                "ticket": identifier,
            }
        }

    # Found: read the document, and look at any diagram beside it.
    document = next(match for match in matches if match["path"].endswith(".md"))
    folder = "/".join(document["path"].split("/")[:-1])
    reads = [output_of(result) for result in named(request, "library__read_file")]
    listings = named(request, "library__list_files")
    listing = listings[0] if listings else None
    if listing is None and folder != "policies":
        return {
            "say": f"{document['path']} mentions it. Checking what else is in {folder}/.",
            "call": {"name": "library__list_files", "input": {"path": folder}},
        }
    text = next((read for read in reads if read is not None and read.get("path") == document["path"]), None)
    if text is None:
        return {
            "say": f"Reading {document['path']}.",
            "call": {"name": "library__read_file", "input": {"path": document["path"]}},
        }
    images = [file for file in (output_of(listing) or {}).get("files") or [] if file["mediaType"].startswith("image/")]
    unseen = next(
        (
            image
            for image in images
            if not any(read is not None and read.get("path") == image["path"] for read in reads)
        ),
        None,
    )
    if unseen is not None:
        return {
            "say": f"There is a diagram, {unseen['path']}. Opening it as an image.",
            "call": {"name": "library__read_file", "input": {"path": unseen["path"]}},
        }
    saw_image = any(
        artifact["mediaType"].startswith("image/")
        for result in request.results
        for artifact in result.get("artifacts") or []
    )
    body = " ".join(
        line for line in (text.get("content") or "").split("\n") if line.strip() and not line.startswith("#")
    )
    return {
        "output": {
            "found": True,
            "answer": body,
            "sources": [document["path"], *([image["path"] for image in images] if saw_image else [])],
            "ticket": "",
        }
    }


def reply(request: ScriptRequest) -> ScriptTurn:
    found = re.search(r"Research: (\{.*\})", request.prompt)
    findings = json_or(found[1] if found else "{}", {})
    if not isinstance(findings, dict):
        findings = {}
    if not findings.get("found"):
        ticket = findings.get("ticket")
        return {
            "output": "\n".join(
                [
                    "I couldn't find a published policy that answers this.",
                    "",
                    f"I've opened ticket **{ticket if ticket is not None else '?'}** with People Operations, and they'll follow up with you.",
                ]
            )
        }
    sources = [f"`{source}`" for source in findings.get("sources") or []]
    return {
        "output": "\n".join(
            [
                findings.get("answer") or "",
                "",
                f"Source{'' if len(sources) == 1 else 's'}: {', '.join(sources)}",
            ]
        )
    }


def document_library_script(request: ScriptRequest) -> ScriptTurn:
    return reply(request) if "friendly reply" in request.system else research(request)
