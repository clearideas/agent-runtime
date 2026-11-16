"""The public API: every value ``@clearideas/agent-runtime`` exports has a Python counterpart.

The Python package's top level re-exports its subpackages the way the
TypeScript umbrella package does. Names follow Python conventions: functions
and values in snake_case (``composeRuntime`` → ``compose_runtime``,
``agentManifestSchema`` → ``agent_manifest_schema``), classes and constants
unchanged. Exported constants must have the same values.
"""

from __future__ import annotations

import re

import clearideas_agent_runtime as runtime

#: TypeScript exports whose Python counterpart has a different name.
RENAMED = {
    # The model adapter is built on pydantic-ai instead of the AI SDK.
    "AiSdkModelAdapter": "PydanticAIModelAdapter",
}


def python_name(name: str) -> str:
    if name in RENAMED:
        return RENAMED[name]
    if re.fullmatch(r"[A-Z][A-Z0-9_]*", name) or name[0].isupper():
        return name
    snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    return re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", snake).lower()


def test_every_typescript_export_has_a_python_counterpart(oracle) -> None:
    exports = oracle.values("umbrellaExports", [None])[0]
    assert len(exports) > 200
    missing = []
    for export in exports:
        name = python_name(export["name"])
        if not hasattr(runtime, name):
            missing.append(f"{export['name']} → {name}")
            continue
        value = getattr(runtime, name)
        if export["kind"] == "function":
            assert callable(value), export["name"]
        if "value" in export:
            expected = export["value"]
            actual = value.pattern if isinstance(value, re.Pattern) else value
            assert actual == expected, f"{export['name']}: {actual!r} != {expected!r}"
    assert missing == []


def test_the_top_level_lists_its_public_names() -> None:
    names = set(runtime.__all__)
    for name in ("AgentRuntime", "compose_runtime", "FileRunStore", "AbortController", "define_agent"):
        assert name in names
    assert all(hasattr(runtime, name) for name in names)
