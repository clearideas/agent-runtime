import { JexlConditionEvaluator } from "@clearideas/agent-runtime-condition-jexl";
import type {
  JsonValue,
  LoopStep,
  PromptStep,
  AgentManifest,
  AgentVariableType,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import {
  AgentRuntime,
  RunSuspendedError,
  type StepExecutor,
} from "@clearideas/agent-runtime-core";
import {
  MemoryRunStore,
  SequenceIdGenerator,
} from "@clearideas/agent-runtime-core/testing";
import { describe, expect, it } from "vitest";

import { LoopStepExecutor } from "./index.js";

const prompt = (id: string, outputVariable: string): PromptStep => ({
  id,
  type: "prompt",
  prompt: id,
  outputVariable,
});

const variableType = (value: JsonValue): AgentVariableType => {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
};

const manifest = (loop: LoopStep, variables: VariableState): AgentManifest => ({
  schemaVersion: "1.0",
  variables: Object.entries(variables).map(([key, value]) => ({
    key,
    type: variableType(value),
    value,
  })),
  steps: [loop],
});

const createRunner = (
  store: MemoryRunStore,
  childExecutor: StepExecutor,
): AgentRuntime =>
  new AgentRuntime({
    runStore: store,
    stepExecutors: [new LoopStepExecutor(), childExecutor],
    conditionEvaluator: new JexlConditionEvaluator(),
    idGenerator: new SequenceIdGenerator(),
  });

describe("LoopStepExecutor with conversation messages", () => {
  it("iterates over the history and never stores the messages view", async () => {
    const store = new MemoryRunStore();
    const seen: Array<{ item: JsonValue; count: JsonValue }> = [];
    const child: StepExecutor = {
      type: "prompt",
      execute: async ({ variables }) => {
        const view = variables.messages as { count: JsonValue };
        seen.push({ item: variables.turn ?? null, count: view.count });
        return { output: "ok", statePatch: { set: { last: "ok" } } };
      },
    };
    const chat: AgentManifest = {
      schemaVersion: "1.0",
      messages: {},
      steps: [
        {
          id: "turns",
          type: "loop",
          history: { last: 2 },
          loop: {
            source: "messages.all",
            itemVariable: "turn",
            condition: 'turn.role == "user" && messages.count == 2',
          },
          steps: [
            { id: "inspect", type: "prompt", prompt: "x", history: "all" },
          ],
        },
      ],
    };
    const result = await createRunner(store, child).run({
      manifest: chat,
      runId: "loop-messages",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });
    expect(seen).toEqual([
      {
        item: {
          role: "user",
          content: [{ type: "text", text: "three" }],
          turn: 2,
          position: 3,
        },
        count: 3,
      },
    ]);
    expect(JSON.stringify(result.state)).not.toContain('"count"');
    for (const checkpoint of store.checkpoints.get("loop-messages")!) {
      expect(JSON.stringify(checkpoint.state)).not.toContain('"lastUser"');
    }
  });
});

describe("LoopStepExecutor", () => {
  it("filters collection items while retaining source indices", async () => {
    const visited: Array<{ name: string; index: string }> = [];
    const child = prompt("process", "candidateResult");
    const loop: LoopStep = {
      id: "candidates-loop",
      type: "loop",
      outputVariable: "processed",
      loop: {
        source: "candidates",
        itemVariable: "candidate",
        indexVariable: "candidateIndex",
        condition: "candidate.enabled == true",
        outputMode: "array",
      },
      steps: [child],
    };
    const childExecutor: StepExecutor = {
      type: "prompt",
      execute: async ({ variables }) => {
        const candidate = variables.candidate as { name: string };
        const index = String(variables.candidateIndex);
        visited.push({ name: candidate.name, index });
        const output = `${index}:${candidate.name}`;
        return {
          output,
          statePatch: { set: { candidateResult: output } },
        };
      },
    };
    const store = new MemoryRunStore();
    const result = await createRunner(store, childExecutor).run({
      runId: "collection-loop",
      manifest: manifest(loop, {
        candidates: [
          { name: "alpha", enabled: true },
          { name: "beta", enabled: false },
          { name: "gamma", enabled: true },
        ],
      }),
    });

    expect(visited).toEqual([
      { name: "alpha", index: "0" },
      { name: "gamma", index: "2" },
    ]);
    expect(result.output).toEqual(["0:alpha", "2:gamma"]);
    expect(result.variables.processed).toEqual(["0:alpha", "2:gamma"]);
  });

  it("carries previous iteration state and stops when a goal is met", async () => {
    const draft = prompt("draft", "draft");
    const review = prompt("review", "review");
    const loop: LoopStep = {
      id: "goal-loop",
      type: "loop",
      outputVariable: "acceptedScore",
      loop: {
        maxIterations: 5,
        goal: "{{review.score}} >= {{targetScore}}",
        resultVariable: "review.score",
        outputMode: "final",
      },
      steps: [draft, review],
    };
    const previousScores: Array<number | undefined> = [];
    const childExecutor: StepExecutor = {
      type: "prompt",
      execute: async ({ step, variables }) => {
        const loopMemory = variables.loop as {
          iteration: number;
          previous?: { variables?: { review?: { score?: number } } };
        };
        if (step.id === "draft") {
          previousScores.push(loopMemory.previous?.variables?.review?.score);
          const output = `draft-${loopMemory.iteration}`;
          return { output, statePatch: { set: { draft: output } } };
        }
        const output = {
          score: loopMemory.iteration,
          draft: String(variables.draft),
        };
        return { output, statePatch: { set: { review: output } } };
      },
    };
    const result = await createRunner(new MemoryRunStore(), childExecutor).run({
      runId: "goal-loop",
      manifest: manifest(loop, { targetScore: "3" }),
    });

    expect(previousScores).toEqual([undefined, 1, 2]);
    expect(result.output).toBe(3);
    expect(result.variables.acceptedScore).toBe(3);
    expect(result.variables.review).toEqual({ score: 3, draft: "draft-3" });
    expect(result.variables.loop).toMatchObject({
      outputs: [1, 2, 3],
      goalMet: true,
      goalMetAtIteration: 3,
    });
  });

  it("replaces a result variable with each final child output when no child writes it", async () => {
    const increment = prompt("increment", "number");
    const loop: LoopStep = {
      id: "accumulator-loop",
      type: "loop",
      loop: {
        maxIterations: 10,
        goal: "{{number}} > 5",
        resultVariable: "result",
        outputMode: "final",
      },
      steps: [increment],
    };
    const childExecutor: StepExecutor = {
      type: "prompt",
      execute: async ({ variables }) => {
        const output = Number(variables.result ?? 0) + 1;
        return { output, statePatch: { set: { number: output } } };
      },
    };

    const result = await createRunner(new MemoryRunStore(), childExecutor).run({
      runId: "accumulator-loop",
      manifest: manifest(loop, {}),
    });

    expect(result.output).toBe(6);
    expect(result.variables.number).toBe(6);
    expect(result.variables.result).toBe(6);
    expect(result.variables.loop).toMatchObject({
      outputs: [1, 2, 3, 4, 5, 6],
      goalMet: true,
      goalMetAtIteration: 6,
    });
  });

  it("resumes at the next child without replaying the committed child", async () => {
    const draft = prompt("draft", "draft");
    const finalize = prompt("finalize", "finalItem");
    const loop: LoopStep = {
      id: "resume-loop",
      type: "loop",
      outputVariable: "processed",
      loop: {
        source: "items",
        itemVariable: "item",
        indexVariable: "itemIndex",
        outputMode: "array",
      },
      steps: [draft, finalize],
    };
    const calls: string[] = [];
    let failFinalize = true;
    const childExecutor: StepExecutor = {
      type: "prompt",
      execute: async ({ step, variables }) => {
        calls.push(step.id);
        const item = variables.item as { name: string };
        if (step.id === "draft") {
          const output = `${item.name}-draft`;
          return {
            output,
            statePatch: { set: { draft: output } },
            transcript: [
              {
                id: "draft-message",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: output }],
                createdAt: "2026-07-22T12:00:00.000Z",
              },
            ],
            artifacts: [
              {
                id: "draft-artifact",
                name: "draft.txt",
                mediaType: "text/plain",
              },
            ],
          };
        }
        if (failFinalize) {
          failFinalize = false;
          throw new Error("temporary child failure");
        }
        const output = `${String(variables.draft)}-final`;
        return {
          output,
          statePatch: { set: { finalItem: output } },
          transcript: [
            {
              id: "final-message",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: output }],
              createdAt: "2026-07-22T12:00:01.000Z",
            },
          ],
          artifacts: [
            {
              id: "final-artifact",
              name: "final.txt",
              mediaType: "text/plain",
            },
          ],
        };
      },
    };
    const store = new MemoryRunStore();
    const firstRunner = createRunner(store, childExecutor);
    await expect(
      firstRunner.run({
        runId: "resume-loop",
        manifest: manifest(loop, { items: [{ name: "alpha" }] }),
      }),
    ).rejects.toThrow("temporary child failure");
    expect(calls).toEqual(["draft", "finalize"]);
    expect(store.checkpoints.get("resume-loop")?.at(-1)?.cursor).toMatchObject({
      stepPath: "resume-loop/finalize",
      childIndex: 1,
    });

    const result = await createRunner(store, childExecutor).run({
      runId: "resume-loop",
      resume: true,
    });

    expect(calls).toEqual(["draft", "finalize", "finalize"]);
    expect(result.output).toEqual(["alpha-draft-final"]);
    expect(result.variables.processed).toEqual(["alpha-draft-final"]);
    expect(result.stepResults[0]?.transcript?.map((item) => item.id)).toEqual([
      "draft-message",
      "final-message",
    ]);
    expect(result.stepResults[0]?.artifacts?.map((item) => item.id)).toEqual([
      "draft-artifact",
      "final-artifact",
    ]);
    expect(result.transcript.map((item) => item.id)).toEqual([
      "draft-message",
      "final-message",
    ]);
    expect(result.artifacts.map((item) => item.id)).toEqual([
      "draft-artifact",
      "final-artifact",
    ]);
  });

  it("ends the loop and the run when a child returns endRun", async () => {
    const store = new MemoryRunStore();
    const ran: string[] = [];
    const runner = createRunner(store, {
      type: "prompt",
      execute: async ({ step, variables }) => {
        ran.push(`${step.id}:${String(variables.item)}`);
        return variables.item === "b"
          ? { output: "stop", endRun: true }
          : { output: String(variables.item) };
      },
    });
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      loop: { source: "items" },
      steps: [prompt("work", "result"), prompt("after", "later")],
    };
    const result = await runner.run({
      manifest: {
        ...manifest(loop, { items: ["a", "b", "c"] }),
        steps: [loop, prompt("final", "finalValue")],
      },
    });
    expect(ran).toEqual(["work:a", "after:a", "work:b"]);
    expect(result.stepResults.map((entry) => entry.stepId)).toEqual(["each"]);
  });

  it("continues past a failed child whose onError is continue", async () => {
    const store = new MemoryRunStore();
    const runner = createRunner(store, {
      type: "prompt",
      execute: async ({ variables }) => {
        if (variables.item === "b") throw new Error("item b is broken");
        return { output: `ok ${String(variables.item)}` };
      },
    });
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      loop: { source: "items" },
      steps: [
        { ...prompt("work", "result"), policies: { onError: "continue" } },
      ],
    };
    const result = await runner.run({
      manifest: manifest(loop, { items: ["a", "b", "c"] }),
    });
    expect(result.output).toEqual([
      "ok a",
      {
        error: { code: "AGENT_EXECUTION_FAILED", message: "item b is broken" },
      },
      "ok c",
    ]);
  });
});

describe("LoopStepExecutor resuming a child that was mid-step", () => {
  const at = "2026-07-22T12:00:00.000Z";
  const message = (id: string) => ({
    id,
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: id }],
    createdAt: at,
  });

  /**
   * A child that, for one chosen item, commits half its work through a
   * nested checkpoint and then suspends, the way a prompt step does after a
   * tool result when the run pauses or runs out of token budget.
   */
  const pausingChild = (pauseOn: (variables: VariableState) => boolean) => {
    const calls: string[] = [];
    let paused = false;
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ variables, resume, checkpoint, executionKey }) => {
        const item = String(variables.item);
        const label = `${item}${variables.outer ? `@${String(variables.outer)}` : ""}`;
        if (resume?.continuation) {
          calls.push(`${label}:resumed`);
          expect(resume.continuation).toEqual({ type: "fake", label });
          expect(resume.transcript?.map((entry) => entry.id)).toEqual([
            `${label}-half`,
          ]);
          return {
            output: `done ${label}`,
            transcript: [...resume.transcript!, message(`${label}-done`)],
            metadata: { executionKey: executionKey ?? null },
          };
        }
        calls.push(`${label}:started`);
        if (!paused && pauseOn(variables)) {
          paused = true;
          await checkpoint!({
            state: { ...variables },
            continuation: { type: "fake", label },
            transcript: [message(`${label}-half`)],
          });
          throw new RunSuspendedError("paused");
        }
        return {
          output: `done ${label}`,
          transcript: [message(`${label}-done`)],
          metadata: { executionKey: executionKey ?? null },
        };
      },
    };
    return { calls, executor };
  };

  it("resumes the paused child in its iteration without replaying earlier ones", async () => {
    const { calls, executor } = pausingChild((v) => v.item === "beta");
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      outputVariable: "results",
      loop: { source: "items", itemVariable: "item" },
      steps: [{ id: "work", type: "prompt", prompt: "{{ item }}" }],
    };
    const store = new MemoryRunStore();
    const definition = manifest(loop, { items: ["alpha", "beta", "gamma"] });
    await expect(
      createRunner(store, executor).run({ runId: "r", manifest: definition }),
    ).rejects.toBeInstanceOf(RunSuspendedError);
    const saved = store.checkpoints.get("r")!.at(-1)!;
    expect(saved.cursor).toMatchObject({
      stepPath: "each/work",
      loopIteration: 2,
      childIndex: 0,
    });
    expect(saved.continuation).toMatchObject({
      type: "loop",
      iterationIndex: 1,
      child: { continuation: { type: "fake", label: "beta" } },
    });

    const result = await createRunner(store, executor).run({
      runId: "r",
      resume: true,
    });
    expect(calls).toEqual([
      "alpha:started",
      "beta:started",
      "beta:resumed",
      "gamma:started",
    ]);
    expect(result.output).toEqual(["done alpha", "done beta", "done gamma"]);
    expect(result.transcript.map((entry) => entry.id)).toEqual([
      "alpha-done",
      "beta-half",
      "beta-done",
      "gamma-done",
    ]);
  });

  it("frames nested loops at every level", async () => {
    const { calls, executor } = pausingChild(
      (v) => v.outer === "2" && v.item === "b",
    );
    const loop: LoopStep = {
      id: "outer",
      type: "loop",
      outputVariable: "results",
      loop: { source: "rows", itemVariable: "outer", outputMode: "array" },
      steps: [
        {
          id: "inner",
          type: "loop",
          loop: { source: "cells", itemVariable: "item" },
          steps: [{ id: "work", type: "prompt", prompt: "{{ item }}" }],
        },
      ],
    };
    const store = new MemoryRunStore();
    const definition = manifest(loop, { rows: ["1", "2"], cells: ["a", "b"] });
    await expect(
      createRunner(store, executor).run({ runId: "n", manifest: definition }),
    ).rejects.toBeInstanceOf(RunSuspendedError);
    const result = await createRunner(store, executor).run({
      runId: "n",
      resume: true,
    });
    expect(calls).toEqual([
      "a@1:started",
      "b@1:started",
      "a@2:started",
      "b@2:started",
      "b@2:resumed",
    ]);
    expect(result.transcript.map((entry) => entry.id)).toEqual([
      "a@1-done",
      "b@1-done",
      "a@2-done",
      "b@2-half",
      "b@2-done",
    ]);
  });

  it("gives each iteration its own execution key", async () => {
    const keys: string[] = [];
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ executionKey }) => {
        keys.push(executionKey!);
        return { output: "ok" };
      },
    };
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      loop: { source: "items", itemVariable: "item" },
      steps: [{ id: "work", type: "prompt", prompt: "{{ item }}" }],
    };
    await createRunner(new MemoryRunStore(), executor).run({
      manifest: manifest(loop, { items: ["x", "y"] }),
    });
    expect(keys).toEqual(["each[0]/work", "each[1]/work"]);
  });

  it("marks each completed child as a restart point", async () => {
    const executor: StepExecutor = {
      type: "prompt",
      execute: async () => ({ output: "ok" }),
    };
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      loop: { source: "items", itemVariable: "item" },
      steps: [{ id: "work", type: "prompt", prompt: "{{ item }}" }],
    };
    const store = new MemoryRunStore();
    await createRunner(store, executor).run({
      runId: "boundaries",
      manifest: manifest(loop, { items: ["x", "y"] }),
    });
    expect(
      store.checkpoints
        .get("boundaries")!
        .flatMap((checkpoint) =>
          checkpoint.boundary ? [checkpoint.boundary] : [],
        ),
    ).toEqual([
      { stepPath: "each/work", executionKey: "each[0]/work", stepIndex: 0 },
      { stepPath: "each/work", executionKey: "each[1]/work", stepIndex: 0 },
      { stepPath: "each", executionKey: "each", stepIndex: 0 },
    ]);
  });

  it("reports a saved position it cannot recognize and starts over", async () => {
    const { executor } = pausingChild((v) => v.item === "beta");
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      loop: { source: "items", itemVariable: "item" },
      steps: [{ id: "work", type: "prompt", prompt: "{{ item }}" }],
    };
    const store = new MemoryRunStore();
    const definition = manifest(loop, { items: ["alpha", "beta"] });
    await expect(
      createRunner(store, executor).run({ runId: "old", manifest: definition }),
    ).rejects.toBeInstanceOf(RunSuspendedError);
    // The shape written before loops framed their children.
    const saved = store.checkpoints.get("old")!.at(-1)!;
    saved.continuation = { type: "fake", label: "beta" };
    saved.activeStepTranscript = [];
    saved.transcript = [];
    const events: string[] = [];
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [new LoopStepExecutor(), executor],
      idGenerator: new SequenceIdGenerator(),
      eventSinks: [
        {
          emit: (event) => {
            if (event.type === "diagnostic")
              events.push(String(event.data?.code));
          },
        },
      ],
    });
    const result = await runner.run({ runId: "old", resume: true });
    expect(events).toContain("LOOP_RESUME_STATE_UNRECOGNIZED");
    expect(result.transcript.map((entry) => entry.id)).toEqual([
      "alpha-done",
      "beta-done",
    ]);
  });
});

describe("LoopStepExecutor iteration limit", () => {
  it("suspends at maxLoopIterations and continues from the next iteration when more are granted", async () => {
    const seen: string[] = [];
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ variables }) => {
        seen.push(String(variables.item));
        return { output: String(variables.item) };
      },
    };
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      loop: { source: "items", itemVariable: "item" },
      steps: [{ id: "work", type: "prompt", prompt: "{{ item }}" }],
    };
    const store = new MemoryRunStore();
    const definition: AgentManifest = {
      ...manifest(loop, { items: ["a", "b", "c", "d", "e"] }),
      limits: { maxLoopIterations: 2 },
    };
    await expect(
      createRunner(store, executor).run({ runId: "cap", manifest: definition }),
    ).rejects.toMatchObject({
      reason: "blocked",
      details: {
        cause: "limit",
        limit: "maxLoopIterations",
        used: 2,
        value: 2,
      },
    });
    expect(seen).toEqual(["a", "b"]);
    const result = await createRunner(store, executor).run({
      runId: "cap",
      resume: true,
      limits: { maxLoopIterations: 100 },
    });
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.output).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("LoopStepExecutor restart points", () => {
  it("restarts a new run from an iteration's completed child", async () => {
    const seen: string[] = [];
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ variables, runId }) => {
        seen.push(`${runId}:${String(variables.item)}`);
        return { output: String(variables.item).toUpperCase() };
      },
    };
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      outputVariable: "results",
      loop: { source: "items", itemVariable: "item" },
      steps: [{ id: "work", type: "prompt", prompt: "{{ item }}" }],
    };
    const store = new MemoryRunStore();
    const definition = manifest(loop, { items: ["a", "b", "c", "d"] });
    await createRunner(store, executor).run({
      runId: "source",
      manifest: definition,
    });
    const point = (
      await store.listCheckpoints("source", { boundaries: true })
    ).find((summary) => summary.boundary?.executionKey === "each[1]/work")!;
    const result = await createRunner(store, executor).run({
      runId: "restart",
      manifest: definition,
      seed: (await store.loadCheckpoint("source", point.sequence))!,
    });
    expect(seen.filter((entry) => entry.startsWith("restart:"))).toEqual([
      "restart:c",
      "restart:d",
    ]);
    expect(result.output).toEqual(["A", "B", "C", "D"]);
  });
});

describe("LoopStepExecutor step execution limits", () => {
  it("applies step limits to each iteration's child, not to the whole loop", async () => {
    const tokensFor: Record<string, number> = { a: 40, b: 40, c: 60 };
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ variables, checkpoint }) => {
        const item = String(variables.item);
        const transcript = [
          {
            id: `reply-${item}`,
            type: "message" as const,
            role: "assistant" as const,
            content: [{ type: "text" as const, text: item }],
            createdAt: "2026-07-22T00:00:00.000Z",
            usage: { totalTokens: tokensFor[item]! },
          },
        ];
        await checkpoint?.({ state: { ...variables }, transcript });
        return { output: item, transcript };
      },
    };
    const loop: LoopStep = {
      id: "each",
      type: "loop",
      loop: { source: "items", itemVariable: "item" },
      steps: [{ id: "work", type: "prompt", prompt: "{{ item }}" }],
    };
    const store = new MemoryRunStore();
    const definition: AgentManifest = {
      ...manifest(loop, { items: ["a", "b", "c"] }),
      limits: { maxStepTokens: 50 },
    };
    // a and b stay under 50 each although the loop passes 80; c does not.
    await expect(
      createRunner(store, executor).run({
        runId: "steps",
        manifest: definition,
      }),
    ).rejects.toMatchObject({
      reason: "blocked",
      details: {
        cause: "limit",
        limit: "maxStepTokens",
        used: 60,
        value: 50,
        stepId: "each[2]/work",
      },
    });
  });
});
