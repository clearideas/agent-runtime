"""
Document Library — a read-only workspace next to an MCP tool (Python edition of host.ts).

  agent.yaml           binds the library read-only and the ticket system
  runtime.config.yaml  which files are published, and where tickets go
  this file            composes both tool sources and keeps the artifacts

Workspace tools and MCP tools arrive through one ToolAdapter: compose_runtime
merges them, and the model sees a single list of tools.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

from clearideas_agent_runtime import (
    AgentRuntime,
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

from lib.demo import DemoContext, DemoRunRequest, Emit, ShowcaseDemo
from lib.environment import apply_sandbox_choice, assert_mode_allowed
from lib.host_kit import mirror_tools, run_sync, summarize_result, to_json, visibility_of, with_model_overrides
from lib.mcp_server import DemoMcpTool, start_mcp_server
from lib.scripted_model import ScriptedModelAdapter
from lib.workspace_files import describe_workspace, seed_workspace

from .script import document_library_script

demo_directory = Path(__file__).resolve().parent
fixture = str(demo_directory / "fixture" / "policy-library")

QUESTIONS = [
    "How many days of annual leave do I get?",
    "How does expense approval work?",
    "Is there a home-office stipend?",
]

manifest = run_sync(FileAgentManifestSource(str(demo_directory), "agent.yaml").load_manifest())
host_config = run_sync(load_agent_runtime_config(demo_directory / "runtime.config.yaml"))
library_definition = host_config["workspaces"].get("policy-library")


def paths(context: DemoContext) -> dict[str, str]:
    return {
        "library": os.path.join(context.data_directory, "policy-library"),
        "artifacts": os.path.join(context.data_directory, "artifacts"),
    }


#: Artifact references seen in tool results, so the page can show them.
artifact_refs: dict[str, dict[str, Any]] = {}
ticket_number = 1041


def create_ticket(_input: dict[str, Any]) -> dict[str, Any]:
    global ticket_number
    ticket_number += 1
    return {"id": f"PEOPLE-{ticket_number}", "status": "open"}


class DocumentLibrary(ShowcaseDemo):
    id = "document-library"
    title = "Document Library"
    summary = "Answer questions from documents the agent can read but never change."
    tagline = "A policy assistant searches a read-only library, looks at a diagram as an image, and files a ticket through an MCP server when no published policy has the answer."
    features = ["Read-only workspaces", "Visibility globs", "Image artifacts", "MCP tools"]
    sources = [
        {
            "path": "demos/document-library/agent.yaml",
            "language": "yaml",
            "caption": "The agent: research with workspace and MCP tools, then reply.",
        },
        {
            "path": "demos/document-library/runtime.config.yaml",
            "language": "yaml",
            "caption": "Host configuration: which library files are published, and the ticket system.",
        },
        {
            "path": "demos/document-library/host.py",
            "language": "python",
            "caption": "The integration: one composed ToolAdapter and an ArtifactStore for images.",
        },
        {
            "path": "demos/document-library/script.py",
            "language": "python",
            "caption": "Scripted mode only: the model's decisions.",
        },
    ]

    async def describe(self, context: DemoContext) -> Any:
        return to_json({"manifest": manifest, "questions": QUESTIONS})

    async def state(self, context: DemoContext, url: Any) -> Any:
        return to_json(
            {
                "workspaces": [
                    {
                        "alias": "library",
                        "name": "policy-library",
                        "mode": "read",
                        "files": await describe_workspace(
                            root=paths(context)["library"], fixture=fixture, **visibility_of(library_definition)
                        ),
                    }
                ]
            }
        )

    async def reset(self, context: DemoContext) -> None:
        library = paths(context)["library"]
        seed_workspace(fixture, library)
        # Made at seed time: a version-control folder is never addressable.
        os.makedirs(os.path.join(library, ".git"), exist_ok=True)
        with open(os.path.join(library, ".git", "HEAD"), "w", encoding="utf-8") as head:
            head.write("ref: refs/heads/main\n")

    async def artifact(self, context: DemoContext, artifact_id: str) -> tuple[str, bytes] | None:
        ref = artifact_refs.get(artifact_id)
        if ref is None:
            return None
        stored = await FileArtifactStore(paths(context)["artifacts"]).get(ref)
        return ref["mediaType"], stored["data"]

    async def run(self, context: DemoContext, request: DemoRunRequest, emit: Emit, signal: Any) -> None:
        assert_mode_allowed(context.environment, request.mode)
        question_option = request.options.get("question")
        question = (
            question_option if isinstance(question_option, str) and question_option in QUESTIONS else QUESTIONS[0]
        )
        await self.reset(context)

        # The ticket system is an ordinary MCP server; here, a local stand-in.
        tickets = await start_mcp_server(
            "tickets",
            [
                DemoMcpTool(
                    name="create",
                    description="Create a ticket for People Operations.",
                    input_schema={
                        "type": "object",
                        "properties": {"title": {"type": "string"}, "details": {"type": "string"}},
                        "required": ["title", "details"],
                        "additionalProperties": False,
                    },
                    call=create_ticket,
                )
            ],
        )

        try:
            config, sandbox_provider = apply_sandbox_choice(
                with_model_overrides(host_config), context.environment["sandbox"]
            )

            # ─── 1. Compose workspace tools and MCP tools together ───────────
            # MCP calls pass their own host hook; this one only allows
            # creating tickets.
            def authorize_tool(request: dict[str, Any], context: Any) -> None:
                if request["toolName"] != "create":
                    raise PermissionError(f"{request['toolName']} is not allowed.")

            composed = compose_runtime(
                manifest,
                config,
                ValueResolutionContext(
                    environment={
                        **os.environ,
                        "SHOWCASE_LIBRARY_ROOT": paths(context)["library"],
                        "SHOWCASE_TICKETS_URL": tickets.url,
                    }
                ),
                ComposeRuntimeOptions(
                    model=request.mode == "live" and context.live_model is None,
                    workspace_options=WorkspaceCompositionOptions(sandbox_provider=sandbox_provider),
                    tool_options={"authorize_tool": authorize_tool},
                ),
            )
            if composed.tools is None:
                raise RuntimeError("Tools were not composed.")

            def remember_artifacts(message: dict[str, Any]) -> None:
                if message["kind"] == "tool-io" and isinstance(message.get("artifacts"), list):
                    for ref in message["artifacts"]:
                        artifact_refs[ref["id"]] = ref
                emit(message)

            class Forward:
                def emit(self, event: dict[str, Any]) -> None:
                    emit({"kind": "event", "event": event})

            # ─── 2. An ArtifactStore for binary files ────────────────────────
            # read_file never returns base64. Binary files are stored as
            # artifacts and attached to the tool result; multimodal models
            # receive the image.
            runtime = AgentRuntime(
                model=(
                    (context.live_model() if context.live_model is not None else composed.model)
                    if request.mode == "live"
                    else ScriptedModelAdapter(document_library_script, pace=request.pace)
                ),
                tools=mirror_tools(composed.tools, remember_artifacts),
                workspaces=composed.workspaces,
                run_sandbox=composed.run_sandbox,
                messages=composed.messages,
                artifacts=FileArtifactStore(paths(context)["artifacts"]),
                run_store=FileRunStore(os.path.join(context.data_directory, "runs")),
                step_executors=[PromptStepExecutor()],
                condition_evaluator=JexlConditionEvaluator(),
                event_sinks=[Forward()],
            )

            run_id = f"library-{uuid.uuid4()}"
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
                variables=[{"key": "question", "value": question}],
                signal=signal,
            )
            emit({"kind": "result", "result": summarize_result(result)})
        finally:
            await tickets.close()


demo = DocumentLibrary()
