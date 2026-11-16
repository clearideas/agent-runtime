"""Execution interchange: sealed worker invocations open in the other runtime, and worker
processes of either runtime serve either engine."""

from __future__ import annotations

import shutil
from typing import Any

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime.execution import (
    AesGcmWorkerInvocationCodec,
    ChildProcessExecutionEngine,
    ExecutionClient,
    create_worker_invocation,
)

from .conftest import REPOSITORY

KEYS = {"k1": "hex:" + "11" * 32, "k2": "base64:" + "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI"}
NOW = 1_767_225_600_000
MANIFEST = {
    "schemaVersion": "1.0",
    "steps": [
        {
            "id": "a",
            "type": "loop",
            "loop": {"maxIterations": 1},
            "steps": [{"id": "b", "type": "approval", "prompt": "Approve?", "when": "1 == 2"}],
        }
    ],
}
BINDING = {"executionId": "execution-1", "runId": "run-1", "audience": "worker:modal"}


def invocations() -> list[dict[str, Any]]:
    run = create_worker_invocation(
        {"manifest": MANIFEST, "runId": "run-1", "variables": [{"key": "x", "value": "é😀"}], "timeoutMs": 1000}
    )
    resume = create_worker_invocation(
        {"manifest": MANIFEST, "runId": "run-1", "attempt": 2, "checkpointReference": "cp-1"}, "resume"
    )
    return [run, resume]


def test_envelopes_sealed_in_either_runtime_open_in_the_other(oracle) -> None:
    for invocation in invocations():
        for active in ("k1", "k2"):
            codec = AesGcmWorkerInvocationCodec(active_key_id=active, keys=KEYS, now=lambda: NOW)
            python_envelope = codec.seal(
                invocation, execution_id=BINDING["executionId"], run_id=BINDING["runId"], audience=BINDING["audience"]
            )
            typescript_envelope = oracle.values(
                "sealInvocation",
                [{"keys": KEYS, "activeKeyId": active, "invocation": invocation, "binding": BINDING, "now": NOW}],
            )[0]
            # Metadata and authenticated data are byte-identical; nonces differ.
            assert js_json.stringify(
                {**python_envelope, "nonce": "", "ciphertext": "", "authTag": ""}
            ) == js_json.stringify({**typescript_envelope, "nonce": "", "ciphertext": "", "authTag": ""})
            opened_by_typescript = oracle.values(
                "openInvocation",
                [
                    {
                        "keys": KEYS,
                        "activeKeyId": "k1",
                        "envelope": python_envelope,
                        "binding": BINDING,
                        "now": NOW + 1000,
                    }
                ],
            )[0]
            opened_by_python = codec.open(
                typescript_envelope, execution_id="execution-1", run_id="run-1", audience="worker:modal"
            )
            assert js_json.stringify(opened_by_typescript) == js_json.stringify(opened_by_python)


def test_tampering_and_binding_errors_match(oracle) -> None:
    codec = AesGcmWorkerInvocationCodec(active_key_id="k1", keys=KEYS, now=lambda: NOW)
    envelope = codec.seal(invocations()[0], execution_id="execution-1", run_id="run-1", audience="worker:modal")
    cases = [
        ({**envelope, "metadata": {**envelope["metadata"], "audience": "other"}}, BINDING),
        (envelope, {**BINDING, "audience": "other"}),
        ({**envelope, "keyId": "k9"}, BINDING),
        ({**envelope, "nonce": envelope["nonce"] + "A"}, BINDING),
        ({**envelope, "authTag": "A" * 22}, BINDING),
        ({**envelope, "envelopeVersion": "2"}, BINDING),
        ({**envelope, "metadata": {**envelope["metadata"], "issuedAt": "2026-01-01T00:00:00Z"}}, BINDING),
    ]
    inputs = [
        {"keys": KEYS, "activeKeyId": "k1", "envelope": value, "binding": binding, "now": NOW}
        for value, binding in cases
    ]
    inputs.append(
        {"keys": KEYS, "activeKeyId": "k1", "envelope": envelope, "binding": BINDING, "now": NOW + 10 * 60_000}
    )
    results = oracle("openInvocation", inputs)
    for entry, result in zip(inputs, results, strict=True):
        python = AesGcmWorkerInvocationCodec(active_key_id="k1", keys=KEYS, now=lambda entry=entry: entry["now"])
        try:
            python.open(
                entry["envelope"],
                execution_id=entry["binding"]["executionId"],
                run_id=entry["binding"]["runId"],
                audience=entry["binding"]["audience"],
            )
            actual: Any = None
        except Exception as error:
            actual = {"name": error.name, "message": str(error), "code": error.code}  # type: ignore[attr-defined]
        assert not result["ok"]
        assert actual == result["error"], entry


async def test_the_python_child_process_engine_runs_the_typescript_worker(tmp_path, oracle) -> None:
    from .mock_provider import MockProvider

    cli = REPOSITORY / "packages" / "cli" / "dist" / "bin.js"
    assert cli.exists(), "the TypeScript CLI is not built (npm run build)"
    with MockProvider() as mock:
        mock.replies["worker"] = {"kind": "text", "text": "Hello from the mock provider"}
        config = tmp_path / "agent-runtime.config.json"
        config.write_text(
            js_json.stringify(
                {
                    "version": "1.0",
                    "providers": {
                        "local": {
                            "driver": "openai-compatible",
                            "baseURL": mock.url + "/v1",
                            "headers": {"x-case": {"env": "CASE"}},
                        }
                    },
                }
            )
        )
        engine = ChildProcessExecutionEngine(
            command=shutil.which("node"),  # type: ignore[arg-type]
            args=[str(cli), "worker", "--store", str(tmp_path / "store"), "--config", str(config)],
            cwd=str(tmp_path),
            env={"CASE": "worker"},
        )
        client = ExecutionClient(engine)
        manifest = {
            "schemaVersion": "1.0",
            "model": {"provider": "local", "model": "llama3"},
            "steps": [{"id": "answer", "type": "prompt", "prompt": "Say hello", "includeInFinalOutput": True}],
        }
        events: list[dict] = []
        handle = await client.submit({"manifest": manifest, "runId": "child-1"})
        followed = await client.follow(handle, on_event=events.append)
        assert followed["status"]["status"] == "completed", followed
        assert followed["result"]["output"] == "Hello from the mock provider"
        assert events[0]["type"] == "run.started" and events[-1]["type"] == "run.completed"
        assert mock.requests["worker"][0]["body"]["messages"][0]["content"] == "Say hello"


async def test_the_typescript_child_process_engine_runs_the_python_worker(tmp_path, oracle) -> None:
    import sys

    from .mock_provider import MockProvider

    with MockProvider() as mock:
        mock.replies["pyworker"] = {"kind": "text", "text": "Hello from Python"}
        config = tmp_path / "agent-runtime.config.json"
        config.write_text(
            js_json.stringify(
                {
                    "version": "1.0",
                    "providers": {
                        "local": {
                            "driver": "openai-compatible",
                            "baseURL": mock.url + "/v1",
                            "headers": {"x-case": {"env": "CASE"}},
                        }
                    },
                }
            )
        )
        manifest = {
            "schemaVersion": "1.0",
            "model": {"provider": "local", "model": "llama3"},
            "steps": [{"id": "answer", "type": "prompt", "prompt": "Say hello", "includeInFinalOutput": True}],
        }
        outcome = oracle.values(
            "runChildExecution",
            [
                {
                    "command": sys.executable,
                    "args": [
                        "-m",
                        "clearideas_agent_runtime.cli",
                        "worker",
                        "--store",
                        str(tmp_path / "store"),
                        "--config",
                        str(config),
                    ],
                    "cwd": str(tmp_path),
                    "env": {"CASE": "pyworker"},
                    "request": {"manifest": manifest, "runId": "py-child-1"},
                }
            ],
        )[0]
    assert outcome["status"] == "completed", outcome
    assert outcome["result"]["output"] == "Hello from Python"
    assert outcome["events"][0]["type"] == "run.started" and outcome["events"][-1]["type"] == "run.completed"
