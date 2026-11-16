"""End-to-end engine parity: identical results, events, checkpoints, and records."""

from __future__ import annotations

import pytest

from clearideas_agent_runtime._js import json as js_json

from .conftest import run_typescript_scenarios
from .driver import run_scenario


def prompt(step_id, prompt_text=None, **extra):
    return {"id": step_id, "type": "prompt", "prompt": prompt_text or step_id, **extra}


def manifest(steps, **extra):
    return {"schemaVersion": "1.0", "steps": steps, **extra}


SCENARIOS = {
    "sequential": {
        "manifest": manifest(
            [prompt("first", outputVariable="a"), prompt("second", "Use {{ a }}")], id="seq", name="Sequential"
        ),
        "runs": [{"request": {"runId": "r1"}}],
    },
    "variables-and-conditions": {
        "manifest": manifest(
            [
                prompt("greet", "Hi {{ name }} ({{ count }})", outputVariable="greeting"),
                prompt("big", when="count > 2"),
                prompt("small", when="count <= 2"),
                prompt("legacy", when="{{ name }} == 'Ada'"),
            ],
            variables=[
                {"key": "name", "type": "string", "value": "Ada"},
                {"key": "count", "type": "number", "value": 3},
                {"key": "cfg", "type": "object", "value": {"2": "b", "1": "a", "z": 0.5}},
            ],
        ),
        "runs": [{"request": {"runId": "vars", "variables": [{"key": "count", "value": 1.0}]}}],
    },
    "loop-children": {
        "manifest": manifest(
            [
                {
                    "id": "each",
                    "type": "loop",
                    "loop": {"maxIterations": 1},
                    "steps": [prompt("c1", outputVariable="x"), prompt("c2", "after {{ x }}", when="x != null")],
                }
            ]
        ),
        "runs": [{"request": {"runId": "loop"}}],
    },
    "failure-and-resume": {
        "manifest": manifest(
            [
                prompt("ok", outputVariable="ok"),
                prompt("boom", extensions={"test": {"fail": "upstream down", "code": "UPSTREAM_DOWN"}}),
            ]
        ),
        "runs": [{"request": {"runId": "fail"}}, {"resume": True, "request": {"runId": "fail", "resume": True}}],
    },
    "on-error-continue": {
        "manifest": manifest(
            [
                prompt(
                    "flaky",
                    outputVariable="flaky",
                    policies={"onError": "continue"},
                    extensions={"test": {"fail": "nope"}},
                ),
                prompt("after", "{{ flaky.error.message }}"),
            ]
        ),
        "runs": [{"request": {"runId": "continue"}}],
    },
    "suspend-and-resume": {
        "manifest": manifest(
            [
                prompt("first", outputVariable="a"),
                prompt("approval", extensions={"test": {"suspendOnce": True}}),
                prompt("last"),
            ]
        ),
        "runs": [{"request": {"runId": "suspend"}}, {"resume": True, "request": {"runId": "suspend", "resume": True}}],
    },
    "budget-and-usage": {
        "manifest": manifest(
            [
                prompt(
                    "a",
                    extensions={
                        "test": {
                            "usage": {"inputTokens": 7, "outputTokens": 3, "totalTokens": 10, "estimatedCost": 0.1}
                        }
                    },
                ),
                prompt(
                    "b",
                    extensions={
                        "test": {"usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3, "estimatedCost": 0.2}}
                    },
                ),
            ]
        ),
        "runs": [{"request": {"runId": "budget", "budget": {"maxTotalTokens": 100}}}],
    },
    "end-run-and-final-output": {
        "manifest": manifest(
            [
                prompt("a", includeInFinalOutput=True),
                prompt("stop", extensions={"test": {"endRun": True, "output": {"done": True, "2": 1}}}),
                prompt("never"),
            ]
        ),
        "runs": [{"request": {"runId": "end"}}],
    },
    "limits": {
        "manifest": manifest([prompt("a")], limits={"maxOutputBytes": 3}),
        "runs": [{"request": {"runId": "limit"}}],
    },
    "invalid-manifest": {
        "manifest": {
            "schemaVersion": "1.0",
            "steps": [{"id": "", "type": "prompt", "prompt": 1}, {"id": "x", "type": "nope"}],
        },
        "runs": [{"request": {"runId": "invalid"}}],
    },
    "invalid-overrides": {
        "manifest": manifest([prompt("a")], variables=[{"key": "n", "type": "number"}]),
        "runs": [
            {"request": {"runId": "o1", "variables": [{"key": "n", "value": "x"}]}},
            {"request": {"runId": "o2", "variables": [{"key": "m", "value": 1}]}},
        ],
    },
    "messages-pruned": {
        "manifest": manifest(
            [prompt("answer", "Reply to {{ messages.lastUser.text }}", history="all", includeInFinalOutput=True)],
            messages={"maxMessages": 4},
        ),
        "runs": [
            {
                "request": {
                    "runId": "chat",
                    "messagesScope": "s",
                    "messages": [
                        {"role": "user", "content": "a"},
                        {"role": "assistant", "content": "b"},
                        {"role": "user", "content": "c"},
                        {"role": "assistant", "content": [{"type": "json", "value": {"k": [1, 2.5]}}]},
                        {"role": "user", "content": "é😀"},
                    ],
                }
            }
        ],
    },
    "parallel-wave": {
        "manifest": manifest(
            [
                prompt("one", outputVariable="one"),
                prompt("two", outputVariable="two"),
                prompt("three", "{{ one }} {{ two }}", outputVariable="three"),
            ]
        ),
        "runs": [{"request": {"runId": "par", "execution": {"mode": "parallel", "maxConcurrency": 2}}}],
    },
    "resume-errors": {
        "manifest": manifest([prompt("a")]),
        "runs": [
            {"resume": True, "request": {"runId": "missing", "resume": True}},
            {"request": {"runId": "x", "resume": True}},
        ],
    },
}


# Parallel waves: JavaScript's microtask scheduling and asyncio interleave the
# concurrent steps' clock reads and id draws differently. Committed state,
# outputs, and step results must still match; ids, timestamps, and event order
# inside the wave are compared without their interleaving (documented).
PARALLEL = {"parallel-wave"}
_INTERLEAVED_KEYS = {
    "id",
    "timestamp",
    "completedAt",
    "createdAt",
    "updatedAt",
    "startedAt",
    "sequence",
    "checkpointId",
}


def _without_interleaving(value):
    if isinstance(value, dict):
        return {key: _without_interleaving(item) for key, item in value.items() if key not in _INTERLEAVED_KEYS}
    if isinstance(value, list):
        return [_without_interleaving(item) for item in value]
    return value


def _parallel_view(report):
    view = _without_interleaving(report)
    view["events"] = sorted(js_json.stringify(event) for event in view["events"])
    return view


@pytest.fixture(scope="module")
def typescript_reports(oracle):
    return dict(zip(SCENARIOS, run_typescript_scenarios(list(SCENARIOS.values())), strict=True))


@pytest.mark.parametrize("name", list(SCENARIOS))
async def test_scenario_matches_typescript(name, typescript_reports):
    python_report = await run_scenario(js_json.normalize(SCENARIOS[name]))
    if name in PARALLEL:
        expected = js_json.stringify(_parallel_view(typescript_reports[name]))
        actual = js_json.stringify(_parallel_view(python_report))
    else:
        expected = js_json.stringify(typescript_reports[name])
        actual = js_json.stringify(python_report)
    if expected != actual:
        index = next(
            (i for i in range(min(len(expected), len(actual))) if expected[i] != actual[i]),
            min(len(expected), len(actual)),
        )
        pytest.fail(
            f"{name} differs at {index}:\n ts: ...{expected[max(0, index - 300) : index + 300]}\n py: ...{actual[max(0, index - 300) : index + 300]}"
        )
