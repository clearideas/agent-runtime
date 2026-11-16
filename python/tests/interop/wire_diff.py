"""Shows where the two runtimes differ for provider-wire cases (requests and results).

    uv run python -m tests.interop.wire_diff [driver] [case]

Without arguments every case runs; only differing cases are printed.
"""

from __future__ import annotations

import difflib
import json
import sys
from typing import Any

from .test_provider_wire import ALL_CASES, exchange, model_output, normalize


def _diff(label: str, expected: Any, actual: Any) -> str | None:
    left = json.dumps(expected, indent=2, sort_keys=True).splitlines()
    right = json.dumps(actual, indent=2, sort_keys=True).splitlines()
    if left == right:
        return None
    return "\n".join(difflib.unified_diff(left, right, f"typescript {label}", f"python {label}", lineterm="", n=4))


def main(argv: list[str]) -> int:
    cases = [
        (driver, name)
        for driver, name in ALL_CASES
        if (len(argv) < 1 or driver == argv[0]) and (len(argv) < 2 or name == argv[1])
    ]
    differing = 0
    for case_id, (ts, py, ts_requests, py_requests) in exchange(cases).items():
        driver = case_id.split("|", 1)[0]
        if case_id.split("|", 1)[1].startswith("error-"):
            errors = (ts.get("ok"), py.get("ok"), ts.get("error"), py.get("error"))
            expected = {key: value for key, value in (ts.get("error") or {}).items() if value is not None}
            actual = {key: value for key, value in (py.get("error") or {}).items() if value is not None}
            if errors[0] or errors[1] or expected != actual or len(ts_requests or []) != len(py_requests or []):
                differing += 1
                print(f"== {case_id}: errors differ\n{ts}\n{py}\n")
            continue
        if not ts.get("ok") or not py.get("ok") or not ts_requests or not py_requests:
            differing += 1
            print(f"== {case_id}: TypeScript ok={ts.get('ok')} / Python ok={py.get('ok')}\n{ts}\n{py}\n")
            continue
        path = ts_requests[0]["path"]
        diffs = [
            _diff(
                "request",
                normalize(driver, path, ts_requests[0]["body"]),
                normalize(driver, path, py_requests[0]["body"]),
            ),
            _diff("result", model_output(ts, driver), model_output(py, driver)),
        ]
        shown = [diff for diff in diffs if diff]
        if shown:
            differing += 1
            print(f"== {case_id}\n" + "\n".join(shown) + "\n")
    print(f"{differing} of {len(cases)} cases differ")
    return 1 if differing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
