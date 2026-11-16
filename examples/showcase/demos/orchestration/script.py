"""
Scripted model answers for Orchestration (Python edition of script.ts). No
tools here: the interesting parts are the runtime's scheduling, condition,
and loops. The critique rejects the first headline, so the goal loop runs
twice.
"""

from __future__ import annotations

import re

from lib.js import json_or
from lib.scripted_model import ScriptRequest, ScriptTurn


def after(prompt: str, label: str) -> str:
    found = re.search(rf"{label}:\s*(.*)", prompt)
    return found[1].strip() if found else ""


pitches = {
    "blog": "How we gave agents a workspace without handing them the keys.",
    "newsletter": "New this month: sandboxed workspaces and durable, resumable runs.",
    "social": "Agents that fix code in a sandbox, pause for approval, and resume later.",
}


def orchestration_script(request: ScriptRequest) -> ScriptTurn:
    prompt = request.prompt
    if prompt.startswith("Write a two-sentence launch brief"):
        return {
            "output": "Agent Runtime 0.9.0 lets agents work on real files inside an isolated sandbox under host policy. Runs pause for people or budgets and resume later without losing work."
        }
    if prompt.startswith("Who is the primary audience"):
        return {"output": "platform teams adding agents to their products"}
    if prompt.startswith("List launch risks"):
        regulated = after(prompt, "Regulated market") == "true."
        return {
            "output": {
                "level": "high",
                "items": ["Data residency rules for workspace files", "Audit requirements for agent actions"],
            }
            if regulated
            else {"level": "low", "items": ["Documentation gaps at launch"]}
        }
    if prompt.startswith("Suggest launch pricing"):
        return {"output": "Open source under Apache 2.0; paid support from $2,000 per month."}
    if prompt.startswith("Write a mitigation plan"):
        return {
            "output": "Keep workspaces in-region, and export every sandbox command record to the customer's audit log."
        }
    channel = re.search(r"Write a one-line (\S+) pitch", prompt)
    if channel:
        return {"output": pitches.get(channel[1], f"A {channel[1]} pitch for the launch.")}
    if prompt.startswith("Write a launch headline"):
        first_try = after(prompt, "Previous feedback") == "No review yet."
        return {"output": "Agent Runtime 0.9.0 is here" if first_try else "Give your agents a workspace, not the keys"}
    if prompt.startswith("Critique this headline"):
        headline = after(prompt, "Critique this headline strictly")
        return {
            "output": {"approved": False, "feedback": "Too generic. Say what changed for the reader."}
            if "is here" in headline
            else {"approved": True, "feedback": "Specific and memorable."}
        }
    if prompt.startswith("Assemble the launch plan"):
        listed = json_or(after(prompt, "Pitches"), None)
        pitch_list = "\n".join(f"- {pitch}" for pitch in listed) if isinstance(listed, list) else ""
        mitigation = after(prompt, "Mitigation")
        return {
            "output": "\n".join(
                [
                    f"## {after(prompt, 'Headline')}",
                    "",
                    f"**Audience:** {after(prompt, 'Audience')}",
                    "",
                    f"**Pricing:** {after(prompt, 'Pricing')}",
                    *(["", f"**Risk mitigation:** {mitigation}"] if mitigation else []),
                    "",
                    "**Pitches**",
                    "",
                    pitch_list,
                ]
            )
        }
    return {"output": "This prompt is not part of the Orchestration script."}
