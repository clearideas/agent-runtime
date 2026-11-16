"""
Repo Mechanic — how a host gives an agent a workspace (Python edition of host.ts).

  agent.yaml           names the "invoice-service" workspace and the tools it wants
  runtime.config.yaml  says where that workspace lives, what is visible, and
                       which programs the run sandbox may execute
  this file            composes Agent Runtime with host policy and runs it

Read the numbered sections; everything else is demo plumbing.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

from clearideas_agent_runtime import (
    AgentRuntime,
    CodeStepExecutor,
    ComposeRuntimeOptions,
    FileAgentManifestSource,
    FileArtifactStore,
    FileRunStore,
    JexlConditionEvaluator,
    PromptStepExecutor,
    ValueResolutionContext,
    WorkspaceCompositionOptions,
    compose_runtime,
    load_agent_runtime_config,
)

from lib import js
from lib.demo import DemoContext, DemoRunRequest, Emit, ShowcaseDemo
from lib.environment import apply_sandbox_choice, assert_mode_allowed
from lib.host_kit import run_sync, summarize_result, to_json, visibility_of, with_model_overrides
from lib.observed_tools import ObservedToolAdapter, ObservedToolCall, truncate_for_display
from lib.scripted_model import ScriptedModelAdapter
from lib.workspace_files import describe_workspace, seed_workspace

from .script import repo_mechanic_script

demo_directory = Path(__file__).resolve().parent
fixture_directory = str(demo_directory / "fixture")
WORKSPACE = "invoice-service"

# ─── 1. Load the portable agent and the host's configuration ─────────────────
# The manifest is portable: it could run under the CLI, a remote worker, or
# another host. The configuration is host-owned and never comes from a request.
manifest = run_sync(FileAgentManifestSource(str(demo_directory), "agent.yaml").load_manifest())
host_config = run_sync(load_agent_runtime_config(demo_directory / "runtime.config.yaml"))


def repository_root(data_directory: str) -> str:
    return os.path.join(data_directory, "invoice-service")


workspace_definition = host_config["workspaces"][WORKSPACE]
visibility = visibility_of(workspace_definition)


class RepoMechanic(ShowcaseDemo):
    id = "repo-mechanic"
    title = "Repo Mechanic"
    summary = "An agent fixes a failing test inside a sandbox, under host policy."
    tagline = "An agent reproduces a bug, edits the code, and proves the fix — every file operation and test run executes inside an isolated run sandbox."
    features = [
        "Workspaces",
        "Run sandbox",
        "Allowlisted commands",
        "Host policy hooks",
        "Code steps in the sandbox",
        "Sync-back & audit trail",
    ]
    sources = [
        {
            "path": "demos/repo-mechanic/agent.yaml",
            "language": "yaml",
            "caption": "The portable agent: it binds the workspace by name and narrows the tools.",
        },
        {
            "path": "demos/repo-mechanic/runtime.config.yaml",
            "language": "yaml",
            "caption": "Host configuration: where the workspace lives, what is visible, and the sandbox command policy.",
        },
        {
            "path": "demos/repo-mechanic/host.py",
            "language": "python",
            "caption": "The integration: compose adapters, add host policy hooks, and run.",
        },
        {
            "path": "demos/repo-mechanic/script.py",
            "language": "python",
            "caption": "Scripted mode only: the model's decisions, computed from real tool results.",
        },
    ]

    async def describe(self, context: DemoContext) -> Any:
        sandbox = host_config.get("sandbox") or {}
        return to_json(
            {
                "manifest": manifest,
                "workspace": {
                    "name": WORKSPACE,
                    "hostRoot": repository_root(context.data_directory),
                    "mode": workspace_definition["mode"],
                    **visibility,
                },
                "sandbox": {
                    "limits": sandbox.get("limits") or {},
                    "commands": list(sandbox.get("commands") or {}),
                },
            }
        )

    async def state(self, context: DemoContext, url: Any) -> Any:
        return to_json(
            {
                "workspaces": [
                    {
                        "alias": "repo",
                        "name": WORKSPACE,
                        "mode": workspace_definition["mode"],
                        "files": await describe_workspace(
                            root=repository_root(context.data_directory),
                            fixture=fixture_directory,
                            **visibility,
                        ),
                    }
                ]
            }
        )

    async def reset(self, context: DemoContext) -> None:
        seed_workspace(fixture_directory, repository_root(context.data_directory))

    async def run(self, context: DemoContext, request: DemoRunRequest, emit: Emit, signal: Any) -> None:
        assert_mode_allowed(context.environment, request.mode)
        allow_writes = request.options.get("allowWrites") is not False
        issue_option = request.options.get("issue")
        issue = (
            js.slice(js.trim(issue_option), 0, 500) if isinstance(issue_option, str) and js.trim(issue_option) else None
        )
        root = repository_root(context.data_directory)
        if request.options.get("resetWorkspace") is not False:
            seed_workspace(fixture_directory, root)

        # ─── 2. Choose the sandbox this machine supports ─────────────────────
        config, sandbox_provider = apply_sandbox_choice(
            with_model_overrides(host_config), context.environment["sandbox"]
        )

        # ─── 3. Compose adapters from configuration, with host policy hooks ──
        # compose_runtime returns the workspace provider, the run sandbox, and
        # a tool adapter that serves `repo__*` tools by relaying each call
        # into the sandbox. The hooks run before anything executes; raising
        # denies.
        def authorize_workspace(request: dict[str, Any]) -> None:
            if request["binding"]["ref"] != WORKSPACE:
                raise PermissionError(f"Workspace {request['binding']['ref']} is not authorized.")

        def authorize_sandbox(request: dict[str, Any]) -> None:
            if any(mount["alias"] != "repo" for mount in request["mounts"]):
                raise PermissionError("Unexpected mount in the run sandbox.")

        # Every command — built-in file operations, allowlisted programs, and
        # code steps — passes through here with its exact argv.
        def authorize_command(request: dict[str, Any], context: dict[str, Any]) -> None:
            if not allow_writes and request["record"]["name"] in ("write_file", "delete_file"):
                raise PermissionError("Writes to invoice-service are disabled by the host policy.")

        composed = compose_runtime(
            manifest,
            config,
            # Environment references in the configuration resolve from here,
            # so one configuration can serve every tenant or checkout.
            ValueResolutionContext(environment={**os.environ, "SHOWCASE_REPO_ROOT": root}),
            ComposeRuntimeOptions(
                model=request.mode == "live" and context.live_model is None,
                workspace_options=WorkspaceCompositionOptions(
                    sandbox_provider=sandbox_provider,
                    authorize_workspace=authorize_workspace,
                    authorize_sandbox=authorize_sandbox,
                    authorize_command=authorize_command,
                ),
            ),
        )
        if composed.tools is None:
            raise RuntimeError("Workspace tools were not composed.")

        # Mirror tool payloads to the browser (events carry names only).
        def mirror(observed: ObservedToolCall) -> None:
            result = observed.result
            message: dict[str, Any] = {
                "kind": "tool-io",
                "stepId": observed.step_id,
                "toolCallId": observed.call["id"],
                "name": observed.call["name"],
                "input": truncate_for_display(observed.call.get("input")),
            }
            if result.get("error"):
                message["error"] = {"code": result["error"]["code"], "message": result["error"]["message"]}
            else:
                message["output"] = truncate_for_display(result.get("output"))
            emit(message)

        class Forward:
            def emit(self, event: dict[str, Any]) -> None:
                emit({"kind": "event", "event": event})

        # ─── 4. Create the runtime and stream its events ─────────────────────
        runtime = AgentRuntime(
            model=(
                (context.live_model() if context.live_model is not None else composed.model)
                if request.mode == "live"
                else ScriptedModelAdapter(repo_mechanic_script, pace=request.pace)
            ),
            tools=ObservedToolAdapter(composed.tools, mirror),
            workspaces=composed.workspaces,
            run_sandbox=composed.run_sandbox,
            messages=composed.messages,
            run_store=FileRunStore(os.path.join(context.data_directory, "runs")),
            artifacts=FileArtifactStore(os.path.join(context.data_directory, "artifacts")),
            step_executors=[PromptStepExecutor(), CodeStepExecutor()],
            condition_evaluator=JexlConditionEvaluator(),
            event_sinks=[Forward()],
        )

        run_id = f"repo-{uuid.uuid4()}"
        emit(
            {
                "kind": "accepted",
                "runId": run_id,
                "mode": request.mode,
                "sandbox": context.environment["sandbox"]["kind"],
            }
        )
        result = await runtime.run(
            manifest=manifest,
            run_id=run_id,
            **({"variables": [{"key": "issue", "value": issue}]} if issue else {}),
            signal=signal,
        )
        emit({"kind": "result", "result": summarize_result(result)})


demo = RepoMechanic()
