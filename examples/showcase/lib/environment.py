"""
Decides which sandbox the showcase runs workspace commands in, and which
model modes are allowed with it (``lib/environment.ts``).

  bubblewrap  Linux namespaces, no daemon. Isolated.
  docker      A container per run. Isolated.
  unisolated  DEMO FALLBACK ONLY. Commands run as ordinary host processes in
              a temporary directory (the package's test-only provider). It is
              offered only with the scripted model on a loopback address so
              the demos work on any laptop, and the UI says so loudly.

Production hosts choose a sandbox in their configuration file and never fall
back; this module exists because a demo should start everywhere.
"""

from __future__ import annotations

import os
import subprocess
import sys
from typing import Any

from clearideas_agent_runtime import BubblewrapSandboxProvider, parse_agent_runtime_config

from .unisolated_provider import UnisolatedDemoProvider


def _run(command: str, args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            [command, *args], capture_output=True, text=True, timeout=8, stdin=subprocess.DEVNULL, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def docker_image_present(image: str) -> bool:
    return _run("docker", ["image", "inspect", "--format", "{{.Id}}", image]) is not None


def pull_docker_image(image: str) -> bool:
    """Pull the sandbox image, showing Docker's progress."""
    try:
        return subprocess.run(["docker", "pull", image], check=False).returncode == 0
    except OSError:
        return False


def _is_loopback(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1")


PROVIDER_KEYS = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_GENERATIVE_AI_API_KEY",
    "xai": "XAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "cohere": "COHERE_API_KEY",
}


async def detect_environment(
    *,
    host: str,
    preference: str | None = None,
    docker_image: str | None = None,
    live_provider: str | None = None,
    live_model: str | None = None,
) -> dict[str, Any]:
    """The sandbox and model modes this machine supports, as the browser sees them."""
    preference = preference or "auto"
    python = _run("python3", ["--version"])
    # The real interpreter behind `python3`. Shims (pyenv, asdf) and the macOS
    # developer-tools stub need variables such as HOME that sandboxes strip.
    python_executable = _run("python3", ["-c", "import sys; print(sys.executable)"]) if python else None
    notes: list[str] = []
    sandbox: dict[str, Any] | None = None

    if preference in ("auto", "bubblewrap"):
        if not sys.platform.startswith("linux"):
            notes.append("bubblewrap requires Linux.")
        elif not python:
            notes.append("bubblewrap needs python3 on the host for the file helper.")
        else:
            try:
                await BubblewrapSandboxProvider().probe()
                sandbox = {
                    "kind": "bubblewrap",
                    "isolated": True,
                    "detail": "bubblewrap: separate user, PID, IPC, and network namespaces; no capabilities; read-only system binds.",
                    "notes": [],
                }
            except Exception as error:
                notes.append(f"bubblewrap unavailable: {error}")

    if sandbox is None and preference in ("auto", "docker"):
        # `docker info` fails when the CLI is missing or the daemon (Docker
        # Desktop on Windows and macOS) is not running.
        os_type = _run("docker", ["info", "--format", "{{.OSType}}"])
        image = docker_image or "python:3.12-slim"
        if not os_type:
            notes.append(
                "Docker is not reachable. Start Docker Desktop (or the Docker daemon) and wait until it reports that it is running, then restart the showcase."
            )
        elif os_type != "linux":
            notes.append(
                f"Docker is running {os_type} containers. Switch Docker Desktop to Linux containers (right-click the Docker icon > Switch to Linux containers)."
            )
        else:
            sandbox = {
                "kind": "docker",
                "isolated": True,
                "image": image,
                "imagePresent": docker_image_present(image),
                "detail": f"Docker ({image}): no network, read-only root filesystem, resource limits.",
                "notes": [],
            }

    if sandbox is None and preference in ("auto", "unisolated"):
        if not python:
            notes.append("The unisolated fallback also needs python3 on the host.")
        elif not _is_loopback(host):
            notes.append("The unisolated fallback is only offered on a loopback address.")
        else:
            sandbox = {
                "kind": "unisolated",
                "isolated": False,
                **({"python": python_executable} if python_executable else {}),
                "detail": "NOT ISOLATED: commands run as ordinary host processes in a temporary directory.",
                "notes": [],
            }

    if sandbox is None:
        sandbox = {
            "kind": "none",
            "isolated": False,
            "detail": "No sandbox available; workspace demos cannot run.",
            "notes": [],
        }
    sandbox["notes"] = notes

    provider = live_provider or "openai"
    model = live_model or "gpt-6-luna"
    key_name = PROVIDER_KEYS.get(provider)
    has_key = bool(os.environ.get(key_name)) if key_name else True
    if not sandbox["isolated"]:
        live = {"available": False, "reason": "Live models require an isolated sandbox (bubblewrap or Docker)."}
    elif not has_key:
        live = {
            "available": False,
            "reason": f'Set {key_name} to enable live models (PowerShell: $env:{key_name} = "…", then restart).'
            if sys.platform == "win32"
            else f'Set {key_name} to enable live models (export {key_name}="…", then restart).',
        }
    else:
        live = {"available": True, "reason": f"{provider}/{model}"}

    environment: dict[str, Any] = {"sandbox": sandbox}
    if python is not None:
        environment["python"] = python
    environment["live"] = {**live, "provider": provider, "model": model}
    environment["loopback"] = _is_loopback(host)
    return environment


def apply_sandbox_choice(config: dict[str, Any], choice: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    """
    Apply the detected sandbox to a configuration loaded from YAML. The YAML
    files declare `driver: bubblewrap`, which is what a Linux host would ship;
    this swaps in Docker or the demo fallback when bubblewrap is unavailable.

    Returns the configuration and, for the fallback, the sandbox provider.
    """
    if not config.get("sandbox") or choice["kind"] == "bubblewrap":
        return config, None
    if choice["kind"] == "docker":
        return (
            parse_agent_runtime_config(
                {
                    **config,
                    "sandbox": {
                        **config["sandbox"],
                        "driver": "docker",
                        "image": choice["image"],
                        "allowedImages": [choice["image"]],
                    },
                }
            ),
            None,
        )
    if choice["kind"] == "unisolated":
        return (
            parse_agent_runtime_config(
                {**config, "sandbox": {**config["sandbox"], "driver": "host", "image": "unisolated"}}
            ),
            UnisolatedDemoProvider(choice.get("python")),
        )
    raise RuntimeError(choice["detail"])


def assert_mode_allowed(environment: dict[str, Any], mode: str) -> None:
    """Enforce the mode policy for one run request."""
    if environment["sandbox"]["kind"] == "none":
        raise RuntimeError(f"No sandbox is available. {' '.join(environment['sandbox']['notes'])}")
    if mode == "live" and not environment["live"]["available"]:
        raise RuntimeError(environment["live"]["reason"])
