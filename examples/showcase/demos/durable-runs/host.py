"""
Durable Runs — how a host pauses a run and resumes it later (Python edition of host.ts).

  agent.yaml           shared report manifest for both runtimes
  runtime.config.yaml  a read-only data workspace and a read-write reports one
  this file            an ApprovalAdapter that pauses, and a resume endpoint

A paused run is saved by the RunStore. Nothing stays in memory: resuming
builds a brand-new AgentRuntime, as it would after a server restart.
"""

from __future__ import annotations

import copy
import os
import re
import shutil
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from clearideas_agent_runtime import (
    AgentRuntime,
    AgentRuntimeError,
    ApprovalStepExecutor,
    ComposeRuntimeOptions,
    FileAgentManifestSource,
    FileArtifactStore,
    FileRunStore,
    JexlConditionEvaluator,
    LocalDirectoryWorkspace,
    PromptStepExecutor,
    RunSuspendedError,
    ValueResolutionContext,
    WorkspaceCompositionOptions,
    assess_manifest_change,
    compose_runtime,
    is_run_suspended_error,
    load_agent_runtime_config,
    parse_agent_manifest,
)

from lib import js
from lib.demo import DemoContext, DemoRunRequest, Emit, ShowcaseDemo
from lib.environment import apply_sandbox_choice, assert_mode_allowed
from lib.host_kit import (
    mirror_tools,
    run_sync,
    stringify,
    summarize_result,
    to_json,
    visibility_of,
    with_model_overrides,
)
from lib.js import is_safe_integer, number
from lib.scripted_model import ScriptedModelAdapter
from lib.workspace_files import describe_workspace, seed_workspace

from .script import durable_runs_script

demo_directory = Path(__file__).resolve().parent
fixtures = demo_directory / "fixture"
#: Small enough that the run pauses while drafting when the budget is on.
TOKEN_LIMIT = 1_000

manifest = run_sync(FileAgentManifestSource(str(demo_directory), "agent.yaml").load_manifest())
host_config = run_sync(load_agent_runtime_config(demo_directory / "runtime.config.yaml"))

workspaces = [
    {"alias": "data", "name": "sales-data", "folder": "sales-data"},
    {"alias": "reports", "name": "reports", "folder": "reports"},
]


def _with_instruction(source: dict[str, Any], step_id: str, sentence: str) -> dict[str, Any]:
    edited = copy.deepcopy(source)
    for step in edited["steps"]:
        if step["id"] == step_id:
            step["systemPrompt"] += " " + sentence
    return parse_agent_manifest(edited)


EDITS = {
    "turn-limit": {
        "label": "Cap each prompt step at 12 model turns",
        "detail": "limits.maxTurnsPerPrompt: 12",
        "apply": lambda source: {**source, "limits": {**source.get("limits", {}), "maxTurnsPerPrompt": 12}},
    },
    "publish-summary": {
        "label": "Publish: start the report with a one-line summary",
        "detail": "steps.publish.systemPrompt",
        "apply": lambda source: _with_instruction(
            source, "publish", "Begin the published report with a one-line summary."
        ),
    },
    "draft-thousands": {
        "label": "Draft: round amounts to thousands ($453K)",
        "detail": "steps.draft.systemPrompt",
        "apply": lambda source: _with_instruction(
            source, "draft", "Round amounts to the nearest thousand, such as $453K."
        ),
    },
    "quarter-q2": {
        "label": "Report on Q2 instead of Q3",
        "detail": "variables.quarter: Q2",
        "apply": lambda source: {
            **source,
            "variables": [
                {**variable, "value": "Q2"} if variable["key"] == "quarter" else variable
                for variable in source.get("variables", [])
            ],
        },
    },
}


def edit_of(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or value not in EDITS:
        raise RuntimeError("Unknown edit.")
    return value


def manifest_for(edit: str | None) -> dict[str, Any]:
    return EDITS[edit]["apply"](manifest) if edit else manifest


# ─── Host state: what the browser needs to resume a paused run ───────────────
# pending.json holds {runId, reason, details, mode}; each decision file holds
# {approved, reviewer, respondedAt}.


class Files:
    def __init__(self, context: DemoContext) -> None:
        self.data_directory = context.data_directory
        self.pending = os.path.join(context.data_directory, "pending.json")
        self.outage = os.path.join(context.data_directory, "outage.json")
        self.last_run = os.path.join(context.data_directory, "last-run.json")

    def root(self, folder: str) -> str:
        return os.path.join(self.data_directory, folder)

    def decision(self, run_id: str, step_id: str) -> str:
        return os.path.join(self.data_directory, "decisions", f"{run_id}.{step_id}.json")

    def snapshot(self, token: str) -> str:
        return os.path.join(self.data_directory, "snapshots", token)


def read_json_file(file: str) -> Any:
    try:
        with open(file, encoding="utf-8") as handle:
            return js.parse(handle.read())
    except FileNotFoundError:
        return None


def write_json_file(file: str, value: Any) -> None:
    os.makedirs(os.path.dirname(file), exist_ok=True)
    with open(file, "w", encoding="utf-8") as handle:
        handle.write(stringify(value, 2))


class SnapshottingWorkspace(LocalDirectoryWorkspace):
    def __init__(self, root: str, snapshot):
        super().__init__(root=root, mode="read_write")
        self._snapshot = snapshot

    async def commit(self, point: dict[str, Any]) -> dict[str, str]:
        token = f"{point['runId']}.{point['checkpointSequence']}"
        shutil.copytree(self.root, self._snapshot(token), dirs_exist_ok=True)
        return {"token": token}


class RestoringWorkspaces:
    def __init__(self, provider: Any, context: DemoContext):
        self.provider = provider
        self.context = context

    async def resolve_workspace(self, binding: dict[str, Any], resolution: dict[str, Any] | None = None) -> Any:
        alias = binding.get("alias") or binding["ref"]
        token = ((resolution or {}).get("restoreFrom") or {}).get(alias)
        if token:
            paths = Files(self.context)
            folder = next(workspace["folder"] for workspace in workspaces if workspace["name"] == binding["ref"])
            shutil.rmtree(paths.root(folder), ignore_errors=True)
            shutil.copytree(paths.snapshot(token), paths.root(folder))
        return await self.provider.resolve_workspace(binding, resolution)


class OutageModel:
    def __init__(self, model: Any, current_step: dict[str, str | None]):
        self.model = model
        self.current_step = current_step

    def _check(self) -> None:
        if self.current_step["id"] == "publish":
            raise AgentRuntimeError("The model provider is unavailable (HTTP 503).", "MODEL_PROVIDER_UNAVAILABLE", True)

    async def generate(self, request: dict[str, Any]) -> Any:
        self._check()
        return await self.model.generate(request)

    async def stream(self, request: dict[str, Any]):
        self._check()
        async for item in self.model.stream(request):
            yield item

    def describe_model(self, name: str) -> Any:
        return self.model.describe_model(name) if hasattr(self.model, "describe_model") else None


# ─── The runtime for one attempt ─────────────────────────────────────────────


def create_runtime(context: DemoContext, run_id: str, mode: str, pace: float, emit: Emit) -> AgentRuntime:
    paths = Files(context)
    outage = (read_json_file(paths.outage) or {}).get("runId") == run_id
    current_step: dict[str, str | None] = {"id": None}
    config, sandbox_provider = apply_sandbox_choice(with_model_overrides(host_config), context.environment["sandbox"])
    composed = compose_runtime(
        manifest,
        config,
        ValueResolutionContext(
            environment={
                **os.environ,
                "SHOWCASE_SALES_ROOT": paths.root("sales-data"),
                "SHOWCASE_REPORTS_ROOT": paths.root("reports"),
            }
        ),
        ComposeRuntimeOptions(
            model=mode == "live" and context.live_model is None,
            workspace_options=WorkspaceCompositionOptions(
                sandbox_provider=sandbox_provider,
                create_workspace=lambda name, definition, resolution: (
                    SnapshottingWorkspace(paths.root("reports"), paths.snapshot) if name == "reports" else None
                ),
            ),
        ),
    )
    if composed.tools is None:
        raise RuntimeError("Workspace tools were not composed.")

    # ─── 1. An ApprovalAdapter that pauses the run ───────────────────────────
    # With no decision yet, raising RunSuspendedError saves the run and ends
    # this attempt. When the run resumes, the same step asks again and this
    # time finds the person's decision.
    class PausingApprovals:
        async def request_approval(self, request: dict[str, Any], signal: Any = None) -> dict[str, Any]:
            decision = read_json_file(paths.decision(request["runId"], request["stepId"]))
            if decision is None:
                raise RunSuspendedError("approval", {"stepId": request["stepId"], "prompt": request["prompt"]})
            return {
                "approved": decision["approved"],
                "respondedAt": decision["respondedAt"],
                "response": {"reviewer": decision["reviewer"]},
            }

    class Forward:
        def emit(self, event: dict[str, Any]) -> None:
            if event["type"] == "step.started":
                current_step["id"] = event.get("stepId")
            emit({"kind": "event", "event": event})

    # ─── 2. A durable RunStore ───────────────────────────────────────────────
    # FileRunStore keeps checkpoints on disk; SqliteRunStore or your own
    # database-backed RunStore work the same way.
    model = (
        (context.live_model() if context.live_model is not None else composed.model)
        if mode == "live"
        else ScriptedModelAdapter(durable_runs_script, pace=pace)
    )
    return AgentRuntime(
        model=OutageModel(model, current_step) if outage else model,
        tools=mirror_tools(composed.tools, emit),
        workspaces=RestoringWorkspaces(composed.workspaces, context),
        run_sandbox=composed.run_sandbox,
        messages=composed.messages,
        approvals=PausingApprovals(),
        run_store=FileRunStore(os.path.join(context.data_directory, "runs")),
        artifacts=FileArtifactStore(os.path.join(context.data_directory, "artifacts")),
        step_executors=[PromptStepExecutor(), ApprovalStepExecutor()],
        condition_evaluator=JexlConditionEvaluator(),
        event_sinks=[Forward()],
    )


async def attempt(
    context: DemoContext, mode: str, emit: Emit, run: Callable[[], Awaitable[dict[str, Any]]], run_id: str
) -> None:
    """Run one attempt. A pause is a normal outcome, not an error."""
    paths = Files(context)
    try:
        result = await run()
    except Exception as error:
        if not is_run_suspended_error(error):
            raise
        write_json_file(
            paths.pending, {"runId": run_id, "reason": error.reason, "details": error.details or {}, "mode": mode}
        )
        return
    if os.path.exists(paths.pending):
        os.remove(paths.pending)
    emit({"kind": "result", "result": summarize_result(result)})


def run_store_of(context: DemoContext) -> FileRunStore:
    return FileRunStore(os.path.join(context.data_directory, "runs"))


async def restart_points(context: DemoContext, run_id: str, edited: dict[str, Any]) -> list[dict[str, Any]]:
    store = run_store_of(context)
    points = await store.list_checkpoints(run_id, {"boundaries": True})
    described = []
    for point in points:
        boundary = point.get("boundary")
        if not boundary or boundary.get("stepIndex", 0) >= len(manifest["steps"]) - 1:
            continue
        checkpoint = await store.load_checkpoint(run_id, point["sequence"])
        if checkpoint is None:
            continue
        token = ((checkpoint.get("workspaces") or {}).get("reports") or {}).get("token")
        snapshot = (
            await describe_workspace(root=Files(context).snapshot(token), fixture=str(fixtures / "reports"))
            if token
            else []
        )
        described.append(
            {
                "sequence": point["sequence"],
                "stepId": boundary["stepPath"],
                "createdAt": point["createdAt"],
                "snapshot": {"token": token, "files": [item["path"] for item in snapshot]} if token else None,
                "assessment": await assess_manifest_change(checkpoint, edited),
            }
        )
    return described


async def history_of(context: DemoContext, edited: dict[str, Any]) -> dict[str, Any] | None:
    last = read_json_file(Files(context).last_run)
    if not last:
        return None
    store = run_store_of(context)
    record = await store.load_run(last["runId"])
    latest = await store.load_latest_checkpoint(last["runId"])
    if record is None or latest is None:
        return None
    ledger = latest.get("ledger")
    return {
        "runId": last["runId"],
        "status": record["status"],
        "attempts": latest.get("attempt", 1),
        "seededFrom": (latest.get("metadata") or {}).get("seededFrom"),
        "ledger": {
            "tokens": ledger["tokens"],
            "recoveries": ledger.get("recoveries", 0),
            "blocked": ledger.get("blocked"),
        }
        if ledger
        else None,
        "restartPoints": await restart_points(context, last["runId"], edited),
    }


async def seed_for(context: DemoContext, from_point: Any) -> dict[str, Any]:
    point = from_point if isinstance(from_point, dict) else {}
    run_id, sequence = point.get("runId"), point.get("sequence")
    if (
        not isinstance(run_id, str)
        or not re.fullmatch(r"report-[0-9a-f-]{36}", run_id)
        or not isinstance(sequence, (int, float))
        or not is_safe_integer(sequence)
    ):
        raise RuntimeError("Choose a restart point.")
    seed = await run_store_of(context).load_checkpoint(run_id, int(sequence))
    if not seed or not seed.get("boundary"):
        raise RuntimeError("That restart point is not available.")
    return seed


class DurableRuns(ShowcaseDemo):
    id = "durable-runs"
    title = "Durable Runs"
    summary = "A run pauses for approval, a limit, or an outage, then resumes or restarts from a step."
    tagline = "An agent drafts a report, then waits for a person. The run is saved to disk and its sandbox closes; approving resumes it in a new attempt with the draft still there. Every completed step is a restart point with a snapshot of the reports folder, and edits to the agent are checked against what already ran."
    features = [
        "Approvals",
        "Run limits",
        "Pause on failure",
        "Checkpoints",
        "Resume",
        "Step snapshots",
        "Restart from a step",
        "Manifest changes",
    ]
    sources = [
        {
            "path": "demos/durable-runs/agent.yaml",
            "language": "yaml",
            "caption": "The agent: draft, an approval step, then publish; failures pause the run.",
        },
        {
            "path": "demos/durable-runs/runtime.config.yaml",
            "language": "yaml",
            "caption": "Host configuration: a read-only data workspace and a read-write reports workspace.",
        },
        {
            "path": "demos/durable-runs/host.py",
            "language": "python",
            "caption": "The integration: snapshots at step commit points, an ApprovalAdapter that pauses, resume, restart, and edit checks.",
        },
        {
            "path": "demos/durable-runs/script.py",
            "language": "python",
            "caption": "Scripted mode only: the model's decisions, computed from the real CSV files and the instructions it is given.",
        },
    ]

    async def describe(self, context: DemoContext) -> Any:
        return to_json(
            {
                "manifest": manifest,
                "tokenLimit": TOKEN_LIMIT,
                "edits": [{"id": key, "label": edit["label"], "detail": edit["detail"]} for key, edit in EDITS.items()],
            }
        )

    async def state(self, context: DemoContext, url: Any) -> Any:
        paths = Files(context)
        edit = edit_of(url.param("edit"))
        edited = manifest_for(edit)
        pending = read_json_file(paths.pending)
        checkpoint = await run_store_of(context).load_latest_checkpoint(pending["runId"]) if pending else None
        return to_json(
            {
                "workspaces": [
                    {
                        "alias": workspace["alias"],
                        "name": workspace["name"],
                        "mode": (host_config["workspaces"].get(workspace["name"]) or {}).get("mode"),
                        "files": await describe_workspace(
                            root=paths.root(workspace["folder"]),
                            fixture=str(fixtures / workspace["folder"]),
                            **visibility_of(host_config["workspaces"].get(workspace["name"])),
                        ),
                    }
                    for workspace in workspaces
                ],
                "pending": pending,
                "edit": edit,
                "resumeAssessment": await assess_manifest_change(checkpoint, edited) if checkpoint else None,
                "history": await history_of(context, edited),
            }
        )

    async def reset(self, context: DemoContext) -> None:
        paths = Files(context)
        for workspace in workspaces:
            seed_workspace(str(fixtures / workspace["folder"]), paths.root(workspace["folder"]))
        if os.path.exists(paths.pending):
            os.remove(paths.pending)
        if os.path.exists(paths.outage):
            os.remove(paths.outage)

    async def run(self, context: DemoContext, request: DemoRunRequest, emit: Emit, signal: Any) -> None:
        assert_mode_allowed(context.environment, request.mode)
        edit = edit_of(request.options.get("edit"))
        seed = await seed_for(context, request.options["restartFrom"]) if request.options.get("restartFrom") else None
        if seed:
            assessment = await assess_manifest_change(seed, manifest_for(edit))
            if assessment["outcome"] == "refused":
                raise RuntimeError(f"The run cannot restart from there with this edit. {assessment['reason']}")
        await self.reset(context)
        run_id = f"report-{uuid.uuid4()}"
        paths = Files(context)
        write_json_file(paths.last_run, {"runId": run_id})
        if request.options.get("outage") is True:
            write_json_file(paths.outage, {"runId": run_id})
        runtime = create_runtime(context, run_id, request.mode, request.pace, emit)
        emit(
            {
                "kind": "accepted",
                "runId": run_id,
                "mode": request.mode,
                "sandbox": context.environment["sandbox"]["kind"],
            }
        )
        await attempt(
            context,
            request.mode,
            emit,
            lambda: runtime.run(
                manifest=manifest_for(edit),
                run_id=run_id,
                **({"seed": seed} if seed else {}),
                **({"limits": {"maxTotalTokens": TOKEN_LIMIT}} if request.options.get("tokenLimit") is True else {}),
                signal=signal,
            ),
            run_id,
        )

    # ─── 3. Resume a paused run ──────────────────────────────────────────────
    async def resume(self, context: DemoContext, run_id: str, request: DemoRunRequest, emit: Emit, signal: Any) -> None:
        paths = Files(context)
        pending = read_json_file(paths.pending)
        if not pending or pending["runId"] != run_id:
            raise RuntimeError("There is no paused run with that ID.")
        assert_mode_allowed(context.environment, pending["mode"])

        edit = edit_of(request.options.get("edit"))
        checkpoint = await run_store_of(context).load_latest_checkpoint(run_id)
        if checkpoint:
            assessment = await assess_manifest_change(checkpoint, manifest_for(edit))
            if assessment["outcome"] == "refused":
                raise RuntimeError(f"The run cannot resume with this edit. {assessment['reason']}")

        limits: dict[str, Any] | None = None
        if pending["reason"] == "approval":
            decision = request.options.get("decision")
            if decision not in ("approve", "reject"):
                raise RuntimeError("Choose approve or reject.")
            # A real host records the authenticated user here.
            reviewer = request.options.get("reviewer")
            reviewer = (
                js.slice(js.trim(reviewer), 0, 60)
                if isinstance(reviewer, str) and js.trim(reviewer)
                else "the reviewer"
            )
            write_json_file(
                paths.decision(run_id, str(pending["details"].get("stepId"))),
                {
                    "approved": decision == "approve",
                    "reviewer": reviewer,
                    "respondedAt": js.now_iso(),
                },
            )
        elif pending["details"].get("cause") == "limit":
            limit = number(request.options.get("maxTotalTokens"))
            consumed = number(pending["details"].get("used") or 0)
            if not is_safe_integer(limit) or limit <= consumed:
                raise RuntimeError("The new limit must be higher than the tokens used.")
            limits = {"maxTotalTokens": int(limit)}

        if pending["details"].get("cause") == "error" and os.path.exists(paths.outage):
            os.remove(paths.outage)

        # A new runtime with new adapters: nothing is carried over in memory.
        runtime = create_runtime(context, run_id, pending["mode"], request.pace, emit)
        emit(
            {
                "kind": "accepted",
                "runId": run_id,
                "mode": pending["mode"],
                "sandbox": context.environment["sandbox"]["kind"],
                "resumed": True,
            }
        )
        await attempt(
            context,
            pending["mode"],
            emit,
            lambda: runtime.run(
                run_id=run_id,
                resume=True,
                manifest=manifest_for(edit),
                **({"limits": limits} if limits else {}),
                signal=signal,
            ),
            run_id,
        )


demo = DurableRuns()
