"""
Document Chat — a chat about a Word document, built on conversation messages
and a workspace per conversation (Python edition of host.ts).

  agent.yaml           declares `messages` and a `conversation` workspace;
                       reads the newest .docx, asks the model for edits, and
                       writes the revision, all in the run sandbox
  runtime.config.yaml  the conversation workspace and the sandbox
  this file            one run per chat turn, and one directory per
                       conversation for its files

The browser keeps the conversation's history and the host's signature, as in
Data Chat. The files stay on the host: an upload is saved in the
conversation's directory under the turn it arrives in, the message names it,
and each revision the agent writes lands beside it. The history only ever
carries text.

Read the numbered sections; everything else is demo plumbing.
"""

from __future__ import annotations

import functools
import os
import posixpath
import re
import secrets
import shutil
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
    MessagesOptions,
    PromptMessageHistoryCompactor,
    PromptStepExecutor,
    ValueResolutionContext,
    WorkspaceCompositionOptions,
    compose_runtime,
    conversation_turns,
    create_hmac_message_signer,
    load_agent_runtime_config,
)
from starlette.requests import Request
from starlette.responses import Response

from lib import js
from lib.demo import DemoContext, DemoRunRequest, Emit, RequestUrl, ShowcaseDemo
from lib.docx import read_docx
from lib.environment import apply_sandbox_choice, assert_mode_allowed
from lib.host_kit import mirror_tools, run_sync, stringify, summarize_result, to_json, with_model_overrides
from lib.scripted_model import ScriptedModelAdapter

from .script import document_chat_script

demo_directory = Path(__file__).resolve().parent
SAMPLE = demo_directory / "fixture" / "proposal.docx"
#: Largest document a message may attach.
MAX_UPLOAD_BYTES = 5 * 1024 * 1024

# ─── 1. Load the portable agent and the host's configuration ─────────────────
manifest = run_sync(FileAgentManifestSource(str(demo_directory), "agent.yaml").load_manifest())
host_config = run_sync(load_agent_runtime_config(demo_directory / "runtime.config.yaml"))

SUGGESTIONS = [
    "Tighten the introduction.",
    "Add a short timeline after the plan.",
    "Change the setup estimate to three days.",
    "Add a risks section before the cost.",
    "What have we changed so far?",
    "Rename it to “One review workspace”.",
]


def paths(data_directory: str) -> dict[str, str]:
    return {
        "conversations": os.path.join(data_directory, "conversations"),
        "runs": os.path.join(data_directory, "runs"),
        "artifacts": os.path.join(data_directory, "artifacts"),
        "key": os.path.join(data_directory, "messages-signing.key"),
    }


# ─── 2. The host's signing key ───────────────────────────────────────────────
# As in Data Chat: the key belongs to the host. Here the signature also
# decides who may use a conversation's files (section 3).
signers: dict[str, Any] = {}


def signer_for(data_directory: str) -> Any:
    existing = signers.get(data_directory)
    if existing is not None:
        return existing
    file = paths(data_directory)["key"]
    if not os.path.exists(file):
        os.makedirs(os.path.dirname(file), exist_ok=True)
        descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as key:
            key.write(f"hex:{secrets.token_hex(32)}\n")
    with open(file, encoding="utf-8") as key:
        signer = create_hmac_message_signer("showcase", {"showcase": key.read().strip()})
    signers[data_directory] = signer
    return signer


CONVERSATION_ID = re.compile(r"c-[a-f0-9-]{36}")


def scope_of(conversation: str) -> str:
    return f"showcase/document-chat/{conversation}"


def directory_of(data_directory: str, conversation: str) -> str:
    return os.path.join(paths(data_directory)["conversations"], conversation)


# ─── Files in a conversation's workspace ─────────────────────────────────────

#: turns/NNN/input or turns/NNN/output, then a name the workspace accepts.
FILE_PATH = re.compile(r"turns/(\d{3})/(input|output)/([A-Za-z0-9_][A-Za-z0-9._-]*\.docx)")


def turn_directory(turn: int) -> str:
    return f"turns/{turn:03d}"


def safe_name(name: Any) -> str:
    """An upload's name, reduced to the characters workspace paths allow."""
    base = posixpath.basename(name if isinstance(name, str) else "document.docx")
    base = re.sub(r"\.docx$", "", base, flags=re.IGNORECASE)
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base)
    base = re.sub(r"^[^A-Za-z0-9_]+|-+$", "", base)[:80]
    return f"{base or 'document'}.docx"


def conversation_files(directory: str) -> list[dict[str, Any]]:
    """Every document in a conversation's workspace, oldest first."""
    root = os.path.join(directory, "turns")
    files: list[dict[str, Any]] = []
    for current, _folders, names in os.walk(root):
        for name in names:
            relative = "turns/" + os.path.relpath(os.path.join(current, name), root).replace(os.sep, "/")
            match = FILE_PATH.fullmatch(relative)
            if match is None:
                continue
            with open(os.path.join(directory, relative), "rb") as file:
                data = file.read()
            try:
                blocks: Any = to_json(read_docx(data))
            except Exception:
                blocks = None  # Shown without a preview.
            files.append(
                {"path": relative, "turn": int(match[1]), "kind": match[2], "size": len(data), "blocks": blocks}
            )

    def order(left: dict[str, Any], right: dict[str, Any]) -> int:
        return (
            left["turn"] - right["turn"]
            or int(left["kind"] == "output") - int(right["kind"] == "output")
            or js.locale_compare(left["path"], right["path"])
        )

    return sorted(files, key=functools.cmp_to_key(order))


def host_view(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The conversation's files as the stage's host-files panel shows them."""
    latest = files[-1]["turn"] if files else None
    return [
        {
            "alias": "files",
            "name": "conversation",
            "mode": "read_write",
            "files": [
                {
                    "path": file["path"],
                    "size": file["size"],
                    "visible": True,
                    "status": "created" if file["turn"] == latest and file["kind"] == "output" else "unchanged",
                }
                for file in files
            ],
        }
    ]


def send_file(name: str, data: bytes) -> Response:
    return Response(
        data,
        headers={
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "content-disposition": f'attachment; filename="{name}"',
        },
    )


def conversation_refusal(error: BaseException) -> dict[str, Any] | None:
    """A refusal raised before the run exists (MESSAGES_* codes)."""
    code = getattr(error, "code", None)
    if not isinstance(code, str) or not code.startswith("MESSAGES_"):
        return None
    refusal: dict[str, Any] = {"code": code}
    reason = getattr(error, "reason", None)
    if isinstance(reason, str):
        refusal["reason"] = reason
    refusal["message"] = str(error)
    return refusal


class DocumentChat(ShowcaseDemo):
    id = "document-chat"
    title = "Document Chat"
    summary = "Edit a Word document by chatting; every file stays in the conversation's workspace."
    tagline = "A chat about a Word document, one run per message: the newest version is read and rewritten as a real .docx inside the run sandbox, and every file stays in a workspace the host keeps for the conversation, filed by turn."
    features = [
        "Conversation messages",
        "Workspace per conversation",
        "Turn numbers",
        "Real .docx in the sandbox",
        "History compaction",
        "Signed history",
    ]
    # An uploaded document travels in the request, base64-encoded.
    max_request_bytes = 8 * 1024 * 1024
    sources = [
        {
            "path": "demos/document-chat/agent.yaml",
            "language": "yaml",
            "caption": "The portable agent: it declares messages and a conversation workspace, reads the .docx, asks for edits, and writes the revision.",
        },
        {
            "path": "demos/document-chat/runtime.config.yaml",
            "language": "yaml",
            "caption": "Host configuration: the conversation workspace, whose directory the host chooses per run, and the sandbox.",
        },
        {
            "path": "demos/document-chat/host.py",
            "language": "python",
            "caption": "The integration: one run per chat turn, one directory per conversation, uploads filed by turn.",
        },
        {
            "path": "demos/document-chat/script.py",
            "language": "python",
            "caption": "Scripted mode only: the model's edits, computed from the numbered paragraphs and the conversation.",
        },
    ]

    async def describe(self, context: DemoContext) -> Any:
        return to_json(
            {
                "manifest": manifest,
                "suggestions": SUGGESTIONS,
                "sample": {"name": "proposal.docx", "url": "/api/demos/document-chat/sample"},
                "maxUploadBytes": MAX_UPLOAD_BYTES,
                "limits": {
                    "maxMessages": manifest["messages"]["maxMessages"],
                    "maxBytes": manifest["messages"]["maxBytes"],
                },
                "conversationsRoot": paths(context.data_directory)["conversations"],
            }
        )

    async def state(self, context: DemoContext, url: RequestUrl) -> Any:
        """The files of the conversation the page shows (?conversation=c-…)."""
        conversation = url.param("conversation") or ""
        if not CONVERSATION_ID.fullmatch(conversation):
            return {"workspaces": [], "files": []}
        files = conversation_files(directory_of(context.data_directory, conversation))
        return to_json({"workspaces": host_view(files), "files": files})

    async def reset(self, context: DemoContext) -> None:
        shutil.rmtree(paths(context.data_directory)["conversations"], ignore_errors=True)

    async def route(self, context: DemoContext, request: Request, url: RequestUrl) -> Response | None:
        """
        The sample document, and downloads of a conversation's files. Here the
        conversation ID is the browser's key to its files; a production host
        checks that the conversation belongs to the signed-in user.
        """
        if request.method != "GET":
            return None
        if url.pathname == "/api/demos/document-chat/sample":
            return send_file("proposal.docx", SAMPLE.read_bytes())
        if url.pathname != "/api/demos/document-chat/files":
            return None
        conversation = url.param("conversation") or ""
        file = url.param("path") or ""
        match = FILE_PATH.fullmatch(file)
        data = None
        if CONVERSATION_ID.fullmatch(conversation) and match:
            try:
                with open(os.path.join(directory_of(context.data_directory, conversation), file), "rb") as handle:
                    data = handle.read()
            except OSError:
                data = None
        if data is None or match is None:
            return Response(
                stringify({"error": "Unknown file."}).encode(),
                status_code=404,
                headers={"content-type": "application/json"},
            )
        return send_file(match[3], data)

    async def run(self, context: DemoContext, request: DemoRunRequest, emit: Emit, signal: Any) -> None:
        assert_mode_allowed(context.environment, request.mode)
        options = request.options
        text = js.slice(js.trim(options["text"]), 0, 2000) if isinstance(options.get("text"), str) else ""
        if not text:
            raise RuntimeError("Type a message first.")
        history = options["messages"] if isinstance(options.get("messages"), list) else []
        signer = signer_for(context.data_directory)

        # ─── 3. Which conversation, and may this request use its files? ──────
        # A first message starts a new conversation with a new directory. A
        # later message names its conversation, and the host opens that
        # directory only for a history it signed for that conversation: a
        # replayed or edited history cannot read or add files. Agent Runtime
        # checks the signature again when the run is created.
        conversation = f"c-{uuid.uuid4()}"
        if history:
            claimed = str(options.get("conversationId") or "")
            verification = (
                await signer.verify(history, options["signature"], scope=scope_of(claimed))
                if CONVERSATION_ID.fullmatch(claimed) and options.get("signature")
                else {"valid": False, "reason": "authentication-failed"}
            )
            if not verification["valid"]:
                emit(
                    {
                        "kind": "conversation-rejected",
                        "code": "MESSAGES_SIGNATURE_INVALID"
                        if options.get("signature")
                        else "MESSAGES_SIGNATURE_REQUIRED",
                        **({"reason": verification["reason"]} if verification.get("reason") else {}),
                        "message": "The host did not sign this history for this conversation, so it will not open the conversation's files.",
                    }
                )
                return
            conversation = claimed
        scope = scope_of(conversation)
        directory = directory_of(context.data_directory, conversation)

        # ─── 4. File an upload under the turn it arrives in ──────────────────
        # Agent Runtime numbers turns from the history alone: the reply to
        # this message will complete turn `current_turn`. The message names
        # the file; the bytes never enter the history.
        turn = conversation_turns(history).current_turn
        upload = options.get("upload")
        if isinstance(upload, dict) and isinstance(upload.get("data"), str):
            data = js.from_base64(upload["data"])
            if len(data) > MAX_UPLOAD_BYTES:
                raise RuntimeError("The document is larger than 5 MB.")
            try:
                read_docx(data)
            except Exception:
                raise RuntimeError("That file is not a Word document (.docx).") from None
            file = f"{turn_directory(turn)}/input/{safe_name(upload.get('name'))}"
            os.makedirs(os.path.dirname(os.path.join(directory, file)), exist_ok=True)
            with open(os.path.join(directory, file), "wb") as handle:
                handle.write(data)
            text += f"\n\n[Attached: {file}]"
        elif not conversation_files(directory):
            raise RuntimeError("Attach a Word document (.docx) to start.")

        # ─── 5. Compose adapters, with this conversation's directory ─────────
        # The manifest names the workspace "conversation"; this run binds it
        # to the conversation's own directory.
        config, sandbox_provider = apply_sandbox_choice(
            with_model_overrides(host_config), context.environment["sandbox"]
        )
        composed = compose_runtime(
            manifest,
            config,
            ValueResolutionContext(environment={**os.environ, "SHOWCASE_CONVERSATION_ROOT": directory}),
            ComposeRuntimeOptions(
                model=request.mode == "live" and context.live_model is None,
                workspace_options=WorkspaceCompositionOptions(sandbox_provider=sandbox_provider),
            ),
        )
        if composed.tools is None:
            raise RuntimeError("Workspace tools were not composed.")

        run_id = f"doc-{uuid.uuid4()}"
        accepted = False

        class Forward:
            def emit(self, event: dict[str, Any]) -> None:
                nonlocal accepted
                if not accepted:
                    accepted = True
                    emit(
                        {
                            "kind": "accepted",
                            "runId": run_id,
                            "mode": request.mode,
                            "sandbox": context.environment["sandbox"]["kind"],
                        }
                    )
                emit({"kind": "event", "event": event})

        runtime = AgentRuntime(
            model=(
                (context.live_model() if context.live_model is not None else composed.model)
                if request.mode == "live"
                else ScriptedModelAdapter(document_chat_script, pace=request.pace)
            ),
            tools=mirror_tools(composed.tools, emit),
            workspaces=composed.workspaces,
            run_sandbox=composed.run_sandbox,
            run_store=FileRunStore(paths(context.data_directory)["runs"]),
            artifacts=FileArtifactStore(paths(context.data_directory)["artifacts"]),
            step_executors=[PromptStepExecutor(), CodeStepExecutor()],
            condition_evaluator=JexlConditionEvaluator(),
            event_sinks=[Forward()],
            messages=MessagesOptions(signer=signer, compactor=PromptMessageHistoryCompactor()),
        )

        # ─── 6. One run per turn: the history so far, plus the new message ───
        try:
            result = await runtime.run(
                manifest=manifest,
                run_id=run_id,
                messages=[*history, {"role": "user", "content": text}],
                **({"messages_signature": options["signature"]} if options.get("signature") else {}),
                messages_scope=scope,
                signal=signal,
            )
        except Exception as error:
            refusal = conversation_refusal(error)
            if refusal is None:
                raise
            emit({"kind": "conversation-rejected", **refusal})
            return

        # ─── 7. Return the reply, the signed history, and the files ──────────
        emit(
            {
                "kind": "conversation",
                "conversationId": conversation,
                "scope": scope,
                "messages": to_json(result.get("messages") or []),
                "signature": to_json(result.get("messagesSignature")),
                "files": to_json(conversation_files(directory)),
            }
        )
        emit({"kind": "result", "result": summarize_result(result)})


demo = DocumentChat()
