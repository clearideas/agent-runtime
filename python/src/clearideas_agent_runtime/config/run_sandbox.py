"""The run sandbox declared by the ``sandbox`` configuration section (``packages/runtime/src/run-sandbox.ts``)."""

from __future__ import annotations

from typing import Any

from .._js.errors import Error
from ..sandbox import BubblewrapSandboxProvider, DockerSandboxProvider, ProviderRunSandbox
from .values import ValueResolutionContext


def create_configured_run_sandbox(
    config: dict[str, Any],
    context: ValueResolutionContext | None = None,
    *,
    sandbox_provider: Any = None,
    authorize_sandbox: Any = None,
    authorize_command: Any = None,
) -> ProviderRunSandbox | None:
    definition = config.get("sandbox")
    if not definition:
        return None
    if definition["driver"] == "docker":
        image = definition["image"]
        provider: Any = DockerSandboxProvider(allowed_images=definition.get("allowedImages") or [image])
    elif definition["driver"] == "bubblewrap":
        image = definition.get("image") or "bubblewrap"
        provider = BubblewrapSandboxProvider(binds=definition.get("binds"))
    else:
        if sandbox_provider is None:
            raise Error(
                "Sandbox driver host requires a SandboxProvider supplied through workspaceOptions.sandboxProvider."
            )
        provider = sandbox_provider
        image = definition.get("image") or "host"
    helper = definition.get("helper") or {}
    source = helper.get("source")
    return ProviderRunSandbox(
        provider=provider,
        image=image,
        helper_command=helper.get("command"),
        helper_source=source["path"] if isinstance(source, dict) else None,
        commands=definition.get("commands"),
        shell=definition.get("shell"),
        limits=definition.get("limits"),
        allowed_environment=definition.get("allowedEnvironment"),
        authorize_sandbox=authorize_sandbox,
        authorize_command=authorize_command,
    )
