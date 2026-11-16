"""Modal sandboxes through an injected gateway (``@clearideas/agent-runtime-sandbox-modal``).

The gateway (``create``, ``put_files``, ``execute``, ``list_files``,
``read_file``, ``terminate``) is supplied by the host, for example over the
``modal`` SDK; this provider maps the neutral lifecycle onto it.
"""

from __future__ import annotations

from typing import Any

from .._js import strings as js_strings
from .._js import time as js_time
from .._js.abort import AbortSignal
from .._js.errors import Error
from .contracts import assert_sandbox_path

JsonObject = dict[str, Any]


class ModalSandboxProvider:
    def __init__(self, gateway: Any, name: str = "modal") -> None:
        self._gateway = gateway
        self.name = name

    async def create(self, spec: JsonObject, signal: AbortSignal | None = None) -> JsonObject:
        created = await self._gateway.create(spec, signal=signal)
        if not js_strings.trim(created["sandboxId"]):
            raise Error("Modal returned an empty sandbox ID.")
        return {
            "id": created["sandboxId"],
            "provider": self.name,
            "createdAt": js_time.to_iso(js_time.now()),
            "providerData": {"sandboxId": created["sandboxId"], **(created.get("metadata") or {})},
        }

    async def put_files(self, handle: JsonObject, files: list[JsonObject], signal: AbortSignal | None = None) -> None:
        for file in files:
            assert_sandbox_path(file["path"])
        await self._gateway.put_files(self._id(handle), files, signal=signal)

    def execute(self, handle: JsonObject, command: JsonObject, signal: AbortSignal | None = None) -> Any:
        if command.get("cwd"):
            assert_sandbox_path(command["cwd"])
        return self._gateway.execute(self._id(handle), command, signal=signal)

    async def list_files(
        self, handle: JsonObject, directory: str, signal: AbortSignal | None = None
    ) -> list[JsonObject]:
        return await self._gateway.list_files(self._id(handle), assert_sandbox_path(directory), signal=signal)

    async def read_file(self, handle: JsonObject, path: str, signal: AbortSignal | None = None) -> bytes:
        return await self._gateway.read_file(self._id(handle), assert_sandbox_path(path), signal=signal)

    async def terminate(self, handle: JsonObject) -> None:
        await self._gateway.terminate(self._id(handle))

    def _id(self, handle: JsonObject) -> str:
        sandbox_id = (handle.get("providerData") or {}).get("sandboxId")
        if handle.get("provider") != self.name or not isinstance(sandbox_id, str):
            raise Error("Sandbox handle does not belong to ModalSandboxProvider.")
        return sandbox_id
