import type {
  AgentManifest,
  AgentStep,
} from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import { buildExecutionWaves } from "./execution-plan.js";

const prompt = (
  id: string,
  promptText: string,
  outputVariable?: string,
): AgentStep => ({
  id,
  type: "prompt",
  prompt: promptText,
  ...(outputVariable ? { outputVariable } : {}),
});

const manifest = (steps: AgentStep[]): AgentManifest => ({
  schemaVersion: "1.0",
  steps,
});

describe("buildExecutionWaves", () => {
  it("keeps sequential execution as the default", () => {
    expect(
      buildExecutionWaves(
        manifest([prompt("one", "One", "one"), prompt("two", "Two", "two")]),
        0,
        undefined,
      ),
    ).toEqual([{ stepIndexes: [0] }, { stepIndexes: [1] }]);
  });

  it("fans out independent prompts and joins before their consumer", () => {
    expect(
      buildExecutionWaves(
        manifest([
          prompt("facts", "Find facts about {{ topic }}", "facts"),
          prompt("audience", "Analyze {{ audience }}", "audienceNotes"),
          prompt("final", "Use {{ facts }} for {{ audienceNotes }}", "final"),
        ]),
        0,
        { mode: "parallel", maxConcurrency: 4 },
      ),
    ).toEqual([{ stepIndexes: [0, 1] }, { stepIndexes: [2] }]);
  });

  it("recognizes dependencies in conditions and serializes duplicate writes", () => {
    const conditional = prompt("conditional", "Continue", "result");
    conditional.when = "score.value >= 0.8";
    expect(
      buildExecutionWaves(
        manifest([
          prompt("score", "Score", "score"),
          conditional,
          prompt("replace", "Replace", "result"),
        ]),
        0,
        { mode: "parallel" },
      ),
    ).toEqual([
      { stepIndexes: [0] },
      { stepIndexes: [1] },
      { stepIndexes: [2] },
    ]);
  });

  it("recognizes template dependencies inside complete message histories", () => {
    const consumer: AgentStep = {
      id: "consumer",
      type: "prompt",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Use {{ research.summary }}" }],
        },
      ],
      outputVariable: "answer",
    };
    expect(
      buildExecutionWaves(
        manifest([
          prompt("research", "Research", "research"),
          consumer,
          prompt("independent", "Independent", "other"),
        ]),
        0,
        { mode: "parallel" },
      ),
    ).toEqual([{ stepIndexes: [0] }, { stepIndexes: [1, 2] }]);
  });

  it("uses stateful and tool-enabled steps as barriers", () => {
    const toolStep = prompt("tool", "Call tool", "toolResult");
    if (toolStep.type === "prompt") toolStep.tools = ["search"];
    expect(
      buildExecutionWaves(
        manifest([
          prompt("one", "One", "one"),
          toolStep,
          prompt("two", "Two", "two"),
          {
            id: "approval",
            type: "approval",
            prompt: "Approve",
          },
          prompt("three", "Three", "three"),
        ]),
        0,
        { mode: "parallel" },
      ),
    ).toEqual([
      { stepIndexes: [0] },
      { stepIndexes: [1] },
      { stepIndexes: [2] },
      { stepIndexes: [3] },
      { stepIndexes: [4] },
    ]);
  });

  it("honors concurrency limits and disables parallel projection state", () => {
    const steps = [
      prompt("one", "One", "one"),
      prompt("two", "Two", "two"),
      prompt("three", "Three", "three"),
    ];
    expect(
      buildExecutionWaves(manifest(steps), 0, {
        mode: "parallel",
        maxConcurrency: 2,
      }),
    ).toEqual([{ stepIndexes: [0, 1] }, { stepIndexes: [2] }]);
    expect(
      buildExecutionWaves(
        {
          ...manifest(steps),
          extensions: {
            agentRuntime: { stateProjection: "step-output-state-v1" },
          },
        },
        0,
        { mode: "parallel" },
      ),
    ).toEqual([
      { stepIndexes: [0] },
      { stepIndexes: [1] },
      { stepIndexes: [2] },
    ]);
  });
});
