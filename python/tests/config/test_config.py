"""Ports of ``packages/runtime/src/config.test.ts``, ``messages.test.ts``, and ``mcp-integrity.test.ts``."""

from __future__ import annotations

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.config import (
    ComposeRuntimeOptions,
    McpToolIntegrityError,
    ModelAuthorizationPolicy,
    ValueResolutionContext,
    canonicalize_mcp_tool_metadata,
    compose_runtime,
    compute_mcp_tool_digest,
    create_configured_messages_options,
    parse_agent_runtime_config,
    resolve_model_reference,
    validate_runtime_configuration,
)
from clearideas_agent_runtime.contracts._zod import ZodError


def prompt_manifest(model: dict) -> dict:
    return {"schemaVersion": "1.0", "model": model, "steps": [{"id": "answer", "type": "prompt", "prompt": "Hi"}]}


OPENAI_KEY = ValueResolutionContext(environment={"OPENAI_API_KEY": "test-key"})


def test_parses_provider_definitions_without_inline_secrets() -> None:
    config = parse_agent_runtime_config(
        {
            "version": "1.0",
            "providers": {
                "team": {"driver": "openai", "apiKey": {"env": "TEAM_KEY"}},
                "local": {"driver": "openai-compatible", "baseURL": "http://localhost:11434/v1"},
            },
        }
    )
    assert config["providers"]["team"]["apiKey"] == {"env": "TEAM_KEY"}
    with pytest.raises(ZodError):
        parse_agent_runtime_config(
            {"version": "1.0", "providers": {"team": {"driver": "openai", "apiKey": "sk-inline"}}}
        )


def test_resolves_profiles_with_agent_option_overrides() -> None:
    config = parse_agent_runtime_config(
        {
            "version": "1.0",
            "providers": {"local": {"driver": "openai-compatible", "baseURL": "http://localhost:11434/v1"}},
            "models": {
                "private": {
                    "provider": "local",
                    "model": "qwen-test",
                    "options": {"temperature": 0.2},
                    "capabilities": {"tools": False, "maxOutputTokens": 1000},
                }
            },
        }
    )
    resolved = resolve_model_reference({"ref": "private", "options": {"temperature": 0.5}}, config)
    assert (resolved["provider"], resolved["model"], resolved["profile"], resolved["options"]) == (
        "local",
        "qwen-test",
        "private",
        {"temperature": 0.5},
    )


def test_auto_registers_common_providers_with_conventional_keys() -> None:
    runtime = compose_runtime(
        prompt_manifest({"provider": "openai", "model": "gpt-test"}),
        parse_agent_runtime_config({"version": "1.0"}),
        OPENAI_KEY,
    )
    assert runtime.model is not None
    with pytest.raises(Error, match="requires environment variable OPENAI_API_KEY"):
        compose_runtime(
            prompt_manifest({"provider": "openai", "model": "gpt-test"}),
            parse_agent_runtime_config({"version": "1.0"}),
            ValueResolutionContext(environment={}),
        )


def test_enforces_host_model_policy() -> None:
    config = parse_agent_runtime_config(
        {
            "version": "1.0",
            "providers": {"primary": {"driver": "openai", "apiKey": {"env": "OPENAI_API_KEY"}}},
            "models": {"approved": {"provider": "primary", "model": "gpt-test"}},
        }
    )
    with pytest.raises(Error, match="requires agent manifests to use configured model profiles"):
        compose_runtime(
            prompt_manifest({"provider": "primary", "model": "gpt-test"}),
            config,
            OPENAI_KEY,
            ComposeRuntimeOptions(model_policy=ModelAuthorizationPolicy(require_profiles=True)),
        )
    with pytest.raises(Error, match="is not authorized by this host"):
        compose_runtime(
            prompt_manifest({"ref": "approved"}),
            config,
            OPENAI_KEY,
            ComposeRuntimeOptions(model_policy=ModelAuthorizationPolicy(allowed_models=["primary/other-model"])),
        )
    with pytest.raises(Error, match="option overrides are not authorized"):
        compose_runtime(
            prompt_manifest({"ref": "approved", "options": {"temperature": 0.9}}),
            config,
            OPENAI_KEY,
            ComposeRuntimeOptions(model_policy=ModelAuthorizationPolicy(allow_manifest_options=False)),
        )


async def test_describes_model_limits_and_authorizes_summarizer_models() -> None:
    config = parse_agent_runtime_config(
        {
            "version": "1.0",
            "providers": {"primary": {"driver": "openai", "apiKey": {"env": "OPENAI_API_KEY"}}},
            "models": {
                "main": {
                    "provider": "primary",
                    "model": "gpt-main",
                    "capabilities": {"maxInputTokens": 128000, "maxOutputTokens": 8000},
                },
                "fast": {"provider": "primary", "model": "gpt-fast", "capabilities": {"maxOutputTokens": 1000}},
            },
        }
    )
    manifest = {
        **prompt_manifest({"ref": "main"}),
        "policies": {"context": {"strategy": "summarize", "summarizer": {"model": {"ref": "fast"}}}},
    }
    model = compose_runtime(manifest, config, OPENAI_KEY).model
    assert model.describe_model("ref/main") == {"maxInputTokens": 128000, "maxOutputTokens": 8000}
    assert model.describe_model("primary/gpt-main") == {"maxInputTokens": 128000, "maxOutputTokens": 8000}
    assert model.describe_model("ref/unknown") is None
    with pytest.raises(Error, match='Model "primary/gpt-fast" is not authorized by this host'):
        compose_runtime(
            manifest,
            config,
            OPENAI_KEY,
            ComposeRuntimeOptions(model_policy=ModelAuthorizationPolicy(allowed_models=["primary/gpt-main"])),
        )
    with pytest.raises(Error, match="summarizer for prompt step answer requests 5000 output tokens"):
        validate_runtime_configuration(
            {**manifest, "policies": {"context": {"summarizer": {"model": {"ref": "fast"}, "maxOutputTokens": 5000}}}},
            config,
        )
    with pytest.raises(Error, match='Unknown model profile "missing"'):
        validate_runtime_configuration(
            {
                **prompt_manifest({"ref": "main"}),
                "policies": {"context": {"summarizer": {"model": {"ref": "missing"}}}},
            },
            config,
        )


def test_rejects_provider_endpoint_credentials_in_urls() -> None:
    config = parse_agent_runtime_config(
        {
            "version": "1.0",
            "providers": {"local": {"driver": "openai-compatible", "baseURL": "http://user:pass@localhost/v1"}},
        }
    )
    with pytest.raises(Error, match="without URL credentials"):
        compose_runtime(prompt_manifest({"provider": "local", "model": "m"}), config)


def test_rejects_missing_profiles_capability_mismatches_and_elevation() -> None:
    config = parse_agent_runtime_config(
        {
            "version": "1.0",
            "providers": {"primary": {"driver": "openai"}},
            "models": {
                "plain": {
                    "provider": "primary",
                    "model": "m",
                    "capabilities": {"tools": False, "structuredOutput": False, "maxOutputTokens": 10},
                }
            },
            "connections": {
                "docs": {
                    "driver": "mcp",
                    "url": "https://mcp.example.com",
                    "tools": ["search"],
                    "readTools": ["search"],
                }
            },
        }
    )
    with pytest.raises(Error, match="does not support tools"):
        validate_runtime_configuration(
            {
                "schemaVersion": "1.0",
                "model": {"ref": "plain"},
                "steps": [{"id": "a", "type": "prompt", "prompt": "x", "tools": ["t"]}],
            },
            config,
        )
    with pytest.raises(Error, match="does not support structured output"):
        validate_runtime_configuration(
            {
                "schemaVersion": "1.0",
                "model": {"ref": "plain"},
                "steps": [{"id": "a", "type": "prompt", "prompt": "x", "outputSchema": {"type": "object"}}],
            },
            config,
        )
    with pytest.raises(Error, match="exceeding the configured model limit of 10"):
        validate_runtime_configuration(
            {
                "schemaVersion": "1.0",
                "model": {"ref": "plain"},
                "steps": [{"id": "a", "type": "prompt", "prompt": "x", "maxOutputTokens": 11}],
            },
            config,
        )
    with pytest.raises(Error, match="cannot be elevated"):
        validate_runtime_configuration(
            {**prompt_manifest({"ref": "plain"}), "connections": [{"ref": "docs", "mode": "read_write"}]}, config
        )
    with pytest.raises(Error, match='Unknown connection "missing"'):
        validate_runtime_configuration(
            {**prompt_manifest({"ref": "plain"}), "connections": [{"ref": "missing"}]}, config
        )


async def test_composes_a_message_signer_from_environment_keys() -> None:
    config = parse_agent_runtime_config(
        {
            "version": "1.0",
            "messages": {
                "signing": {"activeKeyId": "k1", "keys": {"k1": {"env": "KEY_1"}}, "require": True},
                "media": {"maxInlineBytes": 2048},
                "limits": {"maxSuppliedMessages": 5, "maxSuppliedBytes": 4096},
            },
        }
    )
    options = create_configured_messages_options(
        config, ValueResolutionContext(environment={"KEY_1": "base64:" + "a" * 44})
    )
    assert options is not None and options.signer is not None
    assert (
        options.require_signature,
        options.max_inline_bytes,
        options.max_supplied_messages,
        options.max_supplied_bytes,
    ) == (True, 2048, 5, 4096)
    with pytest.raises(Error, match="Message signing key k1 requires environment variable KEY_1"):
        create_configured_messages_options(config, ValueResolutionContext(environment={}))
    with pytest.raises(ZodError, match=r"must name a key in messages\.signing\.keys"):
        parse_agent_runtime_config(
            {"version": "1.0", "messages": {"signing": {"activeKeyId": "k2", "keys": {"k1": {"env": "K"}}}}}
        )


def test_mcp_tool_canonicalization_rules() -> None:
    base = {
        "name": "search",
        "description": "Find",
        "inputSchema": {"type": "object", "properties": {"b": {"type": "string"}, "a": {"type": ["string", "null"]}}},
    }
    reordered = {
        "inputSchema": {"properties": {"a": {"type": ["string", "null"]}, "b": {"type": "string"}}, "type": "object"},
        "description": "Find",
        "name": "search",
    }
    assert canonicalize_mcp_tool_metadata(base) == canonicalize_mcp_tool_metadata(reordered)
    assert canonicalize_mcp_tool_metadata({**base, "title": "", "annotations": {}}) == canonicalize_mcp_tool_metadata(
        {**base, "title": None}
    )
    assert compute_mcp_tool_digest(base).startswith("sha256:") and len(compute_mcp_tool_digest(base)) == 71
    assert compute_mcp_tool_digest({**base, "outputSchema": {"x": 1}}) == compute_mcp_tool_digest(base)
    with pytest.raises(Error, match="non-empty name"):
        canonicalize_mcp_tool_metadata({"name": ""})
    error = McpToolIntegrityError(
        connection_ref="docs",
        tool_name="search",
        reason="mismatch",
        expected_digest="sha256:a",
        actual_digest="sha256:b",
        tool=base,
    )
    assert (
        str(error)
        == 'Connection "docs" tool "search" metadata digest sha256:b does not match the host-approved digest sha256:a.'
    )
