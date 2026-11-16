"""The persistence-neutral Agent Runtime (``packages/core/src/agent-runtime.ts``)."""

from __future__ import annotations

import asyncio
import copy
import functools
import hashlib
import inspect
import re
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

from .._js import json as js_json
from .._js import strings as js_strings
from .._js import yaml as js_yaml
from .._js.abort import AbortController, AbortSignal
from .._js.collation import locale_compare
from .._js.errors import Error, error_message
from .._js.ops import UNDEFINED
from ..contracts import (
    RUN_CHECKPOINT_CONTRACT_VERSION,
    RUN_CHECKPOINT_CONTRACT_VERSIONS,
    agent_manifest_schema,
    agent_run_budget_schema,
    parse,
    parse_agent_run_manifest,
    parse_run_checkpoint,
    run_limits_schema,
    safe_parse,
    value_matches_agent_variable_type,
)
from .errors import (
    AgentRuntimeError,
    RunCancelledError,
    RunInterruptedError,
    RunSuspendedError,
    create_error_suspension,
    create_limit_suspension,
    create_run_pause_request,
    interruption_reason,
    is_control_flow_error,
    is_fatal_run_error,
    is_run_cancelled_error,
    is_run_interrupted_error,
    is_run_suspended_error,
    suspension_kind,
    to_run_error,
)
from .execution_plan import build_execution_waves
from .limits import RunLedgerTracker, resolve_run_limits, seeded_ledger
from .messages import (
    HistorySelection,
    MessageHistoryCompactionRequest,
    MessagesOptions,
    compaction_label,
    declares_messages,
    history_bytes,
    output_history,
    plan_history_compaction,
    prepare_supplied_history,
    prune_marker_message,
    render_history_text,
    select_history,
    summary_marker_message,
    with_messages_view,
    without_messages_patch,
    without_messages_view,
)
from .policies import merge_execution_policies, resolve_step_policies
from .ports import ResolvedWorkspace, crypto_id_generator, restrict_workspace, system_clock
from .state import apply_state_patch, snapshot_state
from .version import RUNTIME_VERSION

JsonObject = dict[str, Any]

__all__ = [
    "AgentRuntime",
    "AgentRuntimeError",
    "RunCancelledError",
    "RunInterruptedError",
    "RunSuspendedError",
    "StepExecutionContext",
    "StepHistoryContext",
    "StepPreflightContext",
    "aggregate_model_usage",
    "assess_manifest_change",
    "child_execution_key",
    "create_run_pause_request",
    "default_manifest_hasher",
    "fingerprint_manifest",
    "merge_workspace_changes",
    "resolve_agent_variables",
    "resolve_agent_workspaces",
    "select_run_output",
]


async def maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _count_manifest_steps(steps: list[JsonObject]) -> int:
    pending = list(steps)
    count = 0
    while pending:
        step = pending.pop()
        count += 1
        if step["type"] == "loop":
            pending.extend(step["steps"])
    return count


# ─── Step execution contracts ───────────────────────────────────────────────


@dataclass
class StepHistoryContext:
    """One step's view of the run's conversation history."""

    messages: list[JsonObject]
    places: list[JsonObject | None]
    turn: int
    explicit: bool
    insert: bool
    media: str
    sign: Callable[[list[JsonObject]], Awaitable[JsonObject | None]]
    scope: str | None = None


@dataclass
class StepExecutionContext:
    """What a step executor receives (``StepExecutionContext``).

    ``execute`` returns a ``StepExecutionResult`` dictionary:
    ``{output?, statePatch?, transcript?, artifacts?, metadata?, endRun?}``.
    """

    run_id: str
    manifest: JsonObject
    step: JsonObject
    step_index: int
    variables: JsonObject
    emit: Callable[..., Awaitable[JsonObject]]
    step_path: str | None = None
    execution_key: str | None = None
    step_results: list[JsonObject] | None = None
    signal: AbortSignal | None = None
    model: Any = None
    tools: Any = None
    artifacts: Any = None
    approvals: Any = None
    sandbox: Any = None
    sub_runs: Any = None
    workspaces: list[ResolvedWorkspace] | None = None
    run_sandbox: Callable[[], Awaitable[Any]] | None = None
    token_budget: Any = None
    limits: JsonObject | None = None
    policies: JsonObject | None = None
    summarizer: Any = None
    history: StepHistoryContext | None = None
    resume: JsonObject | None = None
    execute_child: Callable[..., Awaitable[JsonObject]] | None = None
    checkpoint: Callable[[JsonObject], Awaitable[None]] | None = None
    evaluate_condition: Callable[[str, JsonObject], Awaitable[bool]] | None = None

    def with_(self, **changes: Any) -> StepExecutionContext:
        """``{...context, ...changes}``."""
        return replace(self, **changes)


@dataclass
class StepPreflightContext:
    manifest: JsonObject
    model: Any = None
    tools: Any = None
    artifacts: Any = None
    approvals: Any = None
    sandbox: Any = None
    sub_runs: Any = None
    run_sandbox: Any = None


class StepExecutor(Protocol):
    type: str

    async def execute(self, context: StepExecutionContext) -> JsonObject: ...


class ConditionEvaluator(Protocol):
    def evaluate(self, expression: str, variables: JsonObject) -> bool | Awaitable[bool]: ...


class ManifestHasher(Protocol):
    def hash(self, manifest: JsonObject) -> str | Awaitable[str]: ...


# ─── Manifest hashing ───────────────────────────────────────────────────────


def stable_stringify(value: Any) -> str:
    """Keys ordered with ``localeCompare`` (ICU), as the TypeScript hasher does."""
    if isinstance(value, list):
        return "[" + ",".join(stable_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = sorted(js_json.js_entries(value), key=functools.cmp_to_key(lambda a, b: locale_compare(a[0], b[0])))
        return "{" + ",".join(js_json.stringify(key) + ":" + stable_stringify(item) for key, item in entries) + "}"
    return js_json.stringify(value)


class _DefaultManifestHasher:
    """A deterministic cryptographic manifest fingerprint for checkpoint safety."""

    def hash(self, manifest: JsonObject) -> str:
        digest = hashlib.sha256(stable_stringify(manifest).encode("utf-8", "surrogatepass")).hexdigest()
        return f"sha256:{digest}"


default_manifest_hasher = _DefaultManifestHasher()


def child_execution_key(parent_key: str, child_id: str, frame: JsonObject | None = None) -> str:
    return (
        f"{parent_key}[{frame['key']}]/{child_id}"
        if frame and frame.get("key") is not None
        else f"{parent_key}/{child_id}"
    )


def _fingerprinted_step(step: JsonObject) -> JsonObject:
    result = {key: value for key, value in step.items() if key not in ("policies", "name", "description", "metadata")}
    if step["type"] == "loop":
        result["steps"] = [_fingerprinted_step(child) for child in step["steps"]]
    return result


def _sha256(value: Any) -> str:
    return "sha256:" + hashlib.sha256(stable_stringify(value).encode("utf-8", "surrogatepass")).hexdigest()


async def fingerprint_manifest(manifest: JsonObject) -> JsonObject:
    return {
        "global": _sha256(
            {key: manifest.get(key) for key in ("variables", "connections", "workspaces", "messages", "extensions")}
        ),
        "steps": [_sha256(_fingerprinted_step(step)) for step in manifest["steps"]],
    }


def _classify_manifest_change(
    manifest: JsonObject, checkpoint: JsonObject, current: JsonObject, hash_matches: bool
) -> JsonObject:
    saved = checkpoint.get("fingerprints")
    if not saved:
        return {
            "outcome": "unchanged" if hash_matches else "refused",
            "changedSteps": [],
            "globalChanged": False,
            "reason": (
                "The manifest is the one the checkpoint was written with."
                if hash_matches
                else "The checkpoint predates step fingerprints, so only the same manifest can resume it."
            ),
        }
    changed = [
        step["id"]
        for index, step in enumerate(manifest["steps"])
        if index >= len(saved["steps"]) or saved["steps"][index] != current["steps"][index]
    ]
    changed.extend(f"#{index + 1}" for index in range(len(current["steps"]), len(saved["steps"])))
    global_changed = saved["global"] != current["global"]
    base = {"changedSteps": changed, "globalChanged": global_changed}
    if global_changed:
        return {
            "outcome": "refused",
            **base,
            "reason": "It changes variables, connections, workspaces, messages, or extensions, which completed steps depend on.",
        }
    cursor = checkpoint["cursor"]["stepIndex"]
    for index in range(cursor):
        if (
            index >= len(saved["steps"])
            or index >= len(current["steps"])
            or saved["steps"][index] != current["steps"][index]
        ):
            step_id = manifest["steps"][index]["id"] if index < len(manifest["steps"]) else f"#{index + 1}"
            return {
                "outcome": "refused",
                **base,
                "step": step_id,
                "reason": f"Step {step_id} already completed and its definition changed.",
            }
    in_progress = bool(
        checkpoint.get("continuation")
        or checkpoint.get("activeStepTranscript")
        or checkpoint.get("activeStepArtifacts")
        or checkpoint["cursor"].get("stepPath")
    )
    if cursor < len(manifest["steps"]) and in_progress and saved["steps"][cursor] != current["steps"][cursor]:
        step_id = manifest["steps"][cursor]["id"]
        if (checkpoint.get("continuation") or {}).get("type") == "loop":
            return {
                "outcome": "refused",
                **base,
                "step": step_id,
                "reason": f"Loop step {step_id} changed while it was in progress, and its saved state reflects iterations already run.",
            }
        return {
            "outcome": "restarts-step",
            **base,
            "step": step_id,
            "reason": f"Step {step_id} was in progress and changed; it runs again from its start.",
        }
    if not changed and hash_matches:
        return {"outcome": "unchanged", **base, "reason": "The manifest is the one the checkpoint was written with."}
    return {
        "outcome": "accepted",
        **base,
        "reason": (
            f"Only steps with no completed work changed ({', '.join(changed)})."
            if changed
            else "Only fields a resume may change differ, such as limits or policies."
        ),
    }


async def assess_manifest_change(
    checkpoint: JsonObject, manifest: JsonObject, manifest_hasher: ManifestHasher | None = None
) -> JsonObject:
    parsed = parse(agent_manifest_schema, manifest)
    saved = parse_run_checkpoint(checkpoint)
    return _classify_manifest_change(
        parsed,
        saved,
        await fingerprint_manifest(parsed),
        saved["manifestHash"] == await maybe_await((manifest_hasher or default_manifest_hasher).hash(parsed)),
    )


def _reconcile_manifest_change(
    run_id: str, manifest: JsonObject, checkpoint: JsonObject, current: JsonObject, hash_matches: bool
) -> tuple[JsonObject, str | None]:
    assessment = _classify_manifest_change(manifest, checkpoint, current, hash_matches)
    if assessment["outcome"] == "refused":
        if not checkpoint.get("fingerprints"):
            raise Error(f"Manifest does not match checkpoint for run {run_id}")
        reason = assessment["reason"]
        advice = (
            "Start a new run, or restore those fields."
            if assessment["globalChanged"]
            else "Restart the run from a step before it, or restore the step."
        )
        raise AgentRuntimeError(
            f"Manifest does not match checkpoint for run {run_id}: {reason[0].lower()}{reason[1:-1]}. {advice}",
            "MANIFEST_CHANGED",
        )
    if assessment["outcome"] != "restarts-step":
        return checkpoint, None
    clean = {
        key: copy.deepcopy(value)
        for key, value in checkpoint.items()
        if key not in ("continuation", "activeStepTranscript", "activeStepArtifacts")
    }
    clean["cursor"] = {"stepIndex": checkpoint["cursor"]["stepIndex"]}
    clean["transcript"] = _without_active_tail(checkpoint["transcript"], checkpoint.get("activeStepTranscript"))
    clean["artifacts"] = _without_active_tail(checkpoint["artifacts"], checkpoint.get("activeStepArtifacts"))
    return clean, assessment["step"]


def merge_workspace_changes(earlier: list[JsonObject], later: list[JsonObject]) -> list[JsonObject]:
    merged = {change["path"]: dict(change) for change in earlier}
    for change in later:
        before = merged.get(change["path"])
        if before and before["action"] == "created" and change["action"] == "deleted":
            del merged[change["path"]]
        elif before and before["action"] == "created":
            merged[change["path"]] = {**change, "action": "created"}
        elif before and before["action"] == "deleted" and change["action"] == "created":
            merged[change["path"]] = {**change, "action": "modified"}
        else:
            merged[change["path"]] = dict(change)
    return list(merged.values())


def _blocked_record(error: RunSuspendedError, at: str) -> JsonObject:
    details = error.details or {}
    step_id = details.get("stepId")
    if details.get("cause") == "limit":
        limit = str(details.get("limit", "limit"))
        used, value = details.get("used"), details.get("value")
        record: JsonObject = {
            "cause": "limit",
            "code": limit,
            "message": f"The run reached its {limit} limit"
            + (f" of {value}" if value is not None else "")
            + (f" (used {used})" if used is not None else "")
            + ". Grant a higher limit to resume.",
        }
        if isinstance(used, (int, float)) and not isinstance(used, bool):
            record["used"] = used
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            record["value"] = value
    else:
        run_error = details.get("error") or {}
        record = {
            "cause": "error",
            "code": str(run_error.get("code", "AGENT_EXECUTION_FAILED")),
            "message": str(run_error.get("message", str(error))),
        }
        for key in ("retryable", "details"):
            if key in run_error:
                record[key] = run_error[key]
    if isinstance(step_id, str):
        record["stepId"] = step_id
    record["at"] = at
    return record


# ─── Helpers ────────────────────────────────────────────────────────────────


def _handled_error_result(step: JsonObject, error: JsonObject) -> JsonObject:
    output = {"error": {"code": error["code"], "message": error["message"]}}
    result: JsonObject = {"output": output}
    if step.get("outputVariable"):
        result["statePatch"] = {"set": {step["outputVariable"]: output}}
    result["metadata"] = {
        "failed": True,
        "handled": True,
        "error": {"code": error["code"], "message": error["message"]},
    }
    return result


class TopLevelStepExecutionError(Error):
    name = "TopLevelStepExecutionError"

    def __init__(self, step: JsonObject, cause: BaseException) -> None:
        super().__init__(error_message(cause))
        self.step = step
        self.cause = cause


def _assert_parallel_wave_state_patches(outcomes: list[JsonObject]) -> None:
    if len(outcomes) < 2:
        return
    for outcome in outcomes:
        result = outcome.get("result")
        if outcome["skipped"] or result is None or result.get("statePatch") is None:
            continue
        patch = result["statePatch"]
        allowed = outcome["step"].get("outputVariable")
        writes = list((patch.get("set") or {}).keys())
        if any(key != allowed for key in writes) or len(patch.get("unset") or []) > 0:
            raise Error(f"Parallel step {outcome['step']['id']} attempted to mutate state outside its outputVariable")


def resolve_agent_variables(manifest: JsonObject, supplied: list[JsonObject] | None) -> JsonObject:
    definitions = manifest.get("variables") or []
    by_key = {definition["key"]: definition for definition in definitions}
    state: JsonObject = {}
    for definition in definitions:
        if "value" in definition:
            state[definition["key"]] = copy.deepcopy(definition["value"])
    override_keys: set[str] = set()
    for override in supplied or []:
        normalized = js_strings.lower(override["key"])
        if normalized in override_keys:
            raise Error(f"Duplicate run variable override: {override['key']}")
        override_keys.add(normalized)
        definition = by_key.get(override["key"])
        if definition is None:
            raise Error(f"Run variable is not declared by the agent: {override['key']}")
        if not value_matches_agent_variable_type(override["value"], definition["type"]):
            raise Error(f"Run variable {override['key']} must be {definition['type']}")
        state[definition["key"]] = copy.deepcopy(override["value"])
    missing = [
        definition["key"]
        for definition in definitions
        if definition.get("requiresOverride") is True and js_strings.lower(definition["key"]) not in override_keys
    ]
    if missing:
        raise Error(f"Missing required runtime variable overrides: {', '.join(missing)}")
    return state


async def resolve_agent_workspaces(
    manifest: JsonObject, provider: Any, context: JsonObject | None = None
) -> list[ResolvedWorkspace]:
    """Resolve workspace bindings against the host provider (narrowing only)."""
    resolved: list[ResolvedWorkspace] = []
    for binding in manifest.get("workspaces") or []:
        alias = binding.get("alias") if binding.get("alias") is not None else binding["ref"]
        store = await provider.resolve_workspace(binding, context or {}) if provider is not None else None
        if store is None:
            if binding.get("required") is False:
                continue
            raise Error(
                f'Unknown workspace "{binding["ref"]}".'
                if provider is not None
                else f'Workspace "{binding["ref"]}" requires a WorkspaceProvider.'
            )
        if store.mode == "read" and binding.get("mode") == "read_write":
            raise Error(f'Workspace "{binding["ref"]}" is read-only and cannot be elevated by an agent.')
        mode = binding.get("mode") or store.mode
        resolved.append(
            ResolvedWorkspace(binding=binding, alias=alias, mode=mode, store=restrict_workspace(store, mode))
        )
    return resolved


def _steps_use_run_sandbox(steps: list[JsonObject]) -> bool:
    return any(
        (step["type"] == "code" and (step.get("sandbox") == "run" or len(step.get("workspaces") or []) > 0))
        or (step["type"] == "loop" and _steps_use_run_sandbox(step["steps"]))
        for step in steps
    )


def _is_safe_integer(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and float(value).is_integer()
        and abs(value) <= js_json.MAX_SAFE_INTEGER
    )


def _sandbox_budget_from_checkpoint(checkpoint: JsonObject | None) -> JsonObject | None:
    value = ((checkpoint or {}).get("metadata") or {}).get("sandboxBudget")
    if (
        not isinstance(value, dict)
        or not _is_safe_integer(value.get("commandsUsed"))
        or not isinstance(value.get("sandboxSecondsUsed"), (int, float))
        or isinstance(value.get("sandboxSecondsUsed"), bool)
    ):
        return None
    return {"commandsUsed": value["commandsUsed"], "sandboxSecondsUsed": value["sandboxSecondsUsed"]}


def _json_byte_length(value: Any) -> int:
    return js_json.byte_length(value)


def _assert_recoverable_checkpoint(checkpoint: JsonObject, run_id: str, manifest: JsonObject, run_attempt: int) -> None:
    checkpoint = parse_run_checkpoint(checkpoint)
    if checkpoint["runId"] != run_id:
        raise Error(f"Checkpoint does not belong to run {run_id}")
    if not _is_safe_integer(checkpoint["sequence"]) or checkpoint["sequence"] < 1:
        raise Error(f"Checkpoint sequence for run {run_id} must be a positive safe integer")
    attempt = checkpoint.get("attempt", 1)
    if not _is_safe_integer(attempt) or attempt < 1 or attempt > run_attempt:
        raise Error(f"Checkpoint attempt for run {run_id} is not recoverable")
    if checkpoint["contractVersion"] not in RUN_CHECKPOINT_CONTRACT_VERSIONS:
        raise Error(f"Unsupported checkpoint contract version {checkpoint['contractVersion']}")
    cursor = checkpoint.get("cursor")
    steps = manifest["steps"]
    if (
        cursor is None
        or not _is_safe_integer(cursor.get("stepIndex"))
        or cursor["stepIndex"] < 0
        or cursor["stepIndex"] > len(steps)
    ):
        raise Error(f"Checkpoint cursor for run {run_id} is outside the manifest")
    if cursor["stepIndex"] < len(steps):
        active_top_level = steps[cursor["stepIndex"]].get("id")
        active_path = cursor.get("stepPath") if cursor.get("stepPath") is not None else cursor.get("stepId")
        if (
            active_top_level
            and active_path
            and active_path != active_top_level
            and not active_path.startswith(f"{active_top_level}/")
        ):
            raise Error(f"Checkpoint active step does not match the manifest for run {run_id}")
    if (
        not isinstance(checkpoint.get("state"), dict)
        or not isinstance(checkpoint.get("stepResults"), list)
        or not isinstance(checkpoint.get("transcript"), list)
        or not isinstance(checkpoint.get("artifacts"), list)
    ):
        raise Error(f"Checkpoint payload for run {run_id} is malformed")
    for name, active, complete in (
        ("transcript", checkpoint.get("activeStepTranscript"), checkpoint["transcript"]),
        ("artifacts", checkpoint.get("activeStepArtifacts"), checkpoint["artifacts"]),
    ):
        if active is None:
            continue
        if not isinstance(active, list) or len(active) > len(complete):
            raise Error(f"Checkpoint active-step {name} for run {run_id} is malformed")
        committed_tail = complete[len(complete) - len(active) :]
        if js_json.stringify(committed_tail) != js_json.stringify(active):
            raise Error(f"Checkpoint active-step {name} for run {run_id} is inconsistent")


def _without_active_tail(complete: list[Any], active: list[Any] | None) -> list[Any]:
    return complete[: -len(active)] if active else complete


def _runtime_extension(value: Any) -> JsonObject | None:
    if isinstance(value, dict) and isinstance(value.get("agentRuntime"), dict):
        return value["agentRuntime"]
    return None


def _uses_step_output_state_projection(manifest: JsonObject) -> bool:
    return (_runtime_extension(manifest.get("extensions")) or {}).get("stateProjection") == "step-output-state-v1"


_FENCE = re.compile(r"^```([^\n\r]*)\r?\n([\s\S]*?)\r?\n```$")


def _parse_structured_output(value: Any) -> Any:
    if not isinstance(value, str):
        return copy.deepcopy(value)
    stripped = js_strings.trim(value)
    fence = _FENCE.fullmatch(stripped)
    if fence:
        language = js_strings.lower(js_strings.trim(fence.group(1) or ""))
        if language in ("json", "yaml", "yml", ""):
            stripped = js_strings.trim(fence.group(2) or "")
            if language in ("yaml", "yml"):
                try:
                    parsed = js_yaml.parse(stripped)
                except js_yaml.YamlParseError:
                    return value
                if isinstance(parsed, (dict, list)):
                    return parsed
    if not stripped.startswith("{") and not stripped.startswith("["):
        return value
    try:
        return js_json.parse(stripped)
    except ValueError:
        return value


def _with_projected_step_state(
    manifest: JsonObject, step: JsonObject, step_index: int, result: JsonObject
) -> JsonObject:
    if not _uses_step_output_state_projection(manifest) or "output" not in result:
        return result
    projected = _parse_structured_output(result["output"])
    extension = _runtime_extension(step.get("extensions")) or {}
    state_key = str(extension["stateKey"]) if isinstance(extension.get("stateKey"), str) else f"step-{step_index + 1}"
    patch = result.get("statePatch") or {}
    updates: JsonObject = {**(patch.get("set") or {}), state_key: projected, "step-previous": projected}
    if step.get("outputVariable"):
        updates[step["outputVariable"]] = projected
    return {**result, "statePatch": {**patch, "set": updates}}


def _stringify_output(value: Any) -> str:
    if value is None or value is UNDEFINED:
        return ""
    return value if isinstance(value, str) else js_json.stringify(value)


def select_run_output(manifest: JsonObject, step_results: list[JsonObject]) -> Any:
    """The run output, or ``UNDEFINED``."""
    selected_ids = [step["id"] for step in manifest["steps"] if step.get("includeInFinalOutput") is True]
    last_output = step_results[-1].get("output", UNDEFINED) if step_results else UNDEFINED
    if not selected_ids:
        return last_output
    outputs = []
    for step_id in selected_ids:
        found = next((result for result in step_results if result["stepId"] == step_id), None)
        if found is not None and "output" in found:
            outputs.append(found["output"])
    if not outputs:
        return last_output
    if _uses_step_output_state_projection(manifest):
        selected = [text for text in map(_stringify_output, outputs) if text != ""]
        if selected:
            return "\n\n".join(selected)
        for result in reversed(step_results):
            steps = manifest["steps"]
            step = steps[result["stepIndex"]] if result["stepIndex"] < len(steps) else None
            if step is not None and step["type"] in ("webhook", "approval"):
                continue
            fallback = _stringify_output(result.get("output", UNDEFINED))
            if fallback != "":
                return fallback
        return ""
    return outputs[0] if len(outputs) == 1 else outputs


_USAGE_KEYS = (
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "totalTokens",
    "estimatedCost",
)


def aggregate_model_usage(transcript: list[JsonObject]) -> JsonObject | None:
    usages = [item["usage"] for item in transcript if item.get("usage")]
    if not usages:
        return None
    result: JsonObject = {}
    for key in _USAGE_KEYS:
        values = [
            usage[key]
            for usage in usages
            if isinstance(usage.get(key), (int, float)) and not isinstance(usage.get(key), bool)
        ]
        if values:
            total: Any = 0
            for value in values:
                total = total + value
            result[key] = js_json.normalize(total)
    return result


def _reported_total_tokens(usage: JsonObject) -> Any:
    if usage.get("totalTokens") is not None:
        return usage["totalTokens"]
    if usage.get("inputTokens") is None and usage.get("outputTokens") is None:
        return None
    return (usage.get("inputTokens") or 0) + (usage.get("outputTokens") or 0)


def _consumed_tokens_from_transcript(transcript: list[JsonObject]) -> Any:
    total: Any = 0
    for item in transcript:
        reported = _reported_total_tokens(item["usage"]) if item.get("usage") else None
        total += reported or 0
    return total


class RunTokenBudget:
    """Cumulative model-token budget (``TokenBudgetContext``)."""

    def __init__(self, state: JsonObject) -> None:
        self.max_total_tokens = state["maxTotalTokens"]
        self._consumed = state["consumedTokens"]

    @property
    def consumed_tokens(self) -> int:
        return self._consumed

    def consume(self, usage: JsonObject) -> JsonObject:
        tokens = _reported_total_tokens(usage)
        if tokens is None:
            raise Error("A budgeted model call must report totalTokens or inputTokens/outputTokens")
        if not _is_safe_integer(tokens) or tokens < 0:
            raise Error("Budgeted model token usage must be a non-negative safe integer")
        self._consumed = js_json.normalize(self._consumed + tokens)
        if not _is_safe_integer(self._consumed):
            raise Error("Cumulative model token usage exceeds the safe integer range")
        return self.snapshot()

    def snapshot(self) -> JsonObject:
        return {"maxTotalTokens": self.max_total_tokens, "consumedTokens": self._consumed}


_REQUEST_KEYS = {
    "agent_run_manifest": "agentRunManifest",
    "manifest": "manifest",
    "manifest_reference": "manifestReference",
    "run_id": "runId",
    "variables": "variables",
    "execution": "execution",
    "budget": "budget",
    "limits": "limits",
    "messages": "messages",
    "messages_signature": "messagesSignature",
    "messages_scope": "messagesScope",
    "signal": "signal",
    "resume": "resume",
    "allow_running_takeover": "allowRunningTakeover",
}


def _truthy(value: Any) -> bool:
    from .._js.ops import truthy

    return value is not UNDEFINED and truthy(value)


# ─── The runtime ────────────────────────────────────────────────────────────


@dataclass
class AgentRuntimeDependencies:
    run_store: Any
    step_executors: Iterable[Any]
    agent_manifest_source: Any = None
    event_sinks: list[Any] = field(default_factory=list)
    model: Any = None
    tools: Any = None
    artifacts: Any = None
    approvals: Any = None
    sandbox: Any = None
    sub_runs: Any = None
    workspaces: Any = None
    run_sandbox: Any = None
    condition_evaluator: Any = None
    clock: Any = None
    id_generator: Any = None
    manifest_hasher: Any = None
    runtime_version: str | None = None
    max_parallel_steps: int | None = None
    policies: JsonObject | None = None
    enforced_policies: JsonObject | None = None
    limits: JsonObject | None = None
    enforced_limits: JsonObject | None = None
    summarizer: Any = None
    messages: MessagesOptions | None = None
    event_sink_failure_policy: str | None = None
    on_event_sink_error: Callable[[BaseException, JsonObject, Any], None] | None = None


class AgentRuntime:
    """Persistence-neutral Agent Runtime with ordered commits."""

    def __init__(self, dependencies: AgentRuntimeDependencies | None = None, **options: Any) -> None:
        if dependencies is None:
            dependencies = AgentRuntimeDependencies(**options)
        elif options:
            dependencies = replace(dependencies, **options)
        self._deps = dependencies
        self._clock = dependencies.clock or system_clock
        self._ids = dependencies.id_generator or crypto_id_generator
        self._manifest_hasher = dependencies.manifest_hasher or default_manifest_hasher
        self._executors: dict[str, Any] = {}
        self._event_sequences: dict[str, int] = {}
        self._event_locks: dict[str, asyncio.Lock] = {}
        self._checkpoint_sequences: dict[str, int] = {}
        self._run_attempts: dict[str, int] = {}
        self._run_token_budgets: dict[str, RunTokenBudget] = {}
        self._run_ledgers: dict[str, RunLedgerTracker] = {}
        self._run_limits: dict[str, JsonObject] = {}
        self._run_fingerprints: dict[str, JsonObject] = {}
        self._run_workspaces: dict[str, list[ResolvedWorkspace]] = {}
        self._run_workspace_state: dict[str, JsonObject] = {}
        self._run_inputs: dict[str, JsonObject] = {}
        self._run_pending_not_persisted: dict[str, dict[str, list[JsonObject]]] = {}
        self._run_limit_controllers: dict[str, AbortController] = {}
        self._run_timer_handles: dict[str, set[asyncio.TimerHandle]] = {}
        self._active_run_ids: set[str] = set()
        self._run_sandbox_openings: dict[str, asyncio.Future[Any]] = {}
        self._run_sandbox_sessions: dict[str, Any] = {}
        self._run_messages: dict[str, JsonObject] = {}
        for executor in dependencies.step_executors:
            if executor.type in self._executors:
                raise Error(f"Duplicate step executor registered for {executor.type}")
            self._executors[executor.type] = executor

    @property
    def dependencies(self) -> AgentRuntimeDependencies:
        return self._deps

    def _now(self) -> str:
        from .._js.time import to_iso

        return to_iso(self._clock.now())

    def _seeded_checkpoint(
        self, run_id: str, source: JsonObject, seed: JsonObject, fingerprints: JsonObject
    ) -> JsonObject:
        checkpoint = {
            key: copy.deepcopy(value)
            for key, value in source.items()
            if key not in ("ledger", "budget", "metadata", "workspaces")
        }
        tokens: JsonObject = {}
        for alias, entry in (source.get("workspaces") or {}).items():
            if entry.get("token"):
                tokens[alias] = {"token": entry["token"]}
                if entry.get("stepPath"):
                    tokens[alias]["stepPath"] = entry["stepPath"]
        checkpoint.update(
            {
                "id": self._ids.generate_id("checkpoint"),
                "runId": run_id,
                "sequence": 1,
                "attempt": 1,
                "contractVersion": RUN_CHECKPOINT_CONTRACT_VERSION,
                "runtimeVersion": self._deps.runtime_version or RUNTIME_VERSION,
                "ledger": {**seeded_ledger(source), "progress": 1},
                "fingerprints": copy.deepcopy(fingerprints),
                "createdAt": self._now(),
            }
        )
        if tokens:
            checkpoint["workspaces"] = tokens
        checkpoint["metadata"] = {
            **{
                key: value
                for key, value in (source.get("metadata") or {}).items()
                if key not in ("sandboxBudget", "workspaceSync")
            },
            "seededFrom": {
                "runId": seed["runId"],
                "checkpointId": seed["id"],
                "checkpointSequence": seed["sequence"],
                "stepPath": seed["boundary"]["stepPath"],
            },
        }
        return checkpoint

    async def run(self, request: JsonObject | None = None, /, **options: Any) -> JsonObject:
        """Run or resume an agent. ``request`` uses the TypeScript ``RunRequest`` keys;
        keyword options use their snake_case names."""
        merged: JsonObject = dict(request or {})
        for key, value in options.items():
            merged[_REQUEST_KEYS.get(key, key)] = value
        normalized = merged
        if merged.get("agentRunManifest") is not None:
            if any(
                _truthy(merged.get(key))
                for key in (
                    "resume",
                    "seed",
                    "manifest",
                    "manifestReference",
                    "variables",
                    "runId",
                    "execution",
                    "budget",
                    "messages",
                    "messagesSignature",
                )
            ):
                raise Error(
                    "agentRunManifest cannot be combined with resume, manifest, manifestReference, variables, runId, execution, budget, messages, or messagesSignature"
                )
            run_manifest = parse_agent_run_manifest(merged["agentRunManifest"])
            host_options = {key: value for key, value in merged.items() if key != "agentRunManifest"}
            normalized = {**host_options, "manifestReference": run_manifest["agent"]["ref"]}
            for key in ("runId", "variables", "execution", "budget", "messages", "messagesSignature"):
                if _truthy(run_manifest.get(key, UNDEFINED)):
                    normalized[key] = run_manifest[key]
        if _truthy(normalized.get("resume")) and not normalized.get("runId"):
            raise Error("A runId is required to resume a run")
        if normalized.get("seed") is not None and (
            normalized.get("resume")
            or normalized.get("variables") is not None
            or normalized.get("messages") is not None
            or normalized.get("messagesSignature") is not None
        ):
            raise Error(
                "A seeded run takes its state and history from the seed; it cannot be combined with resume, variables, or messages"
            )
        if _truthy(normalized.get("resume")) and normalized.get("variables") is not None:
            raise Error("Run variable overrides cannot be supplied when resuming a run")
        if _truthy(normalized.get("resume")) and (
            normalized.get("messages") is not None
            or normalized.get("messagesSignature") is not None
            or normalized.get("messagesScope") is not None
        ):
            raise Error("Conversation messages cannot be supplied when resuming a run")
        run_id = normalized["runId"] if normalized.get("runId") is not None else self._ids.generate_id("run")
        if run_id in self._active_run_ids:
            raise Error(f"Run {run_id} is already active in this Agent Runtime process")
        self._active_run_ids.add(run_id)
        try:
            return await self._run({**normalized, "runId": run_id})
        finally:
            self._active_run_ids.discard(run_id)
            self._forget_run(run_id)
            self._run_token_budgets.pop(run_id, None)
            self._run_ledgers.pop(run_id, None)
            self._run_limits.pop(run_id, None)
            self._run_fingerprints.pop(run_id, None)
            self._run_workspaces.pop(run_id, None)
            self._run_workspace_state.pop(run_id, None)
            self._run_inputs.pop(run_id, None)
            self._run_pending_not_persisted.pop(run_id, None)
            self._run_limit_controllers.pop(run_id, None)
            for timer in self._run_timer_handles.pop(run_id, set()):
                timer.cancel()
            self._run_sandbox_openings.pop(run_id, None)
            self._run_sandbox_sessions.pop(run_id, None)
            self._run_messages.pop(run_id, None)

    def _forget_run(self, run_id: str) -> None:
        self._event_sequences.pop(run_id, None)
        self._event_locks.pop(run_id, None)
        self._checkpoint_sequences.pop(run_id, None)
        self._run_attempts.pop(run_id, None)

    async def preflight(self, manifest: JsonObject) -> None:
        """Check, without creating a run, that a manifest can run with this host."""
        await self._preflight(self._parse_manifest(manifest))

    def _parse_manifest(self, raw: Any) -> JsonObject:
        parsed = safe_parse(agent_manifest_schema, raw)
        if not parsed.success:
            assert parsed.error is not None
            reasons = "; ".join(issue["message"] for issue in parsed.error.issues)
            raise Error(f"Agent manifest is invalid: {reasons}")
        manifest = parsed.data
        count = _count_manifest_steps(manifest["steps"])
        max_steps = (manifest.get("limits") or {}).get("maxSteps")
        if max_steps is not None and count > max_steps:
            raise Error(f"Manifest declares {count} steps, exceeding its {max_steps}-step limit")
        return manifest

    async def _run(self, request: JsonObject) -> JsonObject:
        deps = self._deps
        run_id: str = request["runId"]
        limit_controller = AbortController()
        self._run_limit_controllers[run_id] = limit_controller
        request = {
            **request,
            "signal": AbortSignal.any([request["signal"], limit_controller.signal])
            if request.get("signal") is not None
            else limit_controller.signal,
        }
        resume = _truthy(request.get("resume"))
        signal: AbortSignal | None = request.get("signal")
        existing = await deps.run_store.load_run(run_id) if resume else None
        if resume and not existing:
            raise Error(f"Run {run_id} does not exist")
        if existing and existing.get("status") in ("completed", "cancelled"):
            raise Error(f"Run {run_id} is already {existing['status']}")

        if request.get("manifest") is not None:
            raw_manifest = request["manifest"]
        elif request.get("manifestReference"):
            raw_manifest = await self._resolve_manifest(request)
        elif existing is not None and existing.get("manifest") is not None:
            raw_manifest = existing["manifest"]
        else:
            raw_manifest = await self._resolve_manifest(request)
        manifest = self._parse_manifest(raw_manifest)
        requested_budget = (
            parse(agent_run_budget_schema, request["budget"]) if request.get("budget") is not None else None
        )
        latest = await deps.run_store.load_latest_checkpoint(run_id) if resume else None
        if resume and not latest:
            raise Error(f"Run {run_id} has no checkpoint to resume")
        seed = parse_run_checkpoint(request["seed"]) if request.get("seed") is not None else None
        if seed is not None and not seed.get("boundary"):
            raise AgentRuntimeError(
                "A run can only be seeded from a step-completion checkpoint (one with a boundary); list them with RunStore.listCheckpoints(runId, { boundaries: true }).",
                "SEED_INVALID",
            )
        workspace_context: JsonObject = {"runId": run_id}
        if signal is not None:
            workspace_context["signal"] = signal
        if seed is not None:
            tokens = {
                alias: entry["token"] for alias, entry in (seed.get("workspaces") or {}).items() if entry.get("token")
            }
            if tokens:
                workspace_context["restoreFrom"] = tokens
        workspaces = await resolve_agent_workspaces(manifest, deps.workspaces, workspace_context)
        uses_run_sandbox = len(workspaces) > 0 or _steps_use_run_sandbox(manifest["steps"])
        if uses_run_sandbox:
            if deps.run_sandbox is None:
                raise Error(
                    "Workspace bindings require a RunSandboxProvider"
                    if workspaces
                    else "Code steps that use the run sandbox require a RunSandboxProvider"
                )
            validate_request: JsonObject = {
                "runId": run_id,
                "attempt": ((existing or {}).get("attempt") or 1) + 1 if resume else 1,
                "workspaces": workspaces,
            }
            if signal is not None:
                validate_request["signal"] = signal
            await deps.run_sandbox.validate(validate_request)
        await self._preflight(manifest)
        fingerprints = await fingerprint_manifest(manifest)
        self._run_fingerprints[run_id] = fingerprints
        restarted_step: str | None = None
        if latest is not None:
            latest, restarted_step = _reconcile_manifest_change(
                run_id,
                manifest,
                latest,
                fingerprints,
                latest["manifestHash"] == await maybe_await(self._manifest_hasher.hash(manifest)),
            )
        if seed is not None:
            source, _ = _reconcile_manifest_change(
                run_id,
                manifest,
                seed,
                fingerprints,
                seed["manifestHash"] == await maybe_await(self._manifest_hasher.hash(manifest)),
            )
            latest = self._seeded_checkpoint(run_id, source, seed, fingerprints)
            _assert_recoverable_checkpoint(latest, run_id, manifest, 1)
        if latest is not None and existing is not None:
            _assert_recoverable_checkpoint(latest, run_id, manifest, existing.get("attempt") or 1)
        self._run_workspaces[run_id] = workspaces
        self._run_workspace_state[run_id] = copy.deepcopy((latest or {}).get("workspaces") or {})
        if latest and latest.get("inputs"):
            self._run_inputs[run_id] = copy.deepcopy(latest["inputs"])
        elif not resume and seed is None:
            inputs: JsonObject = {}
            for workspace in workspaces:
                if workspace.mode != "read" or not hasattr(workspace.store, "version"):
                    continue
                token = await maybe_await(workspace.store.version(signal=signal))
                if token:
                    inputs[workspace.alias] = {"token": token}
            self._run_inputs[run_id] = inputs
        ledger = RunLedgerTracker(checkpoint=latest, now=lambda: self._clock.now().timestamp() * 1000)
        ledger.grant(parse(run_limits_schema, request["limits"]) if request.get("limits") is not None else None)
        self._run_ledgers[run_id] = ledger
        self._run_limits[run_id] = resolve_run_limits(
            manifest, defaults=deps.limits, granted=ledger.granted, ceilings=deps.enforced_limits
        )

        effective_budget = requested_budget if requested_budget is not None else (latest or {}).get("budget")
        if effective_budget is not None:
            latest_budget = (latest or {}).get("budget")
            consumed = (
                0
                if seed is not None
                else latest_budget["consumedTokens"]
                if latest_budget and latest_budget.get("consumedTokens") is not None
                else _consumed_tokens_from_transcript((latest or {}).get("transcript") or [])
            )
            self._run_token_budgets[run_id] = RunTokenBudget(
                {"maxTotalTokens": effective_budget["maxTotalTokens"], "consumedTokens": consumed}
            )

        prepared = None
        if not resume and seed is None:
            describe = None  # pyright: ignore[reportAssignmentType]
            if deps.model is not None and hasattr(deps.model, "describe_model"):

                async def describe(model: str) -> JsonObject | None:
                    return await maybe_await(deps.model.describe_model(model))

            prepared = await prepare_supplied_history(
                run_id=run_id,
                manifest=manifest,
                messages=request.get("messages"),
                signature=request.get("messagesSignature"),
                scope=request.get("messagesScope"),
                options=deps.messages or MessagesOptions(),
                artifacts=deps.artifacts,
                strategy=(self._history_policies(manifest).get("context") or {}).get("strategy") or "prune",
                describe_model=describe,
            )
        if prepared is not None:
            state: JsonObject = {
                "history": copy.deepcopy(prepared.history),
                "compaction": prepared.compaction,
                "signedCount": prepared.signed_count,
            }
            if request.get("messagesScope") is not None:
                state["scope"] = request["messagesScope"]
            self._run_messages[run_id] = state
        elif declares_messages(manifest):
            self._run_messages[run_id] = copy.deepcopy(
                (latest or {}).get("messages") or {"history": [], "compaction": "complete", "signedCount": 0}
            )

        started_at = (
            existing["createdAt"] if existing is not None and existing.get("createdAt") is not None else self._now()
        )
        start_step_index = latest["cursor"]["stepIndex"] if latest else 0
        variables: JsonObject = (
            copy.deepcopy(latest["state"]) if latest else resolve_agent_variables(manifest, request.get("variables"))
        )
        step_results: list[JsonObject] = copy.deepcopy((latest or {}).get("stepResults") or [])
        transcript: list[JsonObject] = copy.deepcopy(
            _without_active_tail((latest or {}).get("transcript") or [], (latest or {}).get("activeStepTranscript"))
        )
        artifacts: list[JsonObject] = copy.deepcopy(
            _without_active_tail((latest or {}).get("artifacts") or [], (latest or {}).get("activeStepArtifacts"))
        )

        record: JsonObject = {
            "runId": run_id,
            "manifest": manifest,
            "status": "running",
            "attempt": 1,
            "state": copy.deepcopy(variables),
        }
        if prepared is not None:
            supplied: JsonObject = {"supplied": copy.deepcopy(prepared.history), "signedCount": prepared.signed_count}
            if request.get("messagesScope") is not None:
                supplied["scope"] = request["messagesScope"]
            record["messages"] = supplied
        elif existing is not None and existing.get("messages") is not None:
            record["messages"] = copy.deepcopy(existing["messages"])
        record["createdAt"] = started_at
        record["updatedAt"] = started_at

        uncommitted_steps: list[JsonObject] = []
        failed_step_id: str | None = None

        def failure_pauses(error: BaseException) -> bool:
            policies = merge_execution_policies(deps.policies, manifest.get("policies"), deps.enforced_policies)
            return (
                not (signal is not None and signal.aborted)
                and not is_run_cancelled_error(error)
                and not is_fatal_run_error(error)
                and policies.get("onFailure") != "fail"
            )

        if not resume:
            await deps.run_store.create_run(record)
            self._run_attempts[run_id] = 1
            if seed is not None and latest is not None:
                await deps.run_store.save_checkpoint(latest)
                self._checkpoint_sequences[run_id] = latest["sequence"]
        else:
            resume_options: JsonObject = {}
            if request.get("allowRunningTakeover"):
                resume_options["allowRunningTakeover"] = True
            if request.get("manifest") is not None or request.get("manifestReference") is not None:
                resume_options["manifest"] = manifest
            attempt = await deps.run_store.resume_run(run_id, self._now(), resume_options or None)
            self._run_attempts[run_id] = attempt
            record["attempt"] = attempt
            self._checkpoint_sequences[run_id] = latest["sequence"] if latest else 0
        try:
            started: JsonObject = {"manifestId": manifest.get("id"), "startStepIndex": start_step_index}
            if seed is not None:
                started["seededFrom"] = {
                    "runId": seed["runId"],
                    "checkpointSequence": seed["sequence"],
                    "stepPath": seed["boundary"]["stepPath"],
                }
                if seed["boundary"].get("executionKey"):
                    started["seededFrom"]["executionKey"] = seed["boundary"]["executionKey"]
            if prepared is not None:
                started["messages"] = {
                    "count": len(prepared.history),
                    "signedCount": prepared.signed_count,
                    "verified": prepared.verified,
                    "ingestedArtifacts": prepared.ingested_artifacts,
                    "compaction": "pending" if prepared.compaction == "pending" else "none",
                }
            await self._emit(run_id, "run.resumed" if resume else "run.started", started)
            if restarted_step is not None:
                await self._emit(
                    run_id,
                    "diagnostic",
                    {
                        "code": "STEP_RESTARTED_AFTER_MANIFEST_CHANGE",
                        "message": f"Step {restarted_step} changed while it was in progress; it runs again from its start.",
                    },
                    restarted_step,
                )
            for workspace in workspaces:
                bound: JsonObject = {
                    "workspace": workspace.binding["ref"],
                    "alias": workspace.alias,
                    "mode": workspace.mode,
                }
                if workspace.binding.get("tools") is not None:
                    bound["tools"] = list(workspace.binding["tools"])
                bound["attachable"] = getattr(workspace.store, "attachable", None) is not None
                await self._emit(run_id, "workspace.bound", bound)
            if resume and latest is not None and existing is not None:
                await self._enforce_resume_limits(
                    run_id=run_id,
                    previous_status=existing["status"],
                    checkpoint=latest,
                    granted=request.get("limits") is not None,
                    steps_remain=latest["cursor"]["stepIndex"] < len(manifest["steps"]),
                )
            tracker = self._run_ledgers.get(run_id)
            run_limit = (self._run_limits.get(run_id) or {}).get("maxRunActiveMs")
            if tracker is not None and run_limit is not None:
                active_ms = tracker.active_ms
                if active_ms >= run_limit:
                    raise create_limit_suspension(limit="maxRunActiveMs", used=round(active_ms), value=run_limit)
                self._schedule_limit_timer(
                    run_id,
                    run_limit - active_ms,
                    lambda: create_limit_suspension(
                        limit="maxRunActiveMs", used=round(tracker.active_ms), value=run_limit
                    ),
                )
            run_sandbox = None  # pyright: ignore[reportAssignmentType]
            if deps.run_sandbox is not None:

                def run_sandbox() -> Awaitable[Any]:
                    return self._open_run_sandbox(run_id, workspaces, latest, signal)

            if not resume and seed is None:
                await self._checkpoint(
                    run_id=run_id,
                    manifest=manifest,
                    next_step_index=0,
                    variables=variables,
                    step_results=step_results,
                    transcript=transcript,
                    artifacts=artifacts,
                )
            if (self._run_messages.get(run_id) or {}).get("compaction") == "pending":
                await self._compact_history(run_id, manifest, variables, step_results, transcript, artifacts, signal)

            waves = build_execution_waves(
                manifest,
                start_step_index,
                {"mode": "sequential"} if run_id in self._run_token_budgets else request.get("execution"),
                deps.max_parallel_steps if deps.max_parallel_steps is not None else 8,
            )
            for wave in waves:
                self._throw_if_aborted(signal)
                wave_variables = snapshot_state(variables)
                wave_step_results = copy.deepcopy(step_results)
                uncommitted_steps = [
                    manifest["steps"][index] for index in wave.step_indexes if index < len(manifest["steps"])
                ]
                settled = await asyncio.gather(
                    *[
                        self._execute_top_level_step(
                            checkpoint_enabled=len(wave.step_indexes) == 1,
                            run_id=run_id,
                            manifest=manifest,
                            step_index=index,
                            variables=wave_variables,
                            step_results=wave_step_results,
                            transcript=transcript,
                            artifacts=artifacts,
                            workspaces=workspaces,
                            run_sandbox=run_sandbox,
                            signal=signal,
                            latest=latest,
                        )
                        for index in wave.step_indexes
                    ],
                    return_exceptions=True,
                )
                failures = [outcome for outcome in settled if isinstance(outcome, BaseException)]
                if failures:
                    suspended = next(
                        (
                            failure
                            for failure in failures
                            if is_run_suspended_error(failure) or is_run_interrupted_error(failure)
                        ),
                        None,
                    )
                    if suspended is not None:
                        uncommitted_steps = []
                        raise suspended
                    abort_reason = signal.reason if signal is not None and signal.aborted else None
                    if is_run_suspended_error(abort_reason) or is_run_interrupted_error(abort_reason):
                        uncommitted_steps = []
                        raise abort_reason
                    for failure in failures:
                        if isinstance(failure, TopLevelStepExecutionError):
                            await self._emit(
                                run_id,
                                "step.failed",
                                {
                                    "error": to_run_error(failure.cause),
                                    **(
                                        {"paused": True}
                                        if failure_pauses(
                                            failures[0].cause
                                            if isinstance(failures[0], TopLevelStepExecutionError)
                                            else failures[0]
                                        )
                                        else {}
                                    ),
                                },
                                failure.step["id"],
                            )
                    uncommitted_steps = []
                    first = failures[0]
                    if isinstance(first, TopLevelStepExecutionError):
                        failed_step_id = first.step["id"]
                    raise first.cause if isinstance(first, TopLevelStepExecutionError) else first

                outcomes = sorted(
                    (outcome for outcome in settled if not isinstance(outcome, BaseException)),
                    key=lambda outcome: outcome["stepIndex"],
                )
                _assert_parallel_wave_state_patches(outcomes)
                for outcome in outcomes:
                    if outcome["skipped"] or outcome.get("result") is None or outcome.get("stepResult") is None:
                        continue
                    variables = apply_state_patch(variables, outcome["result"].get("statePatch"))
                    transcript.extend(outcome["result"].get("transcript") or [])
                    artifacts.extend(outcome["result"].get("artifacts") or [])
                    step_results.append(outcome["stepResult"])

                ending = next(
                    (outcome for outcome in outcomes if (outcome.get("result") or {}).get("endRun") is True), None
                )
                next_step_index = (
                    len(manifest["steps"]) if ending else (wave.step_indexes[-1] if wave.step_indexes else -1) + 1
                )
                tracker = self._run_ledgers.get(run_id)
                if tracker is not None:
                    tracker.end_step()
                last_index = wave.step_indexes[-1]
                last_step = manifest["steps"][last_index]
                await self._checkpoint(
                    run_id=run_id,
                    manifest=manifest,
                    next_step_index=next_step_index,
                    variables=variables,
                    step_results=step_results,
                    transcript=transcript,
                    artifacts=artifacts,
                    boundary={"stepPath": last_step["id"], "stepIndex": last_index, "executionKey": last_step["id"]},
                )
                for outcome in outcomes:
                    if outcome.get("handledError") is not None:
                        await self._emit(
                            run_id,
                            "step.failed",
                            {"stepIndex": outcome["stepIndex"], "handled": True, "error": outcome["handledError"]},
                            outcome["step"]["id"],
                        )
                        continue
                    await self._emit(
                        run_id,
                        "step.skipped" if outcome["skipped"] else "step.completed",
                        None if outcome["skipped"] else {"stepIndex": outcome["stepIndex"]},
                        outcome["step"]["id"],
                    )
                uncommitted_steps = []
                if ending:
                    await self._emit(
                        run_id,
                        "diagnostic",
                        {"code": "RUN_ENDED_BY_STEP", "stepIndex": ending["stepIndex"]},
                        ending["step"]["id"],
                    )
                    break

            self._throw_if_aborted(signal)
            await self._close_run_sandbox(run_id, "completed")
            output = select_run_output(manifest, step_results)
            self._assert_output_within_limit(manifest, output, "final run output")
            usage = aggregate_model_usage(transcript)
            messages_state = self._run_messages.get(run_id)
            messages = output_history(messages_state["history"], output) if messages_state else None
            signer = deps.messages.signer if deps.messages is not None else None
            messages_signature = (
                await signer.sign(messages, (messages_state or {}).get("scope"))
                if messages is not None and signer
                else None
            )
            completed_at = self._now()
            supplied_messages = record.get("messages")
            completed: JsonObject = {key: value for key, value in record.items() if key != "messages"}
            completed["status"] = "completed"
            completed["state"] = copy.deepcopy(variables)
            completed["updatedAt"] = completed_at
            if output is not UNDEFINED:
                completed["output"] = output
            completed["transcript"] = copy.deepcopy(transcript)
            completed["artifacts"] = copy.deepcopy(artifacts)
            if usage is not None:
                completed["usage"] = usage
            if messages is not None:
                record_messages: JsonObject = {
                    "supplied": copy.deepcopy((supplied_messages or {}).get("supplied") or []),
                    "signedCount": (supplied_messages or {}).get("signedCount") or 0,
                }
                if (messages_state or {}).get("scope") is not None:
                    record_messages["scope"] = messages_state["scope"]  # type: ignore[index]
                record_messages["output"] = copy.deepcopy(messages)
                if messages_signature is not None:
                    record_messages["signature"] = messages_signature
                completed["messages"] = record_messages
            await deps.run_store.complete_run(completed)
            try:
                await self._emit(run_id, "run.completed")
            except Exception:
                pass
            self._forget_run(run_id)

            result: JsonObject = {
                "runId": run_id,
                "state": variables,
                "variables": variables,
                "stepResults": step_results,
                "transcript": transcript,
                "artifacts": artifacts,
                "startedAt": started_at,
                "completedAt": completed_at,
            }
            if usage is not None:
                result["usage"] = usage
            if output is not UNDEFINED:
                result["output"] = output
            if messages is not None:
                result["messages"] = messages
            if messages_signature is not None:
                result["messagesSignature"] = messages_signature
            return result
        except BaseException as caught:
            if isinstance(caught, (KeyboardInterrupt, SystemExit)):
                raise
            abort_reason = signal.reason if signal is not None and signal.aborted else None
            error = (
                abort_reason
                if is_run_suspended_error(abort_reason) or is_run_interrupted_error(abort_reason)
                else caught
            )
            if is_run_suspended_error(error):
                await self._close_run_sandbox_quietly(run_id, "suspended")
                suspended_at = self._now()
                if error.reason == "blocked":
                    try:
                        await self._commit_checkpoint_copy(run_id, _blocked_record(error, suspended_at))
                    except Exception:
                        pass
                await deps.run_store.suspend_run(run_id, suspended_at, self._run_attempts.get(run_id, 1))
                try:
                    data: JsonObject = {"reason": error.reason, "kind": suspension_kind(error.reason)}
                    if getattr(error, "details", None):
                        data["details"] = error.details
                    await self._emit(run_id, "run.suspended", data)
                finally:
                    self._forget_run(run_id)
                if error is caught:
                    raise
                raise error from caught
            run_error = to_run_error(error)
            if is_run_interrupted_error(error):
                run_error["retryable"] = True
                await self._close_run_sandbox_quietly(run_id, "suspended")
                interrupted_at = self._now()
                attempt = self._run_attempts.get(run_id, 1)
                if hasattr(deps.run_store, "interrupt_run"):
                    await deps.run_store.interrupt_run(run_id, run_error, interrupted_at, attempt)
                else:
                    await deps.run_store.fail_run(run_id, run_error, interrupted_at, attempt)
                try:
                    data = {"reason": interruption_reason(error), "error": run_error}
                    if getattr(error, "details", None):
                        data["details"] = error.details
                    await self._emit(run_id, "run.interrupted", data)
                finally:
                    self._forget_run(run_id)
                if error is caught:
                    raise
                raise error from caught
            cancelled = (signal is not None and signal.aborted) or is_run_cancelled_error(error)
            if failure_pauses(error):
                suspension = create_error_suspension(
                    error=run_error,
                    step_id=failed_step_id or (uncommitted_steps[0]["id"] if uncommitted_steps else None),
                    cause=error,
                )
                await self._close_run_sandbox_quietly(run_id, "suspended")
                suspended_at = self._now()
                try:
                    await self._commit_checkpoint_copy(run_id, _blocked_record(suspension, suspended_at))
                except Exception:
                    pass
                await deps.run_store.suspend_run(run_id, suspended_at, self._run_attempts.get(run_id, 1))
                try:
                    await self._emit(
                        run_id,
                        "run.suspended",
                        {
                            "reason": suspension.reason,
                            "kind": suspension_kind(suspension.reason),
                            "details": suspension.details,
                        },
                    )
                finally:
                    self._forget_run(run_id)
                raise suspension from error
            await self._close_run_sandbox_quietly(run_id, "cancelled" if cancelled else "failed")
            failed_at = self._now()
            if cancelled:
                await deps.run_store.cancel_run(run_id, failed_at, self._run_attempts.get(run_id, 1))
            else:
                await deps.run_store.fail_run(run_id, run_error, failed_at, self._run_attempts.get(run_id, 1))
            try:
                for step in uncommitted_steps:
                    await self._emit(run_id, "step.failed", {"error": run_error}, step["id"])
                await self._emit(run_id, "run.cancelled" if cancelled else "run.failed", {"error": run_error})
            finally:
                self._forget_run(run_id)
            if error is caught:
                raise
            raise error from None

    async def _execute_top_level_step(
        self,
        *,
        run_id: str,
        manifest: JsonObject,
        step_index: int,
        variables: JsonObject,
        step_results: list[JsonObject],
        transcript: list[JsonObject],
        artifacts: list[JsonObject],
        workspaces: list[ResolvedWorkspace],
        run_sandbox: Any,
        signal: AbortSignal | None,
        latest: JsonObject | None,
        checkpoint_enabled: bool,
    ) -> JsonObject:
        deps = self._deps
        if step_index >= len(manifest["steps"]):
            raise Error(f"Manifest step {step_index} does not exist")
        step = manifest["steps"][step_index]
        step_timer: asyncio.TimerHandle | None = None
        try:
            selection = self._history_selection(run_id, step)
            step_variables = with_messages_view(manifest, variables, selection)
            if not await self._should_execute(step, {**step_variables}):
                return {"step": step, "stepIndex": step_index, "skipped": True}
            executor = self._executors.get(step["type"])
            if executor is None:
                raise Error(f"No step executor registered for {step['type']}")
            await self._emit(run_id, "step.started", {"stepIndex": step_index}, step["id"])
            tracker = self._run_ledgers.get(run_id)
            is_execution = step["type"] != "loop"
            if is_execution and checkpoint_enabled and tracker is not None:
                tracker.start_step(step["id"])
            step_limit = (self._run_limits.get(run_id) or {}).get("maxStepActiveMs")
            if is_execution and tracker is not None and step_limit is not None:
                active_ms = tracker.step_active_ms(step["id"])
                if active_ms >= step_limit:
                    raise create_limit_suspension(
                        limit="maxStepActiveMs", used=round(active_ms), value=step_limit, step_id=step["id"]
                    )
                step_timer = self._schedule_limit_timer(
                    run_id,
                    step_limit - active_ms,
                    lambda: create_limit_suspension(
                        limit="maxStepActiveMs",
                        used=round(tracker.step_active_ms(step["id"])) or step_limit,
                        value=step_limit,
                        step_id=step["id"],
                    ),
                )

            async def checkpoint_nested(nested: JsonObject) -> None:
                if is_execution and tracker is not None:
                    from .limits import transcript_tokens

                    tracker.set_step_tokens(step["id"], transcript_tokens(nested.get("transcript") or []))
                if not checkpoint_enabled:
                    return
                cursor: JsonObject = {
                    "stepIndex": step_index,
                    "stepId": step["id"],
                    "stepPath": step["id"],
                    **(nested.get("cursor") or {}),
                }
                await self._checkpoint(
                    run_id=run_id,
                    manifest=manifest,
                    next_step_index=step_index,
                    cursor=cursor,
                    variables=without_messages_view(manifest, nested["state"]),
                    step_results=[*step_results],
                    transcript=[*transcript, *(nested.get("transcript") or [])],
                    artifacts=[*artifacts, *(nested.get("artifacts") or [])],
                    continuation=nested.get("continuation"),
                    boundary={**nested["boundary"], "stepIndex": step_index} if nested.get("boundary") else None,
                    active_step_transcript=nested.get("transcript") or [],
                    active_step_artifacts=nested.get("artifacts") or [],
                )

            async def emit(event_type: str, data: JsonObject | None = None) -> JsonObject:
                return await self._emit(run_id, event_type, data, step["id"], step["id"])

            async def execute_child(
                child: JsonObject, child_variables: JsonObject, child_path: str, frame: JsonObject | None = None
            ) -> JsonObject:
                return await self._execute_child(
                    {
                        "runId": run_id,
                        "manifest": manifest,
                        "parentStepIndex": step_index,
                        "step": child,
                        "stepPath": child_path,
                        "executionKey": child_execution_key(step["id"], child["id"], frame),
                        "frame": frame,
                        "variables": child_variables,
                        "workspaces": workspaces,
                        "runSandbox": run_sandbox,
                        "signal": signal,
                        "latestCheckpoint": latest,
                        "stepResults": step_results,
                        "checkpoint": checkpoint_nested,
                    }
                )

            context = StepExecutionContext(
                run_id=run_id,
                manifest=manifest,
                step=step,
                step_index=step_index,
                step_path=step["id"],
                execution_key=step["id"],
                variables=snapshot_state(step_variables),
                history=self._history_context(run_id, selection),
                step_results=copy.deepcopy(step_results),
                signal=signal,
                model=deps.model,
                tools=deps.tools,
                artifacts=deps.artifacts,
                approvals=deps.approvals,
                sandbox=deps.sandbox,
                sub_runs=deps.sub_runs,
                workspaces=workspaces,
                run_sandbox=run_sandbox,
                token_budget=self._run_token_budgets.get(run_id),
                limits=self._run_limits.get(run_id),
                summarizer=deps.summarizer,
                policies=resolve_step_policies(deps.policies, manifest, step, deps.enforced_policies),
                emit=emit,
                resume=self._resume_state(latest) if latest and latest["cursor"]["stepIndex"] == step_index else None,
                execute_child=execute_child,
                checkpoint=checkpoint_nested if checkpoint_enabled else None,
                evaluate_condition=self._evaluate_condition,
            )
            executed = await executor.execute(context)
            result = self._without_messages_result(manifest, executed)
            self._throw_if_aborted(signal)
            self._assert_output_within_limit(manifest, result.get("output", UNDEFINED), f"step {step['id']}")
            projected = _with_projected_step_state(manifest, step, step_index, result)
            step_usage = aggregate_model_usage(result.get("transcript") or [])
            step_result: JsonObject = {"stepId": step["id"], "stepIndex": step_index, "status": "completed"}
            if "output" in result:
                step_result["output"] = result["output"]
            if result.get("transcript") is not None:
                step_result["transcript"] = result["transcript"]
            if result.get("artifacts") is not None:
                step_result["artifacts"] = result["artifacts"]
            if step_usage is not None:
                step_result["usage"] = step_usage
            step_result["completedAt"] = self._now()
            if result.get("metadata") is not None:
                step_result["metadata"] = result["metadata"]
            return {
                "step": step,
                "stepIndex": step_index,
                "skipped": False,
                "result": projected,
                "stepResult": step_result,
            }
        except Exception as error:
            if is_run_suspended_error(error) or is_run_interrupted_error(error):
                raise
            if (
                not is_control_flow_error(error, signal)
                and resolve_step_policies(deps.policies, manifest, step, deps.enforced_policies).get("onError")
                == "continue"
            ):
                handled = to_run_error(error)
                result = _handled_error_result(step, handled)
                return {
                    "step": step,
                    "stepIndex": step_index,
                    "skipped": False,
                    "result": result,
                    "handledError": handled,
                    "stepResult": {
                        "stepId": step["id"],
                        "stepIndex": step_index,
                        "status": "completed",
                        "output": result["output"],
                        "completedAt": self._now(),
                        "metadata": result["metadata"],
                    },
                }
            raise TopLevelStepExecutionError(step, error) from error
        finally:
            if step_timer is not None:
                step_timer.cancel()
                self._run_timer_handles.get(run_id, set()).discard(step_timer)

    @staticmethod
    def _resume_state(latest: JsonObject) -> JsonObject:
        resume: JsonObject = {"cursor": latest["cursor"]}
        if latest.get("continuation") is not None:
            resume["continuation"] = latest["continuation"]
        if latest.get("activeStepTranscript") is not None:
            resume["transcript"] = copy.deepcopy(latest["activeStepTranscript"])
        if latest.get("activeStepArtifacts") is not None:
            resume["artifacts"] = copy.deepcopy(latest["activeStepArtifacts"])
        return resume

    async def _preflight(self, manifest: JsonObject) -> None:
        deps = self._deps
        problems: list[str] = []
        expressions: list[JsonObject] = []
        tool_names: dict[str, list[str]] = {}

        def visit(steps: list[JsonObject]) -> None:
            for step in steps:
                if step["type"] not in self._executors:
                    problems.append(
                        f"Step {step['id']} is a {step['type']} step, but no {step['type']} step executor is registered."
                    )
                if js_strings.trim(step.get("when") or ""):
                    expressions.append({"stepId": step["id"], "label": "when", "value": step["when"]})
                if step["type"] == "prompt" and step.get("tools"):
                    tool_names[step["id"]] = step["tools"]
                if step["type"] == "loop":
                    loop = step["loop"]
                    if js_strings.trim(loop.get("condition") or ""):
                        expressions.append(
                            {"stepId": step["id"], "label": "loop.condition", "value": loop["condition"]}
                        )
                    if js_strings.trim(loop.get("goal") or ""):
                        expressions.append({"stepId": step["id"], "label": "loop.goal", "value": loop["goal"]})
                    visit(step["steps"])

        visit(manifest["steps"])
        context = StepPreflightContext(
            manifest=manifest,
            model=deps.model,
            tools=deps.tools,
            artifacts=deps.artifacts,
            approvals=deps.approvals,
            sandbox=deps.sandbox,
            sub_runs=deps.sub_runs,
            run_sandbox=deps.run_sandbox,
        )

        async def check_executors(steps: list[JsonObject]) -> None:
            for step in steps:
                executor = self._executors.get(step["type"])
                if executor is not None and hasattr(executor, "preflight"):
                    problems.extend(await maybe_await(executor.preflight(step, context)))
                if step["type"] == "loop":
                    await check_executors(step["steps"])

        await check_executors(manifest["steps"])

        evaluator = deps.condition_evaluator
        if expressions and evaluator is None:
            ids = list(dict.fromkeys(entry["stepId"] for entry in expressions))
            problems.append(f"Steps {', '.join(ids)} use conditions, but no ConditionEvaluator is configured.")
        elif evaluator is not None and hasattr(evaluator, "validate"):
            for expression in expressions:
                try:
                    await maybe_await(evaluator.validate(expression["value"]))
                except Exception as error:
                    problems.append(
                        f"Step {expression['stepId']} has an invalid {expression['label']} expression: {error_message(error)}"
                    )

        if tool_names and deps.tools is not None:
            tools = deps.tools
            available = {tool["name"] for tool in await tools.list_tools()}
            for step_id, names in tool_names.items():
                unknown = [
                    name
                    for name in names
                    if name not in available
                    and not (hasattr(tools, "is_tool_excluded") and tools.is_tool_excluded(name) is True)
                    and not (
                        hasattr(tools, "unavailable_tool_reason") and tools.unavailable_tool_reason(name) is not None
                    )
                ]
                if unknown:
                    problems.append(f"Prompt step {step_id} names unknown tools: {', '.join(unknown)}.")

        declaration = manifest.get("messages")
        if (
            declaration
            and (declaration.get("maxMessages") is not None or declaration.get("maxBytes") is not None)
            and not (deps.messages and deps.messages.compactor)
        ):
            strategy = (self._history_policies(manifest).get("context") or {}).get("strategy")
            if strategy in ("summarize", "summarize-or-prune"):
                problems.append(
                    f"The conversation history may be summarized (context strategy {strategy}), but no MessageHistoryCompactor is configured."
                )

        if problems:
            raise AgentRuntimeError(
                f"Agent manifest cannot run with this host configuration: {' '.join(problems)}",
                "MANIFEST_PREFLIGHT_FAILED",
            )

    async def _resolve_manifest(self, request: JsonObject) -> JsonObject:
        if request.get("manifest"):
            return request["manifest"]
        source = self._deps.agent_manifest_source
        if source is None:
            raise Error("An agent manifest or AgentManifestSource is required")
        return await source.load_manifest(request.get("manifestReference"))

    def _assert_output_within_limit(self, manifest: JsonObject, output: Any, label: str) -> None:
        max_output_bytes = (manifest.get("limits") or {}).get("maxOutputBytes")
        if output is UNDEFINED or max_output_bytes is None:
            return
        size = _json_byte_length(output)
        if size > max_output_bytes:
            raise Error(f"{label} is {size} bytes, exceeding the {max_output_bytes}-byte output limit")

    async def _should_execute(self, step: JsonObject, variables: JsonObject) -> bool:
        if not step.get("when"):
            return True
        evaluator = self._deps.condition_evaluator
        if evaluator is None:
            raise Error(f"Step {step['id']} has a condition but no ConditionEvaluator is configured")
        return bool(await maybe_await(evaluator.evaluate(step["when"], variables)))

    async def _evaluate_condition(self, expression: str, variables: JsonObject) -> bool:
        if js_strings.trim(expression) == "":
            return True
        evaluator = self._deps.condition_evaluator
        if evaluator is None:
            raise Error("A ConditionEvaluator is required for loop conditions and goals")
        return bool(await maybe_await(evaluator.evaluate(expression, variables)))

    def _throw_if_aborted(self, signal: AbortSignal | None) -> None:
        if signal is None or not signal.aborted:
            return
        reason = signal.reason
        raise reason if isinstance(reason, BaseException) else Error("Run cancelled")

    async def _execute_child(self, parent: JsonObject) -> JsonObject:
        self._throw_if_aborted(parent["signal"])
        manifest = parent["manifest"]
        child = {
            **parent,
            "variables": with_messages_view(
                manifest, parent["variables"], self._history_selection(parent["runId"], parent["step"])
            ),
        }
        step = child["step"]
        run_id = child["runId"]
        if not await self._should_execute(step, {**child["variables"]}):
            await self._emit(run_id, "step.skipped", None, step["id"], child["stepPath"])
            return {"metadata": {"skipped": True}}
        executor = self._executors.get(step["type"])
        if executor is None:
            raise Error(f"No step executor registered for {step['type']}")
        await self._emit(run_id, "step.started", {"stepIndex": child["parentStepIndex"]}, step["id"], child["stepPath"])
        latest = child["latestCheckpoint"]
        cursor_path = ((latest or {}).get("cursor") or {}).get("stepPath")
        is_resuming_path = (
            latest is not None
            and latest["cursor"]["stepIndex"] == child["parentStepIndex"]
            and (
                cursor_path == child["stepPath"]
                or (isinstance(cursor_path, str) and cursor_path.startswith(f"{child['stepPath']}/"))
            )
        )
        if child.get("frame") is not None:
            is_resuming_path = child["frame"].get("resume") is not None
        tracker = self._run_ledgers.get(run_id)
        is_execution = step["type"] != "loop"
        key = child.get("executionKey") or child["stepPath"]
        step_timer: asyncio.TimerHandle | None = None
        try:
            if is_execution and tracker is not None:
                tracker.start_step(key)
                step_limit = (self._run_limits.get(run_id) or {}).get("maxStepActiveMs")
                if step_limit is not None:
                    active_ms = tracker.step_active_ms(key)
                    if active_ms >= step_limit:
                        raise create_limit_suspension(
                            limit="maxStepActiveMs", used=round(active_ms), value=step_limit, step_id=key
                        )
                    step_timer = self._schedule_limit_timer(
                        run_id,
                        step_limit - active_ms,
                        lambda: create_limit_suspension(
                            limit="maxStepActiveMs",
                            used=round(tracker.step_active_ms(key)) or step_limit,
                            value=step_limit,
                            step_id=key,
                        ),
                    )
            result = self._without_messages_result(
                manifest, await self._execute_child_step(executor, child, is_resuming_path)
            )
            if is_execution and tracker is not None:
                tracker.end_step(key)
        except Exception as error:
            if (
                is_control_flow_error(error, child["signal"])
                or resolve_step_policies(self._deps.policies, manifest, step, self._deps.enforced_policies).get(
                    "onError"
                )
                != "continue"
            ):
                raise
            handled = to_run_error(error)
            if is_execution and tracker is not None:
                tracker.end_step(key)
            await self._emit(
                run_id,
                "step.failed",
                {"stepIndex": child["parentStepIndex"], "handled": True, "error": handled},
                step["id"],
                child["stepPath"],
            )
            return _handled_error_result(step, handled)
        finally:
            if step_timer is not None:
                step_timer.cancel()
                self._run_timer_handles.get(run_id, set()).discard(step_timer)
        await self._emit(
            run_id, "step.completed", {"stepIndex": child["parentStepIndex"]}, step["id"], child["stepPath"]
        )
        return _with_projected_step_state(manifest, step, child["parentStepIndex"], result)

    async def _execute_child_step(self, executor: Any, child: JsonObject, is_resuming_path: bool) -> JsonObject:
        deps = self._deps
        run_id = child["runId"]
        step = child["step"]

        async def emit(event_type: str, data: JsonObject | None = None) -> JsonObject:
            return await self._emit(run_id, event_type, data, step["id"], child["stepPath"])

        async def execute_child(
            grandchild: JsonObject, variables: JsonObject, path: str, frame: JsonObject | None = None
        ) -> JsonObject:
            return await self._execute_child(
                {
                    **child,
                    "step": grandchild,
                    "stepPath": path,
                    "executionKey": child_execution_key(
                        child.get("executionKey") or child["stepPath"], grandchild["id"], frame
                    ),
                    "variables": variables,
                    "frame": frame,
                }
            )

        async def checkpoint(nested: JsonObject) -> None:
            own = {
                **nested,
                "cursor": {"stepId": step["id"], "stepPath": child["stepPath"], **(nested.get("cursor") or {})},
            }
            frame = child.get("frame")
            await child["checkpoint"](frame["checkpoint"](own) if frame is not None else own)

        latest = child["latestCheckpoint"]
        context = StepExecutionContext(
            run_id=run_id,
            manifest=child["manifest"],
            step=step,
            step_index=child["parentStepIndex"],
            step_path=child["stepPath"],
            execution_key=child.get("executionKey"),
            variables=snapshot_state({**child["variables"]}),
            step_results=copy.deepcopy(child["stepResults"]),
            signal=child["signal"],
            model=deps.model,
            tools=deps.tools,
            artifacts=deps.artifacts,
            approvals=deps.approvals,
            sandbox=deps.sandbox,
            sub_runs=deps.sub_runs,
            workspaces=child["workspaces"],
            run_sandbox=child["runSandbox"],
            token_budget=self._run_token_budgets.get(run_id),
            limits=self._run_limits.get(run_id),
            summarizer=deps.summarizer,
            history=self._history_context(run_id, self._history_selection(run_id, step)),
            emit=emit,
            resume=(child["frame"].get("resume") if child.get("frame") is not None else self._resume_state(latest))
            if is_resuming_path and latest
            else None,
            execute_child=execute_child,
            checkpoint=checkpoint,
            evaluate_condition=self._evaluate_condition,
            policies=resolve_step_policies(deps.policies, child["manifest"], step, deps.enforced_policies),
        )
        return await executor.execute(context)

    def _history_policies(self, manifest: JsonObject) -> JsonObject:
        messages = manifest.get("messages") or {}
        return merge_execution_policies(
            self._deps.policies,
            manifest.get("policies"),
            {"context": messages["context"]} if messages.get("context") else None,
            self._deps.enforced_policies,
        )

    def _history_selection(self, run_id: str, step: JsonObject) -> HistorySelection | None:
        state = self._run_messages.get(run_id)
        return select_history(state["history"], step.get("history")) if state else None

    def _history_context(self, run_id: str, selection: HistorySelection | None) -> StepHistoryContext | None:
        if selection is None:
            return None
        scope = (self._run_messages.get(run_id) or {}).get("scope")
        signer = self._deps.messages.signer if self._deps.messages is not None else None

        async def sign(messages: list[JsonObject]) -> JsonObject | None:
            return await signer.sign(messages, scope) if signer else None

        return StepHistoryContext(
            messages=copy.deepcopy(selection.messages),
            places=copy.deepcopy(selection.places),
            turn=selection.current_turn,
            explicit=selection.explicit,
            insert=selection.insert,
            media=selection.media,
            scope=scope,
            sign=sign,
        )

    def _without_messages_result(self, manifest: JsonObject, result: JsonObject) -> JsonObject:
        if not declares_messages(manifest) or result.get("statePatch") is None:
            return result
        patch = without_messages_patch(manifest, result["statePatch"])
        rest = {key: value for key, value in result.items() if key != "statePatch"}
        return {**rest, "statePatch": patch} if patch is not None else rest

    async def _compact_history(
        self,
        run_id: str,
        manifest: JsonObject,
        variables: JsonObject,
        step_results: list[JsonObject],
        transcript: list[JsonObject],
        artifacts: list[JsonObject],
        signal: AbortSignal | None,
    ) -> None:
        state = self._run_messages[run_id]

        async def save(extra: list[JsonObject] | None = None) -> None:
            await self._checkpoint(
                run_id=run_id,
                manifest=manifest,
                next_step_index=0,
                variables=variables,
                step_results=step_results,
                transcript=[*transcript, *(extra or [])],
                artifacts=artifacts,
            )

        policies = self._history_policies(manifest)
        strategy = (policies.get("context") or {}).get("strategy") or "prune"
        reduce_to = (policies.get("context") or {}).get("reduceTo")
        plan = plan_history_compaction(state["history"], manifest, 0.25 if reduce_to is None else reduce_to)
        if plan is None:
            state["compaction"] = "complete"
            state.pop("journal", None)
            await save()
            return
        messages_before = len(state["history"])
        bytes_before = history_bytes(state["history"])
        marker: JsonObject | None = None
        used = "prune"
        summarizer_calls = 0
        markers = (manifest.get("messages") or {}).get("markers")
        if strategy in ("summarize", "summarize-or-prune"):
            compactor = self._deps.messages.compactor if self._deps.messages is not None else None
            recorded: list[JsonObject] = []
            try:
                if compactor is None:
                    raise Error("No MessageHistoryCompactor is configured.")
                segment_text = render_history_text(plan.segment)

                async def checkpoint(journal: JsonObject, transcript_items: list[JsonObject]) -> None:
                    nonlocal recorded
                    state["journal"] = copy.deepcopy(journal)
                    recorded = copy.deepcopy(transcript_items)
                    await save(recorded)

                async def emit(event_type: str, data: JsonObject | None = None) -> JsonObject:
                    return await self._emit(run_id, event_type, data)

                task = (
                    js_strings.trim(manifest.get("description") or "")
                    or js_strings.trim(manifest.get("name") or "")
                    or "an ongoing conversation"
                )
                result = await compactor.summarize(
                    MessageHistoryCompactionRequest(
                        run_id=run_id,
                        manifest=manifest,
                        text=segment_text,
                        label=compaction_label(plan),
                        task=task,
                        segment_bytes=history_bytes(plan.segment),
                        max_target_bytes=plan.marker_bytes,  # type: ignore[arg-type]
                        policies=policies,
                        model=self._deps.model,
                        summarizer=self._deps.summarizer,
                        token_budget=self._run_token_budgets.get(run_id),
                        journal=state.get("journal"),
                        checkpoint=checkpoint,
                        emit=emit,
                        signal=signal,
                    )
                )
                transcript.extend(result["transcript"])
                marker = summary_marker_message(plan, result["text"], markers)
                used = "summarize"
                summarizer_calls = result["summarizerCalls"]
            except Exception as error:
                if is_control_flow_error(error, signal) or strategy == "summarize":
                    raise
                transcript.extend(recorded)
                await self._emit(
                    run_id,
                    "diagnostic",
                    {"code": "CONTEXT_SUMMARY_FAILED", "scope": "messages", "message": error_message(error)},
                )
        if marker is None:
            marker = prune_marker_message(plan, plan.segment[0] if plan.segment else None, markers)
        state["history"] = [marker, *plan.retained]
        state["compaction"] = "complete"
        state.pop("journal", None)
        await self._emit(
            run_id,
            "context.reduced",
            {
                "scope": "messages",
                "strategy": used,
                "reason": plan.reason,
                "messagesBefore": messages_before,
                "messagesAfter": len(state["history"]),
                "bytesBefore": bytes_before,
                "bytesAfter": history_bytes(state["history"]),
                "summarizerCalls": summarizer_calls,
            },
        )
        await save()

    def _collect_workspace_changes(self, run_id: str, session: Any = None) -> None:
        session = session or self._run_sandbox_sessions.get(run_id)
        if session is None or not hasattr(session, "take_changes"):
            return
        taken = session.take_changes()
        state = self._run_workspace_state.setdefault(run_id, {})
        not_saved = self._run_pending_not_persisted.setdefault(run_id, {})
        for alias, batch in taken.items():
            if batch["changes"]:
                entry = state.setdefault(alias, {})
                entry["pending"] = merge_workspace_changes(entry.get("pending") or [], batch["changes"])
                if not entry["pending"]:
                    del entry["pending"]
            if batch["notPersisted"]:
                not_saved.setdefault(alias, []).extend(batch["notPersisted"])

    async def _commit_workspaces(self, run_id: str, boundary: JsonObject, sequence: int) -> None:
        state = self._run_workspace_state.setdefault(run_id, {})
        not_saved = self._run_pending_not_persisted.setdefault(run_id, {})
        for workspace in self._run_workspaces.get(run_id, []):
            if workspace.mode != "read_write":
                continue
            entry = state.get(workspace.alias) or {}
            changes = entry.get("pending") or []
            not_persisted = not_saved.get(workspace.alias) or []
            if not changes and not not_persisted:
                continue
            request: JsonObject = {
                "runId": run_id,
                "attempt": self._run_attempts.get(run_id, 1),
                "alias": workspace.alias,
                "stepPath": boundary["stepPath"],
                "checkpointSequence": sequence,
                "changes": copy.deepcopy(changes),
                "notPersisted": copy.deepcopy(not_persisted),
            }
            if boundary.get("executionKey"):
                request["executionKey"] = boundary["executionKey"]
            committed = (
                await maybe_await(workspace.store.commit(request)) if hasattr(workspace.store, "commit") else None
            )
            entry.pop("pending", None)
            if committed and committed.get("token"):
                entry.update({"token": committed["token"], "stepPath": boundary["stepPath"], "sequence": sequence})
            state[workspace.alias] = entry
            not_saved.pop(workspace.alias, None)
            await self._emit(
                run_id,
                "workspace.committed",
                {
                    "alias": workspace.alias,
                    "workspace": workspace.binding["ref"],
                    "stepPath": boundary["stepPath"],
                    **({"executionKey": boundary["executionKey"]} if boundary.get("executionKey") else {}),
                    "checkpointSequence": sequence,
                    "created": sum(change["action"] == "created" for change in changes),
                    "modified": sum(change["action"] == "modified" for change in changes),
                    "deleted": sum(change["action"] == "deleted" for change in changes),
                    "notPersisted": len(not_persisted),
                    **({"token": committed["token"]} if committed and committed.get("token") else {}),
                },
                boundary["stepPath"].split("/")[-1],
                boundary["stepPath"],
            )

    async def _checkpoint(
        self,
        *,
        run_id: str,
        manifest: JsonObject,
        next_step_index: int,
        variables: JsonObject,
        step_results: list[JsonObject],
        transcript: list[JsonObject],
        artifacts: list[JsonObject],
        active_step_transcript: list[JsonObject] | None = None,
        active_step_artifacts: list[JsonObject] | None = None,
        cursor: JsonObject | None = None,
        continuation: JsonObject | None = None,
        boundary: JsonObject | None = None,
    ) -> None:
        sequence = self._checkpoint_sequences.get(run_id, 0) + 1
        self._collect_workspace_changes(run_id)
        if boundary is not None:
            await self._commit_workspaces(run_id, boundary, sequence)
        tracker = self._run_ledgers.get(run_id)
        if tracker is not None:
            session = self._run_sandbox_sessions.get(run_id)
            if session is not None:
                budget_snapshot = session.budget()
                tracker.set_sandbox(
                    {"commands": budget_snapshot["commandsUsed"], "seconds": budget_snapshot["sandboxSecondsUsed"]}
                )
            ledger = tracker.observe({"sequence": sequence, "transcript": transcript, "artifacts": artifacts})
        else:
            ledger = None
        checkpoint: JsonObject = {"id": self._ids.generate_id("checkpoint")}
        checkpoint["runId"] = run_id
        checkpoint["sequence"] = sequence
        checkpoint["attempt"] = self._run_attempts.get(run_id, 1)
        checkpoint["manifestHash"] = await maybe_await(self._manifest_hasher.hash(manifest))
        checkpoint["contractVersion"] = RUN_CHECKPOINT_CONTRACT_VERSION
        checkpoint["runtimeVersion"] = self._deps.runtime_version or RUNTIME_VERSION
        checkpoint["cursor"] = cursor if cursor is not None else {"stepIndex": next_step_index}
        checkpoint["state"] = copy.deepcopy(variables)
        checkpoint["stepResults"] = copy.deepcopy(step_results)
        checkpoint["transcript"] = copy.deepcopy(transcript)
        checkpoint["artifacts"] = copy.deepcopy(artifacts)
        if active_step_transcript is not None:
            checkpoint["activeStepTranscript"] = copy.deepcopy(active_step_transcript)
        if active_step_artifacts is not None:
            checkpoint["activeStepArtifacts"] = copy.deepcopy(active_step_artifacts)
        if continuation is not None:
            checkpoint["continuation"] = copy.deepcopy(continuation)
        if run_id in self._run_token_budgets:
            checkpoint["budget"] = self._run_token_budgets[run_id].snapshot()
        if run_id in self._run_messages:
            checkpoint["messages"] = copy.deepcopy(self._run_messages[run_id])
        if run_id in self._run_sandbox_sessions:
            checkpoint["metadata"] = {"sandboxBudget": {**self._run_sandbox_sessions[run_id].budget()}}
        if ledger is not None:
            checkpoint["ledger"] = ledger
        if run_id in self._run_fingerprints:
            checkpoint["fingerprints"] = copy.deepcopy(self._run_fingerprints[run_id])
        if self._run_workspace_state.get(run_id):
            checkpoint["workspaces"] = copy.deepcopy(self._run_workspace_state[run_id])
        if self._run_inputs.get(run_id):
            checkpoint["inputs"] = copy.deepcopy(self._run_inputs[run_id])
        if boundary is not None:
            checkpoint["boundary"] = copy.deepcopy(boundary)
        checkpoint["createdAt"] = self._now()
        max_bytes = (self._run_limits.get(run_id) or {}).get("maxCheckpointBytes")
        if max_bytes is not None:
            size = len(js_json.stringify(checkpoint).encode("utf-8"))
            if size > max_bytes:
                raise create_limit_suspension(limit="maxCheckpointBytes", used=size, value=max_bytes)
        await self._deps.run_store.save_checkpoint(checkpoint)
        self._checkpoint_sequences[run_id] = sequence
        await self._emit(
            run_id,
            "checkpoint.saved",
            {"checkpointId": checkpoint["id"], "nextStepIndex": checkpoint["cursor"]["stepIndex"]},
        )
        step_id = checkpoint["cursor"].get("stepId")
        self._enforce_usage_limits(run_id, step_id if isinstance(step_id, str) else None)

    async def _commit_checkpoint_copy(self, run_id: str, blocked: JsonObject | None = None) -> None:
        last = await self._deps.run_store.load_latest_checkpoint(run_id)
        if last is None:
            return
        sequence = max(self._checkpoint_sequences.get(run_id, 0), last["sequence"]) + 1
        copied = copy.deepcopy(last)
        copied.pop("boundary", None)
        copied["id"] = re.sub(r":copy-\d+$", "", last["id"]) + f":copy-{sequence}"
        copied["sequence"] = sequence
        copied["attempt"] = self._run_attempts.get(run_id, 1)
        copied["contractVersion"] = RUN_CHECKPOINT_CONTRACT_VERSION
        tracker = self._run_ledgers.get(run_id)
        if tracker is not None:
            copied["ledger"] = tracker.snapshot()
            if blocked is not None:
                copied["ledger"]["blocked"] = blocked
        if run_id in self._run_fingerprints:
            copied["fingerprints"] = copy.deepcopy(self._run_fingerprints[run_id])
        copied["createdAt"] = self._now()
        await self._deps.run_store.save_checkpoint(copied)
        self._checkpoint_sequences[run_id] = sequence

    async def _enforce_resume_limits(
        self, *, run_id: str, previous_status: str, checkpoint: JsonObject, granted: bool, steps_remain: bool
    ) -> None:
        ledger = self._run_ledgers[run_id]
        limits = self._run_limits[run_id]
        after_trouble = (
            previous_status != "suspended"
            or (checkpoint.get("ledger") or {}).get("blocked", {}).get("cause") == "error"
        )
        count = 0
        if after_trouble:
            ledger.record_recovery()
            progress = ledger.progress or checkpoint["sequence"]
            previous = ledger.stalled_resumes
            count = previous["count"] + 1 if previous and previous["sequence"] == progress else 1
            ledger.stalled_resumes = {"count": count, "sequence": progress}
        if after_trouble or granted:
            await self._commit_checkpoint_copy(run_id)
        for name, used in (("maxRecoveries", ledger.recoveries), ("maxResumesWithoutProgress", count)):
            value = limits.get(name)
            if value is not None and used > value:
                raise create_limit_suspension(limit=name, used=used, value=value)
        if steps_remain:
            self._enforce_usage_limits(run_id)

    def _schedule_limit_timer(
        self, run_id: str, delay_ms: float, suspension: Callable[[], RunSuspendedError]
    ) -> asyncio.TimerHandle | None:
        controller = self._run_limit_controllers.get(run_id)
        if controller is None:
            return None
        handles = self._run_timer_handles.setdefault(run_id, set())

        def expire() -> None:
            handles.discard(timer)
            controller.abort(suspension())

        timer = asyncio.get_running_loop().call_later(max(0, min(delay_ms, 2_147_483_647)) / 1000, expire)
        handles.add(timer)
        return timer

    def _enforce_usage_limits(self, run_id: str, step_id: str | None = None) -> None:
        ledger = self._run_ledgers.get(run_id)
        limits = self._run_limits.get(run_id)
        if ledger is None or limits is None:
            return
        for name, used in (
            ("maxTotalTokens", ledger.tokens),
            ("maxStepTokens", ledger.step_tokens),
            ("maxEstimatedCost", ledger.estimated_cost),
            ("maxArtifacts", ledger.artifacts["count"]),
            ("maxArtifactBytes", ledger.artifacts["bytes"]),
        ):
            value = limits.get(name)
            if value is not None and used > value:
                raise create_limit_suspension(
                    limit=name,
                    used=used,
                    value=value,
                    step_id=(ledger.step_key or step_id) if name == "maxStepTokens" else None,
                )

    def _open_run_sandbox(
        self, run_id: str, workspaces: list[ResolvedWorkspace], latest: JsonObject | None, signal: AbortSignal | None
    ) -> Awaitable[Any]:
        existing = self._run_sandbox_openings.get(run_id)
        if existing is not None:
            return existing
        provider = self._deps.run_sandbox
        loop = asyncio.get_running_loop()
        if provider is None:
            failed: asyncio.Future[Any] = loop.create_future()
            failed.set_exception(Error("This run has no RunSandboxProvider configured"))
            return failed
        budget = _sandbox_budget_from_checkpoint(latest)

        async def emit(event_type: str, data: JsonObject | None = None, step_id: str | None = None) -> JsonObject:
            return await self._emit(run_id, event_type, data, step_id, step_id)

        request: JsonObject = {
            "runId": run_id,
            "attempt": self._run_attempts.get(run_id, 1),
            "workspaces": workspaces,
            "emit": emit,
        }
        if self._deps.artifacts is not None:
            request["artifacts"] = self._deps.artifacts
        if budget is not None:
            request["budget"] = budget
        sandbox_limits = (self._run_limits.get(run_id) or {}).get("sandbox") or {}
        if sandbox_limits:
            request["limits"] = dict(sandbox_limits)
        if signal is not None:
            request["signal"] = signal

        async def opening() -> Any:
            try:
                session = await provider.open(request)
            except BaseException:
                self._run_sandbox_openings.pop(run_id, None)
                raise
            self._run_sandbox_sessions[run_id] = session
            return session

        future = asyncio.ensure_future(opening())
        self._run_sandbox_openings[run_id] = future
        return future

    async def _close_run_sandbox(self, run_id: str, reason: str) -> None:
        session = self._run_sandbox_sessions.pop(run_id, None)
        self._run_sandbox_openings.pop(run_id, None)
        if session is not None:
            budget = session.budget()
            tracker = self._run_ledgers.get(run_id)
            if tracker is not None:
                tracker.set_sandbox({"commands": budget["commandsUsed"], "seconds": budget["sandboxSecondsUsed"]})
            try:
                await session.close(reason)
            finally:
                self._collect_workspace_changes(run_id, session)

    async def _close_run_sandbox_quietly(self, run_id: str, reason: str) -> None:
        try:
            await self._close_run_sandbox(run_id, reason)
        except Exception as error:
            try:
                await self._emit(
                    run_id, "diagnostic", {"code": "SANDBOX_CLOSE_FAILED", "message": error_message(error)}
                )
            except Exception:
                pass

    async def _emit(
        self,
        run_id: str,
        event_type: str,
        data: JsonObject | None = None,
        step_id: str | None = None,
        step_path: str | None = None,
    ) -> JsonObject:
        lock = self._event_locks.get(run_id)
        if lock is None:
            lock = asyncio.Lock()
            self._event_locks[run_id] = lock
        async with lock:
            event: JsonObject = {
                "id": self._ids.generate_id("event"),
                "runId": run_id,
                "type": event_type,
                "sequence": self._event_sequences.get(run_id, 0) + 1,
                "attempt": self._run_attempts.get(run_id, 1),
                "timestamp": self._now(),
            }
            if step_id:
                event["stepId"] = step_id
                event["stepPath"] = step_path or step_id
            if data is not None:
                event["data"] = data
            self._event_sequences[run_id] = event["sequence"]
            for sink in self._deps.event_sinks or []:
                try:
                    await maybe_await(sink.emit(event))
                except Exception as error:
                    if self._deps.on_event_sink_error is not None:
                        self._deps.on_event_sink_error(error, event, sink)
                    if self._deps.event_sink_failure_policy == "fail-run":
                        raise
            return event
