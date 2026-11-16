"""The Python showcase's host helpers: formatting, documents, hosting, and policy."""

from __future__ import annotations

from pathlib import Path

import pytest
from clearideas_agent_runtime import parse_agent_runtime_config

from lib.browser_analytics import resolve_browser_analytics
from lib.docx import read_docx
from lib.environment import apply_sandbox_choice, assert_mode_allowed
from lib.hosting import create_session_resolver, parse_origin
from lib.js import from_base64, round_half_up, to_fixed, to_locale_string
from lib.live_check import check_live_model
from lib.scripted_model import ScriptedModelAdapter

SHOWCASE = Path(__file__).resolve().parent.parent


def test_javascript_number_formatting() -> None:
    # Values printed by Node for the same calls.
    assert [to_fixed(value, 1) for value in (7.857142857142857, 0.25, -0.04, 1.005, -12.35, 0)] == [
        "7.9",
        "0.3",
        "-0.0",
        "1.0",
        "-12.3",
        "0.0",
    ]
    assert to_fixed(1.005, 2) == "1.00"
    assert [to_locale_string(value) for value in (420000, 1234.5678, 0.1, 1e6, 12.0005)] == [
        "420,000",
        "1,234.568",
        "0.1",
        "1,000,000",
        "12.001",
    ]


def test_javascript_rounding_and_base64() -> None:
    # Math.round and Buffer.from(text, "base64"), as Node evaluates them.
    assert [round_half_up(value) for value in (2.5, -2.5, 0.49999999999999994, 1.4, -1.6)] == [3, -2, 0, 1, -2]
    assert [from_base64(text) for text in ("aGVsbG8=", "aGVs bG8", "aGVsbG8=extra", "_-8", "a")] == [
        b"hello",
        b"hello",
        b"hello",
        b"\xff\xef",
        b"",
    ]


def test_reads_the_sample_word_document() -> None:
    blocks = read_docx((SHOWCASE / "demos/document-chat/fixture/proposal.docx").read_bytes())
    assert blocks[0] == {"type": "paragraph", "style": "Title", "text": "Proposal: one shared review workspace"}
    table = next(block for block in blocks if block["type"] == "table")
    assert any("Two days of one administrator" in " | ".join(row) for row in table["rows"])
    with pytest.raises(ValueError):
        read_docx(b"plain text")


def test_browser_analytics_is_off_unless_both_settings_are_configured() -> None:
    assert resolve_browser_analytics(None, {}) == {"enabled": False}
    assert resolve_browser_analytics(False, {"SHOWCASE_ANALYTICS_SITE_KEY": "demo"}) == {"enabled": False}
    with pytest.raises(ValueError):
        resolve_browser_analytics(None, {"SHOWCASE_ANALYTICS_SITE_KEY": "demo"})
    for url in ("javascript:alert(1)", "https://user:secret@collector.example", "https://collector.example?token=x"):
        with pytest.raises(ValueError):
            resolve_browser_analytics({"apiBaseUrl": url, "siteKey": "demo"}, {})
    assert resolve_browser_analytics(
        {"apiBaseUrl": "https://collector.example/api/", "siteKey": "runtime-demo"}, {}
    ) == {
        "enabled": True,
        "apiBaseUrl": "https://collector.example/api",
        "siteKey": "runtime-demo",
    }


def test_origins_and_signed_sessions(tmp_path: Path) -> None:
    assert parse_origin("https://docs.example.com") == "https://docs.example.com"
    for origin in ("https://example.com/path", "https://user:password@example.com", "javascript:alert(1)"):
        with pytest.raises(ValueError):
            parse_origin(origin)
    resolve = create_session_resolver(str(tmp_path))
    session, cookie = resolve(None, True)
    assert cookie is not None and "SameSite=None; Secure; Partitioned" in cookie
    assert resolve(cookie.split(";")[0], True) == (session, None)
    forged = f"showcase_session={session}.{'0' * 64}"
    assert resolve(forged, False)[0] != session


def environment(kind: str, live: bool = True) -> dict:
    return {
        "sandbox": {"kind": kind, "isolated": kind in ("bubblewrap", "docker"), "detail": "", "notes": []},
        "python": "Python 3",
        "live": {
            "available": live,
            "reason": "openai/gpt-6-luna" if live else "Set OPENAI_API_KEY",
            "provider": "openai",
            "model": "gpt-6-luna",
        },
        "loopback": True,
    }


def test_mode_policy_and_sandbox_substitution() -> None:
    with pytest.raises(RuntimeError, match="No sandbox"):
        assert_mode_allowed(environment("none"), "scripted")
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        assert_mode_allowed(environment("bubblewrap", False), "live")
    assert_mode_allowed(environment("unisolated", False), "scripted")

    config = parse_agent_runtime_config(
        {"version": "1.0", "sandbox": {"driver": "bubblewrap", "commands": {"t": {"argv": ["true"]}}}}
    )
    docker, provider = apply_sandbox_choice(
        config, {"kind": "docker", "isolated": True, "image": "python:3.12-slim", "detail": "", "notes": []}
    )
    assert docker["sandbox"]["driver"] == "docker"
    assert docker["sandbox"]["image"] == "python:3.12-slim"
    assert list(docker["sandbox"]["commands"]) == ["t"]
    assert provider is None
    fallback, provider = apply_sandbox_choice(
        config, {"kind": "unisolated", "isolated": False, "detail": "", "notes": []}
    )
    assert fallback["sandbox"]["driver"] == "host"
    assert provider is not None


async def test_the_live_check_reports_each_capability() -> None:
    def script(request):  # type: ignore[no-untyped-def]
        if request.structured:
            return {"output": {"code": "AR-0600-OK"}}
        if request.turn == 0:
            return {"call": {"name": "lookup_code", "input": {}}}
        return {"output": request.results[0]["output"]["code"]}

    check = await check_live_model(provider="openai", model="test", model_adapter=ScriptedModelAdapter(script, pace=0))
    assert check.error is None
    assert [line["ok"] for line in check.lines] == [True, True]

    lazy = await check_live_model(
        provider="openai",
        model="test",
        model_adapter=ScriptedModelAdapter(
            lambda request: {"output": {"code": "none"} if request.structured else "AR-0600-OK"}, pace=0
        ),
    )
    assert lazy.ok is False
    assert "without calling the tool" in lazy.lines[0]["text"]
