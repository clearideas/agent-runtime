/**
 * End-to-end behavior of the guaranteed-execution features through the
 * primary package: interrupted runs resume, approvals can continue or end a
 * run, and a long tool loop finishes inside a small input limit.
 */
import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  ApprovalStepExecutor,
  createAgentRuntime,
  defineAgent,
  InProcessExecutionEngine,
  JexlConditionEvaluator,
  MemoryRunStore,
  PromptStepExecutor,
  RunInterruptedError,
  type ModelAdapter,
  type ModelResult,
  type ToolCall,
} from "./index.js";

const at = "2026-07-22T00:00:00.000Z";
let counter = 0;
const reply = (text: string, calls: ToolCall[] = []): ModelResult => ({
  ...(calls.length === 0 ? { output: text } : {}),
  toolCalls: calls,
  transcript: [
    {
      id: `reply-${++counter}`,
      type: "message",
      role: "assistant",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...calls.map((call) => ({ type: "tool-call" as const, call })),
      ],
      createdAt: at,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  ],
});

describe("parallel prompt checkpoints", () => {
  const manifest = defineAgent({
    schemaVersion: "1.0",
    model: { provider: "test", model: "m" },
    policies: { modelRetry: { maxAttempts: 1 } },
    steps: ["first", "second", "third"].map((id) => ({
      id,
      type: "prompt" as const,
      prompt: id,
      outputVariable: id,
    })),
  });

  it("commits simultaneous prompt responses as one complete wave", async () => {
    const runStore = new MemoryRunStore();
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkpoints: number[] = [];
    const runtime = new AgentRuntime({
      runStore,
      stepExecutors: [new PromptStepExecutor()],
      eventSinks: [
        {
          emit: async (event) => {
            if (event.type === "checkpoint.saved")
              checkpoints.push(
                (await runStore.loadLatestCheckpoint(event.runId))!.cursor
                  .stepIndex,
              );
          },
        },
      ],
      model: {
        generate: async (request) => {
          if (++started === 3) release();
          await barrier;
          const part = request.messages[0]!.content[0]!;
          return reply(part.type === "text" ? part.text : "");
        },
      },
    });
    const result = await runtime.run({
      runId: "parallel",
      manifest,
      execution: { mode: "parallel", maxConcurrency: 3 },
    });
    expect(result.state).toEqual({
      first: "first",
      second: "second",
      third: "third",
    });
    expect(result.stepResults.map((step) => step.stepId)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(checkpoints).toEqual([0, 3]);
  });

  it("resumes an interrupted parallel wave from its start without skipping sibling outputs", async () => {
    const runStore = new MemoryRunStore();
    const calls: string[] = [];
    let interrupt = true;
    const runtime = new AgentRuntime({
      runStore,
      stepExecutors: [new PromptStepExecutor()],
      model: {
        generate: async (request) => {
          const part = request.messages[0]!.content[0]!;
          const text = part.type === "text" ? part.text : "";
          calls.push(text);
          if (text === "third" && interrupt) {
            interrupt = false;
            throw new RunInterruptedError("shutdown");
          }
          return reply(text);
        },
      },
    });
    await expect(
      runtime.run({
        runId: "interrupted-wave",
        manifest,
        execution: { mode: "parallel" },
      }),
    ).rejects.toMatchObject({ code: "RUN_INTERRUPTED" });
    expect(
      (await runStore.loadLatestCheckpoint("interrupted-wave"))?.cursor
        .stepIndex,
    ).toBe(0);
    const result = await runtime.run({
      runId: "interrupted-wave",
      resume: true,
      execution: { mode: "parallel" },
    });
    expect(result.state).toEqual({
      first: "first",
      second: "second",
      third: "third",
    });
    expect(calls).toEqual([
      "first",
      "second",
      "third",
      "first",
      "second",
      "third",
    ]);
  });
});

describe("interrupted executions", () => {
  it("an execution timeout leaves the run interrupted, and resuming completes it", async () => {
    const runStore = new MemoryRunStore();
    const manifest = defineAgent({
      schemaVersion: "1.0",
      model: { provider: "test", model: "m" },
      steps: [
        { id: "first", type: "prompt", prompt: "one" },
        { id: "slow", type: "prompt", prompt: "two" },
      ],
    });
    let hung = false;
    const model: ModelAdapter = {
      generate: async (request) => {
        const prompt = JSON.stringify(request.messages);
        // Under the engine (which supplies a signal), hang once until its
        // timeout aborts the request. The direct resume has no signal.
        if (prompt.includes("two") && request.signal && !hung) {
          hung = true;
          await new Promise((_resolve, reject) =>
            request.signal!.addEventListener("abort", () =>
              reject(request.signal!.reason),
            ),
          );
        }
        return reply(prompt.includes("two") ? "second" : "first");
      },
    };
    const agentRuntime = new AgentRuntime({
      runStore,
      model,
      stepExecutors: [new PromptStepExecutor()],
    });
    const engine = new InProcessExecutionEngine((request, execution) =>
      agentRuntime.run({
        manifest: request.manifest,
        runId: execution.handle.runId,
        signal: execution.signal,
      }),
    );
    const handle = await engine.submit({
      manifest,
      runId: "timed-out",
      timeoutMs: 300,
    });
    await expect(engine.result(handle)).rejects.toMatchObject({
      code: "EXECUTION_TIMEOUT",
    });
    expect((await runStore.loadRun("timed-out"))?.status).toBe("interrupted");

    const resumed = await agentRuntime.run({
      runId: "timed-out",
      manifest,
      resume: true,
    });
    expect(resumed.stepResults.map((result) => result.stepId)).toEqual([
      "first",
      "slow",
    ]);
    expect(resumed.output).toBe("second");
  });
});

describe("approval rejections", () => {
  const manifest = (onReject: "continue" | "complete") =>
    defineAgent({
      schemaVersion: "1.0",
      model: { provider: "test", model: "m" },
      steps: [
        {
          id: "draft",
          type: "prompt",
          prompt: "draft",
          outputVariable: "draft",
        },
        {
          id: "review",
          type: "approval",
          prompt: "Publish?",
          outputVariable: "review",
          onReject,
        },
        {
          id: "publish",
          type: "prompt",
          prompt: "publish",
          when: "review.approved == true",
          includeInFinalOutput: true,
        },
        {
          id: "revise",
          type: "prompt",
          prompt: "revise",
          when: "review.approved == false",
          includeInFinalOutput: true,
        },
      ],
    });
  const run = (onReject: "continue" | "complete") => {
    const prompts: string[] = [];
    const agentRuntime = new AgentRuntime({
      runStore: new MemoryRunStore(),
      model: {
        generate: async (request) => {
          const text = JSON.stringify(request.messages);
          const name = ["draft", "publish", "revise"].find((value) =>
            text.includes(`"${value}"`),
          )!;
          prompts.push(name);
          return reply(`${name} done`);
        },
      },
      approvals: {
        requestApproval: async () => ({ approved: false, respondedAt: at }),
      },
      conditionEvaluator: new JexlConditionEvaluator(),
      stepExecutors: [new PromptStepExecutor(), new ApprovalStepExecutor()],
    });
    return {
      prompts,
      result: agentRuntime.run({ manifest: manifest(onReject) }),
    };
  };

  it("continue lets later steps branch on the rejection", async () => {
    const { prompts, result } = run("continue");
    await expect(result).resolves.toMatchObject({ output: "revise done" });
    expect(prompts).toEqual(["draft", "revise"]);
  });

  it("complete ends the run successfully at the rejection", async () => {
    const { prompts, result } = run("complete");
    const completed = await result;
    expect(prompts).toEqual(["draft"]);
    expect(completed.stepResults.map((entry) => entry.stepId)).toEqual([
      "draft",
      "review",
    ]);
  });
});

describe("a long tool loop under a small input limit", () => {
  it("finishes with the default prune policy and keeps every tool result durably", async () => {
    let reads = 0;
    const executed: string[] = [];
    const runtime = createAgentRuntime({
      manifest: defineAgent({
        schemaVersion: "1.0",
        model: { provider: "test", model: "m" },
        limits: { maxInputBytes: 16_000, maxToolCallsPerIteration: 50 },
        steps: [
          {
            id: "investigate",
            type: "prompt",
            prompt: "Read all 30 log files, then summarize.",
            tools: ["logs__read"],
          },
        ],
      }),
      model: {
        generate: async () =>
          reads >= 30
            ? reply("All 30 logs read; no anomalies.")
            : reply("", [
                {
                  id: `read-${++reads}`,
                  name: "logs__read",
                  input: { file: `log-${reads}.txt` },
                },
              ]),
      },
      tools: {
        listTools: async () => [
          { name: "logs__read", inputSchema: { type: "object" } },
        ],
        executeTool: async (call) => {
          executed.push(call.id);
          return {
            callId: call.id,
            name: call.name,
            output: `${String(call.input.file)}\n${"INFO request ok\n".repeat(250)}`,
          };
        },
      },
    });
    const result = await runtime.run({});
    expect(result.output).toBe("All 30 logs read; no anomalies.");
    expect(executed).toHaveLength(30);
    expect(
      result.transcript.filter((item) => item.role === "tool"),
    ).toHaveLength(30);
  });
});
