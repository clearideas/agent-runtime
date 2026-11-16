import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentManifest,
  RunCheckpoint,
} from "@clearideas/agent-runtime-contracts";
import type { RunStore } from "@clearideas/agent-runtime-core";
import { afterEach, describe, expect, it } from "vitest";

import { FileRunStore } from "./run-store.file.js";
import { MemoryRunStore } from "./run-store.memory.js";

const manifest: AgentManifest = {
  schemaVersion: "1.0",
  steps: [{ id: "one", type: "prompt", prompt: "one" }],
};

const checkpoint = (sequence: number, boundary?: string): RunCheckpoint => ({
  id: `checkpoint-${sequence}`,
  runId: "run",
  sequence,
  attempt: 1,
  manifestHash: "hash",
  contractVersion: "1.1",
  runtimeVersion: "0.9.0",
  cursor: { stepIndex: sequence },
  state: { sequence },
  stepResults: [],
  transcript: [],
  artifacts: [],
  ...(boundary
    ? { boundary: { stepPath: boundary, stepIndex: sequence } }
    : {}),
  createdAt: "2026-07-22T00:00:00.000Z",
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const stores: Array<[string, () => Promise<RunStore>]> = [
  ["MemoryRunStore", async () => new MemoryRunStore()],
  [
    "FileRunStore",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "restart-points-"));
      directories.push(directory);
      return new FileRunStore(directory);
    },
  ],
];

describe.each(stores)("%s restart points", (_name, create) => {
  it("keeps step-completion checkpoints after later ones replace the latest", async () => {
    const store = await create();
    await store.createRun({
      runId: "run",
      manifest,
      status: "running",
      attempt: 1,
      state: {},
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    await store.saveCheckpoint(checkpoint(1));
    await store.saveCheckpoint(checkpoint(2, "one"));
    await store.saveCheckpoint(checkpoint(3));
    await store.saveCheckpoint(checkpoint(4, "two"));
    await store.saveCheckpoint(checkpoint(5));

    const boundaries = await store.listCheckpoints!("run", {
      boundaries: true,
    });
    expect(boundaries.map((summary) => summary.sequence)).toEqual([2, 4]);
    expect(boundaries[0]).toEqual({
      id: "checkpoint-2",
      sequence: 2,
      attempt: 1,
      createdAt: "2026-07-22T00:00:00.000Z",
      cursor: { stepIndex: 2 },
      boundary: { stepPath: "one", stepIndex: 2 },
    });
    // The latest checkpoint is always listed; other non-boundaries may not be.
    expect(
      (await store.listCheckpoints!("run")).map((summary) => summary.sequence),
    ).toEqual(expect.arrayContaining([2, 4, 5]));
    expect((await store.loadCheckpoint!("run", 2))?.state).toEqual({
      sequence: 2,
    });
    expect((await store.loadCheckpoint!("run", 5))?.state).toEqual({
      sequence: 5,
    });
    expect(await store.loadCheckpoint!("run", 99)).toBeNull();
  });
});

describe.each(stores)("%s restart point retention", (_name, create) => {
  it("keeps every top-level restart point and the most recent nested ones", async () => {
    const store = await create();
    await store.createRun({
      runId: "run",
      manifest,
      status: "running",
      attempt: 1,
      state: {},
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    });
    await store.saveCheckpoint(checkpoint(1, "first"));
    for (let sequence = 2; sequence <= 14; sequence += 1)
      await store.saveCheckpoint(checkpoint(sequence, "each/item"));
    await store.saveCheckpoint(checkpoint(15, "each"));
    const kept = (
      await store.listCheckpoints!("run", { boundaries: true })
    ).map((summary) => summary.sequence);
    expect(kept).toEqual([1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(await store.loadCheckpoint!("run", 4)).toBeNull();
  });
});
