# pyright: reportInvalidTypeForm=false, reportAssignmentType=false
# Field annotations are Zod-style schema calls resolved by the ZodModel layer at runtime.
"""The host configuration schema (``packages/runtime/src/config.ts``).

Models use the Zod-compatible layer, so parsed configurations and validation
issues are byte-identical to the TypeScript runtime's.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .._js import json as js_json
from .._js import yaml as js_yaml
from .._js.errors import Error, error_message
from ..contracts._zod import (
    ZodModel,
    array,
    boolean,
    custom,
    discriminated,
    enum,
    integer,
    literal,
    number,
    optional,
    parse,
    record,
    string,
    tag,
    union,
    unknown,
)
from ..contracts.schemas import WORKSPACE_MODES
from ..sandbox.policy import resolve_run_sandbox_policy

JsonObject = dict[str, Any]

AGENT_RUNTIME_CONFIG_SCHEMA_VERSION = "1.0"
MCP_TOOL_DIGEST_PATTERN = "/^sha256:[0-9a-f]{64}$/u"

Name = string(min=1, regex=("/^[a-z][a-z0-9-]*$/u", None))
EnvironmentName = string(min=1, regex=("/^[A-Za-z_][A-Za-z0-9_]*$/u", None))
NonEmpty = string(min=1)
Str = string()
Bool = boolean()
PositiveInt = integer(gt=0)
PositiveSafeInt = integer(gt=0, safe=True)


class EnvironmentReference(ZodModel):
    env: EnvironmentName


ValueSource = union(Str, EnvironmentReference)


class ModelCapabilities(ZodModel):
    streaming: optional(Bool) = None
    tools: optional(Bool) = None
    structuredOutput: optional(Bool) = None
    reasoning: optional(Bool) = None
    imageInput: optional(Bool) = None
    maxInputTokens: optional(PositiveInt) = None
    maxOutputTokens: optional(PositiveInt) = None


DRIVERS = ("openai", "anthropic", "google", "xai", "groq", "cohere", "openai-compatible")


class ProviderDefinition(ZodModel):
    driver: enum(*DRIVERS)
    baseURL: optional(ValueSource) = None
    apiKey: optional(EnvironmentReference) = None
    headers: optional(record(Str, EnvironmentReference)) = None
    includeUsage: optional(Bool) = None
    supportsStructuredOutputs: optional(Bool) = None


class ConfiguredModelDefinition(ZodModel):
    provider: Name
    model: NonEmpty
    options: optional(record(Str, unknown())) = None
    capabilities: optional(ModelCapabilities) = None


class _AuthNone(ZodModel):
    type: tag("none")


class _AuthBearer(ZodModel):
    type: tag("bearer")
    token: EnvironmentReference


class _AuthOauth(ZodModel):
    type: tag("oauth")
    profile: optional(Name) = None


class _AuthClientCredentials(ZodModel):
    type: tag("client_credentials")
    clientId: EnvironmentReference
    clientSecret: EnvironmentReference
    scopes: optional(array(string(trim=True, min=1))) = None


McpConnectionAuth = discriminated("type", _AuthNone, _AuthBearer, _AuthOauth, _AuthClientCredentials)


class McpToolIntegrity(ZodModel):
    digests: record(NonEmpty, string(regex=(MCP_TOOL_DIGEST_PATTERN, "Expected a sha256:<64 hex> tool digest.")))
    onFailure: enum("fail", "exclude") = "fail"


class McpConnectionDefinition(ZodModel):
    driver: literal("mcp")
    transport: literal("streamable-http") = "streamable-http"
    url: ValueSource
    auth: optional(McpConnectionAuth) = None
    bearerToken: optional(EnvironmentReference) = None
    headers: optional(record(Str, EnvironmentReference)) = None
    mode: enum("read", "read_write") = "read"
    tools: array(NonEmpty, min=1)
    readTools: array(NonEmpty) = []
    required: Bool = False
    connectTimeoutMs: PositiveInt = 10_000
    toolTimeoutMs: PositiveInt = 30_000
    toolIntegrity: optional(McpToolIntegrity) = None


_AttachMode = enum("auto", "never")
_TrimmedNonEmpty = string(trim=True, min=1)


class LocalWorkspaceDefinition(ZodModel):
    driver: tag("local")
    root: ValueSource
    mode: enum(*WORKSPACE_MODES) = "read"
    include: optional(array(_TrimmedNonEmpty)) = None
    exclude: optional(array(_TrimmedNonEmpty)) = None
    maxFiles: optional(PositiveSafeInt) = None
    maxFileBytes: optional(PositiveSafeInt) = None
    maxTotalBytes: optional(PositiveSafeInt) = None
    attach: _AttachMode = "never"


class HostWorkspaceDefinition(ZodModel):
    driver: tag("host")
    mode: enum(*WORKSPACE_MODES) = "read"
    attach: _AttachMode = "never"


WorkspaceDefinition = discriminated("driver", LocalWorkspaceDefinition, HostWorkspaceDefinition)
_CommandName = string(regex=("/^[a-z][a-z0-9_]*$/u", None))


class _SandboxCommandArgs(ZodModel):
    maxCount: optional(integer(ge=0)) = None
    allowPatterns: optional(array(NonEmpty)) = None
    denyPatterns: optional(array(NonEmpty)) = None


class SandboxCommandDefinition(ZodModel):
    description: optional(Str) = None
    argv: optional(array(NonEmpty, min=1)) = None
    program: optional(NonEmpty) = None
    args: optional(_SandboxCommandArgs) = None
    inputs: optional(array(NonEmpty)) = None
    workspaces: optional(array(Name)) = None
    modes: optional(array(enum(*WORKSPACE_MODES), min=1)) = None
    timeoutMs: optional(PositiveSafeInt) = None

    @classmethod
    def refine(cls, entry: dict[str, Any]) -> list[dict[str, Any]]:
        if (entry.get("argv") is None) == (entry.get("program") is None):
            return [custom("A sandbox command requires exactly one of argv or program.", [])]
        return []


class SandboxLimits(ZodModel):
    memoryMb: optional(PositiveSafeInt) = None
    cpuCount: optional(number(gt=0, le=1024)) = None
    processLimit: optional(PositiveSafeInt) = None
    workspaceTmpfsMb: optional(PositiveSafeInt) = None
    commandTimeoutMs: optional(PositiveSafeInt) = None
    maxCommandTimeoutMs: optional(PositiveSafeInt) = None
    maxCommandsPerRun: optional(PositiveSafeInt) = None
    maxTotalSandboxSeconds: optional(PositiveSafeInt) = None
    maxStdoutBytes: optional(PositiveSafeInt) = None
    maxStderrBytes: optional(PositiveSafeInt) = None
    maxArgs: optional(PositiveSafeInt) = None
    maxArgBytes: optional(PositiveSafeInt) = None
    maxTotalStagedBytes: optional(PositiveSafeInt) = None
    maxOutputFiles: optional(PositiveSafeInt) = None
    maxOutputBytes: optional(PositiveSafeInt) = None


class _HelperPath(ZodModel):
    path: NonEmpty


class SandboxHelper(ZodModel):
    command: optional(array(NonEmpty, min=1)) = None
    source: optional(union(literal("bundled"), _HelperPath)) = None


class SandboxShell(ZodModel):
    enabled: Bool = False
    program: optional(array(NonEmpty, min=1)) = None
    timeoutMs: optional(PositiveSafeInt) = None
    modes: optional(array(enum(*WORKSPACE_MODES), min=1)) = None


class SandboxDefinition(ZodModel):
    driver: enum("docker", "bubblewrap", "host")
    image: optional(NonEmpty) = None
    allowedImages: optional(array(NonEmpty)) = None
    binds: optional(array(NonEmpty)) = None
    helper: optional(SandboxHelper) = None
    limits: optional(SandboxLimits) = None
    commands: record(_CommandName, SandboxCommandDefinition) = {}
    shell: SandboxShell = SandboxShell.model_validate({"enabled": False})
    allowedEnvironment: optional(array(string(regex=("/^[A-Za-z_][A-Za-z0-9_]*$/u", None)))) = None

    @classmethod
    def refine(cls, sandbox: dict[str, Any]) -> list[dict[str, Any]]:
        issues: list[dict[str, Any]] = []
        if sandbox.get("driver") == "docker" and not sandbox.get("image"):
            issues.append(custom("Docker sandboxes require an image.", ["image"], order=ORDER))
        if (
            sandbox.get("driver") == "docker"
            and sandbox.get("image")
            and sandbox.get("allowedImages")
            and sandbox["image"] not in sandbox["allowedImages"]
        ):
            issues.append(
                custom("The sandbox image must be included in allowedImages.", ["allowedImages"], order=ORDER)
            )
        try:
            resolve_run_sandbox_policy(
                commands=sandbox.get("commands") or {},
                shell=sandbox.get("shell") or {"enabled": False},
                limits=sandbox.get("limits"),
            )
        except Exception as error:
            issues.append(custom(error_message(error), ["commands"], order=ORDER))
        return issues


class MessagesSigning(ZodModel):
    activeKeyId: NonEmpty
    keys: record(NonEmpty, EnvironmentReference)
    require: optional(Bool) = None


class MessagesMedia(ZodModel):
    maxInlineBytes: optional(PositiveInt) = None


class MessagesLimits(ZodModel):
    maxSuppliedMessages: optional(PositiveInt) = None
    maxSuppliedBytes: optional(PositiveInt) = None


class MessagesConfig(ZodModel):
    signing: optional(MessagesSigning) = None
    media: optional(MessagesMedia) = None
    limits: optional(MessagesLimits) = None

    @classmethod
    def refine(cls, messages: dict[str, Any]) -> list[dict[str, Any]]:
        signing = messages.get("signing")
        if signing and signing.get("activeKeyId") not in (signing.get("keys") or {}):
            return [
                custom(
                    f'messages.signing.activeKeyId "{signing.get("activeKeyId")}" must name a key in messages.signing.keys.',
                    ["signing", "activeKeyId"],
                    order=ORDER,
                )
            ]
        return []


ORDER = "code,message,path"  # superRefine addIssue({code, message, path})


BUILT_IN_PROVIDER_DRIVERS = {
    "openai": "openai",
    "anthropic": "anthropic",
    "google": "google",
    "gemini": "google",
    "xai": "xai",
    "grok": "xai",
    "groq": "groq",
    "cohere": "cohere",
}


def is_built_in_provider_name(name: str) -> bool:
    return name in BUILT_IN_PROVIDER_DRIVERS


def built_in_provider_definition(name: str) -> JsonObject | None:
    driver = BUILT_IN_PROVIDER_DRIVERS.get(name)
    return {"driver": driver} if driver is not None else None


class AgentRuntimeConfig(ZodModel):
    version: literal(AGENT_RUNTIME_CONFIG_SCHEMA_VERSION)
    providers: record(Name, ProviderDefinition) = {}
    models: record(Name, ConfiguredModelDefinition) = {}
    connections: record(Name, McpConnectionDefinition) = {}
    workspaces: record(Name, WorkspaceDefinition) = {}
    sandbox: optional(SandboxDefinition) = None
    messages: optional(MessagesConfig) = None

    @classmethod
    def refine(cls, config: dict[str, Any]) -> list[dict[str, Any]]:
        issues: list[dict[str, Any]] = []
        workspaces = config.get("workspaces") or {}
        providers = config.get("providers") or {}
        for name, entry in js_json.js_entries(((config.get("sandbox") or {}).get("commands")) or {}):
            for workspace in entry.get("workspaces") or []:
                if workspace not in workspaces:
                    issues.append(
                        custom(
                            f'Sandbox command "{name}" references unknown workspace "{workspace}".',
                            ["sandbox", "commands", name, "workspaces"],
                            order=ORDER,
                        )
                    )
        for name, model in js_json.js_entries(config.get("models") or {}):
            if model["provider"] not in providers and not is_built_in_provider_name(model["provider"]):
                issues.append(
                    custom(
                        f'Model "{name}" references unknown provider "{model["provider"]}".',
                        ["models", name, "provider"],
                        order=ORDER,
                    )
                )
        for name, provider in js_json.js_entries(providers):
            if provider["driver"] == "openai-compatible" and provider.get("baseURL") is None:
                issues.append(
                    custom(
                        f'OpenAI-compatible provider "{name}" requires baseURL.',
                        ["providers", name, "baseURL"],
                        order=ORDER,
                    )
                )
        for name, connection in js_json.js_entries(config.get("connections") or {}):
            allowed = set(connection["tools"])
            for tool in connection.get("readTools") or []:
                if tool not in allowed:
                    issues.append(
                        custom(
                            f'Connection "{name}" readTools must be included in tools.',
                            ["connections", name, "readTools"],
                            order=ORDER,
                        )
                    )
            for tool in js_json.js_keys((connection.get("toolIntegrity") or {}).get("digests") or {}):
                if tool not in allowed:
                    issues.append(
                        custom(
                            f'Connection "{name}" toolIntegrity.digests may only name tools included in tools.',
                            ["connections", name, "toolIntegrity", "digests", tool],
                            order=ORDER,
                        )
                    )
            if connection.get("mode") == "read" and len(connection.get("readTools") or []) == 0:
                issues.append(
                    custom(
                        f'Read-only connection "{name}" requires an explicit readTools allowlist.',
                        ["connections", name, "readTools"],
                        order=ORDER,
                    )
                )
            if connection.get("auth") and connection.get("bearerToken"):
                issues.append(
                    custom(
                        f'Connection "{name}" cannot define both auth and bearerToken.',
                        ["connections", name, "auth"],
                        order=ORDER,
                    )
                )
            if (connection.get("auth") or {}).get("type") is not None and any(
                header.lower() == "authorization" for header in (connection.get("headers") or {})
            ):
                issues.append(
                    custom(
                        f'Connection "{name}" cannot define both auth and an Authorization header.',
                        ["connections", name, "headers"],
                        order=ORDER,
                    )
                )
        return issues


def parse_agent_runtime_config(value: Any) -> JsonObject:
    """Validate a configuration; returns its JSON form with defaults applied."""
    return parse(AgentRuntimeConfig, value)


def empty_agent_runtime_config() -> JsonObject:
    return parse_agent_runtime_config({"version": AGENT_RUNTIME_CONFIG_SCHEMA_VERSION})


def resolve_configuration_paths(config: JsonObject, base_directory: str) -> JsonObject:
    """Resolve literal workspace roots and helper paths against the configuration's directory."""
    workspaces = {
        name: {**definition, "root": os.path.normpath(os.path.join(base_directory, definition["root"]))}
        if definition["driver"] == "local" and isinstance(definition.get("root"), str)
        else definition
        for name, definition in js_json.js_entries(config.get("workspaces") or {})
    }
    sandbox = config.get("sandbox")
    helper_source = ((sandbox or {}).get("helper") or {}).get("source")
    if sandbox and isinstance(helper_source, dict):
        sandbox = {
            **sandbox,
            "helper": {
                **sandbox["helper"],
                "source": {"path": os.path.normpath(os.path.join(base_directory, helper_source["path"]))},
            },
        }
    result = {**config, "workspaces": workspaces}
    if sandbox:
        result["sandbox"] = sandbox
    return result


async def load_agent_runtime_config(file: str | os.PathLike[str]) -> JsonObject:
    absolute = os.path.abspath(os.fspath(file))
    source = Path(absolute).read_text(encoding="utf-8")
    try:
        parsed = js_json.parse(source) if absolute.endswith(".json") else js_yaml.parse(source)
    except Exception as error:
        raise Error(f"Could not parse Agent Runtime configuration {absolute}: {error_message(error)}") from error
    try:
        config = parse_agent_runtime_config(parsed)
    except Exception as error:
        raise Error(f"Invalid Agent Runtime configuration {absolute}: {error_message(error)}") from error
    return resolve_configuration_paths(config, os.path.dirname(absolute))
