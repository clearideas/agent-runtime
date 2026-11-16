import type {
  AgentManifest,
  AgentStep,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  RunSuspendedError,
  assessManifestChange,
  fingerprintManifest,
  type StepExecutionContext,
  type StepExecutionResult,
  type StepExecutor,
} from "./agent-runtime.js";
import { CollectingEventSink, MemoryRunStore } from "./testing/index.js";

const at = "2026-07-22T00:00:00.000Z";
const note = (id: string): TranscriptItem => ({
  id,
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: id }],
  createdAt: at,
});

const prompt = (id: string, text = id): AgentStep => ({
  id,
  type: "prompt",
  prompt: text,
});

const definition = (
  steps: AgentStep[],
  extra: Partial<AgentManifest> = {},
): AgentManifest => ({ schemaVersion: "1.0", steps, ...extra });

/**
 * Steps run their prompt text. A step whose text includes "pause" commits
 * half its work and suspends once, like a prompt step paused mid-turn.
 */
const harness = () => {
  const store = new MemoryRunStore();
  const events = new CollectingEventSink();
  const ran: string[] = [];
  const paused = new Set<string>();
  const execute = async (
    context: StepExecutionContext,
  ): Promise<StepExecutionResult> => {
    const text = (context.step as { prompt: string }).prompt;
    if (context.resume?.continuation) {
      ran.push(`${context.step.id}:resumed`);
      return {
        output: text,
        transcript: [
          ...(context.resume.transcript ?? []),
          note(`${text}-done`),
        ],
      };
    }
    ran.push(`${context.step.id}:${text}`);
    if (text.includes("pause") && !paused.has(context.step.id)) {
      paused.add(context.step.id);
      await context.checkpoint?.({
        state: { ...context.variables },
        continuation: { type: "half" },
        transcript: [note(`${text}-half`)],
      });
      throw new RunSuspendedError("paused");
    }
    return { output: text, transcript: [note(`${text}-done`)] };
  };
  const executor: StepExecutor = { type: "prompt", execute };
  const runtime = () =>
    new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      eventSinks: [events],
    });
  return { store, events, ran, runtime };
};

describe("manifest changes on resume", () => {
  it("fingerprints steps without policies or descriptions, and globals separately", async () => {
    const base = definition([prompt("a"), prompt("b")]);
    const first = await fingerprintManifest(base);
    const described = await fingerprintManifest(
      definition(
        [
          {
            ...prompt("a"),
            description: "now described",
            policies: { onError: "continue" },
          },
          prompt("b"),
        ],
        { limits: { maxTotalTokens: 5 }, description: "changed" },
      ),
    );
    expect(described).toEqual(first);
    const changed = await fingerprintManifest(
      definition([prompt("a", "different"), prompt("b")]),
    );
    expect(changed.steps[0]).not.toBe(first.steps[0]);
    expect(changed.steps[1]).toBe(first.steps[1]);
    expect(changed.global).toBe(first.global);
  });

  it("accepts a raised limit and stores the manifest for later resumes", async () => {
    const { store, runtime } = harness();
    const steps = [prompt("a"), prompt("b", "pause b"), prompt("c")];
    await expect(
      runtime().run({ runId: "r", manifest: definition(steps) }),
    ).rejects.toMatchObject({ reason: "paused" });
    const raised = definition(steps, { limits: { maxRecoveries: 50 } });
    await expect(
      runtime().run({ runId: "r", manifest: raised, resume: true }),
    ).resolves.toBeDefined();
    expect((await store.loadRun("r"))?.manifest.limits).toEqual({
      maxRecoveries: 50,
    });
  });

  it("accepts changes to steps not yet reached", async () => {
    const { ran, runtime } = harness();
    await expect(
      runtime().run({
        runId: "later",
        manifest: definition([prompt("a", "pause a"), prompt("b")]),
      }),
    ).rejects.toMatchObject({ reason: "paused" });
    const result = await runtime().run({
      runId: "later",
      resume: true,
      manifest: definition([
        prompt("a", "pause a"),
        prompt("b", "rewritten"),
        prompt("c"),
      ]),
    });
    expect(ran).toEqual(["a:pause a", "a:resumed", "b:rewritten", "c:c"]);
    expect(result.stepResults.map((step) => step.output)).toEqual([
      "pause a",
      "rewritten",
      "c",
    ]);
  });

  it("restarts an in-progress step that changed, keeping earlier results", async () => {
    const { ran, runtime, events } = harness();
    await expect(
      runtime().run({
        runId: "restart",
        manifest: definition([prompt("a"), prompt("b", "pause b")]),
      }),
    ).rejects.toMatchObject({ reason: "paused" });
    const result = await runtime().run({
      runId: "restart",
      resume: true,
      manifest: definition([prompt("a"), prompt("b", "fixed prompt")]),
    });
    expect(ran).toEqual(["a:a", "b:pause b", "b:fixed prompt"]);
    // The abandoned half of step b is not in the run's transcript.
    expect(result.transcript.map((item) => item.id)).toEqual([
      "a-done",
      "fixed prompt-done",
    ]);
    expect(
      events.events.find(
        (event) =>
          event.type === "diagnostic" &&
          event.data?.code === "STEP_RESTARTED_AFTER_MANIFEST_CHANGE",
      )?.stepId,
    ).toBe("b");
  });

  it("refuses a changed completed step without touching the run", async () => {
    const { store, runtime } = harness();
    await expect(
      runtime().run({
        runId: "refuse",
        manifest: definition([prompt("a"), prompt("b", "pause b")]),
      }),
    ).rejects.toMatchObject({ reason: "paused" });
    const before = await store.loadRun("refuse");
    await expect(
      runtime().run({
        runId: "refuse",
        resume: true,
        manifest: definition([prompt("a", "edited"), prompt("b", "pause b")]),
      }),
    ).rejects.toMatchObject({
      code: "MANIFEST_CHANGED",
      message: expect.stringContaining("step a already completed"),
    });
    expect(await store.loadRun("refuse")).toEqual(before);
  });

  it("refuses changes to variables and to an in-progress loop", async () => {
    const { runtime } = harness();
    await expect(
      runtime().run({
        runId: "globals",
        manifest: definition([prompt("a", "pause a")], {
          variables: [{ key: "x", type: "string", value: "1" }],
        }),
      }),
    ).rejects.toMatchObject({ reason: "paused" });
    await expect(
      runtime().run({
        runId: "globals",
        resume: true,
        manifest: definition([prompt("a", "pause a")], {
          variables: [{ key: "x", type: "string", value: "2" }],
        }),
      }),
    ).rejects.toMatchObject({ code: "MANIFEST_CHANGED" });

    const store = new MemoryRunStore();
    const loopExecutor: StepExecutor = {
      type: "loop",
      execute: async (context) => {
        await context.checkpoint?.({
          state: { ...context.variables },
          continuation: { type: "loop", stepId: context.step.id },
        });
        throw new RunSuspendedError("paused");
      },
    };
    const loop = (text: string): AgentStep => ({
      id: "each",
      type: "loop",
      loop: { maxIterations: 2 },
      steps: [prompt("inner", text)],
    });
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        loopExecutor,
        { type: "prompt", execute: async () => ({}) },
      ],
    });
    await expect(
      runner.run({ runId: "loop", manifest: definition([loop("one")]) }),
    ).rejects.toMatchObject({ reason: "paused" });
    await expect(
      runner.run({
        runId: "loop",
        resume: true,
        manifest: definition([loop("two")]),
      }),
    ).rejects.toMatchObject({
      code: "MANIFEST_CHANGED",
      message: expect.stringContaining("loop step each changed"),
    });
  });
});

describe("assessing a manifest change before resuming", () => {
  it("tells a host what a resume with an edited manifest would do", async () => {
    const { store, runtime } = harness();
    const steps = [prompt("a"), prompt("b", "pause b"), prompt("c")];
    const original = definition(steps, {
      variables: [{ key: "x", type: "string", value: "1" }],
    });
    await expect(
      runtime().run({ runId: "assess", manifest: original }),
    ).rejects.toMatchObject({ reason: "paused" });
    const paused = (await store.loadLatestCheckpoint("assess"))!;
    const assess = (changed: AgentManifest) =>
      assessManifestChange(paused, changed);

    expect(await assess(original)).toMatchObject({ outcome: "unchanged" });
    expect(
      await assess({ ...original, limits: { maxRecoveries: 500 } }),
    ).toMatchObject({ outcome: "accepted", changedSteps: [] });
    expect(
      await assess({
        ...original,
        steps: [prompt("a"), prompt("b", "pause b"), prompt("c", "new")],
      }),
    ).toMatchObject({ outcome: "accepted", changedSteps: ["c"] });
    expect(
      await assess({
        ...original,
        steps: [prompt("a"), prompt("b", "pause b, revised"), prompt("c")],
      }),
    ).toMatchObject({ outcome: "restarts-step", step: "b" });
    expect(
      await assess({
        ...original,
        steps: [prompt("a", "edited"), prompt("b", "pause b"), prompt("c")],
      }),
    ).toMatchObject({ outcome: "refused", step: "a", changedSteps: ["a"] });
    expect(
      await assess({
        ...original,
        variables: [{ key: "x", type: "string", value: "2" }],
      }),
    ).toMatchObject({ outcome: "refused", globalChanged: true });

    // The assessment matches what a resume does.
    await expect(
      runtime().run({
        runId: "assess",
        resume: true,
        manifest: {
          ...original,
          steps: [prompt("a", "edited"), prompt("b", "pause b"), prompt("c")],
        },
      }),
    ).rejects.toMatchObject({ code: "MANIFEST_CHANGED" });
  });
});
