"""
Scripted model decisions for Repo Mechanic (Python edition of script.ts).

Nothing here touches files or runs tests: the script only *asks* for tool
calls. Agent Runtime executes them in the run sandbox, and every branch below
is chosen from the real results it returns — failing test names, search
matches, file contents, and host-policy denials.
"""

from __future__ import annotations

import re
from typing import Any

from lib import js
from lib.scripted_model import ScriptRequest, ScriptTurn, last_result, output_of

BUGGY = re.compile(r"^(\s*)discounted = subtotal - discount_rate\s*$", re.MULTILINE)
FIXED_LINE = "discounted = subtotal * (1 - discount_rate)"


def summarize_tests(output: dict[str, Any] | None) -> dict[str, Any]:
    """Summarize unittest output the way an engineer would read it."""
    text = f"{(output or {}).get('stdout', '')}\n{(output or {}).get('stderr', '')}"
    ran = re.search(r"Ran (\d+) tests?", text)
    failing = re.findall(r"^(?:FAIL|ERROR): (\w+)", text, re.MULTILINE | re.ASCII)
    return {
        "ran": int(ran[1]) if ran else 0,
        "failing": failing,
        "passed": output is not None and output.get("exitCode") == 0,
    }


def investigate(request: ScriptRequest) -> ScriptTurn:
    if request.turn == 0:
        return {
            "say": "Let me get oriented in the repository first.",
            "call": {"name": "repo__list_files", "input": {}},
        }
    if request.turn == 1:
        files = (output_of(last_result(request)) or {}).get("files") or []
        return {
            "say": f"The workspace exposes {len(files)} files. Reproducing the report with the test suite.",
            "call": {"name": "repo__run_tests", "input": {}},
        }
    if request.turn == 2:
        tests = summarize_tests(output_of(last_result(request)))
        if tests["passed"]:
            return {
                "output": {
                    "status": "healthy",
                    "summary": f"All {tests['ran']} tests pass; the reported behaviour no longer reproduces.",
                    "file": "",
                    "failingTests": [],
                }
            }
        return {
            "say": f"{len(tests['failing'])} of {tests['ran']} tests fail: {', '.join(tests['failing'])}. Both involve discounts, so I'll search the source for discount_rate.",
            "call": {"name": "repo__search_files", "input": {"query": "discount_rate", "glob": "src/**"}},
        }
    if request.turn == 3:
        matches = (output_of(last_result(request)) or {}).get("matches") or []
        suspect = next((match for match in matches if "- discount_rate" in match["text"]), None) or (
            matches[0] if matches else None
        )
        if suspect is None:
            return {
                "output": {
                    "status": "bug",
                    "summary": "Tests fail, but no discount logic was found in src/.",
                    "file": "",
                    "failingTests": [],
                }
            }
        return {
            "say": f"Line {suspect['line']} of {suspect['path']} looks wrong: `{suspect['text'].strip()}`. Reading the function to confirm.",
            "call": {"name": "repo__read_file", "input": {"path": suspect["path"]}},
        }
    read = output_of(last_result(request))
    tests = summarize_tests(output_of(request.results[1]))
    return {
        "output": {
            "status": "bug",
            "summary": "invoice_total subtracts discount_rate (a fraction such as 0.10) from the subtotal instead of reducing the subtotal by that percentage.",
            "file": (read or {}).get("path") or "src/invoice.py",
            "failingTests": tests["failing"],
        }
    }


def fix(request: ScriptRequest) -> ScriptTurn:
    found = re.search(r"File: (\S+)", request.prompt)
    file = found[1] if found else "src/invoice.py"
    if request.turn == 0:
        return {
            "say": f"Opening {file} to make the smallest correct change.",
            "call": {"name": "repo__read_file", "input": {"path": file}},
        }
    if request.turn == 1:
        read = output_of(last_result(request))
        if not read or not BUGGY.search(read["content"]):
            return {"output": f"I could not find the faulty discount line in {file}; no change was made."}
        # Replace only the faulty expression; keep the file's line endings.
        content = read["content"].replace("subtotal - discount_rate", "subtotal * (1 - discount_rate)", 1)
        return {
            "say": "Replacing the subtraction with a percentage reduction and writing the file.",
            "call": {
                "name": "repo__write_file",
                # read_file returns lines without the final newline; keep it.
                "input": {"path": file, "content": content if content.endswith("\n") else f"{content}\n"},
            },
        }
    if request.turn == 2:
        write = last_result(request)
        if write is not None and write.get("error"):
            return {
                "output": "\n".join(
                    [
                        f"**The host denied the write** (`{write['error']['code']}`): {write['error']['message']}",
                        "",
                        f"Proposed change to `{file}`, not applied:",
                        "",
                        "```diff",
                        "-    discounted = subtotal - discount_rate",
                        f"+    {FIXED_LINE}",
                        "```",
                    ]
                )
            }
        return {
            "say": "Written. Rerunning the test suite to confirm.",
            "call": {"name": "repo__run_tests", "input": {}},
        }
    tests = summarize_tests(output_of(last_result(request)))
    return {
        "output": f"Changed `{file}` to apply the discount as a percentage (`{FIXED_LINE}`). All {tests['ran']} tests now pass."
        if tests["passed"]
        else f"Changed `{file}`, but {len(tests['failing'])} tests still fail: {', '.join(tests['failing'])}."
    }


def json_after(text: str, label: str) -> dict[str, Any]:
    match = re.search(rf"{label}:\s*(\{{[^\n]*\}})", text)
    try:
        value = js.parse(match[1]) if match else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def report(request: ScriptRequest) -> ScriptTurn:
    diagnosis = json_after(request.prompt, "Diagnosis")
    verification = json_after(request.prompt, "Independent verification")
    found = re.search(r"Fix notes:\s*([\s\S]*?)\nIndependent verification:", request.prompt)
    notes = found[1].strip() if found else None
    denied = notes is not None and "host denied the write" in notes
    tests_run = verification.get("testsRun") or 0
    failed = verification["failed"] if isinstance(verification.get("failed"), list) else []
    evidence = (
        f"Independent verification in the run sandbox: **{tests_run} tests run, 0 failed.**"
        if verification.get("passed")
        else f"Independent verification in the run sandbox: **{len(failed)} of {tests_run} tests still fail** ({', '.join(failed)})."
    )

    if diagnosis.get("status") == "healthy":
        return {"output": "\n".join(["## No change needed", "", str(diagnosis.get("summary") or ""), "", evidence])}
    change = (
        "The host policy denied writes to the repository, so the patch below was proposed but not applied."
        if denied
        else notes
    )
    return {
        "output": "\n".join(
            [
                "## Proposed: apply invoice discounts as a percentage (not applied)"
                if denied
                else "## Fix: apply invoice discounts as a percentage",
                "",
                f"**Root cause.** {diagnosis.get('summary') or ''}",
                "",
                f"**Change.** {change}",
                *(["", notes or ""] if denied else []),
                "",
                f"**Evidence.** {evidence}",
            ]
        )
    }


def repo_mechanic_script(request: ScriptRequest) -> ScriptTurn:
    if "Reproduce the problem" in request.prompt:
        return investigate(request)
    if "Fix the defect" in request.prompt:
        return fix(request)
    if "pull-request descriptions" in request.system:
        return report(request)
    return {"output": "This step is not part of the Repo Mechanic script."}
