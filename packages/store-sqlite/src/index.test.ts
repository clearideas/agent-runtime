import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  RunCheckpoint,
  AgentManifest,
} from "@clearideas/agent-runtime-contracts";
import {
  AgentRuntime,
  type RunRecord,
  type StepExecutor,
} from "@clearideas/agent-runtime-core";
import { SequenceIdGenerator } from "@clearideas/agent-runtime-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteRunStore } from "./index.js";

const manifest: AgentManifest = {
  schemaVersion: "1.0",
  id: "manifest-1",
  variables: [{ key: "count", type: "number", value: 0 }],
  steps: [{ id: "one", type: "prompt", prompt: "one" }],
};

const runRecord = (runId: string): RunRecord => ({
  runId,
  manifest,
  status: "running",
  state: { count: 0 },
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
});

const checkpoint = (runId: string, sequence: number): RunCheckpoint => ({
  id: `checkpoint-${sequence}`,
  runId,
  sequence,
  manifestHash: "hash",
  contractVersion: "1.0",
  runtimeVersion: "0.1.0",
  cursor: { stepIndex: sequence },
  state: { count: sequence },
  stepResults: [],
  transcript: [],
  artifacts: [],
  createdAt: `2026-07-22T00:00:0${sequence}.000Z`,
});

describe("SqliteRunStore", () => {
  let directory: string;
  let filename: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-sqlite-"));
    filename = path.join(directory, "runs.sqlite");
  });

  afterEach(async () => {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("persists runs and monotonically sequenced checkpoints across instances", async () => {
    const first = new SqliteRunStore(filename);
    await first.createRun(runRecord("run-1"));
    await first.saveCheckpoint(checkpoint("run-1", 1));
    await first.saveCheckpoint(checkpoint("run-1", 2));
    await first.saveCheckpoint(checkpoint("run-1", 2));
    await expect(first.saveCheckpoint(checkpoint("run-1", 4))).rejects.toThrow(
      "expected 3",
    );
    first.close();

    const second = new SqliteRunStore(filename);
    await expect(second.loadRun("run-1")).resolves.toMatchObject({
      runId: "run-1",
    });
    await expect(second.loadLatestCheckpoint("run-1")).resolves.toMatchObject({
      id: "checkpoint-2",
      sequence: 2,
      state: { count: 2 },
    });
    second.close();
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
  });

  it("supports core failure recovery without replaying a committed step", async () => {
    const store = new SqliteRunStore(filename);
    const twoSteps: AgentManifest = {
      ...manifest,
      steps: [
        { id: "first", type: "prompt", prompt: "first" },
        { id: "second", type: "prompt", prompt: "second" },
      ],
    };
    const calls: string[] = [];
    let failSecond = true;
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ step, variables }) => {
        calls.push(step.id);
        if (step.id === "second" && failSecond) {
          failSecond = false;
          throw new Error("temporary failure");
        }
        const count = Number(variables.count ?? 0) + 1;
        return { output: count, statePatch: { set: { count } } };
      },
    };
    const runner = () =>
      new AgentRuntime({
        runStore: store,
        stepExecutors: [executor],
        idGenerator: new SequenceIdGenerator(),
      });
    await expect(
      runner().run({ runId: "run-recover", manifest: twoSteps }),
    ).rejects.toThrow("temporary failure");
    const result = await runner().run({ runId: "run-recover", resume: true });

    expect(calls).toEqual(["first", "second", "second"]);
    expect(result.variables.count).toBe(2);
    store.close();
  });

  it("rejects duplicate runs and conflicting checkpoint identities", async () => {
    const store = new SqliteRunStore(filename);
    await store.createRun(runRecord("run-conflict"));
    await expect(store.createRun(runRecord("run-conflict"))).rejects.toThrow(
      "already exists",
    );
    await store.saveCheckpoint(checkpoint("run-conflict", 1));
    await expect(
      store.saveCheckpoint({
        ...checkpoint("run-conflict", 1),
        state: { count: 99 },
      }),
    ).rejects.toThrow("conflicts");
    store.close();
  });

  it("fences checkpoint and terminal mutations from a superseded attempt", async () => {
    const store = new SqliteRunStore(filename);
    await store.createRun({ ...runRecord("run-fenced"), attempt: 1 });
    await store.saveCheckpoint({ ...checkpoint("run-fenced", 1), attempt: 1 });
    await expect(
      store.resumeRun("run-fenced", "2026-07-22T00:01:00.000Z"),
    ).rejects.toThrow("still owned by a running attempt");
    await expect(
      store.resumeRun("run-fenced", "2026-07-22T00:01:00.000Z", {
        allowRunningTakeover: true,
      }),
    ).resolves.toBe(2);

    await expect(
      store.saveCheckpoint({ ...checkpoint("run-fenced", 2), attempt: 1 }),
    ).rejects.toThrow("owned by another attempt");
    const staleCompletion = {
      ...runRecord("run-fenced"),
      attempt: 1,
      status: "completed" as const,
      transcript: [],
      artifacts: [],
    };
    await expect(store.completeRun(staleCompletion)).rejects.toThrow(
      "owned by another attempt",
    );
    await expect(
      store.failRun(
        "run-fenced",
        { code: "STALE", message: "stale" },
        "2026-07-22T00:02:00.000Z",
        1,
      ),
    ).rejects.toThrow("owned by another attempt");
    await expect(
      store.cancelRun("run-fenced", "2026-07-22T00:02:00.000Z", 1),
    ).rejects.toThrow("owned by another attempt");

    await store.saveCheckpoint({ ...checkpoint("run-fenced", 2), attempt: 2 });
    await store.cancelRun("run-fenced", "2026-07-22T00:03:00.000Z", 2);
    await expect(
      store.saveCheckpoint({ ...checkpoint("run-fenced", 3), attempt: 2 }),
    ).rejects.toThrow("Cannot checkpoint cancelled run");
    store.close();
  });
});
