import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  RunCheckpoint,
  RunError,
  AgentManifest,
} from "@clearideas/agent-runtime-contracts";
import type {
  CompletedRunRecord,
  RunRecord,
} from "@clearideas/agent-runtime-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileRunStore } from "./run-store.file.js";

const manifest: AgentManifest = {
  schemaVersion: "1.0",
  name: "File store test",
  steps: [],
};

const runRecord = (runId: string): RunRecord => ({
  runId,
  manifest,
  status: "running",
  state: { phase: "initial" },
  createdAt: "2026-07-22T11:00:00.000Z",
  updatedAt: "2026-07-22T11:00:00.000Z",
});

const checkpoint = (
  runId: string,
  id: string,
  stepIndex: number,
): RunCheckpoint => ({
  id,
  runId,
  sequence: stepIndex,
  manifestHash: "sha256:test",
  contractVersion: "1.0",
  runtimeVersion: "0.1.0",
  cursor: { stepIndex },
  state: { phase: `step-${stepIndex}` },
  stepResults: [],
  transcript: [],
  artifacts: [],
  createdAt: `2026-07-22T11:00:0${stepIndex}.000Z`,
});

describe("FileRunStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-run-store-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("atomically writes runs and the latest checkpoint inside the configured root", async () => {
    const store = new FileRunStore(directory);
    const runId = "../unsafe/run-id";
    await store.createRun(runRecord(runId));
    await store.saveCheckpoint(checkpoint(runId, "checkpoint-1", 1));
    await store.saveCheckpoint(checkpoint(runId, "checkpoint-2", 2));

    await expect(store.loadRun(runId)).resolves.toMatchObject({
      runId,
      state: { phase: "initial" },
    });
    await expect(store.loadLatestCheckpoint(runId)).resolves.toMatchObject({
      id: "checkpoint-2",
      state: { phase: "step-2" },
    });

    const runDirectory = path.join(
      directory,
      "runs",
      createHash("sha256").update(runId).digest("hex"),
    );
    expect((await readdir(runDirectory)).sort()).toEqual([
      "checkpoint.json",
      "run.json",
    ]);
    expect(
      JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8")),
    ).toMatchObject({
      runId,
    });
  });

  it("maps dot-segment identifiers to safe directories", async () => {
    const store = new FileRunStore(directory);
    await store.createRun(runRecord(".."));

    await expect(store.loadRun("..")).resolves.toMatchObject({ runId: ".." });
    await expect(
      readFile(path.join(directory, "run.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists terminal completion and failure records", async () => {
    const store = new FileRunStore(directory);
    await store.createRun(runRecord("completed"));
    const completed: CompletedRunRecord = {
      ...runRecord("completed"),
      status: "completed",
      updatedAt: "2026-07-22T11:01:00.000Z",
      output: "done",
      transcript: [],
      artifacts: [],
    };
    await store.completeRun(completed);
    await expect(store.loadRun("completed")).resolves.toMatchObject({
      status: "completed",
      output: "done",
    });

    await store.createRun(runRecord("failed"));
    const error: RunError = { code: "RUN_FAILED", message: "Run failed" };
    await store.failRun("failed", error, "2026-07-22T11:02:00.000Z", 1);
    await expect(store.loadRun("failed")).resolves.toMatchObject({
      status: "failed",
      error,
      failedAt: "2026-07-22T11:02:00.000Z",
    });
  });

  it("does not overwrite an existing run and reports missing terminal runs", async () => {
    const store = new FileRunStore(directory);
    await store.createRun(runRecord("existing"));

    await expect(store.createRun(runRecord("existing"))).rejects.toThrow(
      "Run already exists: existing",
    );
    await expect(
      store.failRun(
        "missing",
        { code: "FAILED", message: "failed" },
        new Date().toISOString(),
        1,
      ),
    ).rejects.toThrow("Run not found: missing");
  });

  it("serializes lifecycle mutations for the same run within one process", async () => {
    const store = new FileRunStore(directory);
    const createResults = await Promise.allSettled([
      store.createRun({
        ...runRecord("concurrent-create"),
        status: "suspended",
      }),
      store.createRun({
        ...runRecord("concurrent-create"),
        status: "suspended",
      }),
    ]);
    expect(
      createResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      createResults.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const resumeResults = await Promise.allSettled([
      store.resumeRun("concurrent-create", "2026-07-22T11:01:00.000Z"),
      store.resumeRun("concurrent-create", "2026-07-22T11:01:01.000Z"),
    ]);
    expect(
      resumeResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      resumeResults.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const first = {
      ...checkpoint("concurrent-create", "checkpoint-a", 1),
      attempt: 2,
    };
    const conflicting = {
      ...checkpoint("concurrent-create", "checkpoint-b", 1),
      attempt: 2,
    };
    const checkpointResults = await Promise.allSettled([
      store.saveCheckpoint(first),
      store.saveCheckpoint(conflicting),
    ]);
    expect(
      checkpointResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      checkpointResults.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
});
