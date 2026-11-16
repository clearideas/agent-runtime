"""The provider-backed run sandbox (``packages/sandbox/src/run-sandbox.ts``).

Opens one sandbox per run attempt, stages bound workspaces, executes every
workspace command under the host policy, syncs read-write mounts back to
their stores after each command, and reports everything through run events
and command records. Events and records have the TypeScript shape.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .._js import json as js_json
from .._js import strings as js_strings
from .._js import time as js_time
from .._js.abort import AbortController, AbortSignal
from .._js.errors import Error, error_message
from .._js.ops import to_string
from ..core.ports import ResolvedWorkspace, is_safe_workspace_path
from .contracts import assert_sandbox_path, assert_sandbox_resource_limits
from .policy import (
    DEFAULT_HELPER_COMMAND,
    SANDBOX_HELPER_PATH,
    SANDBOX_MOUNT_DIRECTORY,
    SANDBOX_OUTPUT_DIRECTORY,
    SANDBOX_WORKSPACES_FILE,
    AdmissionContext,
    AdmittedCommand,
    SandboxPolicyError,
    admit_command,
    describe_workspace_tools,
    resolve_run_sandbox_policy,
)
from .provider_adapter import SandboxRuntimeProfile, media_type_for

JsonObject = dict[str, Any]

HELPER_PROTOCOL_VERSION = 1
STAGING_BATCH_BYTES = 4 * 1024 * 1024
MAXIMUM_HELPER_OUTPUT_BYTES = 1_048_576
CLOSE_SYNC_TIMEOUT_MS = 30_000
OUTPUT_PLACEHOLDER = ".agent-runtime-output"

DEFAULT_RUN_PROFILES = [
    SandboxRuntimeProfile(
        language="python", image="python:3.12-slim", extension="py", command="python3", args=lambda source: [source]
    )
]

_MEDIA_TYPES = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


def bundled_helper_path() -> str:
    """The workspace helper shipped with the package (identical to the TypeScript asset)."""
    return str(Path(__file__).resolve().parent / "assets" / "agent-fs.py")


class RunSandboxExecutionError(Error):
    name = "RunSandboxExecutionError"

    def __init__(self, code: str, message: str, limit: JsonObject | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.limit = limit


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class _Bounded:
    bytes: int = 0
    truncated: bool = False
    chunks: list[str] = field(default_factory=list)

    def append(self, chunk: str, maximum: int) -> None:
        size = js_strings.utf8_length(chunk)
        if self.truncated:
            return
        if self.bytes + size > maximum:
            remaining = max(0, maximum - self.bytes)
            self.chunks.append(
                js_strings.well_formed(chunk).encode("utf-8", "surrogatepass")[:remaining].decode("utf-8", "replace")
            )
            self.bytes = maximum
            self.truncated = True
            return
        self.chunks.append(chunk)
        self.bytes += size

    def text(self) -> str:
        return "".join(self.chunks)


@dataclass
class _Mount:
    workspace: ResolvedWorkspace
    directory: str
    attached: bool
    file_count: int = 0
    bytes: int = 0
    #: path → {size, sha256} for read-write mounts.
    baseline: dict[str, JsonObject] = field(default_factory=dict)


def _limits_of(store: Any) -> JsonObject:
    return getattr(store, "limits", None) or {}


class ProviderRunSandbox:
    """``RunSandboxProvider`` over a ``SandboxProvider``.

    Host hooks: ``authorize_sandbox(input)`` and
    ``authorize_command(input, context)`` (sync or async; raise to deny).
    """

    def __init__(
        self,
        *,
        provider: Any,
        image: str,
        helper_command: list[str] | None = None,
        helper_source: str | None = None,
        commands: JsonObject | None = None,
        shell: JsonObject | None = None,
        limits: JsonObject | None = None,
        profiles: list[SandboxRuntimeProfile] | None = None,
        allowed_environment: list[str] | None = None,
        attach: str = "auto",
        now: Callable[[], datetime] | None = None,
        authorize_sandbox: Callable[[JsonObject], Any] | None = None,
        authorize_command: Callable[[JsonObject, JsonObject], Any] | None = None,
    ) -> None:
        if not js_strings.trim(image):
            raise Error("Run sandbox requires an image.")
        self._provider = provider
        self._image = image
        self.policy = resolve_run_sandbox_policy(commands=commands, shell=shell, limits=limits)
        self._helper_command = list(helper_command) if helper_command is not None else list(DEFAULT_HELPER_COMMAND)
        if not self._helper_command:
            raise Error("Run sandbox helper command cannot be empty.")
        self._helper_source = helper_source or bundled_helper_path()
        self._profiles = {profile.language: profile for profile in (profiles or DEFAULT_RUN_PROFILES)}
        self._allowed_environment = set(allowed_environment or [])
        self._attach = attach
        self._now = now or js_time.now
        self._authorize_sandbox = authorize_sandbox
        self._authorize_command = authorize_command

    async def tools(self, workspace: ResolvedWorkspace) -> list[JsonObject]:
        return describe_workspace_tools(workspace, self.policy)

    def _read_helper(self) -> bytes:
        try:
            return Path(self._helper_source).read_bytes()
        except OSError as error:
            raise Error(f"Run sandbox helper is not readable at {self._helper_source}: {error}") from error

    async def validate(self, request: JsonObject) -> None:
        self._read_helper()
        spec = self._spec(request["runId"], [])
        assert_sandbox_resource_limits(spec["limits"])
        signal = request.get("signal")
        validate = getattr(self._provider, "validate", None)
        if validate is not None:
            await validate(spec, signal=signal)
        total = 0
        for workspace in request["workspaces"]:
            if self._can_attach(workspace):
                continue
            entries = await workspace.store.entries(signal=signal)
            size = sum(entry["size"] for entry in entries)
            self._assert_staging_limits(workspace, len(entries), size)
            total += size
        maximum = self.policy["limits"]["maxTotalStagedBytes"]
        if total > maximum:
            raise Error(f"Bound workspaces total {total} bytes, exceeding the {maximum}-byte sandbox staging limit.")

    async def open(self, request: JsonObject) -> ProviderRunSandboxSession:
        mounts: list[_Mount] = []
        attachments: list[JsonObject] = []
        aliases: set[str] = set()
        for workspace in request["workspaces"]:
            if workspace.alias in aliases:
                raise Error(f"Duplicate workspace alias: {workspace.alias}")
            aliases.add(workspace.alias)
            directory = assert_sandbox_path(f"{SANDBOX_MOUNT_DIRECTORY}/{workspace.alias}")
            attached = self._can_attach(workspace)
            if attached:
                attachments.append({"source": workspace.store.attachable["root"], "target": directory})
            mounts.append(_Mount(workspace, directory, attached))
        from .policy import narrow_run_sandbox_limits, run_sandbox_budget

        policy = {**self.policy, "limits": narrow_run_sandbox_limits(self.policy["limits"], request.get("limits"))}
        run_budget = run_sandbox_budget(self.policy["limits"], request.get("limits"))
        spec = self._spec(request["runId"], attachments, policy["limits"])
        signal = request.get("signal")
        handle = await self._provider.create(spec, signal=signal)
        session = ProviderRunSandboxSession(
            handle=handle,
            provider=self._provider,
            policy=policy,
            run_budget=run_budget,
            helper_command=self._helper_command,  # pyright: ignore[reportArgumentType]
            profiles=self._profiles,
            allowed_environment=self._allowed_environment,
            authorize_command=self._authorize_command,
            request=request,
            mounts=mounts,
            now=self._now,
        )
        try:
            await session.stage(self._read_helper())
            if self._authorize_sandbox is not None:
                decision = self._authorize_sandbox(
                    {
                        "runId": request["runId"],
                        "attempt": request["attempt"],
                        "image": spec["image"],
                        "mounts": [
                            {
                                "alias": mount.workspace.alias,
                                "mode": mount.workspace.mode,
                                **({} if mount.attached else {"fileCount": mount.file_count}),
                                "attached": mount.attached,
                            }
                            for mount in mounts
                        ],
                    }
                )
                if asyncio.iscoroutine(decision):
                    await decision
            await request["emit"](
                "sandbox.opened",
                {
                    "sandboxId": handle["id"],
                    "image": spec["image"],
                    "provider": self._provider.name,
                    "mounts": [
                        {
                            "alias": mount.workspace.alias,
                            "mode": mount.workspace.mode,
                            **({} if mount.attached else {"fileCount": mount.file_count, "bytes": mount.bytes}),
                            "attached": mount.attached,
                        }
                        for mount in mounts
                    ],
                    "helper": {"command": list(self._helper_command)},
                },
            )
        except BaseException:
            try:
                await self._provider.terminate(handle)
            except Exception:
                pass
            raise
        return session

    def _can_attach(self, workspace: ResolvedWorkspace) -> bool:
        capabilities = getattr(self._provider, "capabilities", None) or {}
        return (
            self._attach == "auto"
            and workspace.mode == "read"
            and getattr(workspace.store, "attachable", None) is not None
            and capabilities.get("readOnlyAttachments") is True
        )

    def _assert_staging_limits(self, workspace: ResolvedWorkspace, file_count: int, size: int) -> None:
        limits = _limits_of(workspace.store)
        if limits.get("maxFiles") is not None and file_count > limits["maxFiles"]:
            raise Error(
                f"Workspace {workspace.alias} has {file_count} files, exceeding its {limits['maxFiles']}-file limit."
            )
        if limits.get("maxTotalBytes") is not None and size > limits["maxTotalBytes"]:
            raise Error(
                f"Workspace {workspace.alias} has {size} bytes, exceeding its {limits['maxTotalBytes']}-byte limit."
            )

    def _spec(self, run_id: str, attachments: list[JsonObject], limits: JsonObject | None = None) -> JsonObject:
        limits = limits or self.policy["limits"]
        spec: JsonObject = {
            "image": self._image,
            "workingDirectory": "/workspace",
            "network": "none",
            "limits": {
                "timeoutMs": limits["maxTotalSandboxSeconds"] * 1_000 + 60_000,
                "memoryMb": limits["memoryMb"],
                "cpuCount": limits["cpuCount"],
                "processLimit": limits["processLimit"],
                "workspaceTmpfsMb": limits["workspaceTmpfsMb"],
                "maximumOutputBytes": limits["maxOutputBytes"],
                "maximumOutputFiles": limits["maxOutputFiles"],
            },
        }
        if attachments:
            spec["attachments"] = attachments
        spec["metadata"] = {"agent-runtime.run": run_id, "agent-runtime.kind": "run-sandbox"}
        return spec


_SHA256 = re.compile(r"[a-f0-9]{64}")


class ProviderRunSandboxSession:
    def __init__(
        self,
        *,
        handle: JsonObject,
        provider: Any,
        policy: JsonObject,
        run_budget: JsonObject,
        helper_command: list[str],
        profiles: dict[str, SandboxRuntimeProfile],
        allowed_environment: set[str],
        authorize_command: Callable[[JsonObject, JsonObject], Any] | None,
        request: JsonObject,
        mounts: list[_Mount],
        now: Callable[[], datetime],
    ) -> None:
        self.id = handle["id"]
        self._handle = handle
        self._provider = provider
        self._policy = policy
        self._run_budget = run_budget
        self._helper_command = helper_command
        self._profiles = profiles
        self._allowed_environment = allowed_environment
        self._authorize_command = authorize_command
        self._request = request
        self._mounts = {mount.workspace.alias: mount for mount in mounts}
        self._now = now
        budget = request.get("budget") or {}
        self._commands_used = budget.get("commandsUsed") or 0
        self._sandbox_seconds_used = budget.get("sandboxSecondsUsed") or 0
        self._sequence = 0
        self._lock = asyncio.Lock()
        self._closed = False
        self._pending: dict[str, JsonObject] = {}

    def budget(self) -> JsonObject:
        return {
            "commandsUsed": self._commands_used,
            "sandboxSecondsUsed": js_json.normalize(self._sandbox_seconds_used),
        }

    def take_changes(self) -> JsonObject:
        taken = {
            alias: {
                "changes": list(value["changes"].values()),
                "notPersisted": list(value["notPersisted"].values()),
            }
            for alias, value in self._pending.items()
        }
        self._pending.clear()
        return taken

    def _remember(self, changes: list[JsonObject], not_persisted: list[JsonObject]) -> None:
        def entry(alias: str) -> JsonObject:
            return self._pending.setdefault(alias, {"changes": {}, "notPersisted": {}})

        for change in changes:
            pending = entry(change["alias"])["changes"]
            before = pending.get(change["path"])
            next_change = {key: change[key] for key in ("path", "action", "size", "sha256") if key in change}
            if before and before["action"] == "created" and change["action"] == "deleted":
                pending.pop(change["path"], None)
            elif before and before["action"] == "created":
                pending[change["path"]] = {**next_change, "action": "created"}
            elif before and before["action"] == "deleted" and change["action"] == "created":
                pending[change["path"]] = {**next_change, "action": "modified"}
            else:
                pending[change["path"]] = next_change
        for item in not_persisted:
            entry(item["alias"])["notPersisted"][(item["path"], item["reason"])] = item

    async def stage(self, helper_source: bytes) -> None:
        """Stage the helper, every non-attached mount, and the mount index."""
        provider, handle = self._provider, self._handle
        signal = self._request.get("signal")
        await provider.put_files(
            handle, [{"path": SANDBOX_HELPER_PATH, "content": helper_source, "mode": 0o500}], signal=signal
        )
        staged_bytes = 0
        maximum_staged = self._policy["limits"]["maxTotalStagedBytes"]
        for mount in self._mounts.values():
            if mount.attached:
                continue
            workspace = mount.workspace
            entries = await workspace.store.entries(signal=signal)
            limits = _limits_of(workspace.store)
            total = sum(entry["size"] for entry in entries)
            if limits.get("maxFiles") is not None and len(entries) > limits["maxFiles"]:
                raise Error(
                    f"Workspace {workspace.alias} has {len(entries)} files, exceeding its {limits['maxFiles']}-file limit."
                )
            if limits.get("maxTotalBytes") is not None and total > limits["maxTotalBytes"]:
                raise Error(
                    f"Workspace {workspace.alias} has {total} bytes, exceeding its {limits['maxTotalBytes']}-byte limit."
                )
            mode = 0o600 if workspace.mode == "read_write" else 0o400
            batch: list[JsonObject] = []
            batch_bytes = 0
            for entry in entries:
                if not is_safe_workspace_path(entry["path"]):
                    continue
                data = await workspace.store.read(entry["path"], signal=signal)
                staged_bytes += len(data)
                if staged_bytes > maximum_staged:
                    raise Error(f"Bound workspaces exceed the {maximum_staged}-byte sandbox staging limit.")
                batch.append(
                    {"path": assert_sandbox_path(f"{mount.directory}/{entry['path']}"), "content": data, "mode": mode}
                )
                batch_bytes += len(data)
                mount.file_count += 1
                mount.bytes += len(data)
                if workspace.mode == "read_write":
                    mount.baseline[entry["path"]] = {"size": len(data), "sha256": _sha256(data)}
                if batch_bytes >= STAGING_BATCH_BYTES:
                    await provider.put_files(handle, batch, signal=signal)
                    batch, batch_bytes = [], 0
            if batch:
                await provider.put_files(handle, batch, signal=signal)
            if not entries:
                # Guarantee the mount directory exists even for empty workspaces.
                await provider.put_files(
                    handle,
                    [{"path": f"{mount.directory}/.agent-runtime-mount", "content": "", "mode": 0o400}],
                    signal=signal,
                )
        index = {
            "version": 1,
            "mounts": {
                mount.workspace.alias: {
                    "path": mount.directory,
                    "mode": mount.workspace.mode,
                    **({} if mount.attached else {"fileCount": mount.file_count}),
                    "attached": mount.attached,
                }
                for mount in self._mounts.values()
            },
            "output": SANDBOX_OUTPUT_DIRECTORY,
        }
        await provider.put_files(
            handle,
            [{"path": SANDBOX_WORKSPACES_FILE, "content": js_json.stringify(index), "mode": 0o400}],
            signal=signal,
        )

    async def execute(self, request: JsonObject) -> JsonObject:
        # Commands run one at a time, in submission order.
        async with self._lock:
            return await self._execute(request)

    async def close(self, reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        async with self._lock:
            pass
        files_changed = 0
        ignored = 0
        sync_error: BaseException | None = None
        try:
            controller = AbortController()
            timer = asyncio.get_running_loop().call_later(
                CLOSE_SYNC_TIMEOUT_MS / 1000, lambda: controller.abort(Error("Final workspace sync timed out."))
            )
            try:
                for mount in self._mounts.values():
                    if mount.workspace.mode != "read_write":
                        continue
                    changed, ignored_paths = await self._sync_back(mount, controller.signal)
                    files_changed += len(changed)
                    ignored += len(ignored_paths)
                    self._remember(changed, ignored_paths)
            finally:
                timer.cancel()
        except Exception as error:
            sync_error = error
        finally:
            await self._provider.terminate(self._handle)
            data: JsonObject = {
                "sandboxId": self._handle["id"],
                "reason": reason,
                "commandsUsed": self._commands_used,
                "sandboxSecondsUsed": js_json.normalize(self._sandbox_seconds_used),
                "finalSync": {"filesChanged": files_changed, "ignored": ignored},
            }
            if sync_error is not None:
                data["syncError"] = error_message(sync_error)
            await self._request["emit"]("sandbox.closed", data)
        if sync_error is not None:
            raise sync_error

    async def _execute(self, request: JsonObject) -> JsonObject:
        if self._closed:
            raise RunSandboxExecutionError("sandbox_unavailable", "The run sandbox is closed.")
        policy, provider, handle = self._policy, self._provider, self._handle
        run_request = self._request
        alias = request.get("alias")
        mount = self._mounts.get(alias) if alias else None
        if request["kind"] != "code" and mount is None:
            raise SandboxPolicyError("tool_not_allowed", f'Workspace "{alias or ""}" is not bound to this run.')
        command_id = f"cmd-{run_request['attempt']}-{self._sequence + 1}"

        def code_profile(language: str) -> tuple[str, Callable[[str], list[str]]] | None:
            profile = self._profiles.get(language)
            if profile is None:
                return None
            return profile.extension, lambda source: [profile.command, *profile.args(source)]

        admitted = admit_command(
            request,
            AdmissionContext(
                policy=policy,
                workspace=mount.workspace if mount else None,
                command_id=command_id,
                helper_command=self._helper_command,
                code_profile=code_profile,
            ),
        )
        limits = policy["limits"]
        if self._commands_used >= self._run_budget["maxCommands"]:
            raise RunSandboxExecutionError(
                "sandbox_budget_exhausted",
                f"The run has used its {self._run_budget['maxCommands']}-command sandbox limit.",
                {
                    "name": "sandbox.maxCommands",
                    "used": self._commands_used,
                    "value": self._run_budget["maxCommands"],
                },
            )
        if self._sandbox_seconds_used >= self._run_budget["maxSeconds"]:
            raise RunSandboxExecutionError(
                "sandbox_budget_exhausted",
                f"The run has used its {self._run_budget['maxSeconds']}-second sandbox limit.",
                {
                    "name": "sandbox.maxSeconds",
                    "used": round(self._sandbox_seconds_used),
                    "value": self._run_budget["maxSeconds"],
                },
            )
        self._sequence += 1
        partial: JsonObject = {"kind": admitted.kind, "name": admitted.name}
        if admitted.policy_entry:
            partial["policyEntry"] = admitted.policy_entry
        partial["argv"] = list(admitted.argv)
        partial["cwd"] = admitted.cwd
        if mount is not None:
            partial["alias"] = mount.workspace.alias
            partial["workspace"] = mount.workspace.binding["ref"]
        if self._authorize_command is not None:
            hook_input: JsonObject = {"record": partial}
            if request.get("toolCallId"):
                hook_input["toolCall"] = {
                    "id": request["toolCallId"],
                    "name": request["name"],
                    "input": request.get("arguments"),
                }
            try:
                decision = self._authorize_command(
                    hook_input,
                    {"runId": run_request["runId"], "stepId": request["stepId"], "attempt": run_request["attempt"]},
                )
                if asyncio.iscoroutine(decision):
                    await decision
            except Exception as error:
                raise RunSandboxExecutionError("tool_not_authorized", error_message(error)) from error
        started_data: JsonObject = {"commandId": command_id}
        if request.get("toolCallId"):
            started_data["toolCallId"] = request["toolCallId"]
        started_data["kind"] = admitted.kind
        started_data["name"] = admitted.name
        if admitted.policy_entry:
            started_data["policyEntry"] = admitted.policy_entry
        if mount is not None:
            started_data["alias"] = mount.workspace.alias
            started_data["workspace"] = mount.workspace.binding["ref"]
        started_data["argv"] = list(admitted.argv)
        started_data["cwd"] = admitted.cwd
        started_data["timeoutMs"] = admitted.timeout_ms
        await run_request["emit"]("sandbox.command.started", started_data, request["stepId"])
        started_at = self._now()
        self._commands_used += 1
        signal = request.get("signal") or run_request.get("signal")
        await provider.put_files(
            handle,
            [
                *admitted.staged_files,
                {"path": f"{admitted.output_directory}/{OUTPUT_PLACEHOLDER}", "content": "", "mode": 0o400},
            ],
            signal=signal,
        )
        command = {
            "command": admitted.argv[0],
            "args": admitted.argv[1:],
            "cwd": admitted.cwd,
            "environment": self._environment(admitted, request),
            "timeoutMs": admitted.timeout_ms,
        }
        stdout = _Bounded()
        stderr = _Bounded()
        exit_code = -1
        exit_signal: str | None = None
        try:
            async for event in provider.execute(handle, command, signal=signal):
                if event["type"] == "stdout":
                    stdout.append(event["data"], limits["maxStdoutBytes"])
                elif event["type"] == "stderr":
                    stderr.append(event["data"], limits["maxStderrBytes"])
                else:
                    exit_code = event["exitCode"]
                    exit_signal = event.get("signal")
        except Exception as error:
            if signal is not None and signal.aborted:
                raise
            exit_code = -1
            stderr.append(error_message(error), limits["maxStderrBytes"])
        completed_at = self._now()
        duration_ms = max(0, js_time.to_ms(completed_at) - js_time.to_ms(started_at))
        self._sandbox_seconds_used += duration_ms / 1_000
        timed_out = duration_ms >= admitted.timeout_ms and (exit_code != 0 or exit_signal in ("SIGKILL", "SIGTERM"))
        stdout_text = stdout.text()
        stderr_text = stderr.text()
        artifacts = await self._collect_artifacts(admitted.output_directory, signal)
        files_changed: list[JsonObject] = []
        ignored_paths: list[JsonObject] = []
        for candidate in self._mounts.values():
            if candidate.workspace.mode != "read_write":
                continue
            changed, ignored = await self._sync_back(candidate, signal)
            files_changed.extend(changed)
            ignored_paths.extend(ignored)
        self._remember(files_changed, ignored_paths)
        record: JsonObject = {
            "id": command_id,
            "runId": run_request["runId"],
            "attempt": run_request["attempt"],
            "stepId": request["stepId"],
        }
        if request.get("toolCallId"):
            record["toolCallId"] = request["toolCallId"]
        record.update(partial)
        record.update(
            {
                "startedAt": js_time.to_iso(started_at),
                "completedAt": js_time.to_iso(completed_at),
                "durationMs": duration_ms,
                "exitCode": exit_code,
                "timedOut": timed_out,
                "stdoutBytes": stdout.bytes,
                "stderrBytes": stderr.bytes,
                "stdoutTruncated": stdout.truncated,
                "stderrTruncated": stderr.truncated,
                "filesChanged": files_changed,
            }
        )
        if artifacts:
            record["artifacts"] = [artifact["id"] for artifact in artifacts]
        record["ignoredPaths"] = ignored_paths
        record["budget"] = {
            "commandsUsed": self._commands_used,
            "commandsLimit": self._run_budget["maxCommands"],
            "sandboxSecondsUsed": js_json.normalize(self._sandbox_seconds_used),
            "sandboxSecondsLimit": self._run_budget["maxSeconds"],
        }
        await run_request["emit"]("sandbox.command.completed", js_json.to_json_value(record), request["stepId"])
        if timed_out:
            raise RunSandboxExecutionError(
                "sandbox_command_timeout", f"Sandbox command {admitted.name} timed out after {admitted.timeout_ms}ms."
            )
        output: Any
        has_output = True
        if admitted.expects_json:
            output = self._parse_helper_output(stdout_text, exit_code, stderr_text, artifacts)
        elif admitted.kind == "code":
            output = stdout_text
            has_output = len(stdout_text) > 0
        else:
            output = {
                "exitCode": exit_code,
                "stdout": stdout_text,
                "stderr": stderr_text,
                "truncated": stdout.truncated or stderr.truncated,
            }
            if artifacts:
                output["artifacts"] = [artifact["id"] for artifact in artifacts]
        result: JsonObject = {"record": record}
        if has_output:
            result["output"] = output
        result["stdout"] = stdout_text
        result["stderr"] = stderr_text
        if artifacts:
            result["artifacts"] = artifacts
        return result

    def _environment(self, admitted: AdmittedCommand, request: JsonObject) -> dict[str, str]:
        environment = {
            "AGENT_WORKSPACES_FILE": SANDBOX_WORKSPACES_FILE,
            "AGENT_OUTPUT_DIRECTORY": admitted.output_directory,
            "AGENT_COMMAND_ID": admitted.output_directory.split("/")[-1],
        }
        if admitted.kind == "code":
            environment["AGENT_VARIABLES_FILE"] = f"{admitted.cwd}/variables.json"
            requested = (request.get("arguments") or {}).get("environment")
            if isinstance(requested, dict):
                for name, value in js_json.js_entries(requested):
                    if name in self._allowed_environment and isinstance(value, str):
                        environment[name] = value
        return environment

    async def _collect_artifacts(self, directory: str, signal: AbortSignal | None) -> list[JsonObject]:
        provider, handle, limits = self._provider, self._handle, self._policy["limits"]
        store = self._request.get("artifacts")
        try:
            listed = await provider.list_files(handle, directory, signal=signal)
        except Exception:
            listed = []
        files = [file for file in listed if not file["path"].endswith(f"/{OUTPUT_PLACEHOLDER}")]
        if not files or store is None:
            return []
        if len(files) > limits["maxOutputFiles"]:
            raise RunSandboxExecutionError(
                "workspace_limit_exceeded",
                f"Command produced {len(files)} output files, exceeding {limits['maxOutputFiles']}.",
            )
        refs: list[JsonObject] = []
        total = 0
        for file in files:
            output_path = assert_sandbox_path(file["path"])
            if not output_path.startswith(f"{directory}/") or output_path.endswith(f"/{OUTPUT_PLACEHOLDER}"):
                continue
            data = await provider.read_file(handle, output_path, signal=signal)
            total += len(data)
            if total > limits["maxOutputBytes"]:
                raise RunSandboxExecutionError(
                    "workspace_limit_exceeded", f"Command output exceeded {limits['maxOutputBytes']} bytes."
                )
            relative = output_path[len(directory) + 1 :]
            refs.append(
                await store.put(
                    {
                        "name": relative,
                        "mediaType": media_type_for(relative, _MEDIA_TYPES),
                        "data": data,
                        "metadata": {
                            "sandboxProvider": provider.name,
                            "commandId": directory.split("/")[-1],
                            "sha256": _sha256(data),
                        },
                    }
                )
            )
        return refs

    def _parse_helper_output(self, stdout: str, exit_code: int, stderr: str, artifacts: list[JsonObject]) -> Any:
        if js_strings.utf8_length(stdout) > MAXIMUM_HELPER_OUTPUT_BYTES:
            raise RunSandboxExecutionError("workspace_limit_exceeded", "Helper output exceeded the 1 MiB limit.")
        try:
            parsed = js_json.parse(js_strings.trim(stdout) or "null")
        except ValueError as error:
            raise RunSandboxExecutionError(
                "sandbox_command_failed",
                f"Workspace helper returned invalid output (exit {exit_code}): {js_strings.slice(stderr, 0, 512)}",
            ) from error
        if not isinstance(parsed, dict) or parsed.get("protocolVersion") != HELPER_PROTOCOL_VERSION:
            raise RunSandboxExecutionError(
                "sandbox_command_failed", f"Workspace helper protocol mismatch (exit {exit_code})."
            )
        document = {key: value for key, value in parsed.items() if key != "protocolVersion"}
        error = document.get("error")
        if isinstance(error, dict):
            code = to_string(error.get("code") if error.get("code") is not None else "")
            message = to_string(error.get("message") if error.get("message") is not None else "Workspace helper error.")
            mapped = {
                "path_invalid": "workspace_path_invalid",
                "limit_exceeded": "workspace_limit_exceeded",
                "read_only": "tool_not_allowed",
            }.get(code, "sandbox_command_failed")
            raise RunSandboxExecutionError(mapped, message)
        if exit_code != 0:
            raise RunSandboxExecutionError(
                "sandbox_command_failed",
                f"Workspace helper exited with {exit_code}: {js_strings.slice(stderr, 0, 512)}",
            )
        if document.get("encoding") == "binary":
            artifact_file = document.get("artifactFile")
            rest = {key: value for key, value in document.items() if key != "artifactFile"}
            artifact = next((candidate for candidate in artifacts if candidate.get("name") == artifact_file), None)
            if artifact is not None:
                rest["artifactId"] = artifact["id"]
            else:
                rest["note"] = "binary content requires an artifact store"
            return rest
        return document

    async def _sync_back(self, mount: _Mount, signal: AbortSignal | None) -> tuple[list[JsonObject], list[JsonObject]]:
        workspace = mount.workspace
        alias = workspace.alias
        files_changed: list[JsonObject] = []
        ignored_paths: list[JsonObject] = []
        max_file_bytes = _limits_of(workspace.store).get("maxFileBytes")
        max_file_bytes = 1_048_576 if max_file_bytes is None else max_file_bytes
        files, ignored = await self._snapshot(mount, signal)
        for item in ignored:
            ignored_paths.append({"alias": alias, "path": item["path"], "reason": item["reason"]})
        seen: set[str] = set()
        for file in files:
            seen.add(file["path"])
            previous = mount.baseline.get(file["path"])
            if file.get("sha256") is None or file["size"] > max_file_bytes:
                if previous is None or previous.get("sha256") is not None:
                    ignored_paths.append({"alias": alias, "path": file["path"], "reason": "size"})
                continue
            if previous is not None and previous.get("sha256") == file["sha256"]:
                continue
            data = await self._provider.read_file(
                self._handle, assert_sandbox_path(f"{mount.directory}/{file['path']}"), signal=signal
            )
            if len(data) > max_file_bytes:
                ignored_paths.append({"alias": alias, "path": file["path"], "reason": "size"})
                continue
            try:
                await workspace.store.write(file["path"], data, signal=signal)
                mount.baseline[file["path"]] = {"size": len(data), "sha256": _sha256(data)}
                files_changed.append(
                    {
                        "alias": alias,
                        "path": file["path"],
                        "action": "modified" if previous is not None else "created",
                        "size": len(data),
                        "sha256": file["sha256"],
                    }
                )
            except Exception as error:
                ignored_paths.append({"alias": alias, "path": file["path"], "reason": f"store: {error_message(error)}"})
        for previous_path in list(mount.baseline):
            if previous_path in seen:
                continue
            try:
                await workspace.store.delete(previous_path, signal=signal)
                del mount.baseline[previous_path]
                files_changed.append({"alias": alias, "path": previous_path, "action": "deleted"})
            except Exception as error:
                ignored_paths.append(
                    {"alias": alias, "path": previous_path, "reason": f"store: {error_message(error)}"}
                )
        return files_changed, ignored_paths

    async def _snapshot(self, mount: _Mount, signal: AbortSignal | None) -> tuple[list[JsonObject], list[JsonObject]]:
        limits = _limits_of(mount.workspace.store)
        argv = [
            *self._helper_command,
            "snapshot",
            "--mount",
            mount.directory,
            "--max-files",
            to_string(5_000 if limits.get("maxFiles") is None else limits["maxFiles"]),
            "--max-bytes",
            to_string(1_048_576 if limits.get("maxFileBytes") is None else limits["maxFileBytes"]),
        ]
        output = _Bounded()
        exit_code = -1
        async for event in self._provider.execute(
            self._handle,
            {
                "command": argv[0],
                "args": argv[1:],
                "cwd": "/workspace",
                "environment": {},
                "timeoutMs": self._policy["limits"]["maxCommandTimeoutMs"],
            },
            signal=signal,
        ):
            if event["type"] == "stdout":
                output.append(event["data"], 8 * MAXIMUM_HELPER_OUTPUT_BYTES)
            elif event["type"] == "exit":
                exit_code = event["exitCode"]
        try:
            parsed = js_json.parse(js_strings.trim(output.text()) or "null")
        except ValueError:
            parsed = None
        if exit_code != 0 or not isinstance(parsed, dict) or not isinstance(parsed.get("files"), list):
            raise Error(f"Workspace snapshot of {mount.workspace.alias} failed (exit {exit_code}).")
        files: list[JsonObject] = []
        for item in parsed["files"]:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("path"), str)
                or not is_safe_workspace_path(item["path"])
            ):
                continue
            entry: JsonObject = {
                "path": item["path"],
                "size": item["size"]
                if isinstance(item.get("size"), (int, float)) and not isinstance(item.get("size"), bool)
                else 0,
            }
            if isinstance(item.get("sha256"), str) and _SHA256.fullmatch(item["sha256"]):
                entry["sha256"] = item["sha256"]
            files.append(entry)
        ignored = [
            {
                "path": js_strings.slice(to_string(item["path"]), 0, 1024),
                "reason": to_string(item.get("reason") if item.get("reason") is not None else "path"),
            }
            for item in (parsed.get("ignored") if isinstance(parsed.get("ignored"), list) else [])
            if isinstance(item, dict) and isinstance(item.get("path"), str)
        ]
        return files, ignored


__all__ = [
    "ProviderRunSandbox",
    "ProviderRunSandboxSession",
    "RunSandboxExecutionError",
    "bundled_helper_path",
]
