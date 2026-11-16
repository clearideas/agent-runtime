"""Configured MCP connections as a ``ToolAdapter`` (``packages/runtime/src/mcp-tools.ts``).

Connections use MCP streamable HTTP through the official ``mcp`` SDK (the
``mcp`` extra). The client layer is injectable (``client_factory``), as the
TypeScript adapter's ``fetch`` is, so hosts and tests can supply their own.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.errors import Error, error_message, error_name
from .._js.url import URL
from .mcp_integrity import McpToolIntegrityError, compute_mcp_tool_digest
from .values import ValueResolutionContext, resolve_environment_reference, resolve_headers, resolve_value_source

JsonObject = dict[str, Any]
MAXIMUM_TOOL_LIST_PAGES = 100


class ConnectionAuthorizationRequiredError(Error):
    name = "ConnectionAuthorizationRequiredError"

    def __init__(self, connection_ref: str, authorization_url: str | None = None) -> None:
        super().__init__(f'Connection "{connection_ref}" requires authorization.')
        self.connection_ref = connection_ref
        self.authorization_url = authorization_url


async def _with_timeout(operation: Any, milliseconds: float, label: str) -> Any:
    try:
        return await asyncio.wait_for(operation, milliseconds / 1000)
    except TimeoutError as error:
        raise Error(f"{label} timed out after {milliseconds}ms.") from error


def _json_value(value: Any) -> Any:
    if value is None:
        return None
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        # Only the members the server sent, as the TypeScript SDK returns them
        # (pydantic defaults such as `isError: false` are not part of the reply).
        value = dump(mode="json", by_alias=True, exclude_unset=True)
    return js_json.to_json_value(value)


def tool_metadata(tool: JsonObject) -> JsonObject:
    """The subset of a ``tools/list`` entry exposed to a model (and digested)."""
    metadata: JsonObject = {"name": tool["name"]}
    for field in ("title", "description"):
        if tool.get(field) is not None:
            metadata[field] = tool[field]
    if tool.get("inputSchema") is not None:
        metadata["inputSchema"] = _json_value(tool["inputSchema"])
    if tool.get("annotations") is not None:
        metadata["annotations"] = _json_value(tool["annotations"])
    return metadata


def _input_schema(value: Any) -> JsonObject:
    if isinstance(value, dict) and value:
        return _json_value(value)
    if isinstance(value, dict):
        return {}
    return {"type": "object", "properties": {}, "additionalProperties": False}


def _sanitize(value: str) -> str:
    normalized = re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9_-]+", "_", js_strings.lower(value)))
    return normalized or "tool"


def runtime_tool_name(alias: str, tool_name: str) -> str:
    return js_strings.slice(f"{_sanitize(alias)}__{_sanitize(tool_name)}", 0, 64)


def _effective_mode(connection: JsonObject, binding: JsonObject) -> str:
    if connection["mode"] == "read":
        if binding.get("mode") == "read_write":
            raise Error(f'Connection "{binding["ref"]}" is read-only and cannot be elevated by an agent.')
        return "read"
    return binding.get("mode") or connection["mode"]


def _allowed_tool_names(connection: JsonObject, binding: JsonObject, mode: str) -> list[str]:
    configured = list(dict.fromkeys(connection["tools"]))
    if binding.get("tools"):
        allowed = [name for name in dict.fromkeys(binding["tools"]) if name in configured]
    else:
        allowed = configured
    if mode == "read":
        read_tools = set(connection.get("readTools") or [])
        return [name for name in allowed if name in read_tools]
    return allowed


def _assert_url(value: str, connection_name: str) -> str:
    try:
        url = URL(value)
    except Exception as error:
        raise Error(f'Connection "{connection_name}" URL is invalid.') from error
    if url.protocol not in ("https:", "http:") or url.username or url.password:
        raise Error(f'Connection "{connection_name}" must use HTTP or HTTPS without URL credentials.')
    return url.href


def _auth_type(definition: JsonObject) -> str:
    auth = definition.get("auth") or {}
    return auth.get("type") or ("bearer" if definition.get("bearerToken") else "none")


def _credential_request(
    name: str, definition: JsonObject, context: JsonObject | None = None, force_refresh: bool = False
) -> JsonObject:
    context = context or {}
    request: JsonObject = {"connectionRef": name, "authType": _auth_type(definition)}
    auth = definition.get("auth") or {}
    if auth.get("type") == "oauth" and auth.get("profile"):
        request["credentialProfile"] = auth["profile"]
    for key in ("runId", "stepId"):
        if context.get(key):
            request[key] = context[key]
    if force_refresh:
        request["forceRefresh"] = True
    if context.get("signal") is not None:
        request["signal"] = context["signal"]
    return request


_UNAUTHORIZED_TEXT = (
    "unauthorized",
    "invalid_token",
    "invalid access token",
    "expired access token",
    "access token expired",
)


def _is_unauthorized_error(error: Any) -> bool:
    if error is None:
        return False
    if (
        (isinstance(error, BaseException) and error_name(error) == "UnauthorizedError")
        or getattr(error, "status", None) == 401
        or getattr(error, "status_code", None) == 401
        or getattr(error, "statusCode", None) == 401
        or getattr(error, "code", None) == 401
    ):
        return True
    message = js_strings.lower(error_message(error)) if isinstance(error, BaseException) else ""
    return any(text in message for text in _UNAUTHORIZED_TEXT)


def _is_unauthorized_result(result: JsonObject) -> bool:
    if not isinstance(result, dict) or result.get("isError") is not True:
        return False
    serialized = js_strings.lower(js_json.stringify(result))
    return any(text in serialized for text in _UNAUTHORIZED_TEXT)


@dataclass
class McpClientRequest:
    """What a client factory needs to open one MCP session."""

    connection_ref: str
    url: str
    headers: dict[str, str]
    #: An ``httpx2.Auth`` (client-credentials OAuth) or ``None``.
    auth: Any
    connect_timeout_ms: int


class McpSession:
    """The session operations the adapter uses (``list_tools`` pages and ``call_tool``)."""

    async def list_tools(self, cursor: str | None) -> JsonObject: ...
    async def call_tool(self, name: str, arguments: JsonObject, meta: JsonObject | None) -> JsonObject: ...


ClientFactory = Callable[[McpClientRequest], Any]


@contextlib.asynccontextmanager
async def default_client_factory(request: McpClientRequest) -> AsyncIterator[McpSession]:
    """An MCP streamable-HTTP session through the official SDK (redirects are not followed)."""
    import httpx2
    from mcp import types
    from mcp.client.session import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    from pydantic import TypeAdapter

    # Results are kept as the server sent them, like the TypeScript SDK's
    # (its schemas pass unknown members through); the typed models validate
    # them but would drop members they do not declare.
    raw_result: Any = TypeAdapter(dict[str, Any])

    async with (
        httpx2.AsyncClient(headers=request.headers, auth=request.auth, follow_redirects=False) as http_client,
        streamable_http_client(request.url, http_client=http_client) as (read_stream, write_stream),
        ClientSession(
            read_stream, write_stream, client_info=types.Implementation(name="agent-runtime", version="0.1.0")
        ) as session,
    ):
        await _with_timeout(session.initialize(), request.connect_timeout_ms, f"Connection {request.connection_ref}")

        class _Session(McpSession):
            async def list_tools(self, cursor: str | None) -> JsonObject:
                params = types.PaginatedRequestParams(cursor=cursor) if cursor else None
                result = await session.send_request(types.ListToolsRequest(params=params), raw_result)
                types.ListToolsResult.model_validate(result)
                return _json_value(result)

            async def call_tool(self, name: str, arguments: JsonObject, meta: JsonObject | None) -> JsonObject:
                result = await session.send_request(
                    types.CallToolRequest(
                        params=types.CallToolRequestParams(name=name, arguments=arguments, _meta=meta)  # pyright: ignore[reportCallIssue, reportArgumentType]
                    ),
                    raw_result,
                )
                # Validated like the TypeScript SDK's callTool. Like it, a session
                # that has not listed the tool does not check structured content
                # against an output schema (the SDK's call_tool would first list
                # the tools again: one extra request per call).
                types.CallToolResult.model_validate(result)
                return _json_value(result)

        yield _Session()


class ConfiguredMcpToolAdapter:
    """Tools of the manifest's connection bindings, namespaced ``<alias>__<tool>``.

    Options (all optional): ``credential_provider`` (``get_credential``,
    ``invalidate_credential``), ``client_factory``, ``authorize_connection``,
    ``verify_tool_metadata``, ``authorize_tool``.
    """

    def __init__(
        self,
        config: JsonObject,
        bindings: list[JsonObject],
        context: ValueResolutionContext | None = None,
        *,
        credential_provider: Any = None,
        client_factory: ClientFactory | None = None,
        authorize_connection: Callable[[JsonObject], Any] | None = None,
        verify_tool_metadata: Callable[[JsonObject], Any] | None = None,
        authorize_tool: Callable[[JsonObject, Any], Any] | None = None,
    ) -> None:
        self._config = config
        self._bindings = bindings
        self._context = context
        self._credential_provider = credential_provider
        self._client_factory = client_factory or default_client_factory
        self._authorize_connection = authorize_connection
        self._verify_tool_metadata = verify_tool_metadata
        self._authorize_tool = authorize_tool
        self._oauth_providers: dict[str, Any] = {}
        self._resolved: dict[str, JsonObject] = {}
        self._excluded: set[str] = set()
        self._unavailable: dict[str, str] = {}

    async def list_tools(self) -> list[JsonObject]:
        tools: list[JsonObject] = []
        resolved: dict[str, JsonObject] = {}
        excluded: set[str] = set()
        unavailable: dict[str, str] = {}
        connections = self._config.get("connections") or {}
        for binding in self._bindings:
            connection = connections.get(binding["ref"])
            if connection is None:
                if binding.get("required") is not False:
                    raise Error(f'Unknown connection "{binding["ref"]}".')
                continue
            alias = binding.get("alias") or binding["ref"]
            try:
                if self._authorize_connection is not None:
                    await _maybe(self._authorize_connection({"binding": binding, "connection": connection}))
                discovered = await self._with_client(
                    binding["ref"],
                    connection,
                    {},
                    False,
                    lambda session, connection=connection, binding=binding: self._list_all(
                        session, connection, f"Connection {binding['ref']} tool discovery"
                    ),
                )
                allowlist = set(_allowed_tool_names(connection, binding, _effective_mode(connection, binding)))
                for tool in discovered:
                    if not tool.get("name") or tool["name"] not in allowlist:
                        continue
                    name = runtime_tool_name(alias, tool["name"])
                    if not await self._verify_tool(binding, connection, tool):
                        excluded.add(name)
                        continue
                    if name in resolved:
                        raise Error(f"Connection tool name collision: {name}. Use a distinct connection alias.")
                    resolved[name] = {
                        "toolName": tool["name"],
                        "connectionName": binding["ref"],
                        "connection": connection,
                        "binding": binding,
                    }
                    entry: JsonObject = {"name": name}
                    if tool.get("description") or tool.get("title"):
                        entry["description"] = (
                            tool["description"] if tool.get("description") is not None else tool.get("title")
                        )
                    entry["inputSchema"] = _input_schema(tool.get("inputSchema"))
                    annotations = tool.get("annotations") or {}
                    entry["metadata"] = {
                        "connection": binding["ref"],
                        "connectionAlias": alias,
                        "sourceTool": tool["name"],
                        "readOnly": annotations.get("readOnlyHint") is True,
                        "destructive": annotations.get("destructiveHint") is True,
                    }
                    tools.append(entry)
            except Exception as error:
                if (
                    isinstance(error, McpToolIntegrityError)
                    or binding.get("required") is True
                    or connection.get("required") is True
                ):
                    raise
                reason = f'Connection "{alias}" is unavailable: {error_message(error)}'
                names: list[str] = connection["tools"]
                with contextlib.suppress(Exception):
                    names = _allowed_tool_names(connection, binding, _effective_mode(connection, binding))
                for tool_name in names:
                    unavailable[runtime_tool_name(alias, tool_name)] = reason
        self._resolved = resolved
        self._excluded = excluded
        self._unavailable = unavailable
        return tools

    def is_tool_excluded(self, name: str) -> bool:
        return name not in self._resolved and name in self._excluded

    def unavailable_tool_reason(self, name: str) -> str | None:
        return None if name in self._resolved else self._unavailable.get(name)

    async def discover_tools(self, connection_ref: str) -> list[JsonObject]:
        """Every tool a connection offers, with digests and allowlist/integrity status (host review)."""
        connection = (self._config.get("connections") or {}).get(connection_ref)
        if connection is None:
            raise Error(f'Unknown connection "{connection_ref}".')
        discovered = await self._with_client(
            connection_ref,
            connection,
            {},
            False,
            lambda session: self._list_all(session, connection, f"Connection {connection_ref} tool discovery"),
        )
        allowed = set(connection["tools"])
        integrity = connection.get("toolIntegrity")
        result: list[JsonObject] = []
        for tool in discovered:
            if not tool.get("name"):
                continue
            metadata = tool_metadata(tool)
            digest = compute_mcp_tool_digest(metadata)
            entry = {**metadata, "digest": digest, "allowed": tool["name"] in allowed}
            if integrity:
                expected = integrity["digests"].get(tool["name"])
                status = "unpinned" if expected is None else "verified" if expected == digest else "mismatch"
                entry["integrity"] = {
                    "status": status,
                    **({"expectedDigest": expected} if expected is not None else {}),
                }
            result.append(entry)
        return result

    async def _verify_tool(self, binding: JsonObject, connection: JsonObject, tool: JsonObject) -> bool:
        integrity = connection.get("toolIntegrity")
        if not integrity and self._verify_tool_metadata is None:
            return True
        metadata = tool_metadata(tool)
        digest = compute_mcp_tool_digest(metadata)
        expected = (integrity or {}).get("digests", {}).get(tool["name"])
        if integrity:
            reason = "unpinned" if expected is None else "mismatch" if expected != digest else None
            if reason is not None:
                error = McpToolIntegrityError(
                    connection_ref=binding["ref"],
                    tool_name=tool["name"],
                    reason=reason,
                    expected_digest=expected,
                    actual_digest=digest,
                    tool=metadata,
                )
                if integrity.get("onFailure", "fail") == "fail":
                    raise error
                return False
        if self._verify_tool_metadata is not None:
            request: JsonObject = {"binding": binding, "connection": connection, "tool": metadata, "digest": digest}
            if expected is not None:
                request["expectedDigest"] = expected
            try:
                await _maybe(self._verify_tool_metadata(request))
            except Exception as cause:
                raise McpToolIntegrityError(
                    connection_ref=binding["ref"],
                    tool_name=tool["name"],
                    reason="rejected",
                    expected_digest=expected,
                    actual_digest=digest,
                    tool=metadata,
                    cause=cause,
                ) from cause
        return True

    async def execute_tool(self, call: JsonObject, context: Any) -> JsonObject:
        if not self._resolved:
            await self.list_tools()
        binding = self._resolved.get(call["name"])
        if binding is None:
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {"code": "tool_not_allowed", "message": f'Tool "{call["name"]}" is not available.'},
            }
        if self._authorize_tool is not None:
            try:
                await _maybe(
                    self._authorize_tool(
                        {
                            "binding": binding["binding"],
                            "connection": binding["connection"],
                            "toolName": binding["toolName"],
                            "call": call,
                        },
                        context,
                    )
                )
            except Exception:
                return {
                    "callId": call["id"],
                    "name": call["name"],
                    "error": {
                        "code": "tool_not_authorized",
                        "message": f'Tool "{call["name"]}" is not authorized for this run.',
                        "retryable": False,
                    },
                }
        execution = {
            "runId": getattr(context, "run_id", None),
            "stepId": getattr(context, "step_id", None),
            "signal": getattr(context, "signal", None),
        }
        idempotency_key = getattr(context, "idempotency_key", None)

        async def operation(session: McpSession) -> JsonObject:
            meta = {"agent-runtime/idempotency-key": idempotency_key} if idempotency_key else None
            result = await _with_timeout(
                session.call_tool(binding["toolName"], call["input"], meta),
                binding["connection"]["toolTimeoutMs"],
                f"Tool {call['name']}",
            )
            if _is_unauthorized_result(result):
                error = Error(f'Connection "{binding["connectionName"]}" is unauthorized.')
                error.name = "UnauthorizedError"
                raise error
            return result

        try:
            result = await self._with_client(
                binding["connectionName"], binding["connection"], execution, False, operation
            )
        except ConnectionAuthorizationRequiredError as error:
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {"code": "connection_authorization_required", "message": error.message, "retryable": False},
            }
        except Exception as error:
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {"code": "mcp_tool_failed", "message": error_message(error), "retryable": True},
            }
        if result.get("isError"):
            return {
                "callId": call["id"],
                "name": call["name"],
                "error": {
                    "code": "mcp_tool_error",
                    "message": f'MCP tool "{call["name"]}" returned an error.',
                    "details": {"result": _json_value(result)},
                },
            }
        return {
            "callId": call["id"],
            "name": call["name"],
            "output": _json_value(result),
            "metadata": {"connection": binding["connectionName"], "sourceTool": binding["toolName"]},
        }

    async def _list_all(self, session: McpSession, connection: JsonObject, label: str) -> list[JsonObject]:
        tools: list[JsonObject] = []
        cursor: str | None = None
        for _ in range(MAXIMUM_TOOL_LIST_PAGES):
            result = await _with_timeout(session.list_tools(cursor), connection["connectTimeoutMs"], label)
            tools.extend(result.get("tools") or [])
            if not result.get("nextCursor"):
                return tools
            cursor = result["nextCursor"]
        raise Error(f"{label} exceeded {MAXIMUM_TOOL_LIST_PAGES} pages.")

    def _client_credentials_auth(self, name: str, connection: JsonObject) -> Any:
        auth = connection.get("auth") or {}
        if auth.get("type") != "client_credentials":
            return None
        if name in self._oauth_providers:
            return self._oauth_providers[name]
        from mcp.client.auth.extensions.client_credentials import ClientCredentialsOAuthProvider
        from mcp.shared.auth import OAuthToken

        class _MemoryTokens:
            def __init__(self) -> None:
                self.tokens: OAuthToken | None = None
                self.client: Any = None

            async def get_tokens(self) -> Any:
                return self.tokens

            async def set_tokens(self, tokens: Any) -> None:
                self.tokens = tokens

            async def get_client_info(self) -> Any:
                return self.client

            async def set_client_info(self, client_info: Any) -> None:
                self.client = client_info

        scopes = auth.get("scopes") or []
        provider = ClientCredentialsOAuthProvider(
            server_url=_assert_url(
                resolve_value_source(connection["url"], self._context, f"Connection {name} URL"), name
            ),
            storage=_MemoryTokens(),
            client_id=resolve_environment_reference(auth["clientId"], self._context, f"Connection {name} client id"),
            client_secret=resolve_environment_reference(
                auth["clientSecret"], self._context, f"Connection {name} client secret"
            ),
            scope=" ".join(scopes) if scopes else None,
        )
        self._oauth_providers[name] = provider
        return provider

    async def _client_request(
        self, name: str, definition: JsonObject, execution: JsonObject, force_refresh: bool
    ) -> McpClientRequest:
        url = _assert_url(resolve_value_source(definition["url"], self._context, f"Connection {name} URL"), name)
        headers = resolve_headers(definition.get("headers"), self._context) or {}
        auth = definition.get("auth") or {}
        if auth.get("type") == "bearer":
            headers["Authorization"] = (
                f"Bearer {resolve_environment_reference(auth['token'], self._context, f'Connection {name}')}"
            )
        elif definition.get("bearerToken"):
            headers["Authorization"] = (
                f"Bearer {resolve_environment_reference(definition['bearerToken'], self._context, f'Connection {name}')}"
            )
        elif auth.get("type") == "oauth":
            if self._credential_provider is None:
                raise Error(f'Connection "{name}" requires a ConnectionCredentialProvider.')
            credential = await self._credential_provider.get_credential(
                _credential_request(name, definition, execution, force_refresh)
            )
            if credential.get("status") == "authorization_required":
                raise ConnectionAuthorizationRequiredError(name, credential.get("authorizationUrl"))
            if credential.get("status") == "unavailable":
                raise Error(credential.get("message") or f'Connection "{name}" credentials are unavailable.')
            headers.update(credential.get("headers") or {})
        return McpClientRequest(
            connection_ref=name,
            url=url,
            headers=headers,
            auth=self._client_credentials_auth(name, definition),
            connect_timeout_ms=definition["connectTimeoutMs"],
        )

    async def _with_client(
        self,
        name: str,
        connection: JsonObject,
        execution: JsonObject,
        force_refresh: bool,
        operation: Callable[[McpSession], Any],
    ) -> Any:
        try:
            request = await self._client_request(name, connection, execution, force_refresh)
            manager = self._client_factory(request)
            session = await _with_timeout(manager.__aenter__(), connection["connectTimeoutMs"], f"Connection {name}")
            try:
                result = await operation(session)
            except BaseException as error:
                with contextlib.suppress(BaseException):
                    await manager.__aexit__(type(error), error, error.__traceback__)
                raise
            with contextlib.suppress(BaseException):
                await manager.__aexit__(None, None, None)
            return result
        except Exception as error:
            if (
                not force_refresh
                and (connection.get("auth") or {}).get("type") == "oauth"
                and _is_unauthorized_error(error)
                and self._credential_provider is not None
            ):
                invalidate = getattr(self._credential_provider, "invalidate_credential", None)
                if invalidate is not None:
                    await _maybe(
                        invalidate({**_credential_request(name, connection, execution, True), "reason": "unauthorized"})
                    )
                return await self._with_client(name, connection, execution, True, operation)
            raise


async def _maybe(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def discover_mcp_connection_tools(
    config: JsonObject,
    connection_ref: str,
    context: ValueResolutionContext | None = None,
    *,
    credential_provider: Any = None,
    client_factory: ClientFactory | None = None,
) -> list[JsonObject]:
    return await ConfiguredMcpToolAdapter(
        config, [], context, credential_provider=credential_provider, client_factory=client_factory
    ).discover_tools(connection_ref)


def create_configured_tool_adapter(
    manifest: JsonObject, config: JsonObject, context: ValueResolutionContext | None = None, **options: Any
) -> ConfiguredMcpToolAdapter | None:
    if not manifest.get("connections"):
        return None
    return ConfiguredMcpToolAdapter(config, manifest["connections"], context, **options)
