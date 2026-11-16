"""
Long Investigation — a step that reads more than fits in its input limit
(Python edition of host.ts).

  agent.yaml           one investigation step that reads 16 logs, and the
                       manifest's context policy (what to keep, how much)
  runtime.config.yaml  a read-only workspace with the logs
  this file            the host's default context strategy, and a model
                       wrapper that measures every request for the page

The logs and the runbook together are more than three times
`limits.maxInputBytes`. With the strategy Off the step fails at the limit, as
before context management existed. With Prune or Summarize, Agent Runtime
reduces the opening prompt and the older tool rounds before each request
would be too large, and the run finishes.
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from clearideas_agent_runtime import (
    DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
    PROMPT_POLICY_DEFAULTS,
    RUNTIME_VERSION,
    AgentRuntime,
    ComposeRuntimeOptions,
    FileAgentManifestSource,
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
from lib.host_kit import (
    forward_describe_model,
    run_sync,
    summarize_result,
    to_json,
    visibility_of,
    with_model_overrides,
)
from lib.observed_tools import ObservedToolAdapter, ObservedToolCall
from lib.scripted_model import ScriptedModelAdapter
from lib.workspace_files import describe_workspace, seed_workspace

from .script import create_investigation_script

demo_directory = Path(__file__).resolve().parent
fixtures = demo_directory / "fixture"


def _load_manifest() -> tuple[dict[str, Any] | None, str | None]:
    needs = f"Long Investigation needs an Agent Runtime with context management (installed: {RUNTIME_VERSION})."
    try:
        return run_sync(FileAgentManifestSource(str(demo_directory), "agent.yaml").load_manifest()), None
    except Exception as error:
        return None, f"{needs} ({error})"


_loaded, unavailable = _load_manifest()
#: A placeholder keeps the page renderable when the demo cannot run.
manifest: dict[str, Any] = _loaded or {
    "schemaVersion": "1.0",
    "steps": [
        {"id": "investigate", "name": "Investigate", "type": "prompt", "prompt": ""},
        {"id": "report", "name": "Report", "type": "prompt", "prompt": ""},
    ],
    "limits": {"maxInputBytes": 40_000},
}

host_config = run_sync(load_agent_runtime_config(demo_directory / "runtime.config.yaml"))
runbook = (fixtures / "runbook.md").read_text(encoding="utf-8")
log_files = sorted(os.listdir(fixtures / "incident-logs" / "logs"))
log_bytes = sum((fixtures / "incident-logs" / "logs" / file).stat().st_size for file in log_files)

#: The strategies the page offers. Off is `fail`: no reduction at all.
STRATEGIES = [
    {
        "value": "summarize-or-prune",
        "label": "Summarize",
        "help": "A summarizer model condenses the runbook and older rounds; pruning is the fallback.",
    },
    {
        "value": "prune",
        "label": "Prune",
        "help": "No extra model calls: clip the runbook, stub old tool outputs, drop the oldest rounds.",
    },
    {
        "value": "fail",
        "label": "Off",
        "help": "No reduction: the step fails at the input limit, as it did before context management.",
    },
]


def roots(context: DemoContext) -> dict[str, str]:
    return {
        "logs": os.path.join(context.data_directory, "incident-logs"),
        "runs": os.path.join(context.data_directory, "runs"),
    }


# ─── Measuring what the model receives ───────────────────────────────────────
# This wrapper is for the page only: it reports the size and kind of each
# message in every request. It never forwards content.


def size_of(value: Any) -> int:
    """UTF-8 bytes of ``JSON.stringify(value)``."""
    return js.byte_length(value)


def utf8_bytes(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


def text_of(message: dict[str, Any]) -> str:
    return "\n".join(part["text"] for part in message["content"] if part["type"] == "text")


def segment_of(message: dict[str, Any]) -> dict[str, Any]:
    size = size_of(message)
    role = message["role"]
    if role == "system":
        return {"kind": "system", "bytes": size, "label": "System prompt"}
    if role == "user":
        text = text_of(message)
        if text.startswith("[Summary of earlier work"):
            return {"kind": "summary", "bytes": size, "label": "Summary of earlier rounds"}
        removed = re.match(r"\[Agent Runtime removed (\d+)", text)
        if removed:
            return {"kind": "note", "bytes": size, "label": f"Note: {removed[1]} rounds removed"}
        if text.startswith("[Agent Runtime]"):
            return {"kind": "note", "bytes": size, "label": "Runtime note"}
        return {"kind": "opening", "bytes": size, "label": "Opening prompt"}
    if role == "assistant":
        calls = [
            f"{part['call']['name'].split('__')[-1]} {part['call']['input'].get('path') or ''}".strip()
            for part in message["content"]
            if part["type"] == "tool-call"
        ]
        return {"kind": "call", "bytes": size, "label": ", ".join(calls) if calls else "Answer"}
    part = message["content"][0] if message["content"] else None
    result = part["result"] if part is not None and part["type"] == "tool-result" else None
    output = result.get("output") if result is not None else None
    reduced = output.get("agentRuntime") if isinstance(output, dict) else None
    # A stub keeps a preview of the original output, including its path.
    stub = (
        re.search(r'"path":"([^"]+)"', output["preview"])
        if isinstance(output, dict) and isinstance(output.get("preview"), str)
        else None
    )
    tool = result["name"].split("__")[-1] if result is not None else "tool"
    return {
        "kind": "stub" if reduced == "omitted" else "clipped" if reduced == "clipped" else "result",
        "bytes": size,
        "label": output["path"]
        if isinstance(output, dict) and isinstance(output.get("path"), str)
        else stub[1]
        if stub
        else f"{tool} result",
    }


class Measured:
    """A model wrapper that reports each request before passing it on."""

    def __init__(self, model: Any, report: Callable[[dict[str, Any]], None]) -> None:
        self._model = model
        self._report = report
        # Agent Runtime treats a model whose ``stream`` is None as non-streaming.
        if getattr(model, "stream", None) is None:
            self.stream = None  # pyright: ignore[reportAttributeAccessIssue]
        for name, method in forward_describe_model(model).items():
            setattr(self, name, method)

    async def generate(self, request: dict[str, Any]) -> dict[str, Any]:
        self._report(request)
        return await self._model.generate(request)

    def stream(self, request: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:  # type: ignore[override]
        self._report(request)
        return self._model.stream(request)


def without_content(output: Any) -> Any:
    """A read_file result without its text, so the page gets sizes and counts."""
    if isinstance(output, dict) and "content" in output:
        rest = {key: value for key, value in output.items() if key != "content"}
        return to_json({**rest, "contentBytes": utf8_bytes(str(output["content"]))})
    return to_json(output)


class LongInvestigation(ShowcaseDemo):
    id = "long-investigation"
    title = "Long Investigation"
    summary = "Explore context pruning and summarization during a long-running investigation."
    tagline = "An on-call agent reads 16 service logs and a long runbook to find an incident's root cause: more than three times its input limit. Agent Runtime prunes or summarizes the opening prompt and older tool rounds before each request would be too large."
    features = [
        "Context management",
        "Opening-prompt reduction",
        "Tool-loop compaction",
        "Execution policies",
    ]
    sources = [
        {
            "path": "demos/long-investigation/agent.yaml",
            "language": "yaml",
            "caption": "The agent: one long investigation step, and its context policy.",
        },
        {
            "path": "demos/long-investigation/runtime.config.yaml",
            "language": "yaml",
            "caption": "Host configuration: the read-only log workspace.",
        },
        {
            "path": "demos/long-investigation/host.py",
            "language": "python",
            "caption": "The integration: the host's default context strategy, and a wrapper that measures each request for this page.",
        },
        {
            "path": "demos/long-investigation/script.py",
            "language": "python",
            "caption": "Scripted mode only: the model's decisions, and its answers to the summarizer.",
        },
    ]

    def __init__(self) -> None:
        self.unavailable = unavailable

    async def describe(self, context: DemoContext) -> Any:
        return to_json(
            {
                "manifest": manifest,
                "strategies": STRATEGIES,
                "limit": (manifest.get("limits") or {}).get("maxInputBytes"),
                # The goal line on the chart: the manifest's setting, else the runtime's.
                "reduceTo": ((manifest.get("policies") or {}).get("context") or {}).get("reduceTo")
                or PROMPT_POLICY_DEFAULTS.get("reduceTo")
                or 0.25,
                "runbookBytes": utf8_bytes(runbook),
                "logBytes": log_bytes,
                "logCount": len(log_files),
            }
        )

    async def state(self, context: DemoContext, url: Any) -> Any:
        return to_json(
            {
                "workspaces": [
                    {
                        "alias": "logs",
                        "name": "incident-logs",
                        "mode": "read",
                        "files": await describe_workspace(
                            root=roots(context)["logs"],
                            fixture=str(fixtures / "incident-logs"),
                            **visibility_of(host_config["workspaces"].get("incident-logs")),
                        ),
                    }
                ]
            }
        )

    async def reset(self, context: DemoContext) -> None:
        seed_workspace(str(fixtures / "incident-logs"), roots(context)["logs"])

    async def run(self, context: DemoContext, request: DemoRunRequest, emit: Emit, signal: Any) -> None:
        if unavailable:
            raise RuntimeError(unavailable)
        assert_mode_allowed(context.environment, request.mode)
        strategy = next(
            (entry["value"] for entry in STRATEGIES if entry["value"] == request.options.get("strategy")),
            STRATEGIES[0]["value"],
        )
        await self.reset(context)

        config, sandbox_provider = apply_sandbox_choice(
            with_model_overrides(host_config), context.environment["sandbox"]
        )
        composed = compose_runtime(
            manifest,
            config,
            ValueResolutionContext(environment={**os.environ, "SHOWCASE_LOGS_ROOT": roots(context)["logs"]}),
            ComposeRuntimeOptions(
                model=request.mode == "live" and context.live_model is None,
                workspace_options=WorkspaceCompositionOptions(sandbox_provider=sandbox_provider),
            ),
        )
        if composed.tools is None:
            raise RuntimeError("Workspace tools were not composed.")

        current_step = ""
        limit = (manifest.get("limits") or {}).get("maxInputBytes")

        def report(model_request: dict[str, Any]) -> None:
            summarizer = any(
                message["role"] == "system" and text_of(message) == DEFAULT_SUMMARIZER_SYSTEM_PROMPT
                for message in model_request["messages"]
            )
            emit(
                {
                    "kind": "model-input",
                    "stepId": current_step,
                    "purpose": "summarize" if summarizer else "step",
                    "bytes": size_of(model_request["messages"]),
                    "limit": limit,
                    "segments": [] if summarizer else [segment_of(message) for message in model_request["messages"]],
                }
            )

        model = Measured(
            (context.live_model() if context.live_model is not None else composed.model)
            if request.mode == "live"
            else ScriptedModelAdapter(create_investigation_script(), pace=request.pace),
            report,
        )

        # ─── The host's default context strategy ─────────────────────────────
        # Host defaults are the lowest policy layer: the manifest's `policies`
        # (retain, summarizer, variables) merge over this, field by field.
        #
        # ─── The host's summarizer adapter ───────────────────────────────────
        # Every summarization passes through the host. This one calls the
        # built-in summarizer (`next`) unchanged and reports sizes to the
        # page; a host can also rewrite the request, redact the material,
        # cache results, or summarize some other way.
        class ReportingSummarizer:
            async def summarize(self, request: dict[str, Any], next: Any) -> dict[str, Any]:
                result = await next(request)
                emit(
                    {
                        "kind": "summarizer",
                        "stepId": request["stepId"],
                        "summaryKind": request["kind"],
                        "label": request["label"],
                        "inputBytes": utf8_bytes(request["text"]),
                        "targetBytes": request["targetBytes"],
                        "outputBytes": utf8_bytes(result["text"]),
                    }
                )
                return result

        # Mirror each tool call to the page without the log text itself: the
        # terminal shows the path and line count; the model gets the content.
        def mirror(observed: ObservedToolCall) -> None:
            result = observed.result
            message: dict[str, Any] = {
                "kind": "tool-io",
                "stepId": observed.step_id,
                "toolCallId": observed.call["id"],
                "name": observed.call["name"],
                "input": to_json(observed.call.get("input")),
            }
            if result.get("error"):
                message["error"] = {"code": result["error"]["code"], "message": result["error"]["message"]}
            else:
                message["output"] = without_content(result.get("output"))
            emit(message)

        class Forward:
            def emit(self, event: dict[str, Any]) -> None:
                nonlocal current_step
                if event["type"] == "step.started" and event.get("stepId"):
                    current_step = event["stepId"]
                emit({"kind": "event", "event": event})

        runtime = AgentRuntime(
            policies={"context": {"strategy": strategy}},
            summarizer=ReportingSummarizer(),
            model=model,
            tools=ObservedToolAdapter(composed.tools, mirror),
            workspaces=composed.workspaces,
            run_sandbox=composed.run_sandbox,
            messages=composed.messages,
            run_store=FileRunStore(roots(context)["runs"]),
            step_executors=[PromptStepExecutor()],
            condition_evaluator=JexlConditionEvaluator(),
            event_sinks=[Forward()],
        )

        run_id = f"investigation-{uuid.uuid4()}"
        emit(
            {
                "kind": "accepted",
                "runId": run_id,
                "mode": request.mode,
                "sandbox": context.environment["sandbox"]["kind"],
            }
        )
        result = await runtime.run(
            manifest=manifest, run_id=run_id, variables=[{"key": "runbook", "value": runbook}], signal=signal
        )
        emit({"kind": "result", "result": summarize_result(result)})


demo = LongInvestigation()
