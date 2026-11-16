"""End-to-end parity through real provider adapters.

Each driver runs the same two-step manifest (a tool-using prompt step, then a
structured-output step) with the runtime's production adapters: the AI SDK
providers in TypeScript, pydantic-ai in Python, both talking to the local mock
provider that replays the same responses (reasoning, text, tool calls, usage).
Run results, events, checkpoints, and run records must be byte-identical,
including transcripts, provider replay metadata, and aggregated usage.
"""

from __future__ import annotations

import asyncio
import copy
from typing import Any

import pytest

from .conftest import assert_same_json, run_typescript_scenarios
from .driver import run_scenario
from .mock_provider import MockProvider
from .wire_cases import DRIVERS, MODELS, PATHS, rich_cases

SCHEMA = {
    "type": "object",
    "properties": {"status": {"type": "string"}},
    "required": ["status"],
    "additionalProperties": False,
}


def _with_call_ids(driver: str, reply: dict[str, Any]) -> dict[str, Any]:
    """Gemini may omit function-call ids (each runtime then makes random ones); give them fixed ids."""
    reply = copy.deepcopy(reply)
    if driver == "google":
        for part in reply["body"]["candidates"][0]["content"]["parts"]:
            if "functionCall" in part:
                part["functionCall"].setdefault("id", "fc_scenario")
    return reply


def scenario(driver: str) -> dict[str, Any]:
    model = f"{driver}/{MODELS[driver]}"
    replies = rich_cases(driver, model)
    return {
        "replies": [
            _with_call_ids(driver, replies["rich"][1]),
            replies["rich-text"][1],
            replies["rich-structured"][1],
        ],
        "spec": {
            "manifest": {
                "schemaVersion": "1.0",
                "model": {"provider": driver, "model": MODELS[driver]},
                "steps": [
                    {
                        "id": "research",
                        "type": "prompt",
                        "systemPrompt": "Be brief.",
                        "prompt": "Find x",
                        "tools": ["lookup"],
                        "outputVariable": "notes",
                    },
                    {
                        "id": "status",
                        "type": "prompt",
                        "prompt": "Status of {{ notes }}?",
                        "outputSchema": SCHEMA,
                        "includeInFinalOutput": True,
                    },
                ],
            },
            "runs": [{"request": {"runId": f"run-{driver}"}}],
            "real": ["prompt"],
            "model": {"script": []},
            "tools": [{"name": "lookup", "output": "x is 1"}],
        },
    }


@pytest.fixture(scope="module")
def reports(oracle) -> dict[str, tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    with MockProvider() as mock:
        specs = {}
        for driver in DRIVERS:
            case = scenario(driver)
            mock.replies[f"scenario-{driver}"] = case["replies"]
            specs[driver] = case["spec"]

        def with_provider(driver: str, side: str) -> dict[str, Any]:
            return {
                **specs[driver],
                "provider": {
                    "driver": driver,
                    "name": "local",
                    "baseURL": mock.url + PATHS[driver],
                    "caseId": f"{side}:scenario-{driver}",
                },
            }

        typescript = run_typescript_scenarios([with_provider(driver, "ts") for driver in DRIVERS])
        python = [asyncio.run(run_scenario(with_provider(driver, "py"))) for driver in DRIVERS]
        requests = {
            driver: (mock.requests.get(f"ts:scenario-{driver}"), mock.requests.get(f"py:scenario-{driver}"))
            for driver in DRIVERS
        }
    return {driver: (ts, py, requests[driver]) for driver, ts, py in zip(DRIVERS, typescript, python, strict=True)}


@pytest.mark.parametrize("driver", DRIVERS)
def test_a_manifest_runs_identically_through_the_provider_adapters(reports, driver) -> None:
    typescript, python, (ts_requests, py_requests) = reports[driver]
    assert typescript["runs"][0]["ok"], typescript["runs"][0]
    assert len(ts_requests) == len(py_requests)
    assert_same_json(driver, typescript, python)
