"""
Durable Runs — how a host pauses a run and resumes it later (Python edition of host.ts).

  agent.python.yaml    0.9-compatible report manifest for this host
  runtime.config.yaml  a read-only data workspace and a read-write reports one
  this file            an ApprovalAdapter that pauses, and a resume endpoint

A paused run is saved by the RunStore. Nothing stays in memory: resuming
builds a brand-new AgentRuntime, as it would after a server restart.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from clearideas_agent_runtime import (
    AgentRuntime,
    ApprovalStepExecutor,
    ComposeRuntimeOptions,
    FileAgentManifestSource,
    FileArtifactStore,
    FileRunStore,
    JexlConditionEvaluator,
    PromptStepExecutor,
    RunSuspendedError,
    ValueResolutionContext,
    WorkspaceCompositionOptions,
    compose_runtime,
    is_run_suspended_error,
    load_agent_runtime_config,
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
TOKEN_BUDGET = 1_000

manifest = run_sync(FileAgentManifestSource(str(demo_directory), "agent.python.yaml").load_manifest())
host_config = run_sync(load_agent_runtime_config(demo_directory / "runtime.config.yaml"))

workspaces = [
    {"alias": "data", "name": "sales-data", "folder": "sales-data"},
    {"alias": "reports", "name": "reports", "folder": "reports"},
]

# ─── Host state: what the browser needs to resume a paused run ───────────────
# pending.json holds {runId, reason, details, mode}; each decision file holds
# {approved, reviewer, respondedAt}.


class Files:
    def __init__(self, context: DemoContext) -> None:
        self.data_directory = context.data_directory
        self.pending = os.path.join(context.data_directory, "pending.json")

    def root(self, folder: str) -> str:
        return os.path.join(self.data_directory, folder)

    def decision(self, run_id: str, step_id: str) -> str:
        return os.path.join(self.data_directory, "decisions", f"{run_id}.{step_id}.json")


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


# ─── The runtime for one attempt ─────────────────────────────────────────────


def create_runtime(context: DemoContext, mode: str, pace: float, emit: Emit) -> AgentRuntime:
    paths = Files(context)
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
            workspace_options=WorkspaceCompositionOptions(sandbox_provider=sandbox_provider),
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
            emit({"kind": "event", "event": event})

    # ─── 2. A durable RunStore ───────────────────────────────────────────────
    # FileRunStore keeps checkpoints on disk; SqliteRunStore or your own
    # database-backed RunStore work the same way.
    return AgentRuntime(
        model=(
            (context.live_model() if context.live_model is not None else composed.model)
            if mode == "live"
            else ScriptedModelAdapter(durable_runs_script, pace=pace)
        ),
        tools=mirror_tools(composed.tools, emit),
        workspaces=composed.workspaces,
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


class DurableRuns(ShowcaseDemo):
    id = "durable-runs"
    title = "Durable Runs"
    summary = "A run pauses for approval, then resumes later with its work intact."
    tagline = "An agent drafts a report, then waits for a person. The run is saved to disk and its sandbox closes; approving it resumes the run in a new attempt with the draft still there."
    features = ["Approvals", "Token budgets", "Checkpoints", "Resume"]
    sources = [
        {
            "path": "demos/durable-runs/agent.python.yaml",
            "language": "yaml",
            "caption": "The agent: draft, an approval step, then publish.",
        },
        {
            "path": "demos/durable-runs/runtime.config.yaml",
            "language": "yaml",
            "caption": "Host configuration: a read-only data workspace and a read-write reports workspace.",
        },
        {
            "path": "demos/durable-runs/host.py",
            "language": "python",
            "caption": "The integration: an ApprovalAdapter that pauses the run, and resume with a new runtime.",
        },
        {
            "path": "demos/durable-runs/script.py",
            "language": "python",
            "caption": "Scripted mode only: the model's decisions, computed from the real CSV files.",
        },
    ]

    async def describe(self, context: DemoContext) -> Any:
        return to_json({"manifest": manifest, "tokenBudget": TOKEN_BUDGET})

    async def state(self, context: DemoContext, url: Any) -> Any:
        paths = Files(context)
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
                "pending": read_json_file(paths.pending),
            }
        )

    async def reset(self, context: DemoContext) -> None:
        paths = Files(context)
        for workspace in workspaces:
            seed_workspace(str(fixtures / workspace["folder"]), paths.root(workspace["folder"]))
        if os.path.exists(paths.pending):
            os.remove(paths.pending)

    async def run(self, context: DemoContext, request: DemoRunRequest, emit: Emit, signal: Any) -> None:
        assert_mode_allowed(context.environment, request.mode)
        await self.reset(context)
        runtime = create_runtime(context, request.mode, request.pace, emit)
        run_id = f"report-{uuid.uuid4()}"
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
                manifest=manifest,
                run_id=run_id,
                # A cumulative token budget, persisted in every checkpoint.
                **({"budget": {"maxTotalTokens": TOKEN_BUDGET}} if request.options.get("tokenBudget") is True else {}),
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

        budget: dict[str, Any] | None = None
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
        elif pending["reason"] == "token-budget":
            limit = number(request.options.get("maxTotalTokens"))
            consumed = number(pending["details"].get("consumedTokens") or 0)
            if not is_safe_integer(limit) or limit <= consumed:
                raise RuntimeError("The new limit must be higher than the tokens used.")
            # The new limit replaces the saved one; it is not an extra allowance.
            budget = {"maxTotalTokens": int(limit)}

        # A new runtime with new adapters: nothing is carried over in memory.
        runtime = create_runtime(context, pending["mode"], request.pace, emit)
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
                manifest=manifest,
                **({"budget": budget} if budget else {}),
                signal=signal,
            ),
            run_id,
        )


demo = DurableRuns()
