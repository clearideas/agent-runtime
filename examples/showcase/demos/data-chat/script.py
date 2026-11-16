"""
Scripted model decisions for Data Chat (Python edition of script.ts).

The script never reads files itself: it asks for tool calls, Agent Runtime
runs them in the run sandbox, and every figure below is computed from the CSV
rows the sandbox returns. What "it" or "that" means is read from the
conversation the runtime inserts, including a runtime summary once the
history has been compacted.
"""

from __future__ import annotations

import re
from typing import Any

from lib import js
from lib.js import json_or, number, round_half_up, to_fixed
from lib.scripted_model import ScriptRequest, ScriptTurn, last_result, output_of

REGIONS = ["Americas", "EMEA", "APAC", "LATAM"]

Rows = list[dict[str, str]]


def topic_of(message: str) -> str:
    text = message.lower()
    if re.search(r"\b(chart|plot|graph|visuali[sz]e)\b", text, re.ASCII):
        return "chart"
    if re.search(r"\b(account|accounts|customer|customers|client|deals?|who)\b", text, re.ASCII):
        return "accounts"
    if re.search(r"(compare|year before|last year|previous year|a year ago|yoy)", text):
        return "comparison"
    return "growth"


def last(request: ScriptRequest, role: str) -> str:
    """The last message with a given role."""
    return next((message["text"] for message in reversed(request.messages) if message["role"] == role), "")


def region_in_context(request: ScriptRequest) -> str | None:
    """
    The region the conversation is about: one named in the newest message, or
    else the subject (the first region named) of the most recent message that
    names one, which may be the runtime's summary of earlier turns.
    """
    for message in reversed(request.messages):
        found = sorted(
            ((message["text"].find(region), region) for region in REGIONS if region in message["text"]),
            key=lambda entry: entry[0],
        )
        if found:
            return found[0][1]
    return None


def rows_of(csv: str) -> Rows:
    header, *lines = re.split(r"\r?\n", js.trim(csv))
    names = header.split(",")
    return [
        {(names[index] if index < len(names) else str(index)): value for index, value in enumerate(line.split(","))}
        for line in lines
    ]


def money(value: float) -> str:
    return f"${to_fixed(value / 1_000_000, 2)}M" if value >= 1_000_000 else f"${round_half_up(value / 1000)}K"


def percent(value: float) -> str:
    return f"{'+' if value >= 0 else ''}{to_fixed(value * 100, 1)}%"


def quarters_of(rows: Rows) -> list[str]:
    return sorted(dict.fromkeys(row["quarter"] for row in rows), key=js.code_unit_key)


def revenue(rows: Rows, quarter: str, region: str) -> float:
    row = next((row for row in rows if row.get("quarter") == quarter and row.get("region") == region), None)
    return number(row.get("revenue_usd") if row is not None else 0)


def growth_ranking(rows: Rows) -> dict[str, Any]:
    """Region growth in the latest quarter, fastest first."""
    quarters = quarters_of(rows)
    latest, previous = quarters[-1], quarters[-2]
    ranking = []
    for region in REGIONS:
        now = revenue(rows, latest, region)
        before = revenue(rows, previous, region)
        ranking.append({"region": region, "now": now, "before": before, "growth": now / before - 1})
    ranking.sort(key=lambda entry: -entry["growth"])
    return {"latest": latest, "previous": previous, "ranking": ranking}


EMPTY_CHART = {"title": "", "labels": [], "values": []}


def analyze(request: ScriptRequest) -> ScriptTurn:
    question = last(request, "user")
    topic = topic_of(question)
    file = "deals.csv" if topic == "accounts" else "regional_sales.csv"

    if request.turn == 0:
        return {"say": "Checking which data files the host exposes.", "call": {"name": "data__list_files", "input": {}}}
    if request.turn == 1:
        files = (output_of(last_result(request)) or {}).get("files") or []
        visible = any(entry["path"] == file for entry in files)
        return {
            "say": f"{len(files)} files are visible. Reading {file if visible else 'the README'}.",
            "call": {"name": "data__read_file", "input": {"path": file if visible else "README.md"}},
        }

    read = output_of(last_result(request))
    if not read or not read.get("content") or read["path"].endswith("README.md"):
        return {
            "output": {
                "intent": "unavailable",
                "findings": "The data files needed for that question are not available.",
                "chart": EMPTY_CHART,
            }
        }
    rows = rows_of(read["content"])

    if topic == "accounts":
        latest = quarters_of(rows)[-1]
        region = region_in_context(request) or "EMEA"
        deals = [
            {
                "account": row["account"],
                "amount": number(row["amount_usd"]),
                "isNew": not any(
                    other.get("account") == row["account"] and other.get("quarter") != latest for other in rows
                ),
            }
            for row in rows
            if row.get("quarter") == latest and row.get("region") == region
        ]
        deals.sort(key=lambda deal: -deal["amount"])
        total = sum(deal["amount"] for deal in deals)
        described = ", ".join(
            f"{deal['account']} ({money(deal['amount'])}{', a new account this quarter' if deal['isNew'] else ''})"
            for deal in deals
        )
        return {
            "output": {
                "intent": "answer",
                "findings": f"{len(deals)} {region} deals closed in {latest}, totalling {money(total)}: {described}.",
                "chart": EMPTY_CHART,
            }
        }

    ranked = growth_ranking(rows)
    latest, previous, ranking = ranked["latest"], ranked["previous"], ranked["ranking"]
    region = region_in_context(request) or ranking[0]["region"]

    if topic == "chart":
        quarters = quarters_of(rows)
        values = [revenue(rows, quarter, region) for quarter in quarters]
        return {
            "output": {
                "intent": "chart",
                "findings": f"{region} revenue for each quarter from {quarters[0]} to {latest}; {latest} is the highest at {money(values[-1])}.",
                "chart": {"title": f"{region} revenue by quarter (USD)", "labels": quarters, "values": values},
            }
        }

    if topic == "comparison":
        year_ago = f"{int(latest[:4]) - 1}{latest[4:]}"
        year_ago_previous = f"{int(previous[:4]) - 1}{previous[4:]}"
        now = next(entry for entry in ranking if entry["region"] == region)
        then = revenue(rows, year_ago, region) / revenue(rows, year_ago_previous, region) - 1
        year_over_year = now["now"] / revenue(rows, year_ago, region) - 1
        return {
            "output": {
                "intent": "answer",
                "findings": f"A year earlier, in {year_ago}, {region} grew {percent(then)} quarter on quarter; in {latest} it grew {percent(now['growth'])}, about {round_half_up(now['growth'] / then)} times faster. Year over year, {region} revenue is up {percent(year_over_year)} ({money(revenue(rows, year_ago, region))} to {money(now['now'])}).",
                "chart": EMPTY_CHART,
            }
        }

    top, *rest = ranking
    others = ", ".join(f"{entry['region']} {percent(entry['growth'])}" for entry in rest)
    return {
        "output": {
            "intent": "answer",
            "findings": f"{top['region']} grew fastest in {latest}: revenue rose {percent(top['growth'])}, from {money(top['before'])} to {money(top['now'])}. The other regions: {others}.",
            "chart": EMPTY_CHART,
        }
    }


PERSONAL_DATA = re.compile(r"\b(e-?mails?|phone|contact details|addresses|home address)\b", re.ASCII)
OVERRIDE = re.compile(r"(ignore (all |your |the |previous |any )*(rules|instructions)|system prompt|developer mode)")


def moderate(request: ScriptRequest) -> ScriptTurn:
    found = re.search(r"<message>([\s\S]*)</message>", request.prompt)
    message = (found[1] if found else "").lower()
    if OVERRIDE.search(message):
        return {
            "output": {
                "allowed": False,
                "category": "instruction-override",
                "reason": "The message tries to override the assistant's instructions.",
            }
        }
    if PERSONAL_DATA.search(message):
        return {
            "output": {
                "allowed": False,
                "category": "personal-data",
                "reason": "The message asks for personal contact data.",
            }
        }
    return {"output": {"allowed": True, "category": "ok", "reason": "A question about sales data."}}


def reply(request: ScriptRequest) -> ScriptTurn:
    found = re.search(r"Analysis: (\{[\s\S]*?\})\n", f"{last(request, 'user')}\n")
    analysis = json_or(found[1] if found else "{}", {})
    if not isinstance(analysis, dict):
        analysis = {}
    findings = analysis.get("findings") if analysis.get("findings") is not None else "I could not analyze that."
    if analysis.get("intent") == "chart":
        output = f"{findings} The chart is attached."
    elif analysis.get("intent") == "unavailable":
        output = f"I can't answer that from the sales data: {findings}"
    else:
        output = findings
    return {"output": output}


def summarize(request: ScriptRequest) -> ScriptTurn:
    """Summarizes the earlier conversation when the runtime compacts it."""
    found = re.search(r"<material>\n?([\s\S]*?)\n?</material>", request.prompt)
    material = found[1] if found else ""
    notes = []
    for block in (js.trim(block) for block in re.split(r"\n\n", material)):
        if not block:
            continue
        if block.startswith("[Summary of "):
            notes.append(" ".join(block.split("\n")[1:]))
            continue
        block = re.sub(r"^user \(turn (\d+)\): ", r"In turn \1 the user asked: ", block, count=1)
        block = re.sub(r"^assistant \(turn \d+\): ", "The analyst answered: ", block, count=1)
        notes.append(re.split(r"(?<=\.)\s", block)[0])
    return {"output": f"The user is exploring the quarterly regional sales data. {' '.join(notes)}"}


def data_chat_script(request: ScriptRequest) -> ScriptTurn:
    if "condense material" in request.system:
        return summarize(request)
    if "You moderate messages" in request.system:
        return moderate(request)
    if "You are a sales analyst" in request.system:
        return analyze(request)
    return reply(request)
