"""
Scripted model decisions for Long Investigation (Python edition of script.ts).

The script reads the logs the way an on-call engineer would: list the
workspace, read every log once, keep notes of what matters, then conclude.
Every decision comes from the real tool results Agent Runtime sends back.

Like a real model, it keeps its notes as it goes, so it still knows what it
found after Agent Runtime prunes or summarizes earlier tool rounds out of its
context. It also answers the summarizer's requests, condensing the material
it is sent (the runbook, or earlier rounds) into short notes.
"""

from __future__ import annotations

import functools
import re
from dataclasses import dataclass
from typing import Any

from lib import js
from lib.js import json_or
from lib.scripted_model import Script, ScriptRequest, ScriptTurn


@dataclass(frozen=True, eq=False)
class LogLine:
    file: str
    time: str
    level: str
    service: str
    text: str


LINE = re.compile(r"^(\S+)\s+(INFO|WARN|ERROR)\s+(\S+)\s+(.*)$")
NOTABLE = re.compile(r"deploy|config v\d+|rollback|max_connections|pool", re.IGNORECASE)


def parse_lines(file: str, content: str) -> list[LogLine]:
    lines = []
    for raw in content.split("\n"):
        match = LINE.match(js.trim(raw))
        if match:
            lines.append(LogLine(file, match[1], match[2], match[3], match[4]))
    return lines


def clock(time: str) -> str:
    return time[11:19]


def by_time(lines: list[LogLine]) -> list[LogLine]:
    return sorted(lines, key=functools.cmp_to_key(lambda left, right: js.locale_compare(left.time, right.time)))


def unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def summarize(request: ScriptRequest) -> ScriptTurn:
    """The summarizer's request: condense the material into about N words."""
    found = re.search(r"<material>\n([\s\S]*?)\n</material>", request.prompt)
    material = found[1] if found else ""
    limit = re.search(r"about (\d+) words", request.prompt)
    words = int(limit[1]) if limit else 150
    is_transcript = re.search(r"earlier part of a working session", request.prompt) is not None
    # Tool output arrives JSON-encoded inside the material; decode line breaks.
    lines = material.replace("\\n", "\n").split("\n")
    if is_transcript:
        # Fold in the previous summary's notes, then add the new rounds.
        earlier = re.search(r"Files read so far \(\d+\): ([^.]*)\.", material)
        earlier_files = [file for file in earlier[1].split(", ") if file.startswith("logs/")] if earlier else []
        files = unique([*earlier_files, *re.findall(r'"path":"(logs/[^"]+)"', material)])
        earlier_findings = [line for line in lines if re.match(r"- \d\d:\d\d:\d\d ", line)]
        findings = [
            f"- {clock(match[1])} {match[3]} {match[2]}: {match[4]}"
            for match in (LINE.match(js.trim(line)) for line in lines)
            if match is not None and (match[2] != "INFO" or NOTABLE.search(match[4] or ""))
        ]
        notes = [
            f"Working notes. Files read so far ({len(files)}): {', '.join(files) or 'none'}.",
            "Notable lines:",
            *unique([*earlier_findings, *findings]),
        ]
    else:
        # A document: keep its headings and the lines about its key checks.
        notes = [
            line
            for line in lines
            if re.match(r"#{1,3} ", line) or re.search(r"pool|rollback|deploy|change|timeout", line, re.IGNORECASE)
        ]
    summary: list[str] = []
    count = 0
    for note in notes:
        size = len(re.split(r"\s+", note))
        if count + size > words:
            break
        summary.append(note)
        count += size
    # No narration: summaries are not shown to the user as they are written.
    return {"say": "", "output": "\n".join(summary) or "Nothing notable."}


def conclude(lines: list[LogLine], files_read: int) -> dict[str, Any]:
    """Conclusions drawn only from the lines the logs contained."""
    ordered = by_time(lines)
    errors = [line for line in ordered if line.level == "ERROR"]
    first_error = errors[0] if errors else None
    change = next(
        (
            line
            for line in ordered
            if re.search(r"config v\d+ applied", line.text)
            and (first_error is None or js.compare_code_units(line.time, first_error.time) <= 0)
        ),
        None,
    )
    deploy = next((line for line in ordered if re.search(r"deploy .* started", line.text)), None)
    saturated = next((line for line in ordered if "pool saturated" in line.text), None)
    rollback = next((line for line in ordered if "rollback" in line.text), None)
    error_services = unique([line.service for line in errors])
    warn_only = [
        service
        for service in unique([line.service for line in ordered if line.level == "WARN"])
        if service not in error_services
        and service != (change.service if change else None)
        # Symptoms of the checkout failure are not separate causes.
        and not any(
            line.service == service and re.search(r"payment|checkout|orders delayed", line.text) for line in ordered
        )
    ]
    candidates = [deploy, change, saturated, first_error, *errors[1:3], rollback]
    events: list[LogLine] = []
    for line in candidates:
        if line is not None and not any(line is seen for seen in events):
            events.append(line)
    timeline = [f"{clock(line.time)} {line.service}: {line.text}" for line in by_time(events)]
    errored = f'{first_error.service}: "{first_error.text}"' if first_error else "no errors logged"
    return {
        "rootCause": f'{change.service} ran out of connections after "{change.text}". Requests waiting for a connection timed out ({errored}), so checkout payment authorizations failed.'
        if change
        else "No configuration change precedes the first error; the root cause is unclear.",
        "trigger": f"{clock(deploy.time)} {deploy.text}" if deploy else "not found",
        "timeline": timeline,
        "ruledOut": [
            f"{service}: {next(line for line in ordered if line.service == service and line.level == 'WARN').text} (unrelated to payments)"
            for service in warn_only
        ],
        "filesRead": files_read,
    }


def create_investigation_script() -> Script:
    """A fresh script per run: its notes are the model's working memory."""
    files: list[str] | None = None
    read: dict[str, None] = {}
    seen: set[str] = set()
    lines: list[LogLine] = []

    def absorb(result: dict[str, Any]) -> None:
        nonlocal files
        if result["callId"] in seen or result.get("error"):
            return
        seen.add(result["callId"])
        if result["name"].endswith("list_files"):
            listed = (result.get("output") or {}).get("files") or []
            files = [file["path"] for file in listed if file["path"].startswith("logs/")]
        elif result["name"].endswith("read_file"):
            output = result["output"]
            read[output["path"]] = None
            lines.extend(
                line
                for line in parse_lines(output["path"], output["content"])
                if line.level != "INFO" or NOTABLE.search(line.text)
            )

    def script(request: ScriptRequest) -> ScriptTurn:
        if re.search(r"condense material", request.system):
            return summarize(request)

        if not request.tools:
            # The report step: format the findings it was given.
            found = re.search(r"Findings: (\{[\s\S]*\})\s*$", request.prompt)
            findings = json_or(found[1] if found else "{}", {})
            return {
                "output": "\n".join(
                    [
                        "## Summary",
                        "",
                        f"Checkout latency and payment failures from 14:05 UTC were caused by a configuration change to payments-db. {findings.get('filesRead')} service logs were read.",
                        "",
                        "## Root cause",
                        "",
                        str(findings.get("rootCause")),
                        "",
                        f"Trigger: {findings.get('trigger')}",
                        "",
                        "## Timeline",
                        "",
                        *(f"- {entry}" for entry in findings.get("timeline") or []),
                        "",
                        "## Ruled out",
                        "",
                        *(f"- {entry}" for entry in findings.get("ruledOut") or []),
                    ]
                )
            }

        for result in request.results:
            absorb(result)
        if files is None:
            return {
                "say": "Listing the logs first, then I'll read every file.",
                "call": {"name": "logs__list_files", "input": {}},
            }
        upcoming = next((path for path in files if path not in read), None)
        if upcoming is not None:
            newest = list(read)[-1] if read else None
            last = [line for line in lines if line.file == newest]
            worst = next((line for line in last if line.level == "ERROR"), None) or (last[0] if last else None)
            return {
                "say": f"{worst.service}: {worst.level} at {clock(worst.time)}. Next, {upcoming}."
                if worst
                else f"Reading {upcoming}.",
                "call": {"name": "logs__read_file", "input": {"path": upcoming}},
            }
        return {
            "say": f"Read all {len(read)} logs. The errors start right after a payments-db configuration change.",
            "output": conclude(lines, len(read)),
        }

    return script
