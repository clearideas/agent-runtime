import type {
  AgentManifest,
  AgentStep,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  type StepExecutionContext,
  type StepExecutor,
} from "./agent-runtime.js";
import type {
  RunSandboxProvider,
  WorkspaceResolutionContext,
  WorkspaceStore,
} from "./ports/index.js";
import { CollectingEventSink, MemoryRunStore } from "./testing/index.js";

const at = "2026-07-22T00:00:00.000Z";
const note = (id: string, tokens = 0): TranscriptItem => ({
  id,
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: id }],
  createdAt: at,
  ...(tokens ? { usage: { totalTokens: tokens } } : {}),
});

const prompt = (id: string, text = id): AgentStep => ({
  id,
  type: "prompt",
  prompt: text,
  outputVariable: id,
});

const definition = (steps: AgentStep[], extra: Partial<AgentManifest> = {}) =>
  ({ schemaVersion: "1.0", steps, ...extra }) as AgentManifest;

const harness = (
  extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
) => {
  const store = new MemoryRunStore();
  const events = new CollectingEventSink();
  const ran: string[] = [];
  const executor: StepExecutor = {
    type: "prompt",
    execute: async (context: StepExecutionContext) => {
      const text = (context.step as { prompt: string }).prompt;
      ran.push(text);
      return {
        output: text,
        statePatch: { set: { [context.step.id]: text } },
        transcript: [note(`${context.runId}:${text}`, 60)],
      };
    },
  };
  const runtime = () =>
    new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      eventSinks: [events],
      ...extra,
    });
  return { store, events, ran, runtime };
};

const boundaryAfter = async (
  store: MemoryRunStore,
  runId: string,
  stepPath: string,
) => {
  const summary = (
    await store.listCheckpoints(runId, { boundaries: true })
  ).find((candidate) => candidate.boundary?.stepPath === stepPath)!;
  return (await store.loadCheckpoint(runId, summary.sequence))!;
};

describe("seeded runs", () => {
  it("restarts from a step's checkpoint as a new run without repeating earlier steps", async () => {
    const { store, events, ran, runtime } = harness();
    const steps = [prompt("a"), prompt("b"), prompt("c"), prompt("d")];
    await runtime().run({ runId: "source", manifest: definition(steps) });
    ran.length = 0;

    const seed = await boundaryAfter(store, "source", "b");
    const result = await runtime().run({
      runId: "restart",
      manifest: definition(steps),
      seed,
    });
    expect(ran).toEqual(["c", "d"]);
    expect(result.stepResults.map((step) => step.stepId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result.state).toMatchObject({ a: "a", b: "b", c: "c", d: "d" });
    expect(result.transcript.map((item) => item.id)).toEqual([
      "source:a",
      "source:b",
      "restart:c",
      "restart:d",
    ]);
    const started = events.events.find(
      (event) => event.runId === "restart" && event.type === "run.started",
    );
    expect(started?.data?.seededFrom).toEqual({
      runId: "source",
      checkpointSequence: seed.sequence,
      stepPath: "b",
      executionKey: "b",
    });
    const first = store.checkpoints.get("restart")![0]!;
    expect(first).toMatchObject({
      runId: "restart",
      sequence: 1,
      attempt: 1,
      metadata: { seededFrom: { runId: "source", stepPath: "b" } },
      ledger: { tokens: 0, inherited: { tokens: 120 } },
    });
  });

  it("uses the corrected definition of a step after the restart point", async () => {
    const { store, ran, runtime } = harness();
    await runtime().run({
      runId: "source",
      manifest: definition([prompt("a"), prompt("b", "broken")]),
    });
    ran.length = 0;
    const result = await runtime().run({
      manifest: definition([prompt("a"), prompt("b", "fixed")]),
      seed: await boundaryAfter(store, "source", "a"),
    });
    expect(ran).toEqual(["fixed"]);
    expect(result.output).toBe("fixed");
  });

  it("does not count inherited usage against the new run's limits", async () => {
    const { store, runtime } = harness();
    const steps = [prompt("a"), prompt("b"), prompt("c")];
    await runtime().run({ runId: "source", manifest: definition(steps) });
    // 120 tokens were spent before the restart point; the limit is 100.
    const result = await runtime().run({
      manifest: definition(steps, { limits: { maxTotalTokens: 100 } }),
      seed: await boundaryAfter(store, "source", "b"),
    });
    expect(result.stepResults).toHaveLength(3);
  });

  it("lists each completed step once when the run is blocked after it", async () => {
    const store = new MemoryRunStore();
    let fail = true;
    const executor: StepExecutor = {
      type: "prompt",
      execute: async (context: StepExecutionContext) => {
        if (context.step.id === "b" && fail) throw new Error("provider down");
        return { output: context.step.id };
      },
    };
    const runtime = () =>
      new AgentRuntime({ runStore: store, stepExecutors: [executor] });
    const manifest = definition([prompt("a"), prompt("b")]);
    await expect(
      runtime().run({ runId: "blocked", manifest }),
    ).rejects.toMatchObject({ reason: "blocked" });
    fail = false;
    await runtime().run({ runId: "blocked", manifest, resume: true });
    const points = await store.listCheckpoints("blocked", {
      boundaries: true,
    });
    expect(points.map((point) => point.boundary?.stepPath)).toEqual(["a", "b"]);
  });

  it("refuses a checkpoint that is not a restart point", async () => {
    const { store, runtime } = harness();
    await runtime().run({
      runId: "source",
      manifest: definition([prompt("a")]),
    });
    const initial = store.checkpoints.get("source")![0]!;
    await expect(
      runtime().run({ manifest: definition([prompt("a")]), seed: initial }),
    ).rejects.toMatchObject({ code: "SEED_INVALID" });
  });

  it("hands the seed's workspace tokens to the workspace provider", async () => {
    const contexts: WorkspaceResolutionContext[] = [];
    let commits = 0;
    const notes: WorkspaceStore = {
      mode: "read_write",
      entries: async () => [],
      read: async () => new Uint8Array(),
      write: async (path) => ({ path, size: 0 }),
      delete: async () => undefined,
      commit: async () => ({ token: `snapshot-${++commits}` }),
    };
    const runSandbox: RunSandboxProvider = {
      tools: async () => [],
      validate: async () => undefined,
      open: async () => ({
        id: "sb",
        execute: async () => ({ record: {} as never, stdout: "", stderr: "" }),
        budget: () => ({ commandsUsed: 0, sandboxSecondsUsed: 0 }),
        takeChanges: () => ({
          notes: {
            changes: [{ path: "x.md", action: "created" as const }],
            notPersisted: [],
          },
        }),
        close: async () => undefined,
      }),
    };
    const store = new MemoryRunStore();
    const executor: StepExecutor = {
      type: "prompt",
      execute: async (context) => {
        await (
          await context.runSandbox!()
        ).execute({
          stepId: context.step.id,
          kind: "shell",
          name: "shell",
          alias: "notes",
          arguments: {},
        });
        return { output: context.step.id };
      },
    };
    const runtime = () =>
      new AgentRuntime({
        runStore: store,
        runSandbox,
        workspaces: {
          resolveWorkspace: async (_binding, context) => {
            contexts.push(structuredClone({ ...context, signal: undefined }));
            return notes;
          },
        },
        stepExecutors: [executor],
      });
    const manifest = definition([prompt("a"), prompt("b")], {
      workspaces: [{ ref: "notes", mode: "read_write" }],
    });
    await runtime().run({ runId: "source", manifest });
    await runtime().run({
      runId: "restart",
      manifest,
      seed: await boundaryAfter(store, "source", "a"),
    });
    expect(contexts.at(-1)).toMatchObject({
      runId: "restart",
      restoreFrom: { notes: "snapshot-1" },
    });
  });
});
