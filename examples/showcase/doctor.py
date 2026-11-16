"""
npm run doctor:python [-- --live]   (or: uv run --project ../../python python doctor.py)

Checks this machine for the Python showcase and proves the setup works by
running demos end to end in the real sandbox (the counterpart of doctor.ts).
With --live it also makes three small calls to your model provider to
confirm the key, tool calls, and structured output (this uses a few hundred
tokens).
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import sys
import tempfile
from typing import Any

import httpx
from clearideas_agent_runtime import RUNTIME_VERSION

from lib.environment import pull_docker_image
from lib.live_check import check_live_model
from server import ShowcaseOptions, create_showcase_app

windows = sys.platform == "win32"
failed = False


def ok(text: str) -> None:
    print(f"  ✓ {text}")


def warn(text: str) -> None:
    print(f"  ! {text}")


def fail(text: str, fix: str | None = None) -> None:
    global failed
    failed = True
    print(f"  ✗ {text}")
    if fix:
        print(f"    Fix: {fix}")


def events(messages: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [message["event"] for message in messages if message["kind"] == "event" and message["event"]["type"] == kind]


async def post(client: httpx.AsyncClient, url: str, body: Any) -> list[dict[str, Any]]:
    response = await client.post(url, content=json.dumps(body), timeout=None)
    return [json.loads(line) for line in response.text.split("\n") if line]


def first(messages: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    return next((message for message in messages if message["kind"] == kind), None)


async def check_demos(client: httpx.AsyncClient, base: str) -> None:
    repo = await post(client, f"{base}/repo-mechanic/runs", {"pace": 0})
    error = first(repo, "error")
    result = (first(repo, "result") or {}).get("result")
    commands = len(events(repo, "sandbox.command.completed"))
    opened = events(repo, "sandbox.opened")
    provider = opened[0]["data"]["provider"] if opened else None
    if error:
        fail(
            f"Repo Mechanic failed: {error['error']['message']}", "the terminal output above shows the sandbox's error"
        )
    elif result and json.loads(result["state"]["verification"])["passed"]:
        ok(f"Repo Mechanic: {commands} commands ran in {provider}; the fix synced back and the tests pass")
    else:
        fail("Repo Mechanic ran, but the tests did not pass afterwards")

    paused = await post(client, f"{base}/durable-runs/runs", {"pace": 0})
    run_id = (first(paused, "accepted") or {}).get("runId")
    resumed = (
        await post(
            client,
            f"{base}/durable-runs/runs/{run_id}/resume",
            {"pace": 0, "options": {"decision": "approve", "reviewer": "doctor"}},
        )
        if run_id
        else []
    )
    if first(resumed, "result") and len(events(resumed, "sandbox.opened")) == 1:
        ok("Durable Runs: paused for approval, then resumed with a fresh sandbox and published")
    else:
        problem = first(paused + resumed, "error")
        fail(f"Durable Runs did not complete: {problem['error']['message'] if problem else 'no result'}")

    attack = await post(client, f"{base}/guardrails/runs", {"pace": 0})
    canaries = [message for message in attack if message["kind"] == "canary"]
    if first(attack, "error"):
        fail(f"Guardrails failed: {first(attack, 'error')['error']['message']}")  # type: ignore[index]
    elif canaries and canaries[-1]["hit"] is False:
        ok("Guardrails: the sandbox blocked a script's network access")
    else:
        warn("Guardrails: a script reached the network (expected without an isolated sandbox)")

    catalog = (await client.get(base)).json()
    investigation = next((entry for entry in catalog if entry["id"] == "long-investigation"), None)
    if investigation and investigation["status"] == "unavailable":
        warn(f"Long Investigation is unavailable: {investigation['unavailable']}")
    else:
        run = await post(client, f"{base}/long-investigation/runs", {"pace": 0, "options": {"strategy": "prune"}})
        findings = (((first(run, "result") or {}).get("result") or {}).get("state") or {}).get("findings") or {}
        reductions = len(events(run, "context.reduced"))
        if findings.get("filesRead") == 16:
            ok(f"Long Investigation: read all 16 logs inside the 40 KB input limit ({reductions} context reductions)")
        else:
            problem = first(run, "error")
            fail(f"Long Investigation did not complete: {problem['error']['message'] if problem else 'no result'}")


async def main() -> int:
    print("\nAgent Runtime showcase doctor (Python)\n")

    # ─── Python ──────────────────────────────────────────────────────────────
    print("Python")
    # The runtime requires Python 3.11 or newer; it could not be imported otherwise.
    ok(f"Python {sys.version.split()[0]}, Agent Runtime for Python {RUNTIME_VERSION}")

    # ─── Sandbox ─────────────────────────────────────────────────────────────
    print("\nSandbox")
    data_directory = tempfile.mkdtemp(prefix="showcase-doctor-")
    # The doctor is one local client, even when the host image defaults to
    # per-visitor HTTP sessions. Its approval/resume requests share this store.
    app = await create_showcase_app(
        ShowcaseOptions(sessions=False, host="127.0.0.1", port=0, data_directory=data_directory)
    )
    sandbox, live = app.environment["sandbox"], app.environment["live"]
    for note in sandbox["notes"]:
        warn(note)
    if sandbox["isolated"]:
        ok(f"{sandbox['kind']} is available and isolated")
    elif sandbox["kind"] == "unisolated":
        fail(
            "no isolated sandbox; only the unisolated demo fallback is available",
            "install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/), start it, use Linux containers, then run this again"
            if windows
            else "start Docker, or on Linux install bubblewrap (sudo apt-get install bubblewrap)",
        )
    else:
        fail("no sandbox is available", "install and start Docker Desktop, then run this again")

    if sandbox["kind"] == "docker":
        if sandbox.get("imagePresent"):
            ok(f"image {sandbox['image']} is present")
        else:
            print(f"    Pulling {sandbox['image']} (first run only)…")
            if pull_docker_image(sandbox["image"]):
                ok(f"pulled {sandbox['image']}")
            else:
                fail(
                    f"could not pull {sandbox['image']}",
                    f"check your connection, then run: docker pull {sandbox['image']}",
                )

    # ─── End-to-end runs in the sandbox ──────────────────────────────────────
    if sandbox["kind"] != "none":
        print(f"\nDemos in the {sandbox['kind']} sandbox (scripted model)")
        _, port = await app.listen()
        try:
            async with httpx.AsyncClient() as client:
                await check_demos(client, f"http://127.0.0.1:{port}/api/demos")
        except Exception as error:
            fail(f"the demos could not run: {error}")
    await app.close()
    shutil.rmtree(data_directory, ignore_errors=True)

    # ─── Live model ──────────────────────────────────────────────────────────
    print("\nLive model")
    set_key = '$env:OPENAI_API_KEY = "sk-…"' if windows else 'export OPENAI_API_KEY="sk-…"'
    if not live["available"]:
        warn(live["reason"])
        print(f"    Live mode is optional. To use OpenAI: {set_key}, then restart.")
        print(
            "    Another provider: set SHOWCASE_PROVIDER (anthropic, google, xai, groq, cohere), SHOWCASE_MODEL, and that provider's key."
        )
    elif "--live" not in sys.argv:
        ok(f"configured for {live['provider']}/{live['model']}")
        print("    Run `npm run doctor:python -- --live` to make three small real calls and confirm the key and model.")
    else:
        check = await check_live_model(provider=live["provider"], model=live["model"])
        name = f"{live['provider']}/{live['model']}"
        if check.error:
            fail(
                f"the {name} call failed: {check.error[:300]}",
                "check the API key"
                if re.search(r"401|auth|api key", check.error, re.IGNORECASE)
                else "set SHOWCASE_MODEL to a model your account can use"
                if re.search(r"model", check.error, re.IGNORECASE)
                else "check your network and provider settings",
            )
        else:
            for line in check.lines:
                if line["ok"]:
                    ok(f"{name} {line['text']}")
                else:
                    fail(
                        f"{name} {line['text']}",
                        "the demos need tool calls and structured output; try another SHOWCASE_MODEL",
                    )
            if check.total_tokens:
                print(f"    ({check.total_tokens} tokens)")

    print(
        "\nSome checks failed. Fix them and run `npm run doctor:python` again.\n"
        if failed
        else "\nAll set. Start the Python showcase with `npm run start:python`.\n"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
