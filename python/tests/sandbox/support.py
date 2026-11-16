"""Shared doubles for sandbox tests."""

from __future__ import annotations

from typing import Any

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.core.ports import ResolvedWorkspace


class MemoryStore:
    """Minimal in-memory workspace store with the local stores' contract."""

    def __init__(self, mode: str, initial: dict[str, str] | None = None) -> None:
        self.mode = mode
        self.files: dict[str, bytes] = {key: value.encode("utf-8") for key, value in (initial or {}).items()}
        self.limits = {"maxFiles": 50, "maxFileBytes": 4096, "maxTotalBytes": 1_000_000}
        self.writes: list[str] = []
        self.deletes: list[str] = []
        self.fail_writes = False

    async def entries(self, signal: Any = None) -> list[dict]:
        return [{"path": path, "size": len(data)} for path, data in sorted(self.files.items())]

    async def read(self, path: str, signal: Any = None) -> bytes:
        if path not in self.files:
            raise Error(f"missing {path}")
        return self.files[path]

    async def write(self, path: str, data: bytes, signal: Any = None) -> dict:
        if self.fail_writes:
            raise Error("store rejected")
        self.writes.append(path)
        self.files[path] = bytes(data)
        return {"path": path, "size": len(data)}

    async def delete(self, path: str, signal: Any = None) -> None:
        self.deletes.append(path)
        self.files.pop(path, None)

    def text(self, path: str) -> str | None:
        data = self.files.get(path)
        return data.decode("utf-8") if data is not None else None


class MemoryArtifacts:
    def __init__(self) -> None:
        self.items: list[dict] = []

    async def put(self, item: dict) -> dict:
        self.items.append(item)
        return {"id": f"artifact-{len(self.items)}", "name": item["name"], "mediaType": item["mediaType"]}

    async def get(self, ref: dict) -> dict:
        raise Error("not used")


def resolved(alias: str, store: Any, tools: list[str] | None = None) -> ResolvedWorkspace:
    binding: dict = {"ref": f"{alias}-ref", "alias": alias}
    if tools:
        binding["tools"] = tools
    return ResolvedWorkspace(binding=binding, alias=alias, mode=store.mode, store=store)


async def open_session(run_sandbox: Any, workspaces: list[ResolvedWorkspace], **extra: Any) -> tuple[Any, list[dict]]:
    events: list[dict] = []

    async def emit(type: str, data: dict | None = None, step_id: str | None = None) -> dict:
        event: dict = {"id": f"event-{len(events) + 1}", "runId": "run-1", "sequence": len(events) + 1, "type": type}
        if step_id:
            event["stepId"] = step_id
        if data is not None:
            event["data"] = data
        events.append(event)
        return event

    request = {"runId": "run-1", "attempt": 1, "workspaces": workspaces, "emit": emit, **extra}
    await run_sandbox.validate(request)
    return await run_sandbox.open(request), events
