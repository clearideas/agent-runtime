"""Host configuration parity: parsed configurations and validation issues are byte-identical."""

from __future__ import annotations

import copy
import random
from typing import Any

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime.config.schema import AgentRuntimeConfig
from clearideas_agent_runtime.contracts._zod import safe_parse

from .generators import WRONG_VALUES

DIGEST = "sha256:" + "a" * 64
VALID: dict[str, Any] = {
    "version": "1.0",
    "providers": {
        "primary-openai": {"driver": "openai", "apiKey": {"env": "TEAM_OPENAI_API_KEY"}},
        "local": {
            "driver": "openai-compatible",
            "baseURL": "http://localhost:11434/v1",
            "includeUsage": True,
            "headers": {"x-team": {"env": "TEAM"}},
        },
    },
    "models": {
        "fast": {
            "provider": "primary-openai",
            "model": "gpt-5.4-mini",
            "options": {"openai": {"reasoningEffort": "low"}},
            "capabilities": {"streaming": True, "maxInputTokens": 128000, "maxOutputTokens": 16384},
        },
        "claude": {"provider": "anthropic", "model": "claude-sonnet-4-6"},
    },
    "connections": {
        "docs": {
            "driver": "mcp",
            "url": {"env": "DOCS_URL"},
            "auth": {"type": "bearer", "token": {"env": "DOCS_TOKEN"}},
            "mode": "read_write",
            "tools": ["search", "write"],
            "readTools": ["search"],
            "toolIntegrity": {"digests": {"search": DIGEST}, "onFailure": "exclude"},
        }
    },
    "workspaces": {
        "repo": {"driver": "local", "root": "./repo", "mode": "read_write", "include": [" **/*.md "], "maxFiles": 100},
        "host": {"driver": "host"},
    },
    "sandbox": {
        "driver": "docker",
        "image": "python:3.12-slim",
        "allowedImages": ["python:3.12-slim"],
        "helper": {"source": {"path": "./agent-fs.py"}},
        "limits": {"memoryMb": 512, "cpuCount": 0.5},
        "commands": {
            "lint": {"program": "ruff", "args": {"maxCount": 4, "allowPatterns": ["^check$"]}, "workspaces": ["repo"]}
        },
        "shell": {"enabled": True, "modes": ["read_write"]},
        "allowedEnvironment": ["SAFE_TOKEN"],
    },
    "messages": {
        "signing": {"activeKeyId": "k1", "keys": {"k1": {"env": "KEY_1"}}, "require": True},
        "media": {"maxInlineBytes": 1000},
        "limits": {"maxSuppliedMessages": 10},
    },
}

INVALID_EDITS: list[tuple[list[Any], Any]] = [
    (["version"], "2.0"),
    (["providers", "Bad"], {"driver": "openai"}),
    (["providers", "local", "baseURL"], None),
    (["models", "fast", "provider"], "missing"),
    (["connections", "docs", "readTools"], ["nope"]),
    (["connections", "docs", "mode"], "read"),
    (["connections", "docs", "bearerToken"], {"env": "X"}),
    (["connections", "docs", "headers"], {"Authorization": {"env": "X"}}),
    (["connections", "docs", "toolIntegrity", "digests", "other"], DIGEST),
    (["connections", "docs", "toolIntegrity", "digests", "search"], "sha256:xyz"),
    (
        ["connections", "docs", "auth"],
        {"type": "client_credentials", "clientId": {"env": "A"}, "clientSecret": {"env": "B"}, "scopes": ["  "]},
    ),
    (["connections", "docs", "auth"], {"type": "magic"}),
    (["workspaces", "repo", "driver"], "s3"),
    (["workspaces", "repo", "maxFiles"], 0),
    (["sandbox", "image"], None),
    (["sandbox", "allowedImages"], ["other"]),
    (["sandbox", "commands", "lint", "argv"], ["x"]),
    (["sandbox", "commands", "lint", "workspaces"], ["missing"]),
    (["sandbox", "commands", "Bad"], {"program": "x"}),
    (["sandbox", "commands", "shell"], {"program": "x"}),
    (["sandbox", "limits", "cpuCount"], 2048),
    (["sandbox", "limits", "commandTimeoutMs"], 10**9),
    (["sandbox", "shell", "program"], []),
    (["messages", "signing", "activeKeyId"], "k2"),
    (["messages", "extra"], True),
]


def _edit(config: dict[str, Any], path: list[Any], value: Any) -> dict[str, Any]:
    result = copy.deepcopy(config)
    target = result
    for key in path[:-1]:
        target = target.setdefault(key, {})
    if value is None:
        target.pop(path[-1], None)
    else:
        target[path[-1]] = value
    return result


def _inputs() -> list[Any]:
    rng = random.Random(31)
    inputs: list[Any] = [VALID, {"version": "1.0"}, None, [], "x"]
    inputs += [_edit(VALID, path, value) for path, value in INVALID_EDITS]
    paths = [path for path, _ in INVALID_EDITS]
    for _ in range(300):
        config = VALID
        for _ in range(rng.randrange(1, 4)):
            config = _edit(config, rng.choice(paths), rng.choice([*WRONG_VALUES, None]))
        inputs.append(config)
    return inputs


def test_configurations_parse_identically(oracle) -> None:
    inputs = _inputs()
    expected = oracle.values("parseConfig", inputs)
    for value, result in zip(inputs, expected, strict=True):
        parsed = safe_parse(AgentRuntimeConfig, value)
        actual = (
            {"success": True, "data": parsed.data}
            if parsed.success
            else {"success": False, "issues": parsed.error.issues, "message": str(parsed.error)}
        )
        assert js_json.stringify(actual) == js_json.stringify(result), value


def test_mcp_tool_digests_match(oracle) -> None:
    from clearideas_agent_runtime.config import canonicalize_mcp_tool_metadata, compute_mcp_tool_digest

    rng = random.Random(32)
    keys = ["type", "properties", "b", "a", "B", "é", "😀", "10", "2", "_", "aa", "Z"]

    def value(depth: int = 0) -> Any:
        kind = rng.randrange(6 if depth < 3 else 3)
        if kind == 0:
            return rng.choice(["x", "", "é😀", "\u2028", "line\nbreak"])
        if kind == 1:
            return rng.choice([None, True, 0, -1.5, 1e21, 12345678901234567890])
        if kind == 2:
            return rng.randrange(-5, 5)
        if kind == 3:
            return [value(depth + 1) for _ in range(rng.randrange(0, 4))]
        return {rng.choice(keys): value(depth + 1) for _ in range(rng.randrange(0, 5))}

    tools = []
    for index in range(300):
        tool: dict[str, Any] = {"name": rng.choice(["search", "é", f"t{index}"])}
        for field in ("title", "description", "inputSchema", "annotations", "outputSchema", "_meta"):
            if rng.random() < 0.6:
                tool[field] = (
                    value() if field not in ("title", "description") else rng.choice(["", None, "Find é", {"x": 1}])
                )
        tools.append(tool)
    expected = oracle("mcpToolDigest", tools)
    for tool, result in zip(tools, expected, strict=True):
        try:
            actual: Any = {
                "ok": True,
                "value": {"canonical": canonicalize_mcp_tool_metadata(tool), "digest": compute_mcp_tool_digest(tool)},
            }
        except Exception as error:
            actual = {"ok": False, "message": str(error)}
        if result["ok"]:
            assert actual == {"ok": True, "value": result["value"]}, tool
        else:
            assert actual == {"ok": False, "message": result["error"]["message"]}, tool
