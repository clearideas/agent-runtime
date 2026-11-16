"""
Scripted model decisions for Durable Runs (Python edition of script.ts). The
script reads the real CSV contents returned by the sandbox and computes the
report from them. It is stateless: after a pause it picks up from the
conversation the runtime restores, exactly as a real model would.
"""

from __future__ import annotations

import re
from typing import Any

from lib import js
from lib.js import json_or, number, to_fixed, to_locale_string
from lib.scripted_model import ScriptRequest, ScriptTurn, last_result, output_of


def money(value: float) -> str:
    return f"${to_locale_string(value)}"


def thousands(value: float) -> str:
    return f"${int(value / 1000 + 0.5)}K"


def percent(value: float) -> str:
    return f"{'+' if value >= 0 else '−'}{to_fixed(abs(value), 1)}%"


def parse_csv(content: str | None = None) -> dict[str, float]:
    rows: dict[str, float] = {}
    for line in js.trim(content or "").split("\n")[1:]:
        cells = line.split(",")
        if len(cells) == 2:
            rows[js.trim(cells[0])] = number(cells[1])
    return rows


def draft_report(
    quarter: str, previous: str, current: dict[str, float], prior: dict[str, float], money_format=money
) -> dict[str, str]:
    """Build the draft from the two quarters the sandbox returned."""

    def change(now: float, before: float) -> float:
        return ((now - before) / before) * 100 if before else 0

    rows = [
        {"region": region, "before": prior.get(region, 0), "revenue": revenue} for region, revenue in current.items()
    ]
    for row in rows:
        row["change"] = change(row["revenue"], row["before"])
    total = sum(row["revenue"] for row in rows)
    prior_total = sum(row["before"] for row in rows)
    best = sorted(rows, key=lambda row: -row["change"])[0]
    worst = sorted(rows, key=lambda row: row["change"])[0]
    content = "\n".join(
        [
            f"# {quarter} revenue report",
            "",
            "**Status:** Draft, awaiting approval",
            "",
            f"| Region | {previous} | {quarter} | Change |",
            "| --- | ---: | ---: | ---: |",
            *(
                f"| {row['region']} | {money_format(row['before'])} | {money_format(row['revenue'])} | {percent(row['change'])} |"
                for row in rows
            ),
            f"| **Total** | {money_format(prior_total)} | {money_format(total)} | **{percent(change(total, prior_total))}** |",
            "",
            f"{best['region']} grew fastest ({percent(best['change'])})."
            + (f" {worst['region']} declined ({percent(worst['change'])})." if worst["change"] < 0 else ""),
            "",
        ]
    )
    summary = f"Draft written to {quarter}-draft.md: revenue {money_format(total)}, {percent(change(total, prior_total))} on {previous}."
    return {"content": content, "summary": summary}


def draft(request: ScriptRequest) -> ScriptTurn:
    found = re.search(r"Prepare the draft (\S+) revenue report", request.prompt)
    quarter = found[1] if found else "Q3"
    previous = f"Q{((int(quarter[1:]) + 2) % 4) + 1}"
    if request.turn == 0:
        return {"say": "Listing the sales data.", "call": {"name": "data__list_files", "input": {}}}
    if request.turn == 1:
        files = (output_of(last_result(request)) or {}).get("files") or []
        path = next(
            (file["path"] for file in files if file["path"] == f"{quarter.lower()}.csv"), f"{quarter.lower()}.csv"
        )
        return {"say": f"Reading {path}.", "call": {"name": "data__read_file", "input": {"path": path}}}
    if request.turn == 2:
        return {
            "say": f"Reading {previous.lower()}.csv for comparison.",
            "call": {"name": "data__read_file", "input": {"path": f"{previous.lower()}.csv"}},
        }
    current = parse_csv((output_of(request.results[1]) or {}).get("content"))
    prior = parse_csv((output_of(request.results[2]) or {}).get("content"))
    report = draft_report(
        quarter, previous, current, prior, thousands if "nearest thousand" in request.system else money
    )
    if request.turn == 3:
        return {
            "say": "Comparing the quarters and writing the draft.",
            "call": {
                "name": "reports__write_file",
                "input": {"path": f"{quarter}-draft.md", "content": report["content"]},
            },
        }
    return {"output": report["summary"]}


def published(request: ScriptRequest) -> dict[str, str]:
    """The published report: the draft, marked approved by the reviewer."""
    draft_text = (output_of(request.results[0]) or {}).get("content") or ""
    found = re.search(r"Approval: (\{.*\})", request.prompt)
    approval: Any = json_or(found[1] if found else "{}", {})
    response = approval.get("response") if isinstance(approval, dict) else None
    reviewer = (
        response["reviewer"] if isinstance(response, dict) and response.get("reviewer") is not None else "the reviewer"
    )
    content = draft_text.replace("**Status:** Draft, awaiting approval", f"**Status:** Approved by {reviewer}", 1)
    if "one-line summary" in request.system:
        total = re.search(r"\| \*\*Total\*\* \| [^|]+ \| ([^|]+) \| \*\*([^*]+)\*\* \|", draft_text)
        if total:
            content = re.sub(
                r"^(# .+\n)",
                lambda match: (
                    f"{match[1]}\n> Revenue {js.trim(total[1])}, {js.trim(total[2])} on the previous quarter.\n"
                ),
                content,
                count=1,
            )
    return {"reviewer": reviewer, "content": f"{js.trim_end(content)}\n"}


def publish(request: ScriptRequest) -> ScriptTurn:
    found = re.search(r"Publish (\S+)-draft\.md", request.prompt)
    quarter = found[1] if found else "Q3"
    if request.turn == 0:
        return {
            "say": "Opening the approved draft. This attempt has a new sandbox, so the file comes from the host's reports folder.",
            "call": {"name": "reports__read_file", "input": {"path": f"{quarter}-draft.md"}},
        }
    if request.turn == 1:
        read = last_result(request)
        if read is not None and read.get("error"):
            return {
                "output": f"The draft could not be read ({read['error']['code']}: {read['error']['message']}); nothing was published."
            }
        result = published(request)
        return {
            "say": f"Marking it approved by {result['reviewer']} and publishing.",
            "call": {
                "name": "reports__write_file",
                "input": {"path": f"{quarter}-report.md", "content": result["content"]},
            },
        }
    written = last_result(request)
    if written is not None and written.get("error"):
        return {"output": f"Publishing failed ({written['error']['code']})."}
    return {"output": js.trim(published(request)["content"])}


def durable_runs_script(request: ScriptRequest) -> ScriptTurn:
    if "Prepare the draft" in request.prompt:
        return draft(request)
    if "-draft.md as" in request.prompt:
        return publish(request)
    return {"output": "This step is not part of the Durable Runs script."}
