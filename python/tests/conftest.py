"""Suite-wide settings.

``make test`` sets ``AGENT_RUNTIME_STRICT=1``: a test that would be skipped
(for example because bubblewrap cannot create user namespaces, or Node.js is
missing) fails instead, so a green run means every test ran. Run
``make test STRICT=0`` on a platform that cannot provide a prerequisite; the
skip reasons are still listed in the summary.
"""

from __future__ import annotations

import os

import pytest

STRICT = os.environ.get("AGENT_RUNTIME_STRICT") == "1"


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo) -> object:
    outcome = yield
    report = outcome.get_result()  # type: ignore[attr-defined]
    if STRICT and report.skipped and not hasattr(report, "wasxfail"):
        reason = report.longrepr[2] if isinstance(report.longrepr, tuple) else str(report.longrepr)
        report.outcome = "failed"
        report.longrepr = (
            f"{reason}\n"
            "Strict mode (AGENT_RUNTIME_STRICT=1, set by `make test`) requires every test to run. "
            "Install the missing prerequisite, or run `make test STRICT=0` to allow skips."
        )
