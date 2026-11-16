"""A run started by one runtime resumes in the other over a shared file store or SQLite database.

Each attempt runs in a fresh process-like driver invocation (fresh ids and a
later clock), so a TypeScript → Python hand-off must produce exactly what a
TypeScript → TypeScript hand-off produces, and vice versa.
"""

from __future__ import annotations

import copy

import pytest

from clearideas_agent_runtime._js import json as js_json

from .conftest import run_typescript_scenarios
from .driver import run_scenario

MANIFEST = {
    "schemaVersion": "1.0",
    "id": "handoff",
    "variables": [
        {"key": "topic", "type": "string", "value": "Quarterly é 😀 report"},
        {"key": "cfg", "type": "object", "value": {"10": 1, "2": 2, "b": 0.25}},
    ],
    "messages": {"maxMessages": 6},
    "steps": [
        {"id": "draft", "type": "prompt", "prompt": "Draft {{ topic }} {{ cfg }}", "outputVariable": "draft"},
        {
            "id": "approval",
            "type": "prompt",
            "prompt": "Approve {{ draft }}",
            "extensions": {"test": {"suspendOnce": True}},
        },
        {
            "id": "each",
            "type": "loop",
            "loop": {"maxIterations": 1},
            "steps": [
                {"id": "child", "type": "prompt", "prompt": "{{ messages.lastUser.text }}", "outputVariable": "child"}
            ],
        },
        {
            "id": "final",
            "type": "prompt",
            "prompt": "Final {{ child }}",
            "includeInFinalOutput": True,
            "extensions": {"test": {"usage": {"inputTokens": 3, "outputTokens": 4, "totalTokens": 7}}},
        },
    ],
}
FIRST = {
    "request": {
        "runId": "handoff-run",
        "messagesScope": "tenant:1",
        "budget": {"maxTotalTokens": 1000},
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": "continue"},
        ],
    }
}
RESUME = {"resume": True, "request": {"runId": "handoff-run", "resume": True}}


def scenario(store, runs, start):
    # A restarted process draws fresh ids; the offset keeps them unique, as a real generator would.
    offset = 1000 if runs[0].get("resume") else 0
    return {
        "manifest": MANIFEST,
        "runs": runs,
        "store": store,
        "storedRunIds": ["handoff-run"],
        "clock": {"start": start},
        "idOffset": offset,
    }


async def python(store, runs, start):
    return await run_scenario(copy.deepcopy(scenario(store, runs, start)))


def typescript(store, runs, start):
    return run_typescript_scenarios([scenario(store, runs, start)])[0]


@pytest.mark.parametrize("kind", ["file", "sqlite"])
async def test_a_suspended_run_resumes_in_the_other_runtime(kind, tmp_path, oracle):
    def store(name):
        path = tmp_path / name / ("runs.sqlite" if kind == "sqlite" else "store")
        return {"kind": kind, "path": str(path)}

    first_start, second_start = "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"
    # Reference: both attempts in TypeScript, and both attempts in Python.
    ts_ts = [typescript(store("ts-ts"), [FIRST], first_start), typescript(store("ts-ts"), [RESUME], second_start)]
    py_py = [await python(store("py-py"), [FIRST], first_start), await python(store("py-py"), [RESUME], second_start)]
    # Hand-offs: the first attempt in one runtime, the resume in the other.
    ts_py = [typescript(store("ts-py"), [FIRST], first_start), await python(store("ts-py"), [RESUME], second_start)]
    py_ts = [await python(store("py-ts"), [FIRST], first_start), typescript(store("py-ts"), [RESUME], second_start)]

    reference = js_json.stringify(ts_ts)
    assert ts_ts[0]["runs"][0]["ok"] is False and ts_ts[0]["runs"][0]["error"]["name"] == "RunSuspendedError"
    assert ts_ts[1]["runs"][0]["ok"] is True
    assert js_json.stringify(py_py) == reference
    assert js_json.stringify(ts_py) == reference
    assert js_json.stringify(py_ts) == reference


@pytest.mark.parametrize("kind", ["file", "sqlite"])
async def test_store_files_are_byte_identical(kind, tmp_path, oracle):
    import sqlite3

    ts_store = {"kind": kind, "path": str(tmp_path / "ts" / ("runs.sqlite" if kind == "sqlite" else "store"))}
    py_store = {"kind": kind, "path": str(tmp_path / "py" / ("runs.sqlite" if kind == "sqlite" else "store"))}
    typescript(ts_store, [FIRST], "2026-01-01T00:00:00.000Z")
    await python(py_store, [FIRST], "2026-01-01T00:00:00.000Z")
    if kind == "file":
        ts_files = {
            path.relative_to(tmp_path / "ts"): path.read_bytes() for path in sorted((tmp_path / "ts").rglob("*.json"))
        }
        py_files = {
            path.relative_to(tmp_path / "py"): path.read_bytes() for path in sorted((tmp_path / "py").rglob("*.json"))
        }
        assert len(ts_files) == 2
        assert ts_files == py_files
    else:

        def rows(path):
            with sqlite3.connect(path) as database:
                return (
                    database.execute(
                        "SELECT run_id, record_json, failure_json FROM agent_runtime_runs ORDER BY run_id"
                    ).fetchall(),
                    database.execute(
                        "SELECT run_id, sequence, checkpoint_id, checkpoint_json FROM agent_runtime_checkpoints ORDER BY run_id, sequence"
                    ).fetchall(),
                )

        assert rows(ts_store["path"]) == rows(py_store["path"])


PROMPT_MANIFEST = {
    "schemaVersion": "1.0",
    "id": "prompt-handoff",
    "model": {"provider": "test", "model": "m"},
    "policies": {"context": {"strategy": "summarize", "maxToolResultBytes": 2_000}},
    "steps": [
        {
            "id": "research",
            "type": "prompt",
            "prompt": "Read files about {{ topic }}",
            "tools": ["docs__read"],
            "outputVariable": "report",
        },
        {"id": "final", "type": "prompt", "prompt": "Summarize {{ report }}", "includeInFinalOutput": True},
    ],
    "variables": [{"key": "topic", "type": "string", "value": "é😀 pricing"}],
}
PROMPT_SPEC = {
    "real": ["prompt"],
    "tools": [{"name": "docs__read", "size": 5_000}],
    "model": {
        "script": [
            {
                "calls": [
                    {"name": "docs__read", "input": {"path": "a.txt"}},
                    {"name": "docs__read", "input": {"path": "b.txt"}},
                ],
                "usage": {"totalTokens": 40},
            },
            {"text": "research done", "usage": {"totalTokens": 20}},
            {"text": "final summary", "usage": {"totalTokens": 5}},
        ],
        "summary": {"text": "Condensed tool output.", "usage": {"totalTokens": 30}},
    },
}
PROMPT_FIRST = {"request": {"runId": "prompt-run", "budget": {"maxTotalTokens": 60}}}
PROMPT_RESUME = {"resume": True, "request": {"runId": "prompt-run", "resume": True, "budget": {"maxTotalTokens": 1000}}}


def prompt_scenario(store, runs, start, script_offset=0):
    offset = 1000 if runs[0].get("resume") else 0
    spec = copy.deepcopy(PROMPT_SPEC)
    # A resumed process has already seen the first model response.
    spec["model"]["script"] = spec["model"]["script"][script_offset:]
    return {
        "manifest": PROMPT_MANIFEST,
        "runs": runs,
        "store": store,
        "storedRunIds": ["prompt-run"],
        "clock": {"start": start},
        "idOffset": offset,
        **spec,
    }


@pytest.mark.parametrize("kind", ["file", "sqlite"])
async def test_a_budget_suspended_prompt_step_resumes_in_the_other_runtime(kind, tmp_path, oracle):
    def store(name):
        path = tmp_path / name / ("runs.sqlite" if kind == "sqlite" else "store")
        return {"kind": kind, "path": str(path)}

    first, second = "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"

    async def py(name, runs, start, offset=0):
        return await run_scenario(copy.deepcopy(prompt_scenario(store(name), runs, start, offset)))

    def ts(name, runs, start, offset=0):
        return run_typescript_scenarios([prompt_scenario(store(name), runs, start, offset)])[0]

    ts_ts = [ts("ts-ts", [PROMPT_FIRST], first), ts("ts-ts", [PROMPT_RESUME], second, 1)]
    py_py = [await py("py-py", [PROMPT_FIRST], first), await py("py-py", [PROMPT_RESUME], second, 1)]
    ts_py = [ts("ts-py", [PROMPT_FIRST], first), await py("ts-py", [PROMPT_RESUME], second, 1)]
    py_ts = [await py("py-ts", [PROMPT_FIRST], first), ts("py-ts", [PROMPT_RESUME], second, 1)]

    assert ts_ts[0]["runs"][0]["ok"] is False and ts_ts[0]["runs"][0]["error"]["reason"] == "token-budget"
    assert ts_ts[1]["runs"][0]["ok"] is True
    checkpoint = ts_ts[0]["stored"]["prompt-run"]["checkpoint"]
    assert checkpoint["continuation"]["type"] == "prompt"
    reference = js_json.stringify(ts_ts)
    assert js_json.stringify(py_py) == reference
    assert js_json.stringify(ts_py) == reference
    assert js_json.stringify(py_ts) == reference
