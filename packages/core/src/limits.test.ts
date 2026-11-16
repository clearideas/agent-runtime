import type {
  AgentManifest,
  RunCheckpoint,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import { DEFAULT_RUN_LIMITS } from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  RunSuspendedError,
  suspensionKind,
  type StepExecutionContext,
  type StepExecutionResult,
  type StepExecutor,
} from "./agent-runtime.js";
import { resolveRunLimits } from "./limits.js";
import type {
  RunSandboxOpenRequest,
  RunSandboxProvider,
  WorkspaceStore,
} from "./ports/index.js";
import { CollectingEventSink, MemoryRunStore } from "./testing/index.js";

const at = "2026-07-22T00:00:00.000Z";
let counter = 0;
const item = (tokens: number): TranscriptItem => ({
  id: `item-${++counter}`,
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "x" }],
  createdAt: at,
  usage: { totalTokens: tokens },
});

const manifest = (
  limits: AgentManifest["limits"] = {},
  steps = ["one", "two"],
): AgentManifest => ({
  schemaVersion: "1.0",
  limits,
  steps: steps.map((id) => ({ id, type: "prompt" as const, prompt: id })),
});

const runtime = (
  store: MemoryRunStore,
  execute: (
    context: StepExecutionContext,
  ) => Promise<StepExecutionResult> | StepExecutionResult,
  extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
) => {
  const executor: StepExecutor = { type: "prompt", execute };
  return new AgentRuntime({
    runStore: store,
    stepExecutors: [executor],
    ...extra,
  });
};

const blockedDetails = (error: unknown) => {
  expect(error).toBeInstanceOf(RunSuspendedError);
  const suspended = error as RunSuspendedError;
  expect(suspended.reason).toBe("blocked");
  expect(suspensionKind(suspended.reason)).toBe("awaiting-host");
  return suspended.details;
};

describe("run limits", () => {
  it("resolves defaults, host defaults, the manifest, grants, and host ceilings in order", () => {
    const limits = resolveRunLimits(
      manifest({
        maxTotalTokens: 500,
        maxRecoveries: 3,
        sandbox: { maxCommands: 50 },
      }),
      {
        defaults: { maxRunActiveMs: 60_000, maxRecoveries: 1 },
        granted: { maxTotalTokens: 900, sandbox: { maxCommands: 400 } },
        ceilings: {
          maxTotalTokens: 800,
          maxArtifacts: 5,
          sandbox: { maxCommands: 300 },
        },
      },
    );
    expect(limits).toEqual({
      ...DEFAULT_RUN_LIMITS,
      maxTotalTokens: 800, // granted 900, capped by the host at 800
      maxRecoveries: 3, // the manifest overrides the host default
      maxRunActiveMs: 60_000, // the host's default replaces the runtime's
      maxArtifacts: 5, // a host ceiling lowers a default
      sandbox: { maxCommands: 300 },
    });
  });

  it("gives every run anti-runaway defaults", async () => {
    expect(DEFAULT_RUN_LIMITS).toEqual({
      maxTotalTokens: 25_000_000,
      maxRunActiveMs: 86_400_000,
      maxStepActiveMs: 14_400_000,
      maxRecoveries: 100,
      maxResumesWithoutProgress: 10,
      maxTurnsPerPrompt: 500,
      maxLoopIterations: 10_000,
      maxArtifacts: 10_000,
      maxArtifactBytes: 10 * 1024 ** 3,
      maxCheckpointBytes: 64 * 1024 ** 2,
    });
    expect(resolveRunLimits(manifest())).toEqual({
      ...DEFAULT_RUN_LIMITS,
      sandbox: {},
    });
    await expect(
      runtime(new MemoryRunStore(), () => ({
        output: "ok",
        transcript: [item(30_000_000)],
      })).run({ manifest: manifest({}, ["one", "two"]) }),
    ).rejects.toMatchObject({
      reason: "blocked",
      details: { limit: "maxTotalTokens", value: 25_000_000 },
    });
    // A host raises a default for every run; a manifest can too.
    await expect(
      runtime(
        new MemoryRunStore(),
        () => ({ output: "ok", transcript: [item(30_000_000)] }),
        { limits: { maxTotalTokens: 100_000_000 } },
      ).run({ manifest: manifest({}, ["one", "two"]) }),
    ).resolves.toBeDefined();
  });

  it("limits reported cost when a limit is set", async () => {
    let caught: unknown;
    await runtime(new MemoryRunStore(), () => ({
      output: "ok",
      transcript: [
        { ...item(10), usage: { totalTokens: 10, estimatedCost: 0.75 } },
      ],
    }))
      .run({ manifest: manifest({ maxEstimatedCost: 1 }, ["one", "two"]) })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toEqual({
      cause: "limit",
      limit: "maxEstimatedCost",
      used: 1.5,
      value: 1,
    });
  });

  it("writes contract 1.1 checkpoints that carry the run ledger", async () => {
    const store = new MemoryRunStore();
    await runtime(store, () => ({
      output: "ok",
      transcript: [item(40)],
      artifacts: [{ id: "a", name: "a.txt", mediaType: "text/plain", size: 7 }],
    })).run({ runId: "ledger", manifest: manifest() });
    const latest = store.checkpoints.get("ledger")!.at(-1)!;
    expect(latest.contractVersion).toBe("1.1");
    expect(latest.ledger).toMatchObject({
      tokens: 80,
      artifacts: { count: 2, bytes: 14 },
    });
  });

  it("suspends at the token limit, records why, and resumes when more is granted", async () => {
    const store = new MemoryRunStore();
    const ran: string[] = [];
    const runner = runtime(store, ({ step }) => {
      ran.push(step.id);
      return { output: step.id, transcript: [item(60)] };
    });
    let caught: unknown;
    await runner
      .run({
        runId: "tokens",
        manifest: manifest({ maxTotalTokens: 100 }, ["one", "two", "three"]),
      })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toEqual({
      cause: "limit",
      limit: "maxTotalTokens",
      used: 120,
      value: 100,
    });
    expect((await store.loadRun("tokens"))?.status).toBe("suspended");
    const blocked = await store.loadLatestCheckpoint("tokens");
    expect(blocked?.ledger?.blocked).toMatchObject({
      cause: "limit",
      code: "maxTotalTokens",
      used: 120,
      value: 100,
    });
    // Two steps completed; the limit was checked after the second committed.
    expect(blocked?.cursor.stepIndex).toBe(2);

    // Resuming without a higher limit is blocked again before any work.
    await expect(runner.run({ runId: "tokens", resume: true })).rejects.toThrow(
      RunSuspendedError,
    );
    expect(ran).toEqual(["one", "two"]);
    const result = await runner.run({
      runId: "tokens",
      resume: true,
      limits: { maxTotalTokens: 1_000 },
    });
    expect(result.stepResults).toHaveLength(3);
    expect(ran).toEqual(["one", "two", "three"]);
  });

  it("keeps granted limits for later attempts", async () => {
    const store = new MemoryRunStore();
    let attempt = 0;
    const runner = runtime(store, async (context) => {
      attempt += 1;
      if (attempt === 1) {
        await context.checkpoint?.({
          state: { ...context.variables },
          transcript: [item(150)],
        });
      }
      if (attempt === 2) throw new RunSuspendedError("paused");
      return { output: "ok", transcript: [item(150)] };
    });
    await expect(
      runner.run({
        runId: "granted",
        manifest: manifest({ maxTotalTokens: 100 }, ["one"]),
      }),
    ).rejects.toMatchObject({ reason: "blocked" });
    await expect(
      runner.run({
        runId: "granted",
        resume: true,
        limits: { maxTotalTokens: 10_000 },
      }),
    ).rejects.toMatchObject({ reason: "paused" });
    expect(
      (await store.loadLatestCheckpoint("granted"))?.ledger?.granted,
    ).toEqual({ maxTotalTokens: 10_000 });
    // No limits supplied: the grant still applies.
    await expect(
      runner.run({ runId: "granted", resume: true }),
    ).resolves.toBeDefined();
  });

  it("limits a step's own tokens while it runs", async () => {
    const store = new MemoryRunStore();
    let caught: unknown;
    await runtime(store, async (context) => {
      await context.checkpoint?.({
        state: { ...context.variables },
        transcript: [item(30), item(30)],
      });
      return { output: "never" };
    })
      .run({
        runId: "step-tokens",
        manifest: manifest({ maxStepTokens: 50 }, ["one"]),
      })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toEqual({
      cause: "limit",
      limit: "maxStepTokens",
      used: 60,
      value: 50,
      stepId: "one",
    });
  });

  it("limits artifacts and refuses a checkpoint above the size limit", async () => {
    const artifacts = new MemoryRunStore();
    let caught: unknown;
    await runtime(artifacts, () => ({
      output: "ok",
      artifacts: [
        { id: "a", name: "a", mediaType: "text/plain", size: 1 },
        { id: "b", name: "b", mediaType: "text/plain", size: 1 },
      ],
    }))
      .run({ runId: "art", manifest: manifest({ maxArtifacts: 1 }, ["one"]) })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toMatchObject({ limit: "maxArtifacts" });

    const big = new MemoryRunStore();
    caught = undefined;
    await runtime(big, () => ({ output: "x".repeat(5_000) }))
      .run({
        runId: "big",
        manifest: manifest({ maxCheckpointBytes: 4_000 }, ["one"]),
      })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toMatchObject({
      limit: "maxCheckpointBytes",
      value: 4_000,
    });
    // The oversized checkpoint was never saved; the run resumes from the last one.
    expect(
      big.checkpoints
        .get("big")!
        .every((checkpoint) => checkpoint.stepResults.length === 0),
    ).toBe(true);
  });

  it("limits recoveries, not resumes that answer a suspension", async () => {
    const store = new MemoryRunStore();
    let attempt = 0;
    const runner = runtime(store, async (context) => {
      attempt += 1;
      // Every attempt makes progress, so only the recovery count applies.
      await context.checkpoint?.({ state: { ...context.variables, attempt } });
      if (attempt <= 3) throw new RunSuspendedError("paused");
      throw new Error("flaky provider");
    });
    const definition = manifest(
      { maxRecoveries: 2, maxResumesWithoutProgress: 100 },
      ["one"],
    );
    await expect(
      runner.run({ runId: "recoveries", manifest: definition }),
    ).rejects.toMatchObject({ reason: "paused" });
    // Two resumes of a paused run are not recoveries.
    for (let index = 0; index < 2; index += 1)
      await expect(
        runner.run({ runId: "recoveries", resume: true }),
      ).rejects.toMatchObject({ reason: "paused" });
    // The next attempt fails (blocked by an error); each resume after it is a recovery.
    await expect(
      runner.run({ runId: "recoveries", resume: true }),
    ).rejects.toMatchObject({ details: { cause: "error" } });
    await expect(
      runner.run({ runId: "recoveries", resume: true }),
    ).rejects.toMatchObject({ details: { cause: "error" } });
    await expect(
      runner.run({ runId: "recoveries", resume: true }),
    ).rejects.toMatchObject({ details: { cause: "error" } });
    let caught: unknown;
    await runner
      .run({ runId: "recoveries", resume: true })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toEqual({
      cause: "limit",
      limit: "maxRecoveries",
      used: 3,
      value: 2,
    });
    expect(
      (await store.loadLatestCheckpoint("recoveries"))?.ledger?.recoveries,
    ).toBe(3);
  });

  it("stops a crash loop: repeated failures that make no progress", async () => {
    const store = new MemoryRunStore();
    let calls = 0;
    const runner = runtime(store, () => {
      calls += 1;
      throw new Error("provider unavailable");
    });
    const definition = manifest({ maxResumesWithoutProgress: 2 }, ["one"]);
    await expect(
      runner.run({ runId: "loop", manifest: definition }),
    ).rejects.toThrow("provider unavailable");
    await expect(runner.run({ runId: "loop", resume: true })).rejects.toThrow(
      "provider unavailable",
    );
    expect(
      (await store.loadLatestCheckpoint("loop"))?.ledger?.stalledResumes,
    ).toMatchObject({ count: 1 });
    await expect(runner.run({ runId: "loop", resume: true })).rejects.toThrow(
      "provider unavailable",
    );
    let caught: unknown;
    await runner
      .run({ runId: "loop", resume: true })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toMatchObject({
      limit: "maxResumesWithoutProgress",
      used: 3,
      value: 2,
    });
    // The blocked attempt never re-ran the failing step.
    expect(calls).toBe(3);
  });

  it("does not count resumes after progress or after an intended suspension", async () => {
    const store = new MemoryRunStore();
    let attempt = 0;
    const runner = runtime(store, async (context) => {
      attempt += 1;
      // Every attempt commits new progress before it fails.
      await context.checkpoint?.({
        state: { ...context.variables, attempt },
      });
      if (attempt < 5) throw new Error("flaky");
      return { output: "ok" };
    });
    const definition = manifest({ maxResumesWithoutProgress: 1 }, ["one"]);
    await expect(
      runner.run({ runId: "progress", manifest: definition }),
    ).rejects.toThrow("flaky");
    for (let index = 0; index < 3; index += 1)
      await expect(
        runner.run({ runId: "progress", resume: true }),
      ).rejects.toThrow("flaky");
    await expect(
      runner.run({ runId: "progress", resume: true }),
    ).resolves.toMatchObject({ output: "ok" });
  });

  it("aborts a run that exceeds its active time, and a step that exceeds its own", async () => {
    const wait = (signal: AbortSignal | undefined) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const store = new MemoryRunStore();
    let caught: unknown;
    await runtime(store, ({ signal }) => wait(signal))
      .run({ runId: "run-time", manifest: manifest({ maxRunActiveMs: 30 }) })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toMatchObject({
      limit: "maxRunActiveMs",
      value: 30,
    });
    expect((await store.loadRun("run-time"))?.status).toBe("suspended");

    caught = undefined;
    await runtime(store, ({ signal }) => wait(signal))
      .run({ runId: "step-time", manifest: manifest({ maxStepActiveMs: 30 }) })
      .catch((error: unknown) => (caught = error));
    expect(blockedDetails(caught)).toMatchObject({
      limit: "maxStepActiveMs",
      value: 30,
      stepId: "one",
    });
  });

  it("resumes a 1.0 checkpoint and carries its sandbox usage into the ledger", async () => {
    const store = new MemoryRunStore();
    const definition = manifest({}, ["one"]);
    await store.createRun({
      runId: "legacy",
      manifest: definition,
      status: "suspended",
      attempt: 1,
      state: {},
      createdAt: at,
      updatedAt: at,
    });
    const { defaultManifestHasher } = await import("./agent-runtime.js");
    const legacy: RunCheckpoint = {
      id: "checkpoint-legacy",
      runId: "legacy",
      sequence: 1,
      attempt: 1,
      manifestHash: await defaultManifestHasher.hash(definition),
      contractVersion: "1.0",
      runtimeVersion: "0.9.0",
      cursor: { stepIndex: 0 },
      state: {},
      stepResults: [],
      transcript: [item(25)],
      artifacts: [],
      createdAt: at,
      metadata: { sandboxBudget: { commandsUsed: 4, sandboxSecondsUsed: 2 } },
    };
    await store.saveCheckpoint(legacy);
    await runtime(store, () => ({ output: "ok" })).run({
      runId: "legacy",
      resume: true,
    });
    expect((await store.loadLatestCheckpoint("legacy"))?.ledger).toMatchObject({
      tokens: 25,
      sandbox: { commands: 4, seconds: 2 },
    });
  });

  it("passes sandbox usage limits to the run sandbox", async () => {
    const opened: RunSandboxOpenRequest[] = [];
    const runSandbox: RunSandboxProvider = {
      tools: async () => [],
      validate: async () => undefined,
      open: async (request) => {
        opened.push(request);
        return {
          id: "sb",
          execute: async () => {
            throw new Error("unused");
          },
          budget: () => ({ commandsUsed: 0, sandboxSecondsUsed: 0 }),
          close: async () => undefined,
        };
      },
    };
    const workspace: WorkspaceStore = {
      mode: "read",
      entries: async () => [],
      read: async () => new Uint8Array(),
    };
    await runtime(
      new MemoryRunStore(),
      async (context) => {
        await context.runSandbox!();
        return { output: "ok" };
      },
      {
        runSandbox,
        workspaces: { resolveWorkspace: async () => workspace },
        enforcedLimits: { sandbox: { maxCommands: 20 } },
      },
    ).run({
      manifest: {
        ...manifest({ sandbox: { maxCommands: 50, maxSeconds: 60 } }, ["one"]),
        workspaces: [{ ref: "w" }],
      },
    });
    expect(opened[0]?.limits).toEqual({ maxCommands: 20, maxSeconds: 60 });
  });

  it("reports blocked runs to event sinks with the awaiting-host kind", async () => {
    const events = new CollectingEventSink();
    await runtime(
      new MemoryRunStore(),
      () => ({ output: "ok", transcript: [item(500)] }),
      { eventSinks: [events] },
    )
      .run({ manifest: manifest({ maxTotalTokens: 100 }, ["one"]) })
      .catch(() => undefined);
    expect(
      events.events.find((event) => event.type === "run.suspended")?.data,
    ).toMatchObject({
      reason: "blocked",
      kind: "awaiting-host",
      details: { cause: "limit", limit: "maxTotalTokens" },
    });
  });
});
