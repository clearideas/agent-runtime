"""Ports of the packages/store-local/src/*.test.ts suites."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlparse

import pytest

from clearideas_agent_runtime._js.errors import Error
from clearideas_agent_runtime.stores.local import (
    ConsoleEventSink,
    FileAgentManifestSource,
    FileArtifactStore,
    FileRunStore,
    JsonlEventSink,
    LocalDirectoryWorkspace,
    MemoryRunStore,
    MemoryWorkspace,
    compile_glob,
    files,
    rename_with_retry,
    with_file_retry,
)


def file_path(uri: str) -> str:
    return unquote(urlparse(uri).path)


# ─── FileRunStore ───────────────────────────────────────────────────────────

MANIFEST = {"schemaVersion": "1.0", "name": "File store test", "steps": []}


def run_record(run_id, **extra):
    return {
        "runId": run_id,
        "manifest": MANIFEST,
        "status": "running",
        "state": {"phase": "initial"},
        "createdAt": "2026-07-22T11:00:00.000Z",
        "updatedAt": "2026-07-22T11:00:00.000Z",
        **extra,
    }


def checkpoint(run_id, checkpoint_id, step_index, **extra):
    return {
        "id": checkpoint_id,
        "runId": run_id,
        "sequence": step_index,
        "manifestHash": "sha256:test",
        "contractVersion": "1.0",
        "runtimeVersion": "0.1.0",
        "cursor": {"stepIndex": step_index},
        "state": {"phase": f"step-{step_index}"},
        "stepResults": [],
        "transcript": [],
        "artifacts": [],
        "createdAt": f"2026-07-22T11:00:0{step_index}.000Z",
        **extra,
    }


class TestFileRunStore:
    async def test_atomically_writes_runs_and_the_latest_checkpoint_inside_the_configured_root(self, tmp_path):
        store = FileRunStore(str(tmp_path))
        run_id = "../unsafe/run-id"
        await store.create_run(run_record(run_id))
        await store.save_checkpoint(checkpoint(run_id, "checkpoint-1", 1))
        await store.save_checkpoint(checkpoint(run_id, "checkpoint-2", 2))
        loaded = await store.load_run(run_id)
        assert (loaded["runId"], loaded["state"]) == (run_id, {"phase": "initial"})
        latest = await store.load_latest_checkpoint(run_id)
        assert (latest["id"], latest["state"]) == ("checkpoint-2", {"phase": "step-2"})
        run_directory = tmp_path / "runs" / hashlib.sha256(run_id.encode()).hexdigest()
        assert sorted(os.listdir(run_directory)) == ["checkpoint.json", "run.json"]
        assert json.loads((run_directory / "run.json").read_text())["runId"] == run_id

    async def test_maps_dot_segment_identifiers_to_safe_directories(self, tmp_path):
        store = FileRunStore(str(tmp_path))
        await store.create_run(run_record(".."))
        assert (await store.load_run(".."))["runId"] == ".."
        assert not (tmp_path / "run.json").exists()

    async def test_persists_terminal_completion_and_failure_records(self, tmp_path):
        store = FileRunStore(str(tmp_path))
        await store.create_run(run_record("completed"))
        await store.complete_run(
            {
                **run_record("completed"),
                "status": "completed",
                "updatedAt": "2026-07-22T11:01:00.000Z",
                "output": "done",
                "transcript": [],
                "artifacts": [],
            }
        )
        completed = await store.load_run("completed")
        assert (completed["status"], completed["output"]) == ("completed", "done")
        await store.create_run(run_record("failed"))
        error = {"code": "RUN_FAILED", "message": "Run failed"}
        await store.fail_run("failed", error, "2026-07-22T11:02:00.000Z", 1)
        failed = await store.load_run("failed")
        assert (failed["status"], failed["error"], failed["failedAt"]) == ("failed", error, "2026-07-22T11:02:00.000Z")

    async def test_does_not_overwrite_an_existing_run_and_reports_missing_terminal_runs(self, tmp_path):
        store = FileRunStore(str(tmp_path))
        await store.create_run(run_record("existing"))
        with pytest.raises(Error, match="Run already exists: existing"):
            await store.create_run(run_record("existing"))
        with pytest.raises(Error, match="Run not found: missing"):
            await store.fail_run("missing", {"code": "FAILED", "message": "failed"}, "2026-07-22T11:00:00.000Z", 1)

    async def test_serializes_lifecycle_mutations_for_the_same_run_within_one_process(self, tmp_path):
        store = FileRunStore(str(tmp_path))

        def outcomes(results):
            return (
                sum(not isinstance(r, BaseException) for r in results),
                sum(isinstance(r, BaseException) for r in results),
            )

        created = await asyncio.gather(
            store.create_run(run_record("concurrent-create", status="suspended")),
            store.create_run(run_record("concurrent-create", status="suspended")),
            return_exceptions=True,
        )
        assert outcomes(created) == (1, 1)
        resumed = await asyncio.gather(
            store.resume_run("concurrent-create", "2026-07-22T11:01:00.000Z"),
            store.resume_run("concurrent-create", "2026-07-22T11:01:01.000Z"),
            return_exceptions=True,
        )
        assert outcomes(resumed) == (1, 1)
        saved = await asyncio.gather(
            store.save_checkpoint(checkpoint("concurrent-create", "checkpoint-a", 1, attempt=2)),
            store.save_checkpoint(checkpoint("concurrent-create", "checkpoint-b", 1, attempt=2)),
            return_exceptions=True,
        )
        assert outcomes(saved) == (1, 1)

    async def test_records_an_interrupted_run_that_can_be_resumed_or_cancelled(self, tmp_path):
        await _interrupted_lifecycle(FileRunStore(str(tmp_path)))


async def _interrupted_lifecycle(store):
    await store.create_run(run_record("run-interrupted"))
    error = {"code": "EXECUTION_TIMEOUT", "message": "Execution timed out.", "retryable": True}
    await store.interrupt_run("run-interrupted", error, "2026-07-22T12:00:00.000Z", 1)
    assert (await store.load_run("run-interrupted"))["status"] == "interrupted"
    with pytest.raises(Error, match="Cannot interrupt interrupted run"):
        await store.interrupt_run("run-interrupted", error, "2026-07-22T12:00:01.000Z", 1)
    assert await store.resume_run("run-interrupted", "2026-07-22T12:01:00.000Z") == 2
    assert (await store.load_run("run-interrupted"))["status"] == "running"
    await store.interrupt_run("run-interrupted", error, "2026-07-22T12:02:00.000Z", 2)
    await store.cancel_run("run-interrupted", "2026-07-22T12:03:00.000Z", 2)
    assert (await store.load_run("run-interrupted"))["status"] == "cancelled"


# ─── MemoryRunStore ─────────────────────────────────────────────────────────


def memory_record(run_id="run-memory", **extra):
    return {
        "runId": run_id,
        "manifest": {**MANIFEST, "name": "Local store test"},
        "status": "running",
        "state": {"count": 1},
        "createdAt": "2026-07-22T10:00:00.000Z",
        "updatedAt": "2026-07-22T10:00:00.000Z",
        **extra,
    }


def memory_checkpoint(checkpoint_id, count, **extra):
    return {
        "id": checkpoint_id,
        "runId": "run-memory",
        "sequence": count,
        "manifestHash": "sha256:test",
        "contractVersion": "1.0",
        "runtimeVersion": "0.1.0",
        "cursor": {"stepIndex": count},
        "state": {"count": count},
        "stepResults": [],
        "transcript": [],
        "artifacts": [],
        "createdAt": f"2026-07-22T10:00:0{count}.000Z",
        **extra,
    }


class TestMemoryRunStore:
    async def test_stores_defensive_copies_of_runs_and_returns_defensive_copies_to_callers(self):
        store = MemoryRunStore()
        original = memory_record()
        await store.create_run(original)
        original["state"]["count"] = 99
        loaded = await store.load_run(original["runId"])
        assert loaded["state"] == {"count": 1}
        loaded["state"]["count"] = 88
        assert (await store.load_run(original["runId"]))["state"] == {"count": 1}
        with pytest.raises(Error, match="Run already exists: run-memory"):
            await store.create_run(memory_record())

    async def test_replaces_the_latest_checkpoint_for_a_run(self):
        store = MemoryRunStore()
        await store.create_run(memory_record())
        await store.save_checkpoint(memory_checkpoint("checkpoint-1", 1))
        await store.save_checkpoint(memory_checkpoint("checkpoint-2", 2))
        latest = await store.load_latest_checkpoint("run-memory")
        assert (latest["id"], latest["state"]) == ("checkpoint-2", {"count": 2})
        assert await store.load_latest_checkpoint("missing") is None

    async def test_records_completed_and_failed_terminal_runs(self):
        completed_store = MemoryRunStore()
        await completed_store.create_run(memory_record("run-completed"))
        await completed_store.complete_run(
            {
                **memory_record("run-completed"),
                "status": "completed",
                "updatedAt": "2026-07-22T10:01:00.000Z",
                "output": {"answer": 42},
                "transcript": [],
                "artifacts": [],
            }
        )
        completed = await completed_store.load_run("run-completed")
        assert (completed["status"], completed["output"]) == ("completed", {"answer": 42})
        failed_store = MemoryRunStore()
        await failed_store.create_run(memory_record("run-failed"))
        error = {"code": "TOOL_FAILED", "message": "Tool failed", "retryable": True}
        await failed_store.fail_run("run-failed", error, "2026-07-22T10:02:00.000Z", 1)
        failed = await failed_store.load_run("run-failed")
        assert {key: failed[key] for key in ("status", "updatedAt", "failedAt", "error")} == {
            "status": "failed",
            "updatedAt": "2026-07-22T10:02:00.000Z",
            "failedAt": "2026-07-22T10:02:00.000Z",
            "error": error,
        }

    async def test_enforces_checkpoint_order_terminal_immutability_and_attempt_fencing(self):
        store = MemoryRunStore()
        await store.create_run(memory_record(attempt=1))
        await store.save_checkpoint(memory_checkpoint("checkpoint-1", 1, attempt=1))
        with pytest.raises(Error, match="does not follow committed sequence"):
            await store.save_checkpoint(memory_checkpoint("checkpoint-3", 3, attempt=1))
        with pytest.raises(Error, match="still owned by a running attempt"):
            await store.resume_run("run-memory", "2026-07-22T10:01:00.000Z")
        assert await store.resume_run("run-memory", "2026-07-22T10:01:00.000Z", {"allowRunningTakeover": True}) == 2
        with pytest.raises(Error, match="owned by another attempt"):
            await store.save_checkpoint(memory_checkpoint("checkpoint-2", 2, attempt=1))
        await store.save_checkpoint(memory_checkpoint("checkpoint-2", 2, attempt=2))
        await store.cancel_run("run-memory", "2026-07-22T10:02:00.000Z", 2)
        with pytest.raises(Error, match="Cannot fail cancelled run"):
            await store.fail_run(
                "run-memory", {"code": "TOO_LATE", "message": "too late"}, "2026-07-22T10:03:00.000Z", 2
            )

    async def test_records_an_interrupted_run_that_can_be_resumed_or_cancelled(self):
        await _interrupted_lifecycle(MemoryRunStore())

    async def test_deletes_finished_runs_and_their_checkpoints_never_a_running_run(self):
        store = MemoryRunStore()
        await store.create_run(memory_record())
        await store.save_checkpoint(memory_checkpoint("checkpoint-1", 1))
        with pytest.raises(Error, match="Cannot delete running run run-memory"):
            await store.delete_run("run-memory")
        await store.cancel_run("run-memory", "2026-07-22T10:01:00.000Z", 1)
        assert await store.delete_run("run-memory") is True
        assert await store.load_run("run-memory") is None
        assert await store.load_latest_checkpoint("run-memory") is None
        assert await store.delete_run("run-memory") is False
        await store.create_run(memory_record())
        assert (await store.load_run("run-memory"))["status"] == "running"


# ─── FileArtifactStore ──────────────────────────────────────────────────────


class TestFileArtifactStore:
    async def test_round_trips_bytes_with_durable_metadata_and_integrity_information(self, tmp_path):
        store = FileArtifactStore(str(tmp_path))
        data = bytes([0, 1, 2, 255])
        ref = await store.put(
            {
                "name": "../report.bin",
                "mediaType": "application/octet-stream",
                "data": data,
                "metadata": {"source": "test"},
            }
        )
        artifact = await store.get(ref)
        assert artifact["data"] == data
        assert artifact["ref"] == ref
        assert ref["size"] == 4
        assert ref["sha256"] == hashlib.sha256(data).hexdigest()
        assert ref["uri"].startswith("file:")
        assert os.path.exists(file_path(ref["uri"]))
        assert str(tmp_path / "artifacts") in file_path(ref["uri"])

    async def test_does_not_use_caller_provided_names_as_filesystem_paths(self, tmp_path):
        store = FileArtifactStore(str(tmp_path))
        ref = await store.put({"name": "../../outside.txt", "mediaType": "text/plain", "data": "safe"})
        assert "outside.txt" not in file_path(ref["uri"])
        assert (await store.get(ref))["data"] == b"safe"

    async def test_rejects_empty_artifact_identifiers_on_reads(self, tmp_path):
        with pytest.raises(Error, match="Artifact id cannot be empty"):
            await FileArtifactStore(str(tmp_path)).get({"id": "", "name": "x", "mediaType": "text/plain"})

    async def test_does_not_interpret_dot_segment_artifact_ids_as_directories(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            await FileArtifactStore(str(tmp_path)).get({"id": "..", "name": "x", "mediaType": "text/plain"})

    async def test_detects_artifact_data_corruption_on_read(self, tmp_path):
        store = FileArtifactStore(str(tmp_path))
        ref = await store.put({"name": "report.txt", "mediaType": "text/plain", "data": "original"})
        Path(file_path(ref["uri"])).write_text("changed")
        with pytest.raises(Error, match="Artifact integrity check failed"):
            await store.get(ref)

    async def test_validates_bytes_against_the_caller_reference_when_data_and_metadata_are_replaced(self, tmp_path):
        store = FileArtifactStore(str(tmp_path))
        ref = await store.put({"name": "report.txt", "mediaType": "text/plain", "data": "original"})
        data_path = Path(file_path(ref["uri"]))
        metadata_path = data_path.parent / "metadata.json"
        metadata = json.loads(metadata_path.read_text())
        replacement = b"changed!"
        metadata["ref"]["sha256"] = hashlib.sha256(replacement).hexdigest()
        metadata["ref"]["size"] = len(replacement)
        data_path.write_bytes(replacement)
        metadata_path.write_text(json.dumps(metadata))
        with pytest.raises(Error, match="Artifact integrity check failed"):
            await store.get(ref)


# ─── Event sinks ────────────────────────────────────────────────────────────


def event(sequence):
    value = {
        "id": f"event-{sequence}",
        "runId": "run-events",
        "type": "run.completed" if sequence == 3 else "step.completed",
        "timestamp": f"2026-07-22T12:00:0{sequence}.000Z",
    }
    if sequence < 3:
        value["stepId"] = f"step-{sequence}"
    value["data"] = {"sequence": sequence}
    return value


class TestLocalEventSinks:
    async def test_writes_concurrent_jsonl_emissions_in_invocation_order(self, tmp_path):
        path = tmp_path / "nested" / "events.jsonl"
        sink = JsonlEventSink(str(path))
        await asyncio.gather(sink.emit(event(1)), sink.emit(event(2)), sink.emit(event(3)))
        await sink.flush()
        contents = path.read_text()
        assert contents.endswith("\n")
        assert [json.loads(line) for line in contents.strip().split("\n")] == [event(1), event(2), event(3)]

    def test_emits_the_same_structured_json_line_format_to_an_injected_console_writer(self):
        lines = []
        ConsoleEventSink(lines.append).emit(event(1))
        assert lines == [json.dumps(event(1), separators=(",", ":")) + "\n"]


# ─── FileAgentManifestSource ────────────────────────────────────────────────

JSON_MANIFEST = {
    "schemaVersion": "1.0",
    "name": "Local manifest",
    "variables": [{"key": "subject", "type": "string", "value": "Quarterly update"}],
    "steps": [{"id": "draft", "type": "prompt", "prompt": "Draft {{subject}}"}],
}


class TestFileAgentManifestSource:
    async def test_loads_and_validates_json_manifests(self, tmp_path):
        (tmp_path / "nested").mkdir()
        (tmp_path / "nested" / "agent.json").write_text(json.dumps(JSON_MANIFEST))
        assert await FileAgentManifestSource(str(tmp_path), "nested/agent.json").load_manifest() == JSON_MANIFEST

    async def test_loads_and_validates_yaml_manifests(self, tmp_path):
        (tmp_path / "agent.yaml").write_text(
            'schemaVersion: "1.0"\nname: YAML agent\nsteps:\n  - id: draft\n    type: prompt\n    prompt: Write a draft\n'
        )
        manifest = await FileAgentManifestSource(str(tmp_path)).load_manifest("agent.yaml")
        assert (
            manifest["schemaVersion"],
            manifest["name"],
            manifest["steps"][0]["id"],
            manifest["steps"][0]["type"],
        ) == ("1.0", "YAML agent", "draft", "prompt")

    async def test_rejects_path_traversal_absolute_paths_and_unknown_formats(self, tmp_path):
        source = FileAgentManifestSource(str(tmp_path))
        with pytest.raises(Error, match="escapes the configured root"):
            await source.load_manifest("../agent.json")
        with pytest.raises(Error, match="must be relative"):
            await source.load_manifest(str(tmp_path / "agent.json"))
        with pytest.raises(Error, match="Unsupported manifest format"):
            await source.load_manifest("agent.txt")

    async def test_returns_contract_validation_errors_for_malformed_manifests(self, tmp_path):
        (tmp_path / "bad.json").write_text(json.dumps({"schemaVersion": "0", "steps": []}))
        with pytest.raises(Exception):  # noqa: B017
            await FileAgentManifestSource(str(tmp_path)).load_manifest("bad.json")

    async def test_rejects_symlinks_that_resolve_outside_the_configured_root(self, tmp_path, tmp_path_factory):
        outside = tmp_path_factory.mktemp("outside")
        (outside / "agent.json").write_text(json.dumps(JSON_MANIFEST))
        try:
            os.symlink(outside / "agent.json", tmp_path / "linked.json")
        except OSError:
            pytest.skip("this system does not permit creating symlinks")
        with pytest.raises(Error, match="resolves outside the configured root"):
            await FileAgentManifestSource(str(tmp_path)).load_manifest("linked.json")


# ─── File retry ─────────────────────────────────────────────────────────────


def failing(codes, value="done"):
    state = {"calls": 0}

    async def operation():
        code = codes[state["calls"]] if state["calls"] < len(codes) else None
        state["calls"] += 1
        if code:
            raise OSError(getattr(errno, code), f"{code}: operation not permitted")
        return value

    return state, operation


class TestWithFileRetry:
    async def test_retries_transient_windows_sharing_errors_then_succeeds(self):
        delays = []

        async def sleep(delay):
            delays.append(delay)

        state, operation = failing(["EPERM", "EBUSY", "EACCES"])
        assert await with_file_retry(operation, platform="win32", sleep=sleep) == "done"
        assert state["calls"] == 4
        assert delays == [10, 20, 40]

    async def test_does_not_retry_the_same_codes_on_other_platforms(self):
        state, operation = failing(["EPERM"])
        with pytest.raises(OSError) as raised:
            await with_file_retry(operation, platform="linux")
        assert raised.value.errno == errno.EPERM
        assert state["calls"] == 1

    async def test_does_not_retry_other_errors_and_gives_up_after_its_time_budget(self):
        missing, operation = failing(["ENOENT"])
        with pytest.raises(OSError) as raised:
            await with_file_retry(operation, platform="win32")
        assert raised.value.errno == errno.ENOENT
        assert missing["calls"] == 1

        async def no_sleep(delay):
            return None

        locked, operation = failing(["EPERM"] * 100)
        with pytest.raises(OSError):
            await with_file_retry(operation, platform="win32", max_wait_ms=500, sleep=no_sleep)
        assert locked["calls"] == 7

    async def test_replaces_a_file_atomically(self, tmp_path):
        target = tmp_path / "checkpoint.json"
        temporary = tmp_path / ".checkpoint.json.tmp"
        target.write_text("old")
        temporary.write_text("new")
        await rename_with_retry(str(temporary), str(target))
        assert target.read_text() == "new"


async def test_saves_checkpoints_while_another_process_holds_checkpoint_json_open(tmp_path, monkeypatch):
    refused = 0
    original_replace = os.replace

    def replace(source, target):
        nonlocal refused
        if str(target).endswith("checkpoint.json") and refused < 3:
            refused += 1
            raise OSError(errno.EPERM, "EPERM: operation not permitted, rename")
        return original_replace(source, target)

    monkeypatch.setattr(files.os, "replace", replace)
    monkeypatch.setattr(files, "PLATFORM", "win32")
    store = FileRunStore(str(tmp_path))
    await store.create_run(
        {
            "runId": "run-locked",
            "manifest": {"schemaVersion": "1.0", "steps": []},
            "status": "running",
            "state": {},
            "createdAt": "2026-07-22T00:00:00.000Z",
            "updatedAt": "2026-07-22T00:00:00.000Z",
        }
    )
    for sequence in (1, 2):
        await store.save_checkpoint(
            {
                "id": f"checkpoint-{sequence}",
                "runId": "run-locked",
                "sequence": sequence,
                "manifestHash": "hash",
                "contractVersion": "1.0",
                "runtimeVersion": "0.1.0",
                "cursor": {"stepIndex": 0},
                "state": {"sequence": sequence},
                "stepResults": [],
                "transcript": [],
                "artifacts": [],
                "createdAt": "2026-07-22T00:00:00.000Z",
            }
        )
    assert refused == 3
    assert (await store.load_latest_checkpoint("run-locked"))["sequence"] == 2


# ─── Workspaces ─────────────────────────────────────────────────────────────


def test_compile_glob_matches_segments_globstars_and_single_characters_deterministically():
    assert compile_glob("**/*.md").search("README.md")
    assert compile_glob("**/*.md").search("docs/guide/intro.md")
    assert not compile_glob("*.md").search("docs/intro.md")
    assert compile_glob("src/**").search("src/a/b.ts")
    assert not compile_glob("src/**").search("lib/a.ts")
    assert compile_glob("**/node_modules/**").search("a/node_modules/")
    assert compile_glob("file?.txt").search("file1.txt")
    assert not compile_glob("file?.txt").search("file/.txt")
    assert not compile_glob("a.b").search("aXb")
    with pytest.raises(Error, match="Invalid workspace glob"):
        compile_glob("  ")


@pytest.fixture
def workspace_root(tmp_path_factory):
    root = tmp_path_factory.mktemp("workspace")
    outside = tmp_path_factory.mktemp("outside")
    (root / "src" / "nested").mkdir(parents=True)
    (root / "node_modules" / "dep").mkdir(parents=True)
    (root / ".git").mkdir()
    (root / "README.md").write_text("# Title\nhello world\n")
    (root / "src" / "index.ts").write_text("export const x = 1;\n")
    (root / "src" / "nested" / "util.ts").write_text("util\n")
    (root / "node_modules" / "dep" / "index.js").write_text("dep\n")
    (root / ".git" / "config").write_text("secret\n")
    (root / ".env").write_text("SECRET=1\n")
    (root / "with space.txt").write_text("hidden by path rule\n")
    (outside / "secret.txt").write_text("outside\n")
    try:
        os.symlink(outside / "secret.txt", root / "link.txt")
        os.symlink(outside, root / "linked-dir")
        supported = True
    except OSError:
        supported = False
    return root, outside, supported


class TestLocalDirectoryWorkspace:
    async def test_enumerates_and_reads_python_package_paths_beginning_with_underscores(self, workspace_root):
        root, _, _ = workspace_root
        (root / "_package").mkdir()
        (root / "_package" / "__init__.py").write_text("value = 42\n")
        workspace = LocalDirectoryWorkspace(root=str(root))
        assert "_package/__init__.py" in [entry["path"] for entry in await workspace.entries()]
        assert (await workspace.read("_package/__init__.py")).decode() == "value = 42\n"
        memory = MemoryWorkspace(mode="read_write")
        await memory.write("_package/__init__.py", b"value = 42\n")
        assert "_package/__init__.py" in [entry["path"] for entry in await memory.entries()]

    async def test_enumerates_only_safe_visible_regular_files_and_advertises_limits(self, workspace_root):
        root, _, _ = workspace_root
        workspace = LocalDirectoryWorkspace(root=str(root), exclude=["**/node_modules/**"], max_file_bytes=2048)
        entries = await workspace.entries()
        assert [entry["path"] for entry in entries] == ["README.md", "src/index.ts", "src/nested/util.ts"]
        assert entries[0]["size"] == 20
        assert entries[0]["modifiedAt"][:4].isdigit()
        assert workspace.limits == {"maxFiles": 5000, "maxFileBytes": 2048, "maxTotalBytes": 100 * 1_048_576}
        assert not hasattr(workspace, "attachable")
        assert not hasattr(LocalDirectoryWorkspace(root=str(root)), "attachable")
        assert LocalDirectoryWorkspace(root=str(root), attach="auto").attachable == {
            "kind": "local-directory",
            "root": str(root),
        }
        with pytest.raises(Error, match="more than 2 visible files"):
            await LocalDirectoryWorkspace(root=str(root), max_files=2).entries()
        assert await LocalDirectoryWorkspace(root=str(root / "missing")).entries() == []

    async def test_applies_include_allowlists_to_enumeration_and_reads(self, workspace_root):
        root, _, _ = workspace_root
        workspace = LocalDirectoryWorkspace(root=str(root), include=["**/*.md"])
        assert [entry["path"] for entry in await workspace.entries()] == ["README.md"]
        with pytest.raises(Error, match="not available"):
            await workspace.read("src/index.ts")
        assert (await workspace.read("README.md")).decode() == "# Title\nhello world\n"

    async def test_refuses_traversal_hidden_entries_symbolic_links_and_oversized_files(self, workspace_root):
        root, _, supported = workspace_root
        workspace = LocalDirectoryWorkspace(root=str(root), max_file_bytes=16)
        for unsafe in ["../outside/secret.txt", ".env", ".git/config"]:
            with pytest.raises(Error, match="safe segments"):
                await workspace.read(unsafe)
        if supported:
            for linked in ["link.txt", "linked-dir/secret.txt"]:
                with pytest.raises(Error, match="symbolic link"):
                    await workspace.read(linked)
        with pytest.raises(Error, match="not available"):
            await workspace.read("src")
        with pytest.raises(Error, match="exceeding the 16-byte limit"):
            await workspace.read("README.md")
        assert (await workspace.read("src/nested/util.ts")).decode() == "util\n"

    async def test_rejects_writes_in_read_mode_and_confines_writes_in_read_write_mode(self, workspace_root):
        root, outside, supported = workspace_root
        read_only = LocalDirectoryWorkspace(root=str(root))
        assert callable(read_only.write)
        with pytest.raises(Error, match="read-only"):
            await read_only.write("new.txt", b"x")
        with pytest.raises(Error, match="read-only"):
            await read_only.delete("README.md")
        workspace = LocalDirectoryWorkspace(
            root=str(root), mode="read_write", max_file_bytes=32, exclude=["protected/**"]
        )
        written = await workspace.write("docs/new/file.md", b"# New\n")
        assert (written["path"], written["size"]) == ("docs/new/file.md", 6)
        assert (root / "docs" / "new" / "file.md").read_text() == "# New\n"
        assert (await workspace.write("docs/new/file.md", b"updated"))["size"] == 7
        with pytest.raises(Error, match="safe segments"):
            await workspace.write("../escape.txt", b"x")
        with pytest.raises(Error, match="not available"):
            await workspace.write("protected/x.txt", b"x")
        if supported:
            for linked in ["linked-dir/new.txt", "link.txt"]:
                with pytest.raises(Error, match="symbolic link"):
                    await workspace.write(linked, b"x")
        with pytest.raises(Error, match="not a regular file"):
            await workspace.write("src", b"x")
        with pytest.raises(Error, match="exceeding the 32-byte limit"):
            await workspace.write("big.txt", b"x" * 33)
        await workspace.delete("docs/new/file.md")
        with pytest.raises(Error, match="not available"):
            await workspace.read("docs/new/file.md")
        if supported:
            with pytest.raises(Error, match="symbolic link"):
                await workspace.delete("link.txt")
        assert (outside / "secret.txt").read_text() == "outside\n"


async def test_memory_workspace_behaves_like_a_bounded_workspace_over_in_memory_files():
    workspace = MemoryWorkspace(
        mode="read_write",
        files={
            "README.md": "# Memory\nhello\n",
            "src/index.ts": "const a = 1;\n",
            "assets/logo.png": bytes([0x89, 0x50, 0, 1]),
        },
        exclude=["assets/**"],
        max_files=4,
        max_file_bytes=64,
    )
    assert [entry["path"] for entry in await workspace.entries()] == ["README.md", "src/index.ts"]
    with pytest.raises(Error, match="not available"):
        await workspace.read("assets/logo.png")
    await workspace.write("notes.txt", b"note")
    assert "notes.txt" in workspace.paths
    assert workspace.text("notes.txt") == "note"
    with pytest.raises(Error, match="more than 4 files"):
        await workspace.write("extra.txt", b"x")
    with pytest.raises(Error, match="exceeding the 64-byte limit"):
        await workspace.write("notes.txt", b"y" * 65)
    await workspace.delete("notes.txt")
    with pytest.raises(Error, match="not available"):
        await workspace.delete("notes.txt")
    with pytest.raises(Error, match="read-only"):
        await MemoryWorkspace(files={"a.txt": "x"}).write("a.txt", b"y")
    with pytest.raises(Error, match="safe segments"):
        MemoryWorkspace(files={"../a.txt": "x"})
