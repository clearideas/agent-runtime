"""Prompt-step parity: the real PromptStepExecutor in both runtimes with scripted adapters.

Reports include every model request the executor sent (byte-compared), tool
calls with idempotency keys, events, checkpoints (with prompt continuations
and context markers), and run records.
"""

from __future__ import annotations

import copy

import pytest

from clearideas_agent_runtime._js import json as js_json

from .conftest import assert_same_json, run_typescript_scenarios
from .driver import run_scenario

READ = {"name": "docs__read", "input": {"path": "a.txt"}}


def reads(count: int, prefix: str = "file") -> list[dict]:
    return [
        {"calls": [{"name": "docs__read", "input": {"path": f"{prefix}-{index}.txt"}}]} for index in range(1, count + 1)
    ]


def prompt_scenario(
    steps, *, runs=None, script=None, tools=None, limits=None, policies=None, variables=None, model=None, **extra
):
    manifest = {"schemaVersion": "1.0", "model": {"provider": "test", "model": "m"}, "steps": steps}
    if limits:
        manifest["limits"] = limits
    if policies:
        manifest["policies"] = policies
    if variables:
        manifest["variables"] = variables
    for key in ("messages",):
        if key in extra:
            manifest[key] = extra.pop(key)
    spec = {"script": script or [], **(model or {})}
    return {
        "manifest": manifest,
        "runs": runs or [{"request": {"runId": "p"}}],
        "real": ["prompt"],
        "model": spec,
        "tools": tools or [{"name": "docs__read", "size": 6000}, {"name": "docs__write", "output": "ok"}],
        **extra,
    }


RESEARCH = {
    "id": "research",
    "type": "prompt",
    "prompt": "Read every file and report.",
    "tools": ["docs__read"],
    "outputVariable": "report",
    "includeInFinalOutput": True,
}
BIG = {
    "id": "analyze",
    "type": "prompt",
    "systemPrompt": "You review contracts for {{ audience }}.",
    "prompt": "Check this contract:\n{{ contract }}\nAgainst policy: {{ policy }}",
}
BIG_VARIABLES = [
    {"key": "contract", "type": "string", "value": f"CONTRACT START {'clause é😀 ' * 6000} CONTRACT END"},
    {"key": "policy", "type": "string", "value": f"POLICY {'rule ' * 900}"},
    {"key": "audience", "type": "string", "value": "legal"},
]

SCENARIOS = {
    "simple-stream": prompt_scenario(
        [
            {
                "id": "greet",
                "type": "prompt",
                "systemPrompt": "Be brief.",
                "prompt": "Hello {{ name }}",
                "outputVariable": "greeting",
                "maxOutputTokens": 50,
            }
        ],
        variables=[{"key": "name", "type": "string", "value": "Ada"}],
        script=[{"text": "Hi Ada", "usage": {"inputTokens": 12, "outputTokens": 3, "totalTokens": 15}}],
        model={"stream": True},
    ),
    "tool-loop-prune": prompt_scenario(
        [RESEARCH],
        script=reads(10),
        limits={"maxInputBytes": 24_000, "maxToolCallsPerIteration": 30},
        model={"final": "report complete"},
    ),
    "tool-loop-summarize": prompt_scenario(
        [RESEARCH],
        script=reads(12),
        limits={"maxInputBytes": 30_000, "maxToolCallsPerIteration": 30},
        policies={"context": {"strategy": "summarize", "summarizer": {"chunkBytes": 8_000}}},
        model={
            "final": "report complete",
            "summary": {"words": True, "usage": {"inputTokens": 50, "outputTokens": 5, "totalTokens": 55}},
        },
    ),
    "tool-loop-summarize-or-prune-rounds": prompt_scenario(
        [RESEARCH],
        script=reads(6),
        tools=[{"name": "docs__read", "size": 100}],
        policies={
            "context": {
                "strategy": "summarize-or-prune",
                "trigger": {"toolRounds": 3},
                "retain": {"recentToolRounds": 1},
            }
        },
    ),
    "opening-prune": prompt_scenario(
        [BIG], limits={"maxInputBytes": 20_000}, variables=BIG_VARIABLES, script=[{"text": "reviewed"}]
    ),
    "opening-summarize": prompt_scenario(
        [BIG],
        limits={"maxInputBytes": 20_000},
        variables=BIG_VARIABLES,
        policies={"context": {"strategy": "summarize", "variables": {"policy": {"keep": True}}}},
        script=[{"text": "reviewed"}],
        model={
            "summary": {
                "text": "Key clause: payment in 30 days.",
                "usage": {"inputTokens": 100, "outputTokens": 10, "totalTokens": 110},
            }
        },
    ),
    "variable-caps": prompt_scenario(
        [BIG],
        variables=BIG_VARIABLES,
        policies={
            "context": {
                "variables": {"contract": {"maxBytes": 2_000}, "policy": {"maxBytes": 300, "strategy": "prune"}}
            }
        },
        script=[{"text": "ok"}],
    ),
    "oversized-tool-result": prompt_scenario(
        [RESEARCH],
        tools=[{"name": "docs__read", "size": 120_000}],
        limits={"maxInputBytes": 50_000},
        script=[{"calls": [READ]}],
    ),
    "retries-and-repairs": prompt_scenario(
        [
            {"id": "retry", "type": "prompt", "prompt": "Answer.", "outputVariable": "a"},
            {
                "id": "structured",
                "type": "prompt",
                "prompt": "JSON please",
                "outputSchema": {"type": "object"},
                "outputVariable": "b",
            },
            {"id": "truncated", "type": "prompt", "prompt": "Long answer", "maxOutputTokens": 100},
            {
                "id": "required",
                "type": "prompt",
                "prompt": "Required",
                "completionPolicy": {"requireOutput": True},
                "includeInFinalOutput": True,
            },
        ],
        script=[
            {"error": {"message": "rate limited", "statusCode": 429}},
            {"error": {"message": "upstream overloaded", "statusCode": 503, "name": "APICallError"}},
            {"text": "ok"},
            {"error": {"message": "No object generated: bad JSON", "name": "AI_NoObjectGeneratedError"}},
            {"text": "{}", "output": {"ok": True}},
            {"text": "partial", "finishReason": "length"},
            {"text": "complete"},
            {"text": ""},
            {"text": "now"},
        ],
    ),
    "non-retryable-failure": prompt_scenario(
        [{"id": "a", "type": "prompt", "prompt": "Answer."}],
        script=[{"error": {"message": "bad key", "statusCode": 401, "code": "AUTH"}}],
    ),
    "context-overflow": prompt_scenario(
        [RESEARCH],
        script=[
            *reads(3),
            {"error": {"message": "This model's maximum context length is 8192 tokens.", "statusCode": 400}},
        ],
        tools=[{"name": "docs__read", "size": 4000}],
    ),
    "tool-safeguards": prompt_scenario(
        [{"id": "tools", "type": "prompt", "prompt": "Use tools.", "tools": ["docs__read"]}],
        script=[
            {"calls": [{"name": "docs__write", "input": {"path": "x"}}, READ]},
            {"calls": [READ]},
            {"calls": [READ]},
            {"text": "final from gathered data"},
        ],
        limits={"maxToolCallsPerIteration": 2},
    ),
    "tool-errors": prompt_scenario(
        [{"id": "tools", "type": "prompt", "prompt": "Use tools.", "tools": ["docs__read", "broken"]}],
        tools=[
            {"name": "docs__read", "size": 20},
            {"name": "broken", "error": {"code": "tool_error", "message": "it broke"}},
        ],
        script=[{"calls": [{"name": "broken", "input": {"q": 1}}, READ]}, {"text": "done"}],
    ),
    "described-window": prompt_scenario(
        [RESEARCH],
        script=reads(8),
        model={"describe": {"maxInputTokens": 6_000, "maxOutputTokens": 4_000}},
    ),
    "budget-suspend-resume": prompt_scenario(
        [RESEARCH, {"id": "after", "type": "prompt", "prompt": "Summarize {{ report }}", "includeInFinalOutput": True}],
        script=[
            {"calls": [READ], "usage": {"inputTokens": 40, "outputTokens": 10, "totalTokens": 50}},
            {"text": "read done", "usage": {"totalTokens": 20}},
            {"text": "summary done", "usage": {"totalTokens": 5}},
        ],
        tools=[{"name": "docs__read", "size": 30}],
        runs=[
            {"request": {"runId": "b", "budget": {"maxTotalTokens": 50}}},
            {"resume": True, "request": {"runId": "b", "resume": True, "budget": {"maxTotalTokens": 1000}}},
        ],
    ),
    "conversation-history": prompt_scenario(
        [
            {
                "id": "answer",
                "type": "prompt",
                "systemPrompt": "Support.",
                "history": "all",
                "prompt": "Answer {{ messages.lastUser.text }}",
                "includeInFinalOutput": True,
            },
        ],
        messages={"maxMessages": 4},
        compactor=True,
        policies={"context": {"strategy": "summarize"}},
        runs=[
            {
                "request": {
                    "runId": "chat",
                    "messagesScope": "s",
                    "messages": [
                        {"role": "user", "content": f"first {'detail ' * 50}"},
                        {"role": "assistant", "content": "second"},
                        {"role": "user", "content": "third é😀"},
                        {"role": "assistant", "content": [{"type": "json", "value": {"k": [1, 2.5]}}]},
                        {"role": "user", "content": "Newest question?"},
                    ],
                }
            }
        ],
        script=[{"text": "Here is the answer."}],
        model={"summary": {"text": "They discussed the first three turns.", "usage": {"totalTokens": 9}}},
    ),
    "history-safety-net": prompt_scenario(
        [{"id": "answer", "type": "prompt", "systemPrompt": "Answer.", "history": "all", "includeInFinalOutput": True}],
        messages={},
        limits={"maxInputBytes": 3_000},
        runs=[
            {
                "request": {
                    "runId": "net",
                    "messages": [
                        {"role": "user", "content": f"first {'detail ' * 150}"},
                        {"role": "assistant", "content": f"second {'detail ' * 150}"},
                        {"role": "user", "content": f"third {'detail ' * 150}"},
                        {"role": "assistant", "content": f"fourth {'detail ' * 150}"},
                        {"role": "user", "content": "Newest question?"},
                    ],
                }
            }
        ],
        script=[{"text": "Answer."}],
    ),
}


@pytest.fixture(scope="module")
def typescript_reports(oracle):
    return dict(zip(SCENARIOS, run_typescript_scenarios(list(SCENARIOS.values())), strict=True))


@pytest.mark.parametrize("name", list(SCENARIOS))
async def test_prompt_scenario_matches_typescript(name, typescript_reports):
    python_report = await run_scenario(js_json.normalize(copy.deepcopy(SCENARIOS[name])))
    assert_same_json(name, typescript_reports[name], python_report)
