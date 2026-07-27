import type {
  RunCheckpoint,
  RunError,
  AgentManifest,
} from "@clearideas/agent-runtime-contracts";
import type {
  CompletedRunRecord,
  RunRecord,
} from "@clearideas/agent-runtime-core";
import { describe, expect, it } from "vitest";

import { type FailedRunRecord, MemoryRunStore } from "./run-store.memory.js";

const manifest: AgentManifest = {
  schemaVersion: "1.0",
  name: "Local store test",
  steps: [],
};

const runRecord = (runId = "run-memory"): RunRecord => ({
  runId,
  manifest,
  status: "running",
  state: { count: 1 },
  createdAt: "2026-07-22T10:00:00.000Z",
  updatedAt: "2026-07-22T10:00:00.000Z",
});

const checkpoint = (id: string, count: number): RunCheckpoint => ({
  id,
  runId: "run-memory",
  sequence: count,
  manifestHash: "sha256:test",
  contractVersion: "1.0",
  runtimeVersion: "0.1.0",
  cursor: { stepIndex: count },
  state: { count },
  stepResults: [],
  transcript: [],
  artifacts: [],
  createdAt: `2026-07-22T10:00:0${count}.000Z`,
});

describe("MemoryRunStore", () => {
  it("stores defensive copies of runs and returns defensive copies to callers", async () => {
    const store = new MemoryRunStore();
    const original = runRecord();

    await store.createRun(original);
    original.state.count = 99;
    const loaded = await store.loadRun(original.runId);
    expect(loaded?.state).toEqual({ count: 1 });

    if (!loaded) throw new Error("Expected stored run.");
    loaded.state.count = 88;
    expect((await store.loadRun(original.runId))?.state).toEqual({ count: 1 });
    await expect(store.createRun(runRecord())).rejects.toThrow(
      "Run already exists: run-memory",
    );
  });

  it("replaces the latest checkpoint for a run", async () => {
    const store = new MemoryRunStore();
    await store.createRun(runRecord());

    await store.saveCheckpoint(checkpoint("checkpoint-1", 1));
    await store.saveCheckpoint(checkpoint("checkpoint-2", 2));

    await expect(
      store.loadLatestCheckpoint("run-memory"),
    ).resolves.toMatchObject({
      id: "checkpoint-2",
      state: { count: 2 },
    });
    await expect(store.loadLatestCheckpoint("missing")).resolves.toBeNull();
  });

  it("records completed and failed terminal runs", async () => {
    const completedStore = new MemoryRunStore();
    await completedStore.createRun(runRecord("run-completed"));
    const completed: CompletedRunRecord = {
      ...runRecord("run-completed"),
      status: "completed",
      updatedAt: "2026-07-22T10:01:00.000Z",
      output: { answer: 42 },
      transcript: [],
      artifacts: [],
    };
    await completedStore.completeRun(completed);
    await expect(
      completedStore.loadRun("run-completed"),
    ).resolves.toMatchObject({
      status: "completed",
      output: { answer: 42 },
    });

    const failedStore = new MemoryRunStore();
    await failedStore.createRun(runRecord("run-failed"));
    const error: RunError = {
      code: "TOOL_FAILED",
      message: "Tool failed",
      retryable: true,
    };
    await failedStore.failRun(
      "run-failed",
      error,
      "2026-07-22T10:02:00.000Z",
      1,
    );
    await expect(failedStore.loadRun("run-failed")).resolves.toMatchObject({
      status: "failed",
      updatedAt: "2026-07-22T10:02:00.000Z",
      failedAt: "2026-07-22T10:02:00.000Z",
      error,
    } satisfies Partial<FailedRunRecord>);
  });

  it("enforces checkpoint order, terminal immutability, and attempt fencing", async () => {
    const store = new MemoryRunStore();
    await store.createRun({ ...runRecord(), attempt: 1 });
    await store.saveCheckpoint({
      ...checkpoint("checkpoint-1", 1),
      attempt: 1,
    });
    await expect(
      store.saveCheckpoint({ ...checkpoint("checkpoint-3", 3), attempt: 1 }),
    ).rejects.toThrow("does not follow committed sequence");
    await expect(
      store.resumeRun("run-memory", "2026-07-22T10:01:00.000Z"),
    ).rejects.toThrow("still owned by a running attempt");
    await expect(
      store.resumeRun("run-memory", "2026-07-22T10:01:00.000Z", {
        allowRunningTakeover: true,
      }),
    ).resolves.toBe(2);
    await expect(
      store.saveCheckpoint({ ...checkpoint("checkpoint-2", 2), attempt: 1 }),
    ).rejects.toThrow("owned by another attempt");
    await store.saveCheckpoint({
      ...checkpoint("checkpoint-2", 2),
      attempt: 2,
    });
    await store.cancelRun("run-memory", "2026-07-22T10:02:00.000Z", 2);
    await expect(
      store.failRun(
        "run-memory",
        { code: "TOO_LATE", message: "too late" },
        "2026-07-22T10:03:00.000Z",
        2,
      ),
    ).rejects.toThrow("Cannot fail cancelled run");
  });
});
