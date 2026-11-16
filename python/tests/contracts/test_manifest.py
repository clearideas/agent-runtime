"""Port of packages/contracts/test/manifest.test.ts."""

from __future__ import annotations

import pytest

from clearideas_agent_runtime._js.json import stringify
from clearideas_agent_runtime.contracts import (
    ZodError,
    parse_agent_manifest,
    parse_agent_run_manifest,
    parse_run_checkpoint,
    safe_parse_agent_manifest,
    safe_parse_agent_run_manifest,
)


def _issues_text(result) -> str:
    return stringify(result.error.issues) if result.error else "[]"


class TestAgentManifestContracts:
    def test_accepts_complete_rich_prompt_histories_while_preserving_legacy_prompts(self):
        legacy = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "legacy",
                        "type": "prompt",
                        "systemPrompt": "Be concise.",
                        "prompt": "Answer.",
                    }
                ],
            }
        )
        assert legacy.success

        parsed = parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "continued-chat",
                        "type": "prompt",
                        "messages": [
                            {
                                "role": "system",
                                "content": [{"type": "text", "text": "Review {{topic}}."}],
                                "metadata": {"source": "agent"},
                            },
                            {
                                "role": "user",
                                "content": [
                                    {"type": "text", "text": "Inspect this image."},
                                    {
                                        "type": "image",
                                        "url": "https://example.test/diagram.png",
                                        "mediaType": "image/png",
                                        "providerOptions": {"openai": {"detail": "high"}},
                                    },
                                ],
                            },
                            {
                                "role": "assistant",
                                "content": [
                                    {
                                        "type": "tool-call",
                                        "call": {
                                            "id": "call-1",
                                            "name": "lookup",
                                            "input": {"id": 1},
                                            "metadata": {"imported": True},
                                        },
                                    }
                                ],
                            },
                            {
                                "role": "tool",
                                "content": [
                                    {
                                        "type": "tool-result",
                                        "result": {
                                            "callId": "call-1",
                                            "name": "lookup",
                                            "output": {"found": True},
                                            "metadata": {"latencyMs": 10},
                                        },
                                    }
                                ],
                            },
                            {
                                "role": "user",
                                "content": [{"type": "text", "text": "Give the final answer."}],
                            },
                        ],
                    }
                ],
            }
        )
        step = parsed["steps"][0]
        assert step["type"] == "prompt"
        assert len(step["messages"]) == 5
        assert step["messages"][1]["content"][1]["type"] == "image"
        assert step["messages"][1]["content"][1]["mediaType"] == "image/png"

    def test_rejects_ambiguous_histories_invalid_media_and_unpaired_tool_results(self):
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "ambiguous",
                        "type": "prompt",
                        "prompt": "Legacy",
                        "messages": [{"role": "user", "content": [{"type": "text", "text": "History"}]}],
                    }
                ],
            }
        ).success
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "invalid-media",
                        "type": "prompt",
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image",
                                        "url": "https://example.test/image.png",
                                        "data": "also-inline",
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ).success
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "orphan-result",
                        "type": "prompt",
                        "messages": [
                            {
                                "role": "tool",
                                "content": [
                                    {
                                        "type": "tool-result",
                                        "result": {
                                            "callId": "missing",
                                            "name": "lookup",
                                            "output": None,
                                        },
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ).success

    def test_accepts_explicit_variables_conditional_collection_loops_and_goal_loops(self):
        manifest = parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "name": "Review documents",
                "variables": [
                    {
                        "key": "documents",
                        "type": "array",
                        "value": [{"id": "one", "enabled": True}, {"id": "two", "enabled": False}],
                    },
                    {"key": "targetScore", "type": "number", "value": 90},
                ],
                "steps": [
                    {
                        "id": "review-documents",
                        "type": "loop",
                        "loop": {
                            "source": "documents",
                            "itemVariable": "document",
                            "condition": "document.enabled == true",
                            "outputMode": "array",
                        },
                        "steps": [
                            {
                                "id": "review-document",
                                "type": "prompt",
                                "prompt": "Review {{document.id}}",
                            }
                        ],
                    },
                    {
                        "id": "improve-draft",
                        "type": "loop",
                        "loop": {
                            "maxIterations": 5,
                            "goal": "{{score}} >= {{targetScore}}",
                            "resultVariable": "draft",
                            "outputMode": "final",
                        },
                        "steps": [{"id": "revise", "type": "prompt", "prompt": "Improve {{draft}}"}],
                    },
                ],
            }
        )
        assert next(v for v in manifest["variables"] if v["key"] == "targetScore")["value"] == 90
        assert [step["type"] for step in manifest["steps"]] == ["loop", "loop"]

    def test_rejects_excessive_manifest_nesting_with_a_controlled_validation_error(self):
        nested_step: dict = {"id": "leaf", "type": "approval", "prompt": "Approve"}
        for depth in range(2000):
            nested_step = {
                "id": f"loop-{depth}",
                "type": "loop",
                "loop": {},
                "steps": [nested_step],
            }
        parsed = safe_parse_agent_manifest({"schemaVersion": "1.0", "steps": [nested_step]})
        assert not parsed.success
        assert "manifest structure depth limit" in parsed.error.issues[0]["message"]

        nested_metadata: dict = {}
        for _ in range(2000):
            nested_metadata = {"nested": nested_metadata}
        metadata_result = safe_parse_agent_manifest({"schemaVersion": "1.0", "steps": [], "metadata": nested_metadata})
        assert not metadata_result.success
        assert "manifest structure depth limit" in metadata_result.error.issues[0]["message"]

    def test_requires_an_exact_supported_schema_version(self):
        assert not safe_parse_agent_manifest({"schemaVersion": "2.0", "steps": []}).success

    def test_accepts_model_profiles_and_connection_bindings_while_rejecting_alias_collisions(self):
        assert safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "model": {"ref": "quality"},
                "connections": [{"ref": "documents", "alias": "docs", "mode": "read", "tools": ["search"]}],
                "steps": [
                    {
                        "id": "answer",
                        "type": "prompt",
                        "prompt": "Answer",
                        "tools": ["docs__search"],
                    }
                ],
            }
        ).success
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "connections": [
                    {"ref": "documents", "alias": "docs"},
                    {"ref": "other-documents", "alias": "docs"},
                ],
                "steps": [],
            }
        ).success

    def test_accepts_workspace_bindings_and_run_sandbox_code_steps_while_rejecting_alias_collisions(
        self,
    ):
        manifest = parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "connections": [{"ref": "documents", "alias": "docs"}],
                "workspaces": [
                    {"ref": "source-code", "alias": "code", "mode": "read_write"},
                    {"ref": "knowledge", "tools": ["list_files", "read_file"]},
                ],
                "steps": [
                    {
                        "id": "plan",
                        "type": "prompt",
                        "prompt": "Inspect the code.",
                        "tools": ["code__read_file", "knowledge__read_file"],
                    },
                    {
                        "id": "loop",
                        "type": "loop",
                        "loop": {"maxIterations": 1, "goal": "true"},
                        "steps": [
                            {
                                "id": "test",
                                "type": "code",
                                "language": "python",
                                "code": "print('ok')",
                                "workspaces": ["code", "knowledge"],
                            }
                        ],
                    },
                    {
                        "id": "scratch",
                        "type": "code",
                        "language": "python",
                        "code": "print('ok')",
                        "sandbox": "run",
                    },
                ],
            }
        )
        assert len(manifest["workspaces"]) == 2

        duplicate = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "workspaces": [
                    {"ref": "source-code", "alias": "code"},
                    {"ref": "other", "alias": "code"},
                ],
                "steps": [],
            }
        )
        assert not duplicate.success
        assert "Duplicate workspace alias: code" in _issues_text(duplicate)

        collision = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "connections": [{"ref": "documents", "alias": "docs"}],
                "workspaces": [{"ref": "knowledge", "alias": "docs"}],
                "steps": [],
            }
        )
        assert not collision.success
        assert "collides with a connection alias" in _issues_text(collision)

        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "workspaces": [{"ref": "knowledge", "alias": "Docs"}],
                "steps": [],
            }
        ).success

    def test_rejects_code_steps_that_mount_undeclared_repeated_or_per_step_sandbox_workspaces(self):
        def code_step(**extra):
            return {
                "id": "test",
                "type": "code",
                "language": "python",
                "code": "print('ok')",
                **extra,
            }

        undeclared = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "workspaces": [{"ref": "knowledge"}],
                "steps": [code_step(workspaces=["missing"])],
            }
        )
        assert "undeclared workspace alias: missing" in _issues_text(undeclared)
        repeated = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "workspaces": [{"ref": "knowledge"}],
                "steps": [code_step(workspaces=["knowledge", "knowledge"])],
            }
        )
        assert "more than once" in _issues_text(repeated)
        per_step = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "workspaces": [{"ref": "knowledge"}],
                "steps": [code_step(workspaces=["knowledge"], sandbox="step")],
            }
        )
        assert "cannot mount workspaces in a per-step sandbox" in _issues_text(per_step)

    def test_requires_a_sub_run_manifest_or_reference(self):
        assert not safe_parse_agent_manifest(
            {"schemaVersion": "1.0", "steps": [{"id": "child", "type": "sub-run"}]}
        ).success

    def test_rejects_ambiguous_sibling_ids_and_agent_variables(self):
        result = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "variables": [
                    {"key": "subject", "type": "string"},
                    {"key": "Subject", "type": "string"},
                ],
                "steps": [
                    {"id": "same", "type": "prompt", "prompt": "First"},
                    {"id": "same", "type": "prompt", "prompt": "Second"},
                ],
            }
        )
        assert not result.success
        messages = [issue["message"] for issue in result.error.issues]
        assert "Duplicate sibling step id: same" in messages
        assert "Duplicate agent variable: Subject" in messages

    def test_rejects_the_discontinued_final_output_steps_manifest_field(self):
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [{"id": "answer", "type": "prompt", "prompt": "Answer."}],
                "finalOutputSteps": ["answer"],
            }
        ).success

    def test_rejects_dotted_variable_keys_and_defaults_that_do_not_match_their_declared_type(self):
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "variables": [{"key": "release.name", "type": "string", "value": "AgentRuntime 1.0"}],
                "steps": [],
            }
        ).success
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "variables": [{"key": "maxWords", "type": "number", "value": "180"}],
                "steps": [],
            }
        ).success

    def test_allows_the_same_child_id_under_different_loop_parents(self):
        assert safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "first-loop",
                        "type": "loop",
                        "loop": {"maxIterations": 1},
                        "steps": [{"id": "child", "type": "prompt", "prompt": "First child"}],
                    },
                    {
                        "id": "second-loop",
                        "type": "loop",
                        "loop": {"maxIterations": 1},
                        "steps": [{"id": "child", "type": "prompt", "prompt": "Second child"}],
                    },
                ],
            }
        ).success

    @pytest.mark.parametrize(
        "output_variable",
        ["__proto__", "safe.__proto__.polluted", "constructor.prototype.polluted"],
    )
    def test_rejects_prototype_sensitive_variable_path(self, output_variable):
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "unsafe",
                        "type": "prompt",
                        "prompt": "Unsafe",
                        "outputVariable": output_variable,
                    }
                ],
            }
        ).success

    def test_rejects_dotted_output_variable_keys(self):
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "draft",
                        "type": "prompt",
                        "prompt": "Draft.",
                        "outputVariable": "brief.draft",
                    }
                ],
            }
        ).success


class TestAgentRunManifestContracts:
    def test_parses_an_agent_reference_and_runtime_variable_overrides(self):
        value = {
            "schemaVersion": "1.0",
            "agent": {"ref": "release-brief"},
            "runId": "release-brief-42",
            "variables": [{"key": "audience", "value": "partners"}],
            "execution": {"mode": "parallel", "maxConcurrency": 4},
            "budget": {"maxTotalTokens": 10_000},
        }
        assert parse_agent_run_manifest(value) == value

    def test_validates_agent_run_execution_options(self):
        assert safe_parse_agent_run_manifest(
            {
                "schemaVersion": "1.0",
                "agent": {"ref": "release-brief"},
                "execution": {"mode": "sequential"},
            }
        ).success
        assert not safe_parse_agent_run_manifest(
            {
                "schemaVersion": "1.0",
                "agent": {"ref": "release-brief"},
                "execution": {"mode": "parallel", "maxConcurrency": 0},
            }
        ).success
        assert not safe_parse_agent_run_manifest(
            {
                "schemaVersion": "1.0",
                "agent": {"ref": "release-brief"},
                "execution": {"mode": "graph"},
            }
        ).success

    def test_requires_a_positive_safe_integer_token_budget(self):
        assert safe_parse_agent_run_manifest(
            {
                "schemaVersion": "1.0",
                "agent": {"ref": "release-brief"},
                "budget": {"maxTotalTokens": 1},
            }
        ).success
        for max_total_tokens in [0, -1, 1.5, 2**53]:
            assert not safe_parse_agent_run_manifest(
                {
                    "schemaVersion": "1.0",
                    "agent": {"ref": "release-brief"},
                    "budget": {"maxTotalTokens": max_total_tokens},
                }
            ).success

    def test_requires_an_agent_reference_and_rejects_agent_definition_fields(self):
        assert not safe_parse_agent_run_manifest(
            {
                "schemaVersion": "1.0",
                "variables": [{"key": "audience", "value": "partners"}],
                "steps": [],
            }
        ).success


CHECKPOINT = {
    "id": "checkpoint-1",
    "runId": "run-1",
    "sequence": 1,
    "attempt": 1,
    "manifestHash": "sha256:test",
    "contractVersion": "1.0",
    "runtimeVersion": "0.1.0",
    "cursor": {"stepIndex": 0},
    "state": {},
    "stepResults": [],
    "transcript": [],
    "artifacts": [],
    "createdAt": "2026-07-22T12:00:00.000Z",
}


class TestRunnerCheckpointContracts:
    def test_parses_a_versioned_checkpoint_with_active_step_accumulators(self):
        parsed = parse_run_checkpoint(
            {
                **CHECKPOINT,
                "activeStepTranscript": [],
                "activeStepArtifacts": [],
                "budget": {"maxTotalTokens": 1000, "consumedTokens": 200},
            }
        )
        assert {key: parsed[key] for key in CHECKPOINT} == CHECKPOINT

    @pytest.mark.parametrize(
        "value",
        [
            {**CHECKPOINT, "sequence": 0},
            {**CHECKPOINT, "createdAt": "not-a-timestamp"},
            {**CHECKPOINT, "unexpected": True},
        ],
    )
    def test_rejects_a_malformed_or_ambiguous_checkpoint(self, value):
        with pytest.raises(ZodError):
            parse_run_checkpoint(value)

    def test_accepts_layered_execution_policies_and_rejects_prompt_only_policies_elsewhere(self):
        valid = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "policies": {
                    "context": {
                        "strategy": "summarize-or-prune",
                        "summarizer": {
                            "model": {"ref": "fast"},
                            "maxOutputTokens": 800,
                            "prompts": {"transcript": "Notes for {{ context.task }}."},
                            "summaryShare": 0.2,
                            "minSummaryBytes": 512,
                            "maxSummaryBytes": 8000,
                            "chunkBytes": 32000,
                            "maxCalls": 40,
                            "maxPasses": 3,
                        },
                        "overflowRetries": 2,
                        "trigger": {"contextRatio": 0.75, "toolRounds": 6},
                        "retain": {"recentToolRounds": 1},
                        "reduceTo": 0.25,
                        "openingShare": 0.2,
                        "maxToolResultBytes": 20000,
                        "toolResultShare": 0.3,
                        "variables": {"report.body": {"strategy": "summarize", "maxBytes": 4000}},
                    },
                    "toolCallLimit": "finalize",
                    "modelRetry": {"maxAttempts": 4, "initialDelayMs": 500},
                    "outputRepair": {"maxAttempts": 2},
                    "onError": "fail",
                },
                "steps": [
                    {
                        "id": "research",
                        "type": "prompt",
                        "prompt": "Research.",
                        "policies": {"context": {"strategy": "prune"}, "onError": "continue"},
                    },
                    {
                        "id": "review",
                        "type": "approval",
                        "prompt": "Ship?",
                        "onReject": "continue",
                        "policies": {"onError": "continue"},
                    },
                ],
            }
        )
        assert valid.success, _issues_text(valid)

        prompt_only = safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [
                    {
                        "id": "each",
                        "type": "loop",
                        "loop": {"source": "items"},
                        "steps": [
                            {
                                "id": "hook",
                                "type": "webhook",
                                "url": "https://example.test",
                                "policies": {"context": {"strategy": "prune"}},
                            }
                        ],
                    }
                ],
            }
        )
        assert not prompt_only.success
        assert "policies.context applies only to prompt steps" in _issues_text(prompt_only)

        for policies in [
            {"context": {"strategy": "shrink"}},
            {"context": {"trigger": {"contextRatio": 1.5}}},
            {"context": {"trigger": {"inputBytes": 0}}},
            {"context": {"reduceTo": 0}},
            {"context": {"reduceTo": 1}},
            {"context": {"openingShare": 1.5}},
            {"context": {"toolResultShare": 0}},
            {"context": {"summarizer": {"minSummaryBytes": 9000, "maxSummaryBytes": 2000}}},
            {"context": {"summarizer": {"chunkBytes": 10}}},
            {"context": {"summarizer": {"maxPasses": 0}}},
            {"context": {"summarizer": {"prompts": {"other": "x"}}}},
            {"context": {"overflowRetries": 11}},
            {"modelRetry": {"maxAttempts": 0}},
            {"onError": "ignore"},
            {"context": {"unknown": True}},
        ]:
            assert not safe_parse_agent_manifest({"schemaVersion": "1.0", "policies": policies, "steps": []}).success, (
                policies
            )
        assert not safe_parse_agent_manifest(
            {
                "schemaVersion": "1.0",
                "steps": [{"id": "a", "type": "approval", "prompt": "?", "onReject": "ignore"}],
            }
        ).success
