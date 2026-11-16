"""
Scripted model decisions for Document Chat (Python edition of script.ts).

The script never opens a file. It reads what a real model would receive: the
conversation Agent Runtime inserts (including its summary once the history
has been compacted) and the numbered paragraphs the read step produced in the
run sandbox. It answers with edits by paragraph number, which the save step
applies to the real .docx.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from lib import js
from lib.js import json_or
from lib.scripted_model import ScriptRequest, ScriptTurn


@dataclass(frozen=True, eq=False)
class Paragraph:
    number: int
    style: str
    in_table: bool
    text: str


def paragraphs_of(prompt: str) -> list[Paragraph]:
    """The read step's listing: `[N] Style (table cell): "text"`."""
    listing = re.search(r"<document>\n?([\s\S]*?)\n?</document>", prompt)
    paragraphs = []
    for line in (listing[1] if listing else "").split("\n"):
        match = re.fullmatch(r'\[(\d+)\] (\S+)( \(table cell\))?: (".*")', line)
        if match:
            paragraphs.append(Paragraph(int(match[1]), match[2], match[3] is not None, json_or(match[4], "")))
    return paragraphs


def is_heading(paragraph: Paragraph) -> bool:
    return re.search(r"heading|berschrift|titre", paragraph.style, re.IGNORECASE) is not None


def section(paragraphs: list[Paragraph], name: str) -> dict[str, Paragraph] | None:
    """The heading named ``name`` (a pattern), and the last paragraph of its section."""
    start = next(
        (
            index
            for index, paragraph in enumerate(paragraphs)
            if is_heading(paragraph) and re.search(name, paragraph.text, re.IGNORECASE)
        ),
        -1,
    )
    if start < 0:
        return None
    following = next(
        (index for index, paragraph in enumerate(paragraphs) if index > start and is_heading(paragraph)), -1
    )
    end = len(paragraphs) - 1 if following < 0 else following - 1
    return {"heading": paragraphs[start], "last": paragraphs[end]}


def heading_style(paragraphs: list[Paragraph]) -> str:
    """The heading style the document already uses."""
    return next((paragraph.style for paragraph in paragraphs if is_heading(paragraph)), "Heading1")


def newest_request(request: ScriptRequest) -> str:
    # The last message is the step's prompt; the one before is the user's.
    return request.messages[-2]["text"] if len(request.messages) >= 2 else ""


TURN_LINE = re.compile(r"^Turn (\d+): (.+?) → (turns/\S+)$", re.MULTILINE)


def revisions(request: ScriptRequest) -> list[tuple[int, dict[str, str]]]:
    """
    Each revision this conversation wrote, by turn: from replies that name a
    revision, and from the summary's "Turn N: … → path" lines once the older
    turns have been summarized.
    """
    found: dict[int, dict[str, str]] = {}
    for message in request.messages[:-1]:
        for turn, change, file in TURN_LINE.findall(message["text"]):
            found[int(turn)] = {"change": change, "path": file}
        revised = re.search(r"Revised document: (turns/(\d{3})/\S+)", message["text"])
        if message["role"] == "assistant" and revised:
            found[int(revised[2])] = {
                "change": re.sub(r"\.\Z", "", message["text"].split("\n")[0]),
                "path": revised[1],
            }
    return sorted(found.items())


def first_sentence(text: str) -> str:
    match = re.match(r".*?[.!?](?=\s|\Z)", text)
    return match[0] if match else text


def revise(request: ScriptRequest) -> ScriptTurn:
    paragraphs = paragraphs_of(request.prompt)
    asked = newest_request(request).lower()
    heading = heading_style(paragraphs)

    def answer(reply: str, edits: list[dict[str, Any]] | None = None) -> ScriptTurn:
        return {"output": {"reply": reply, "edits": edits or []}}

    if re.search(r"\b(tighten|shorten|trim|concise)\b", asked, re.ASCII):
        intro = section(paragraphs, "intro")
        target = (
            next((p for p in paragraphs if p.number > intro["heading"].number), None) if intro is not None else None
        ) or next(
            iter(
                sorted(
                    (p for p in paragraphs if not is_heading(p) and not p.in_table),
                    key=lambda p: -js.length(p.text),
                )
            ),
            None,
        )
        if target is None:
            return answer("I found no paragraph to tighten.")
        text = (
            "This proposal moves document reviews into one shared workspace, so reviewers find and comment on everything in one place."
            if target.text.startswith("This proposal, which")
            else first_sentence(target.text)
        )
        return answer(
            "I cut the introduction to one sentence that says what the proposal does."
            if intro
            else "I cut the longest paragraph to its first sentence.",
            [{"action": "replace", "paragraph": target.number, "style": None, "text": text}],
        )

    if re.search(r"\btimeline\b", asked, re.ASCII):
        plan = section(paragraphs, "plan")
        after = plan["last"] if plan else (paragraphs[-1] if paragraphs else None)
        number = after.number if after else -1
        return answer(
            "I added a Timeline section after the plan.",
            [
                {"action": "insert_after", "paragraph": number, "style": heading, "text": "Timeline"},
                {
                    "action": "insert_after",
                    "paragraph": number,
                    "style": None,
                    "text": "Week 1: set up the workspace and invite the reviewers.\nWeek 2: move every open review into it.\nWeek 4: archive the first finished reviews.",
                },
            ],
        )

    if re.search(r"\brisks?\b", asked, re.ASCII):
        cost = section(paragraphs, "cost")
        if cost:
            index = paragraphs.index(cost["heading"]) - 1
            before = paragraphs[index] if index >= 0 else None
        else:
            before = paragraphs[-1] if paragraphs else None
        number = before.number if before else -1
        return answer(
            "I added a Risks section before the cost.",
            [
                {"action": "insert_after", "paragraph": number, "style": heading, "text": "Risks"},
                {
                    "action": "insert_after",
                    "paragraph": number,
                    "style": None,
                    "text": "Reviewers may keep commenting in the old places at first. We will send one reminder, then close the old review folders after a month.",
                },
            ],
        )

    if re.search(r"\b(estimate|three days)\b", asked, re.ASCII):
        cell = next((p for p in paragraphs if re.match(r"two days", p.text, re.IGNORECASE)), None)
        if cell is None:
            return answer("I could not find the setup estimate.")
        return answer(
            "I changed the setup estimate in the cost table to three days.",
            [
                {
                    "action": "replace",
                    "paragraph": cell.number,
                    "style": None,
                    "text": re.sub(r"^two days", "Three days", cell.text, count=1, flags=re.IGNORECASE),
                }
            ],
        )

    renamed = re.search(
        r"\b(?:rename|title)\b.*?[“\"'‘](.+?)[”\"'’]", newest_request(request), re.IGNORECASE | re.ASCII
    )
    if renamed:
        title = next((p for p in paragraphs if re.fullmatch(r"title", p.style, re.IGNORECASE)), None) or (
            paragraphs[0] if paragraphs else None
        )
        if title is None:
            return answer("The document has no title to rename.")
        return answer(
            f"I renamed the proposal to “{renamed[1]}”.",
            [{"action": "replace", "paragraph": title.number, "style": None, "text": renamed[1]}],
        )

    if re.search(r"\b(changed|changes|so far|history)\b", asked, re.ASCII):
        made = revisions(request)
        if not made:
            return answer("Nothing has changed yet.")
        return answer(
            "\n".join(
                [
                    "Here is what changed, turn by turn. Each revision is its own file:",
                    "",
                    *(f"- **Turn {turn}:** {entry['change']} (`{entry['path']}`)" for turn, entry in made),
                ]
            )
        )

    return answer(
        "In Scripted mode I can tighten the introduction, add a timeline or a risks section, change the setup estimate, rename the proposal, or say what changed so far. Choose Live to ask for anything else."
    )


def summarize(request: ScriptRequest) -> ScriptTurn:
    """
    Summarizes older turns when the runtime compacts the history. The material
    labels each message with its turn; the summary keeps one line per turn
    with the file it produced, so later turns can still find every revision.
    """
    found = re.search(r"<material>\n?([\s\S]*?)\n?</material>", request.prompt)
    material = found[1] if found else ""
    turns: dict[int, dict[str, Any]] = {}
    # An earlier summary's lines carry over unchanged.
    for turn, change, file in TURN_LINE.findall(material):
        turns[int(turn)] = {"change": change, "path": file}
    for role, turn, text in re.findall(
        r"^(user|assistant) \(turn (\d+)\): ([\s\S]*?)(?=\n\n(?:user|assistant) \(turn \d+\): |\s*(?![\s\S]))",
        material,
        re.MULTILINE,
    ):
        entry = turns.get(int(turn), {})
        if role == "user":
            entry["asked"] = text.split("\n")[0]
        else:
            entry["change"] = re.sub(r"\.\Z", "", text.split("\n")[0])
            revised = re.search(r"Revised document: (turns/\S+)", text)
            entry["path"] = revised[1] if revised else None
        turns[int(turn)] = entry
    numbers = sorted(turns)
    attached = re.search(r"\[Attached: (turns/\S+)\]", material)
    lines = []
    for turn in numbers:
        entry = turns[turn]
        if entry.get("path"):
            change = entry.get("change") if entry.get("change") is not None else entry.get("asked")
            lines.append(f"Turn {turn}: {change} → {entry['path']}")
        else:
            lines.append(f"Turn {turn}: the user asked “{entry.get('asked')}”; the document was not changed.")
    return {
        "output": "\n".join(
            [
                f"Turns {numbers[0]}–{numbers[-1]}. The user and the assistant are revising a Word document"
                + (f", first attached as {attached[1]}" if attached else "")
                + ".",
                *lines,
            ]
        )
    }


def document_chat_script(request: ScriptRequest) -> ScriptTurn:
    if "condense material" in request.system:
        return summarize(request)
    return revise(request)
