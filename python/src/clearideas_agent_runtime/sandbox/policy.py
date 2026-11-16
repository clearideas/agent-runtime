"""Run-sandbox host policy and command admission (``packages/sandbox/src/policy.ts``).

Host ``allowPatterns``/``denyPatterns`` are regular expressions; the Python
runtime compiles them with Python's ``re`` module, whose syntax agrees with
JavaScript's for the patterns hosts write (character classes, anchors,
alternation, quantifiers).
"""

from __future__ import annotations

import copy
import math
import re
from dataclasses import dataclass, field
from typing import Any

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.errors import Error
from .._js.ops import UNDEFINED
from ..core.ports import ResolvedWorkspace, is_safe_workspace_path
from .contracts import assert_sandbox_path

JsonObject = dict[str, Any]

BUILTIN_WORKSPACE_TOOLS = ("list_files", "read_file", "search_files", "write_file", "delete_file")
BUILTIN_READ_TOOLS = ("list_files", "read_file", "search_files")
SHELL_TOOL_NAME = "shell"
SANDBOX_MOUNT_DIRECTORY = "/workspace/mounts"
SANDBOX_OUTPUT_DIRECTORY = "/workspace/output"
SANDBOX_STAGING_DIRECTORY = "/workspace/staging"
SANDBOX_STEPS_DIRECTORY = "/workspace/steps"
SANDBOX_HELPER_PATH = "/workspace/bin/agent-fs"
SANDBOX_WORKSPACES_FILE = "/workspace/workspaces.json"
DEFAULT_HELPER_COMMAND = ("python3", SANDBOX_HELPER_PATH)

_COMMAND_NAME = re.compile(r"[a-z][a-z0-9_]*")
_RESERVED_COMMAND_NAMES = {*BUILTIN_WORKSPACE_TOOLS, SHELL_TOOL_NAME}
MAXIMUM_GLOB_LENGTH = 512
MAXIMUM_QUERY_LENGTH = 512
MAXIMUM_LINE_COUNT = 2_000
MAXIMUM_LIST_LIMIT = 5_000
MAXIMUM_SEARCH_LIMIT = 1_000
DEFAULT_LIST_LIMIT = 1_000

DEFAULT_RUN_SANDBOX_LIMITS: JsonObject = {
    "memoryMb": 1_024,
    "cpuCount": 1,
    "processLimit": 128,
    "workspaceTmpfsMb": 1_024,
    "commandTimeoutMs": 300_000,
    "maxCommandTimeoutMs": 3_600_000,
    "maxCommandsPerRun": 2_000,
    "maxTotalSandboxSeconds": 14_400,
    "maxStdoutBytes": 1_048_576,
    "maxStderrBytes": 262_144,
    "maxArgs": 64,
    "maxArgBytes": 4_096,
    "maxTotalStagedBytes": 256 * 1_048_576,
    "maxOutputFiles": 500,
    "maxOutputBytes": 500 * 1_048_576,
}


def narrow_run_sandbox_limits(host: JsonObject, requested: JsonObject | None = None) -> JsonObject:
    if requested is None:
        return host
    narrowed = dict(host)
    for key in (
        "maxCommandTimeoutMs",
        "commandTimeoutMs",
        "maxStdoutBytes",
        "maxStderrBytes",
        "maxOutputFiles",
        "maxOutputBytes",
    ):
        value = requested.get(key)
        if value is not None and value > 0:
            narrowed[key] = min(host[key], value)
    narrowed["commandTimeoutMs"] = min(narrowed["commandTimeoutMs"], narrowed["maxCommandTimeoutMs"])
    return narrowed


def run_sandbox_budget(host: JsonObject, requested: JsonObject | None = None) -> JsonObject:
    requested = requested or {}
    return {
        "maxCommands": min(host["maxCommandsPerRun"], requested.get("maxCommands", host["maxCommandsPerRun"])),
        "maxSeconds": min(host["maxTotalSandboxSeconds"], requested.get("maxSeconds", host["maxTotalSandboxSeconds"])),
    }


def _is_safe_integer(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return abs(value) <= js_json.MAX_SAFE_INTEGER


def resolve_run_sandbox_limits(partial: JsonObject | None = None) -> JsonObject:
    limits = dict(DEFAULT_RUN_SANDBOX_LIMITS)
    for key, value in js_json.js_entries(partial or {}):
        if value is None:
            continue
        if key == "cpuCount":
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or value <= 0
                or value > 1_024
            ):
                raise Error("Sandbox cpuCount must be between 0 and 1024.")
        elif not _is_safe_integer(value) or value <= 0:
            raise Error(f"Sandbox limit {key} must be a positive safe integer.")
        limits[key] = value
    if limits["commandTimeoutMs"] > limits["maxCommandTimeoutMs"]:
        raise Error("Sandbox commandTimeoutMs cannot exceed maxCommandTimeoutMs.")
    return limits


def resolve_run_sandbox_policy(
    commands: JsonObject | None = None, shell: JsonObject | None = None, limits: JsonObject | None = None
) -> JsonObject:
    """``{commands, shell, limits}`` with defaults; the policy is a JSON dictionary."""
    shell = shell or {}
    resolved_shell: JsonObject = {
        "enabled": shell.get("enabled") if shell.get("enabled") is not None else False,
        "program": shell.get("program") if shell.get("program") is not None else ["/bin/sh", "-c"],
    }
    if shell.get("timeoutMs"):
        resolved_shell["timeoutMs"] = shell["timeoutMs"]
    if shell.get("modes"):
        resolved_shell["modes"] = shell["modes"]
    policy = {
        "commands": dict(commands or {}),
        "shell": resolved_shell,
        "limits": resolve_run_sandbox_limits(limits),
    }
    validate_run_sandbox_policy(policy)
    return policy


def _compile_pattern(pattern: str, label: str) -> re.Pattern[str]:
    if js_strings.length(pattern) > 512:
        raise Error(f"{label} pattern is too long: {pattern}")
    try:
        return re.compile(pattern)
    except re.error as error:
        raise Error(f"{label} pattern is not a valid regular expression: {pattern}") from error


_PLACEHOLDER = re.compile(r"\{([^}]*)\}")


def validate_run_sandbox_policy(policy: JsonObject) -> None:
    for name, entry in js_json.js_entries(policy["commands"]):
        if not _COMMAND_NAME.fullmatch(name):
            raise Error(f"Sandbox command name is invalid: {name}")
        if name in _RESERVED_COMMAND_NAMES:
            raise Error(f"Sandbox command name is reserved: {name}")
        if (entry.get("argv") is None) == (entry.get("program") is None):
            raise Error(f"Sandbox command {name} requires exactly one of argv or program.")
        if entry.get("argv") is not None:
            if len(entry["argv"]) == 0:
                raise Error(f"Sandbox command {name} argv cannot be empty.")
            for element in entry["argv"]:
                for placeholder in _PLACEHOLDER.finditer(element):
                    if placeholder.group(1) not in ("file", "mount", "output"):
                        raise Error(f"Sandbox command {name} uses an unknown placeholder: {{{placeholder.group(1)}}}")
            if entry.get("args"):
                raise Error(f"Sandbox command {name} cannot combine argv and args.")
        if entry.get("program") is not None and js_strings.trim(entry["program"]) == "":
            raise Error(f"Sandbox command {name} program cannot be empty.")
        args = entry.get("args") or {}
        for pattern in args.get("allowPatterns") or []:
            _compile_pattern(pattern, f"Sandbox command {name} allow")
        for pattern in args.get("denyPatterns") or []:
            _compile_pattern(pattern, f"Sandbox command {name} deny")
        if args.get("maxCount") is not None and (not _is_safe_integer(args["maxCount"]) or args["maxCount"] < 0):
            raise Error(f"Sandbox command {name} args.maxCount must be a non-negative integer.")
        if entry.get("timeoutMs") is not None and (not _is_safe_integer(entry["timeoutMs"]) or entry["timeoutMs"] <= 0):
            raise Error(f"Sandbox command {name} timeoutMs must be a positive integer.")
    if policy["shell"]["enabled"] and len(policy["shell"].get("program") or []) == 0:
        raise Error("Sandbox shell requires a program.")


class SandboxPolicyError(Error):
    name = "SandboxPolicyError"

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _not_allowed(message: str) -> SandboxPolicyError:
    return SandboxPolicyError("tool_not_allowed", message)


def _invalid_path(message: str) -> SandboxPolicyError:
    return SandboxPolicyError("workspace_path_invalid", message)


def _limit_exceeded(message: str) -> SandboxPolicyError:
    return SandboxPolicyError("workspace_limit_exceeded", message)


def _invalid_arguments(message: str) -> SandboxPolicyError:
    return SandboxPolicyError("sandbox_command_failed", message)


def _entry_applies(entry: JsonObject, workspace: ResolvedWorkspace) -> bool:
    return (entry.get("workspaces") is None or workspace.binding["ref"] in entry["workspaces"]) and (
        entry.get("modes") is None or workspace.mode in entry["modes"]
    )


def _shell_applies(shell: JsonObject, workspace: ResolvedWorkspace) -> bool:
    return bool(shell.get("enabled")) and (shell.get("modes") is None or workspace.mode in shell["modes"])


_PATH_SCHEMA: JsonObject = {
    "type": "string",
    "minLength": 1,
    "maxLength": 1024,
    "description": "Path relative to the workspace root, such as docs/guide.md. Use forward slashes.",
}

BUILTIN_SCHEMAS: dict[str, JsonObject] = {
    "list_files": {
        "description": "List files beneath a directory of the workspace. Supports an optional glob filter such as **/*.md and a result limit.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "path": {
                    **_PATH_SCHEMA,
                    "minLength": 0,
                    "description": "Directory to list, relative to the workspace root, such as docs. Omit it to list the root.",
                },
                "glob": {"type": "string", "minLength": 1, "maxLength": MAXIMUM_GLOB_LENGTH},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAXIMUM_LIST_LIMIT},
            },
        },
    },
    "read_file": {
        "description": "Read one file. Text files return UTF-8 content with an optional line window; binary files return metadata and an artifact reference.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["path"],
            "properties": {
                "path": _PATH_SCHEMA,
                "startLine": {"type": "integer", "minimum": 1},
                "lineCount": {"type": "integer", "minimum": 1, "maximum": MAXIMUM_LINE_COUNT},
            },
        },
    },
    "search_files": {
        "description": "Find lines containing a literal text query across text files. Returns file paths, line numbers, and matching lines.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["query"],
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": MAXIMUM_QUERY_LENGTH},
                "glob": {"type": "string", "minLength": 1, "maxLength": MAXIMUM_GLOB_LENGTH},
                "caseSensitive": {"type": "boolean"},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAXIMUM_SEARCH_LIMIT},
            },
        },
    },
    "write_file": {
        "description": "Create or replace one file. Content is UTF-8 text unless encoding is base64.",
        "readOnly": False,
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["path", "content"],
            "properties": {
                "path": _PATH_SCHEMA,
                "content": {"type": "string"},
                "encoding": {"type": "string", "enum": ["utf-8", "base64"]},
            },
        },
    },
    "delete_file": {
        "description": "Delete one file from the workspace.",
        "readOnly": False,
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["path"],
            "properties": {"path": _PATH_SCHEMA},
        },
    },
}


def describe_workspace_tools(workspace: ResolvedWorkspace, policy: JsonObject) -> list[JsonObject]:
    """The bare (un-prefixed) tools a binding exposes after host policy."""
    tools: list[JsonObject] = []
    permitted = set(BUILTIN_READ_TOOLS if workspace.mode == "read" else BUILTIN_WORKSPACE_TOOLS)
    allowlist = set(workspace.binding["tools"]) if workspace.binding.get("tools") else None

    def include(name: str) -> bool:
        return allowlist is None or name in allowlist

    for name in BUILTIN_WORKSPACE_TOOLS:
        if name not in permitted or not include(name):
            continue
        schema = BUILTIN_SCHEMAS[name]
        tools.append(
            {
                "name": name,
                "description": schema["description"],
                "inputSchema": copy.deepcopy(schema["inputSchema"]),
                "metadata": {"kind": "builtin", "readOnly": schema["readOnly"], "destructive": not schema["readOnly"]},
            }
        )
    limits = policy["limits"]
    for name, entry in js_json.js_entries(policy["commands"]):
        if not _entry_applies(entry, workspace) or not include(name):
            continue
        argv = entry.get("argv")
        uses_file = argv is not None and any("{file}" in element for element in argv)
        input_schema: JsonObject
        if argv is not None:
            input_schema = {"type": "object", "additionalProperties": False}
            if uses_file:
                inputs = entry.get("inputs")
                suffix = f" (matching {', '.join(inputs)})" if inputs else ""
                input_schema["required"] = ["file"]
                input_schema["properties"] = {
                    "file": {**_PATH_SCHEMA, "description": f"Workspace file to process{suffix}."}
                }
            else:
                input_schema["properties"] = {}
        else:
            max_count = (entry.get("args") or {}).get("maxCount")
            input_schema = {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "args": {
                        "type": "array",
                        "items": {"type": "string", "maxLength": limits["maxArgBytes"]},
                        "maxItems": max_count if max_count is not None else limits["maxArgs"],
                        "description": f"Arguments passed to {entry['program']}.",
                    }
                },
            }
        description = entry.get("description")
        if description is None:
            description = (
                f"Run {argv[0]} in the workspace."
                if argv is not None
                else f"Run {entry['program']} with arguments in the workspace."
            )
        tools.append(
            {
                "name": name,
                "description": description,
                "inputSchema": input_schema,
                "metadata": {"kind": "command", "readOnly": False, "destructive": True},
            }
        )
    if _shell_applies(policy["shell"], workspace) and include(SHELL_TOOL_NAME):
        tools.append(
            {
                "name": SHELL_TOOL_NAME,
                "description": "Run a shell command in the workspace directory. Output is bounded; the sandbox has no network.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["command"],
                    "properties": {"command": {"type": "string", "minLength": 1, "maxLength": limits["maxArgBytes"]}},
                },
                "metadata": {"kind": "shell", "readOnly": False, "destructive": True},
            }
        )
    return tools


@dataclass
class AdmittedCommand:
    kind: str
    name: str
    argv: list[str]
    cwd: str
    timeout_ms: int
    #: Files to stage before execution (tool content, step code): ``{path, content, mode?}``.
    staged_files: list[JsonObject] = field(default_factory=list)
    #: Directory collected as artifacts after execution.
    output_directory: str = ""
    #: Helper invocation flags that expect JSON output.
    expects_json: bool = False
    policy_entry: str | None = None


_CONTROL = re.compile("[\u0000-\u0008\u000b\u000c\u000e-\u001f]")


def _arg(arguments: JsonObject, key: str) -> Any:
    """An argument, or ``UNDEFINED`` when absent (``null`` is a value and is rejected)."""
    return arguments.get(key, UNDEFINED)


def _require_string(value: Any, label: str, maximum: float, required: bool) -> str | None:
    if value is UNDEFINED:
        if required:
            raise _invalid_arguments(f"{label} is required.")
        return None
    if not isinstance(value, str):
        raise _invalid_arguments(f"{label} must be a string.")
    if required and len(value) == 0:
        raise _invalid_arguments(f"{label} cannot be empty.")
    if js_strings.length(value) > maximum:
        raise _limit_exceeded(f"{label} exceeds {_s(maximum)} characters.")
    if _CONTROL.search(value):
        raise _invalid_arguments(f"{label} contains control characters.")
    return value


def _s(value: Any) -> str:
    from .._js.ops import to_string

    return to_string(value)


def _require_integer(value: Any, label: str, maximum: float) -> int | None:
    if value is UNDEFINED:
        return None
    if not _is_safe_integer(value) or value < 1:
        raise _invalid_arguments(f"{label} must be a positive integer.")
    if value > maximum:
        raise _limit_exceeded(f"{label} exceeds {_s(maximum)}.")
    return int(value)


def _require_boolean(value: Any, label: str) -> bool | None:
    if value is UNDEFINED:
        return None
    if not isinstance(value, bool):
        raise _invalid_arguments(f"{label} must be a boolean.")
    return value


def normalize_workspace_tool_path(value: str) -> str:
    """The canonical form of a relative workspace path (``reports\\q3.md``, ``./a``, ``a//b/`` …)."""
    return "/".join(
        segment for segment in js_strings.trim(value).replace("\\", "/").split("/") if segment not in ("", ".")
    )


def _require_path(value: Any, label: str, required: bool = True) -> str | None:
    text = _require_string(value, label, 1024, required)
    if text is None:
        return None
    normalized = normalize_workspace_tool_path(text)
    # An optional directory path may name the root; a file path may not.
    if normalized == "" and not required:
        return None
    if not is_safe_workspace_path(normalized):
        raise _invalid_path(
            f"{label} must be a path inside the workspace, such as docs/guide.md (got {js_json.stringify(text)}). "
            'Segments must start with a letter, digit, or underscore and may contain letters, digits, ".", "_", and "-". '
            "Dot-prefixed segments and traversal are not allowed."
        )
    return normalized


def _reject_unknown_keys(arguments: JsonObject, allowed: tuple[str, ...]) -> None:
    for key in js_json.js_keys(arguments):
        if key not in allowed:
            raise _invalid_arguments(f"Unexpected argument: {key}")


def glob_matches(pattern: str, value: str) -> bool:
    source = ""
    index = 0
    any_character = "[^\\n\\r\\u2028\\u2029]"
    while index < len(pattern):
        character = pattern[index]
        if character == "*":
            if pattern[index + 1 : index + 2] == "*":
                slash = pattern[index + 2 : index + 3] == "/"
                source += f"(?:{any_character}*/)?" if slash else f"{any_character}*"
                index += 3 if slash else 2
                continue
            source += "[^/]*"
            index += 1
            continue
        if character == "?":
            source += "[^/]"
            index += 1
            continue
        source += re.escape(character)
        index += 1
    return re.fullmatch(source, value) is not None


def _mount_directory(alias: str) -> str:
    return assert_sandbox_path(f"{SANDBOX_MOUNT_DIRECTORY}/{alias}")


def _helper_limit_flags(workspace: ResolvedWorkspace, writable: bool) -> list[str]:
    limits = getattr(workspace.store, "limits", None) or {}
    max_files = limits.get("maxFiles")
    max_bytes = limits.get("maxFileBytes")
    return [
        *(["--writable"] if writable else []),
        "--max-files",
        _s(5_000 if max_files is None else max_files),
        "--max-bytes",
        _s(1_048_576 if max_bytes is None else max_bytes),
    ]


def _timeout_for(policy: JsonObject, requested: Any) -> int:
    limits = policy["limits"]
    return min(limits["commandTimeoutMs"] if requested is None else requested, limits["maxCommandTimeoutMs"])


@dataclass
class AdmissionContext:
    policy: JsonObject
    command_id: str
    helper_command: tuple[str, ...] | list[str]
    workspace: ResolvedWorkspace | None = None
    #: Runtime profile for code steps: language → ``(extension, argv(source_path))`` or ``None``.
    code_profile: Any = None


def admit_command(request: JsonObject, context: AdmissionContext) -> AdmittedCommand:
    """Decide whether a request may execute and, if so, the exact argv.

    ``request`` is a ``RunSandboxCommandRequest`` (``{kind, name, workspace?, arguments}``).
    Every argument the model supplied is validated before it reaches a process.
    """
    policy = context.policy
    output_directory = assert_sandbox_path(f"{SANDBOX_OUTPUT_DIRECTORY}/{context.command_id}")
    staging_directory = assert_sandbox_path(f"{SANDBOX_STAGING_DIRECTORY}/{context.command_id}")
    arguments: JsonObject = request.get("arguments") or {}

    if request["kind"] == "code":
        language = _require_string(_arg(arguments, "language"), "language", 64, True)
        code = arguments.get("code")
        if not isinstance(code, str):
            raise _invalid_arguments("code is required.")
        profile = context.code_profile(language) if context.code_profile is not None else None
        if not profile:
            raise _not_allowed(f"No sandbox runtime profile for {language}.")
        extension, argv_for = profile
        step_directory = assert_sandbox_path(f"{SANDBOX_STEPS_DIRECTORY}/{context.command_id}")
        source_path = f"{step_directory}/main.{extension}"
        variables = arguments.get("variables")
        return AdmittedCommand(
            kind="code",
            name=request["name"],
            argv=list(argv_for(source_path)),
            cwd=step_directory,
            timeout_ms=_timeout_for(
                policy,
                arguments["timeoutMs"]
                if isinstance(arguments.get("timeoutMs"), (int, float))
                and not isinstance(arguments.get("timeoutMs"), bool)
                else None,
            ),
            staged_files=[
                {"path": source_path, "content": code, "mode": 0o600},
                {
                    "path": f"{step_directory}/variables.json",
                    "content": js_json.stringify(variables if variables is not None else {}),
                    "mode": 0o600,
                },
            ],
            output_directory=output_directory,
            expects_json=False,
        )

    workspace = context.workspace
    if workspace is None:
        raise _not_allowed("The command names no bound workspace.")
    mount = _mount_directory(workspace.alias)
    helper = list(context.helper_command)
    binding_tools = workspace.binding.get("tools")

    if request["kind"] == "builtin":
        name = request["name"]
        if name not in BUILTIN_WORKSPACE_TOOLS:
            raise _not_allowed(f'Tool "{name}" is not available.')
        read_only = BUILTIN_SCHEMAS[name]["readOnly"]
        if not read_only and workspace.mode != "read_write":
            raise _not_allowed(f'Tool "{name}" requires a read_write workspace.')
        if binding_tools and name not in binding_tools:
            raise _not_allowed(f'Tool "{name}" is not available.')
        flags = _helper_limit_flags(workspace, workspace.mode == "read_write")
        staged: list[JsonObject] = []
        if name == "list_files":
            _reject_unknown_keys(arguments, ("path", "glob", "limit"))
            path = _require_path(_arg(arguments, "path"), "path", False)
            glob = _require_string(_arg(arguments, "glob"), "glob", MAXIMUM_GLOB_LENGTH, False)
            limit = _require_integer(_arg(arguments, "limit"), "limit", MAXIMUM_LIST_LIMIT)
            argv = [
                *helper,
                "list",
                "--mount",
                mount,
                *flags,
                *(["--path", path] if path else []),
                *(["--glob", glob] if glob else []),
                "--limit",
                _s(DEFAULT_LIST_LIMIT if limit is None else limit),
            ]
        elif name == "read_file":
            _reject_unknown_keys(arguments, ("path", "startLine", "lineCount"))
            path = _require_path(_arg(arguments, "path"), "path")
            start_line = _require_integer(_arg(arguments, "startLine"), "startLine", js_json.MAX_SAFE_INTEGER)
            line_count = _require_integer(_arg(arguments, "lineCount"), "lineCount", MAXIMUM_LINE_COUNT)
            argv = [
                *helper,
                "read",
                "--mount",
                mount,
                *flags,
                "--path",
                path,  # type: ignore[list-item]
                *(["--start-line", _s(start_line)] if start_line else []),
                *(["--line-count", _s(line_count)] if line_count else []),
                "--artifact-dir",
                output_directory,
            ]
        elif name == "search_files":
            _reject_unknown_keys(arguments, ("query", "glob", "caseSensitive", "limit"))
            query = _require_string(_arg(arguments, "query"), "query", MAXIMUM_QUERY_LENGTH, True)
            glob = _require_string(_arg(arguments, "glob"), "glob", MAXIMUM_GLOB_LENGTH, False)
            case_sensitive = _require_boolean(_arg(arguments, "caseSensitive"), "caseSensitive")
            limit = _require_integer(_arg(arguments, "limit"), "limit", MAXIMUM_SEARCH_LIMIT)
            argv = [
                *helper,
                "search",
                "--mount",
                mount,
                *flags,
                "--query",
                query,  # type: ignore[list-item]
                *(["--glob", glob] if glob else []),
                *(["--case-sensitive"] if case_sensitive else []),
                *(["--limit", _s(limit)] if limit else []),
            ]
        elif name == "write_file":
            _reject_unknown_keys(arguments, ("path", "content", "encoding"))
            path = _require_path(_arg(arguments, "path"), "path")
            content = arguments.get("content")
            if not isinstance(content, str):
                raise _invalid_arguments("content must be a string.")
            encoding = _require_string(_arg(arguments, "encoding"), "encoding", 16, False) or "utf-8"
            if encoding not in ("utf-8", "base64"):
                raise _invalid_arguments("encoding must be utf-8 or base64.")
            limits = getattr(workspace.store, "limits", None) or {}
            max_bytes = limits.get("maxFileBytes")
            max_bytes = 1_048_576 if max_bytes is None else max_bytes
            if js_strings.utf8_length(content) > max_bytes * (2 if encoding == "base64" else 1):
                raise _limit_exceeded(f"content exceeds the {_s(max_bytes)}-byte limit.")
            source = f"{staging_directory}/content"
            staged.append({"path": source, "content": content, "mode": 0o400})
            argv = [
                *helper,
                "write",
                "--mount",
                mount,
                *flags,
                "--path",
                path,  # type: ignore[list-item]
                "--source",
                source,
                "--encoding",
                encoding,
            ]
        else:
            _reject_unknown_keys(arguments, ("path",))
            path = _require_path(_arg(arguments, "path"), "path")
            argv = [*helper, "delete", "--mount", mount, *flags, "--path", path]  # type: ignore[list-item]
        return AdmittedCommand(
            kind="builtin",
            name=name,
            argv=argv,
            cwd=mount,
            timeout_ms=_timeout_for(policy, None),
            staged_files=staged,
            output_directory=output_directory,
            expects_json=True,
        )

    if request["kind"] == "shell":
        if not _shell_applies(policy["shell"], workspace):
            raise _not_allowed("Shell commands are not enabled for this workspace.")
        if binding_tools and SHELL_TOOL_NAME not in binding_tools:
            raise _not_allowed(f'Tool "{SHELL_TOOL_NAME}" is not available.')
        _reject_unknown_keys(arguments, ("command",))
        command = _require_string(_arg(arguments, "command"), "command", policy["limits"]["maxArgBytes"], True)
        program = policy["shell"].get("program") or ["/bin/sh", "-c"]
        return AdmittedCommand(
            kind="shell",
            name=SHELL_TOOL_NAME,
            policy_entry="shell",
            argv=[*program, command],  # type: ignore[list-item]
            cwd=mount,
            timeout_ms=_timeout_for(policy, policy["shell"].get("timeoutMs")),
            output_directory=output_directory,
            expects_json=False,
        )

    entry = policy["commands"].get(request["name"])
    if not entry or not _entry_applies(entry, workspace):
        raise _not_allowed(f'Tool "{request["name"]}" is not available.')
    if binding_tools and request["name"] not in binding_tools:
        raise _not_allowed(f'Tool "{request["name"]}" is not available.')
    if entry.get("argv") is not None:
        uses_file = any("{file}" in element for element in entry["argv"])
        _reject_unknown_keys(arguments, ("file",) if uses_file else ())
        file: str | None = None
        if uses_file:
            file = _require_path(_arg(arguments, "file"), "file")
            inputs = entry.get("inputs")
            if inputs and not any(glob_matches(glob, file) for glob in inputs):  # type: ignore[arg-type]
                raise _invalid_path(f"file does not match the inputs this command accepts: {file}")
        argv = [
            element.replace("{mount}", mount)
            .replace("{output}", output_directory)
            .replace("{file}", f"{mount}/{file}" if file else "")
            for element in entry["argv"]
        ]
    else:
        _reject_unknown_keys(arguments, ("args",))
        raw_args = arguments.get("args")
        raw_args = [] if raw_args is None else raw_args
        if not isinstance(raw_args, list):
            raise _invalid_arguments("args must be an array.")
        args_policy = entry.get("args") or {}
        max_count = args_policy.get("maxCount")
        max_count = policy["limits"]["maxArgs"] if max_count is None else max_count
        if len(raw_args) > max_count:
            raise _limit_exceeded(f"args exceeds {_s(max_count)} entries.")
        args = [
            _require_string(value, f"args[{index}]", policy["limits"]["maxArgBytes"], False)
            for index, value in enumerate(raw_args)
        ]
        if any(value is None or len(value) == 0 for value in args):
            raise _invalid_arguments("args entries must be non-empty strings.")
        deny = [_compile_pattern(pattern, "deny") for pattern in args_policy.get("denyPatterns") or []]
        for value in args:
            if any(pattern.search(value) for pattern in deny):  # type: ignore[arg-type]
                raise _not_allowed(f"Argument is not permitted: {value}")
        allow = [_compile_pattern(pattern, "allow") for pattern in args_policy.get("allowPatterns") or []]
        if allow:
            first = args[0] if args else None
            if first is None or not any(pattern.search(first) for pattern in allow):
                raise _not_allowed("The first argument must match the host allowlist.")
        argv = [entry["program"], *args]  # type: ignore[list-item]
    return AdmittedCommand(
        kind="command",
        name=request["name"],
        policy_entry=request["name"],
        argv=argv,
        cwd=mount,
        timeout_ms=_timeout_for(policy, entry.get("timeoutMs")),
        output_directory=output_directory,
        expects_json=False,
    )
