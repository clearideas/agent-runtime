"""Run-sandbox policy parity: admission decisions, argv, and tool descriptions.

``admit_command`` decides what a model-supplied tool call may execute and the
exact argv; ``describe_workspace_tools`` is what the model is offered. Both
must agree with TypeScript for generated requests, including invalid ones
(same error code and message).
"""

from __future__ import annotations

import random
from typing import Any

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime.core.ports import ResolvedWorkspace
from clearideas_agent_runtime.sandbox.policy import (
    AdmissionContext,
    admit_command,
    describe_workspace_tools,
    resolve_run_sandbox_policy,
)

POLICIES: list[dict[str, Any]] = [
    {},
    {"shell": {"enabled": True, "timeoutMs": 5_000}, "limits": {"maxArgBytes": 32, "maxArgs": 3}},
    {
        "commands": {
            "extract_text": {
                "argv": ["pdftotext", "{file}", "{output}/out.txt"],
                "inputs": ["**/*.pdf"],
                "description": "Extract.",
            },
            "wc": {"argv": ["wc", "-l", "{mount}"], "modes": ["read_write"]},
            "pytest": {
                "program": "pytest",
                "args": {"maxCount": 3, "allowPatterns": ["^tests"], "denyPatterns": ["^-p$"]},
                "timeoutMs": 2_000,
            },
        },
        "shell": {"enabled": True, "modes": ["read_write"]},
    },
]
WORKSPACES = [
    {"binding": {"ref": "docs-ref", "alias": "docs"}, "alias": "docs", "mode": "read_write"},
    {
        "binding": {"ref": "docs-ref", "alias": "docs"},
        "alias": "docs",
        "mode": "read",
        "limits": {"maxFiles": 10, "maxFileBytes": 64},
    },
    {
        "binding": {"ref": "code", "alias": "code", "tools": ["read_file", "pytest", "shell"]},
        "alias": "code",
        "mode": "read_write",
        "limits": {"maxFileBytes": 64},
    },
]
VALUES: list[Any] = [
    None,
    True,
    0,
    1,
    5,
    2.5,
    5000,
    10_000,
    -1,
    "",
    ".",
    "/",
    "\\",
    "a.md",
    "docs/a.pdf",
    ".\\docs\\a.pdf",
    "../x",
    ".env",
    "reports//./Q3.md/",
    "x" * 70,
    "a\u0000b",
    "é😀.md",
    ["tests/unit", "-q"],
    ["tests", "-p", "x"],
    ["-q"],
    [""],
    "tests",
    ["tests", "a", "b", "c"],
    {"k": 1},
    "**/*.md",
    "ls -la",
    "base64",
    "utf-8",
]
KEYS = [
    "path",
    "glob",
    "limit",
    "startLine",
    "lineCount",
    "query",
    "caseSensitive",
    "content",
    "encoding",
    "file",
    "args",
    "command",
    "extra",
]
REQUESTS = [
    ("builtin", "list_files"),
    ("builtin", "read_file"),
    ("builtin", "search_files"),
    ("builtin", "write_file"),
    ("builtin", "delete_file"),
    ("builtin", "nope"),
    ("shell", "shell"),
    ("command", "extract_text"),
    ("command", "wc"),
    ("command", "pytest"),
    ("command", "other"),
    ("code", "step"),
]
PLAUSIBLE = {
    "list_files": (
        ["path", "glob", "limit"],
        {"path": ["", ".", "docs", "\\", "reports//./"], "glob": ["**/*.md", "*.pdf"], "limit": [1, 5, 5000]},
    ),
    "read_file": (
        ["path", "startLine", "lineCount"],
        {"path": ["a.md", "docs/a.pdf", ".\\docs\\a.pdf", "é.md"], "startLine": [1, 2], "lineCount": [3, 2000]},
    ),
    "search_files": (
        ["query", "glob", "caseSensitive", "limit"],
        {"query": ["needle", "x"], "glob": ["**/*.md"], "caseSensitive": [True, False], "limit": [1, 1000]},
    ),
    "write_file": (
        ["path", "content", "encoding"],
        {"path": ["n.md", "d/e.md"], "content": ["hello", "x" * 70, "aGk="], "encoding": ["utf-8", "base64"]},
    ),
    "delete_file": (["path"], {"path": ["a.md", "d/e.md"]}),
    "shell": (["command"], {"command": ["ls -la", "echo hi"]}),
    "extract_text": (["file"], {"file": ["docs/a.pdf", ".\\docs\\b.pdf", "a.txt"]}),
    "wc": ([], {}),
    "pytest": (["args"], {"args": [["tests/unit", "-q"], ["tests"], ["tests", "-p"], []]}),
}


class _Store:
    def __init__(self, mode: str, limits: dict | None) -> None:
        self.mode = mode
        if limits is not None:
            self.limits = limits


def _workspace(value: dict | None) -> ResolvedWorkspace | None:
    if value is None:
        return None
    return ResolvedWorkspace(
        binding=value["binding"],
        alias=value["alias"],
        mode=value["mode"],
        store=_Store(value["mode"], value.get("limits")),
    )


def _python_admit(entry: dict) -> Any:
    admitted = admit_command(
        entry["request"],
        AdmissionContext(
            policy=resolve_run_sandbox_policy(**entry["policy"]),
            workspace=_workspace(entry.get("workspace")),
            command_id=entry["commandId"],
            helper_command=["python3", "/workspace/bin/agent-fs"],
            code_profile=lambda language: ("py", lambda source: ["python3", source]) if language == "python" else None,
        ),
    )
    value: dict[str, Any] = {"kind": admitted.kind, "name": admitted.name}
    if admitted.policy_entry:
        value["policyEntry"] = admitted.policy_entry
    value.update(
        {
            "argv": admitted.argv,
            "cwd": admitted.cwd,
            "timeoutMs": admitted.timeout_ms,
            "stagedFiles": admitted.staged_files,
            "outputDirectory": admitted.output_directory,
            "expectsJson": admitted.expects_json,
        }
    )
    return value


def _normalized(value: Any) -> str:
    return js_json.stringify(js_json.parse(js_json.stringify(value)))


def test_admission_matches_typescript(oracle) -> None:
    rng = random.Random(21)
    entries = []
    for _ in range(700):
        kind, name = rng.choice(REQUESTS)
        arguments = {key: rng.choice(VALUES) for key in rng.sample(KEYS, rng.randrange(0, 4))}
        if name in PLAUSIBLE and rng.random() < 0.7:
            keys, values = PLAUSIBLE[name]
            arguments = {key: rng.choice(values[key]) for key in keys if rng.random() < 0.8}
        if kind == "code":
            arguments = {
                "language": rng.choice(["python", "ruby"]),
                "code": "print(1)",
                "variables": {"a": 1},
                "timeoutMs": rng.choice([100, 10**7]),
            }
        request = {"stepId": "s", "kind": kind, "name": name, "arguments": arguments}
        entry: dict[str, Any] = {
            "policy": rng.choice(POLICIES),
            "request": request,
            "commandId": f"cmd-1-{rng.randrange(1, 9)}",
        }
        if kind != "code" or rng.random() < 0.5:
            entry["workspace"] = rng.choice(WORKSPACES)
        entries.append(entry)
    expected = oracle("admitCommand", entries)
    for entry, result in zip(entries, expected, strict=True):
        try:
            actual: Any = {"ok": True, "value": _python_admit(entry)}
        except Exception as error:
            actual = {
                "ok": False,
                "error": {
                    "name": getattr(error, "name", type(error).__name__),
                    "message": str(error),
                    **({"code": error.code} if isinstance(getattr(error, "code", None), str) else {}),
                },
            }
        if result["ok"]:
            assert actual["ok"], (entry, actual)
            assert _normalized(actual["value"]) == _normalized(result["value"]), entry
        else:
            assert actual == {"ok": False, "error": result["error"]}, entry


def test_tool_descriptions_and_policy_resolution_match_typescript(oracle) -> None:
    inputs = [{"policy": policy, "workspace": workspace} for policy in POLICIES for workspace in WORKSPACES]
    expected = oracle.values("describeWorkspaceTools", inputs)
    for entry, tools in zip(inputs, expected, strict=True):
        actual = describe_workspace_tools(_workspace(entry["workspace"]), resolve_run_sandbox_policy(**entry["policy"]))  # type: ignore[arg-type]
        assert _normalized(actual) == _normalized(tools)
    invalid = [
        {"limits": {"cpuCount": 0}},
        {"limits": {"memoryMb": 1.5}},
        {"limits": {"commandTimeoutMs": 10, "maxCommandTimeoutMs": 5}},
        {"commands": {"Bad": {"argv": ["x"]}}},
        {"commands": {"shell": {"argv": ["x"]}}},
        {"commands": {"a": {"argv": ["x"], "program": "y"}}},
        {"commands": {"a": {"argv": ["{nope}"]}}},
        {"commands": {"a": {"program": " "}}},
        {"commands": {"a": {"program": "p", "args": {"allowPatterns": ["("]}}}},
        {"commands": {"a": {"program": "p", "timeoutMs": 0}}},
        {"shell": {"enabled": True, "program": []}},
        {"shell": {"enabled": False}, "limits": {"maxArgs": 10}},
    ]
    results = oracle("resolveRunSandboxPolicy", invalid)
    for value, result in zip(invalid, results, strict=True):
        try:
            actual: Any = {"ok": True, "value": resolve_run_sandbox_policy(**value)}
        except Exception as error:
            actual = {"ok": False, "message": str(error)}
        if result["ok"]:
            assert actual["ok"] and _normalized(actual["value"]) == _normalized(result["value"]), value
        else:
            assert actual == {"ok": False, "message": result["error"]["message"]}, value
