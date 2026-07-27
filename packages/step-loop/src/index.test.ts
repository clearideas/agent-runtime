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
});
