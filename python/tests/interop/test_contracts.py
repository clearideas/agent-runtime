"""Contract schemas: parsed output and issues are byte-identical to Zod."""

from __future__ import annotations

import json

import pytest

from clearideas_agent_runtime import contracts
from clearideas_agent_runtime._js import json as js_json

from .generators import (
    RICH_MANIFESTS,
    checkpoints,
    conversation_histories,
    mutated,
    repository_manifests,
    run_manifests,
)

SCHEMAS = {
    "agentManifestSchema": contracts.agent_manifest_schema,
    "agentRunManifestSchema": contracts.agent_run_manifest_schema,
    "runCheckpointSchema": contracts.run_checkpoint_schema,
    "conversationMessagesInputSchema": contracts.conversation_messages_input_schema,
    "conversationMessagesSchema": contracts.conversation_messages_schema,
    "messagesSignatureSchema": contracts.messages_signature_schema,
    "executionPoliciesSchema": contracts.execution_policies_schema,
    "agentVariableOverridesSchema": contracts.agent_variable_overrides_schema,
    "runMessagesStateSchema": contracts.run_messages_state_schema,
}


def _python_result(schema: str, value):
    result = contracts.safe_parse(SCHEMAS[schema], value)
    if result.success:
        return {"success": True, "data": result.data}
    return {"success": False, "issues": result.error.issues, "message": str(result.error)}


def _compare(oracle, schema: str, corpus: list) -> None:
    wire = [json.loads(json.dumps(value)) for value in corpus]
    expected = oracle.values("safeParse", [{"schema": schema, "value": value} for value in wire])
    mismatches = []
    for value, reference in zip(wire, expected, strict=True):
        actual = _python_result(schema, value)
        if js_json.stringify(actual) != js_json.stringify(reference):
            mismatches.append({"input": value, "typescript": reference, "python": actual})
    assert not mismatches, f"{len(mismatches)}/{len(wire)} differ; first:\n" + _first_difference(mismatches[0])


def _first_difference(mismatch) -> str:
    typescript, python = mismatch["typescript"], mismatch["python"]
    if typescript["success"] != python["success"]:
        detail = typescript.get("issues") or python.get("issues")
        return f"verdict differs (ts={typescript['success']}): {json.dumps(detail)[:1500]}"
    if typescript["success"]:
        a, b = js_json.stringify(typescript["data"]), js_json.stringify(python["data"])
        index = next((i for i in range(min(len(a), len(b))) if a[i] != b[i]), min(len(a), len(b)))
        return f"data differs:\n ts: ...{a[max(0, index - 150) : index + 150]}\n py: ...{b[max(0, index - 150) : index + 150]}"
    for left, right in zip(typescript["issues"], python["issues"], strict=False):
        if js_json.stringify(left) != js_json.stringify(right):
            return f"issue differs:\n ts: {js_json.stringify(left)[:1500]}\n py: {js_json.stringify(right)[:1500]}"
    return f"issue count differs:\n ts: {js_json.stringify(typescript['issues'])[:1500]}\n py: {js_json.stringify(python['issues'])[:1500]}"


def test_repository_manifests_parse_identically(oracle):
    manifests = repository_manifests()
    assert len(manifests) > 10
    _compare(oracle, "agentManifestSchema", manifests)


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_mutated_manifests_parse_identically(oracle, seed):
    bases = RICH_MANIFESTS + repository_manifests()
    _compare(oracle, "agentManifestSchema", mutated(bases, seed, 1500))


def test_run_manifests_parse_identically(oracle):
    _compare(oracle, "agentRunManifestSchema", mutated(run_manifests(), 4, 800))


def test_checkpoints_parse_identically(oracle):
    _compare(oracle, "runCheckpointSchema", mutated(checkpoints(), 5, 800))


def test_conversation_messages_parse_identically(oracle):
    corpus = mutated(conversation_histories(), 6, 800)
    _compare(oracle, "conversationMessagesInputSchema", corpus)
    _compare(oracle, "conversationMessagesSchema", corpus)


def test_policies_and_overrides_parse_identically(oracle):
    policies = [step.get("policies", {}) for step in RICH_MANIFESTS[0]["steps"]] + [RICH_MANIFESTS[0]["policies"]]
    _compare(oracle, "executionPoliciesSchema", mutated(policies, 7, 600))
    _compare(
        oracle,
        "agentVariableOverridesSchema",
        mutated([run_manifests()[0]["variables"], run_manifests()[1]["variables"]], 8, 300),
    )
