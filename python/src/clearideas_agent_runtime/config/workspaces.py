"""Configured workspace stores (``packages/runtime/src/workspaces.ts``)."""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from .._js import json as js_json
from .._js.errors import Error
from ..stores.local.workspaces import LocalDirectoryWorkspace
from .values import ValueResolutionContext, resolve_value_source

JsonObject = dict[str, Any]


class _WithoutAttachment:
    """Hides provider-native attachment for definitions that require staged copies."""

    def __init__(self, store: Any) -> None:
        self._store = store
        self.mode = store.mode
        if getattr(store, "limits", None) is not None:
            self.limits = store.limits
        if getattr(store, "write", None) is not None:
            self.write = store.write
        if getattr(store, "delete", None) is not None:
            self.delete = store.delete

    async def entries(self, signal: Any = None) -> list[JsonObject]:
        return await self._store.entries(signal=signal)

    async def read(self, path: str, signal: Any = None) -> bytes:
        return await self._store.read(path, signal=signal)


def _without_attachment(store: Any) -> Any:
    return _WithoutAttachment(store) if getattr(store, "attachable", None) is not None else store


class ConfiguredWorkspaceProvider:
    """Resolves manifest bindings against the configuration's ``workspaces`` (one store per name)."""

    def __init__(
        self,
        config: JsonObject,
        context: ValueResolutionContext | None = None,
        *,
        base_directory: str | None = None,
        create_workspace: Callable[[str, JsonObject, ValueResolutionContext | None], Any] | None = None,
    ) -> None:
        self._config = config
        self._context = context
        self._base_directory = base_directory
        self._create_workspace = create_workspace
        self._stores: dict[str, Any] = {}

    def definition(self, ref: str) -> JsonObject | None:
        return (self._config.get("workspaces") or {}).get(ref)

    async def resolve_workspace(self, binding: JsonObject, context: Any = None) -> Any:
        definition = self.definition(binding["ref"])
        if definition is None:
            return None
        if binding["ref"] in self._stores:
            return self._stores[binding["ref"]]
        created = self._create_workspace(binding["ref"], definition, self._context) if self._create_workspace else None
        if created is None and definition["driver"] == "local":
            created = self._create_local(binding["ref"], definition)
        if created is None:
            raise Error(f'Workspace "{binding["ref"]}" uses driver host and requires a store from the host.')
        if created.mode == "read" and definition.get("mode") == "read_write":
            raise Error(f'Workspace "{binding["ref"]}" store is read-only but the configuration declares read_write.')
        store = _without_attachment(created) if definition.get("attach") == "never" else created
        self._stores[binding["ref"]] = store
        return store

    def _create_local(self, name: str, definition: JsonObject) -> LocalDirectoryWorkspace:
        root = os.path.normpath(
            os.path.join(
                self._base_directory or os.getcwd(),
                resolve_value_source(definition["root"], self._context, f"Workspace {name} root"),
            )
        )
        return LocalDirectoryWorkspace(
            root=root,
            mode=definition["mode"],
            attach=definition["attach"],
            include=definition.get("include"),
            exclude=definition.get("exclude"),
            max_files=definition.get("maxFiles") or None,
            max_file_bytes=definition.get("maxFileBytes") or None,
            max_total_bytes=definition.get("maxTotalBytes") or None,
        )


def create_configured_workspace_provider(
    config: JsonObject, context: ValueResolutionContext | None = None, **options: Any
) -> ConfiguredWorkspaceProvider | None:
    if not js_json.js_keys(config.get("workspaces") or {}):
        return None
    return ConfiguredWorkspaceProvider(config, context, **options)
