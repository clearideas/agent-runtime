"""Cross-language test fixtures.

Interop tests evaluate the same inputs with the built TypeScript packages
(``interop/oracle.mjs``) and with this package, and require identical results.
They need Node.js and built TypeScript packages (``npm ci && npm run build``);
``make test`` builds them first.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

REPOSITORY = Path(__file__).resolve().parents[3]
INTEROP = REPOSITORY / "interop"


class Oracle:
    def __init__(self, node: str) -> None:
        self.node = node

    def batch(self, requests: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
        process = subprocess.run(
            [self.node, str(INTEROP / "oracle.mjs")],
            input=json.dumps(requests),
            capture_output=True,
            text=True,
            cwd=INTEROP,
            timeout=600,
            check=False,
        )
        if process.returncode != 0:
            raise RuntimeError(f"TypeScript oracle failed:\n{process.stderr}")
        return [entry["results"] for entry in json.loads(process.stdout)]

    def __call__(self, op: str, inputs: list[Any]) -> list[dict[str, Any]]:
        return self.batch([{"op": op, "inputs": inputs}])[0]

    def values(self, op: str, inputs: list[Any]) -> list[Any]:
        results = self(op, inputs)
        failed = [result for result in results if not result["ok"]]
        if failed:
            raise AssertionError(f"oracle {op} failed: {failed[0]['error']}")
        return [result["value"] for result in results]


@pytest.fixture(scope="session")
def oracle() -> Oracle:
    node = shutil.which("node")
    built = (REPOSITORY / "packages" / "core" / "dist" / "index.js").exists()
    if node is None or not built:
        message = "Interop tests need Node.js and built TypeScript packages (npm ci && npm run build)."
        if os.environ.get("AGENT_RUNTIME_SKIP_INTEROP") == "1":
            pytest.skip(message)
        pytest.fail(message)
    return Oracle(node)


def run_typescript_scenarios(scenarios: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node = shutil.which("node")
    assert node is not None
    process = subprocess.run(
        [node, str(INTEROP / "driver.mjs")],
        input=json.dumps(scenarios),
        capture_output=True,
        text=True,
        cwd=INTEROP,
        timeout=600,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(f"TypeScript driver failed:\n{process.stderr}")
    return json.loads(process.stdout)


def assert_same_json(name: str, expected: Any, actual: Any) -> None:
    """Byte-compare two reports as JavaScript JSON, showing the first difference."""
    from clearideas_agent_runtime._js import json as js_json

    left = js_json.stringify(expected)
    right = js_json.stringify(actual)
    if left != right:
        index = next((i for i in range(min(len(left), len(right))) if left[i] != right[i]), min(len(left), len(right)))
        pytest.fail(
            f"{name} differs at {index}:\n ts: ...{left[max(0, index - 400) : index + 400]}\n"
            f" py: ...{right[max(0, index - 400) : index + 400]}"
        )
