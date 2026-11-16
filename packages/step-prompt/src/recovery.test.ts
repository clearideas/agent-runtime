import type {
  AgentManifest,
  ModelUsage,
  ToolCall,
} from "@clearideas/agent-runtime-contracts";
import {
  AgentRuntime,
  RunSuspendedError,
} from "@clearideas/agent-runtime-core";
import type {
  ContextSummarizerAdapter,
  ModelAdapter,
  ModelRequest,
  ModelResult,
  ToolAdapter,
} from "@clearideas/agent-runtime-core/ports";
import { MemoryRunStore } from "@clearideas/agent-runtime-core/testing";
import { describe, expect, it } from "vitest";

import { jsonBytes } from "./context/measure.js";
import { compactedView, contextMarker } from "./context/transcript.js";
import { DEFAULT_SUMMARIZER_SYSTEM_PROMPT } from "./context/summarize.js";
import { PromptStepExecutor } from "./index.js";

let sequence = 0;
const at = "2026-11-08T00:00:00.000Z";
const reply = (
  text: string | undefined,
  calls: ToolCall[] = [],
  tokens = 10,
): ModelResult => ({
  ...(text === undefined ? {} : { output: text }),
  toolCalls: calls,
  finishReason: calls.length ? "tool-calls" : "stop",
  transcript: [
    {
      id: `reply-${++sequence}`,
      type: "message",
      role: "assistant",
      createdAt: at,
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...calls.map((call) => ({ type: "tool-call" as const, call })),
      ],
      usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens },
    },
  ],
});
const isSummary = (request: ModelRequest) =>
  request.messages.some(
    (message) =>
      message.role === "system" &&
      message.content.some(
        (part) =>
          part.type === "text" &&
          part.text === DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
      ),
  );
const modelReference = { provider: "test", model: "m" };
const tool = { name: "write", inputSchema: { type: "object" } };

describe("durable compaction recovery", () => {
  it("commits a tool before a paused reduction and finishes that reduction before the remaining calls", async () => {
    const runStore = new MemoryRunStore();
    const executed: string[] = [];
    let summaries = 0,
      mainCalls = 0;
    const tools: ToolAdapter = {
      listTools: async () => [tool],
      executeTool: async (call) => {
        executed.push(call.id);
        return { callId: call.id, name: call.name, output: "x".repeat(10000) };
      },
    };
    const summarizer: ContextSummarizerAdapter = {
      summarize: async () => {
        if (++summaries === 1) throw new RunSuspendedError("paused");
        // The second tool must wait for the first result's reduction.
        if (summaries === 2) expect(executed).toEqual(["one"]);
        return { text: "reduced output" };
      },
    };
    const model: ModelAdapter = {
      generate: async (request) => {
        if (++mainCalls === 1)
          return reply(
            undefined,
            ["one", "two"].map((id) => ({ id, name: "write", input: {} })),
          );
        expect(JSON.stringify(request.messages)).not.toContain(
          "x".repeat(1000),
        );
        return reply("done");
      },
    };
    const runtime = () =>
      new AgentRuntime({
        runStore,
        model,
        tools,
        summarizer,
        stepExecutors: [new PromptStepExecutor()],
      });
    const manifest: AgentManifest = {
      schemaVersion: "1.0",
      model: modelReference,
      policies: {
        context: { strategy: "summarize", maxToolResultBytes: 1000 },
      },
      steps: [
        { id: "s", type: "prompt", prompt: "Write once", tools: ["write"] },
      ],
    };
    await expect(
      runtime().run({ runId: "pause", manifest }),
    ).rejects.toBeInstanceOf(RunSuspendedError);
    const checkpoint = (await runStore.loadLatestCheckpoint("pause"))!;
    expect(checkpoint.continuation).toMatchObject({
      phase: "model-completed",
      nextToolIndex: 1,
      toolCallCount: 1,
    });
    expect(
      checkpoint.activeStepTranscript?.filter((item) => item.role === "tool"),
    ).toHaveLength(1);
    const result = await runtime().run({ runId: "pause", resume: true });
    expect(result.output).toBe("done");
    expect(executed).toEqual(["one", "two"]);
    expect(
      result.transcript.filter((item) => item.role === "tool"),
    ).toHaveLength(2);
    expect(JSON.stringify(result.transcript)).toContain("x".repeat(10000));
  });

  it.each([
    { wrap: false, multiple: false, passes: false },
    { wrap: true, multiple: false, passes: false },
    { wrap: false, multiple: true, passes: false },
    { wrap: false, multiple: false, passes: true },
  ])(
    "retains chunk usage and reuses completed work across fresh resumes (%j)",
    async ({ wrap, multiple, passes }) => {
      const runStore = new MemoryRunStore();
      const dispatched: string[] = [];
      let mainCalls = 0;
      const model: ModelAdapter = {
        generate: async (request) => {
          if (!isSummary(request)) {
            mainCalls++;
            return reply("done");
          }
          dispatched.push(JSON.stringify(request.messages));
          return reply(
            passes && dispatched.length <= 3 ? "p".repeat(800) : "summary",
            [],
            100,
          );
        },
      };
      const runtime = () =>
        new AgentRuntime({
          runStore,
          model,
          stepExecutors: [new PromptStepExecutor()],
          ...(wrap
            ? {
                summarizer: {
                  summarize: (request, next) => next(request),
                } satisfies ContextSummarizerAdapter,
              }
            : {}),
        });
      const manifest: AgentManifest = {
        schemaVersion: "1.0",
        model: modelReference,
        variables: [
          {
            key: "doc",
            type: "string",
            value: "x".repeat(passes ? 2500 : 10000),
          },
          ...(multiple
            ? [
                {
                  key: "other",
                  type: "string" as const,
                  value: "y".repeat(3000),
                },
              ]
            : []),
        ],
        policies: {
          context: {
            strategy: "summarize",
            summarizer: { chunkBytes: 1024 },
            variables: { doc: { maxBytes: 500 }, other: { maxBytes: 500 } },
          },
        },
        steps: [
          {
            id: "s",
            type: "prompt",
            prompt: multiple ? "{{ doc }} {{ other }}" : "{{ doc }}",
          },
        ],
      };
      await expect(
        runtime().run({
          runId: "chunks",
          manifest,
          budget: { maxTotalTokens: multiple ? 1050 : passes ? 350 : 150 },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ reason: "token-budget" });
      const checkpoint = (await runStore.loadLatestCheckpoint("chunks"))!;
      const completedCalls = multiple ? 11 : passes ? 4 : 2;
      expect(checkpoint.budget?.consumedTokens).toBe(completedCalls * 100);
      expect(dispatched).toHaveLength(completedCalls);
      await expect(
        runtime().run({ runId: "chunks", resume: true }),
      ).rejects.toMatchObject({ reason: "token-budget" });
      expect(dispatched).toHaveLength(completedCalls);
      const result = await runtime().run({
        runId: "chunks",
        resume: true,
        budget: { maxTotalTokens: 10000 },
      });
      expect(result.output).toBe("done");
      expect(new Set(dispatched).size).toBe(dispatched.length);
      expect(mainCalls).toBe(1);
      const total = result.transcript.reduce(
        (sum, item) => sum + (item.usage?.totalTokens ?? 0),
        0,
      );
      expect(total).toBe(dispatched.length * 100 + 10);
      expect(
        (await runStore.loadLatestCheckpoint("chunks"))?.budget?.consumedTokens,
      ).toBe(total);
      expect(
        compactedView(result.transcript).every(
          (item) => contextMarker(item)?.kind !== "usage",
        ),
      ).toBe(true);
    },
  );

  it.each(["trigger", "overflow", "host"])(
    "stops main-model dispatch when %s compaction exhausts the budget",
    async (mode) => {
      const runStore = new MemoryRunStore();
      let mainCalls = 0,
        summaries = 0;
      const model: ModelAdapter = {
        generate: async (request) => {
          if (isSummary(request)) {
            summaries++;
            return reply("Earlier work completed", [], 200);
          }
          mainCalls++;
          if (mainCalls === 1)
            return reply(undefined, [
              { id: "write", name: "write", input: {} },
            ]);
          if (mode === "overflow" && mainCalls === 2)
            throw Object.assign(new Error("context window exceeded"), {
              code: "MODEL_CONTEXT_OVERFLOW",
            });
          return reply("done");
        },
      };
      const tools: ToolAdapter = {
        listTools: async () => [tool],
        executeTool: async (call) => ({
          callId: call.id,
          name: call.name,
          output: "x".repeat(4000),
        }),
      };
      const runtime = () =>
        new AgentRuntime({
          runStore,
          model,
          tools,
          stepExecutors: [new PromptStepExecutor()],
          ...(mode === "host"
            ? {
                summarizer: {
                  summarize: async () => {
                    summaries++;
                    return {
                      text: "Earlier work completed",
                      usage: { totalTokens: 200 },
                    };
                  },
                },
              }
            : {}),
        });
      const manifest: AgentManifest = {
        schemaVersion: "1.0",
        model: modelReference,
        policies: {
          context: {
            strategy: "summarize",
            retain: { recentToolRounds: 0 },
            ...(mode === "overflow" ? {} : { trigger: { toolRounds: 1 } }),
          },
        },
        steps: [
          {
            id: "s",
            type: "prompt",
            prompt: "Write then report",
            tools: ["write"],
          },
        ],
      };
      await expect(
        runtime().run({
          runId: "budget",
          manifest,
          budget: { maxTotalTokens: 150 },
        }),
      ).rejects.toMatchObject({ reason: "token-budget" });
      expect(mainCalls).toBe(mode === "overflow" ? 2 : 1);
      expect(summaries).toBe(1);
      expect(
        (await runStore.loadLatestCheckpoint("budget"))?.budget?.consumedTokens,
      ).toBe(210);
      const result = await runtime().run({
        runId: "budget",
        resume: true,
        budget: { maxTotalTokens: 1000 },
      });
      expect(result.output).toBe("done");
      expect(summaries).toBe(1);
    },
  );

  it.each([
    { material: "x", limit: 2000 },
    { material: '😀"\\\n', limit: 2000 },
    { material: "x", limit: 850 },
  ])(
    "fits complete summarizer requests within the limit (%j)",
    async ({ material, limit }) => {
      const sizes: number[] = [];
      const model: ModelAdapter = {
        generate: async (request) => {
          sizes.push(jsonBytes(request.messages));
          return reply(isSummary(request) ? "summary" : "done");
        },
      };
      const runtime = new AgentRuntime({
        runStore: new MemoryRunStore(),
        model,
        stepExecutors: [new PromptStepExecutor()],
      });
      const manifest: AgentManifest = {
        schemaVersion: "1.0",
        model: modelReference,
        limits: { maxInputBytes: limit },
        variables: [
          { key: "doc", type: "string", value: material.repeat(10000) },
        ],
        policies: {
          context: {
            strategy: "summarize",
            variables: { doc: { maxBytes: 500 } },
          },
        },
        steps: [{ id: "s", type: "prompt", prompt: "{{ doc }}" }],
      };
      expect((await runtime.run({ manifest })).output).toBe("done");
      expect(sizes.length).toBeGreaterThan(1);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(limit);
    },
    // Summarizing 40 KB of multi-byte material takes many chunked calls.
    30_000,
  );

  it.each(["summarize", "summarize-or-prune"] as const)(
    "%s handles fixed summarizer prompts larger than the entire input limit",
    async (strategy) => {
      let dispatched = 0;
      const runtime = new AgentRuntime({
        runStore: new MemoryRunStore(),
        stepExecutors: [new PromptStepExecutor()],
        model: {
          generate: async (request) => {
            dispatched++;
            expect(jsonBytes(request.messages)).toBeLessThanOrEqual(2000);
            return reply("done");
          },
        },
      });
      const manifest: AgentManifest = {
        schemaVersion: "1.0",
        model: modelReference,
        limits: { maxInputBytes: 2000 },
        variables: [{ key: "doc", type: "string", value: "x".repeat(10000) }],
        policies: {
          context: {
            strategy,
            summarizer: { systemPrompt: "instructions".repeat(300) },
            variables: { doc: { maxBytes: 500 } },
          },
        },
        steps: [{ id: "s", type: "prompt", prompt: "{{ doc }}" }],
      };
      if (strategy === "summarize") {
        await expect(runtime.run({ manifest })).rejects.toThrow(
          "fixed prompts exceed",
        );
        expect(dispatched).toBe(0);
      } else {
        expect((await runtime.run({ manifest })).output).toBe("done");
        expect(dispatched).toBe(1);
      }
    },
  );

  it("retains the summarizer call limit when a partial operation is resumed", async () => {
    const runStore = new MemoryRunStore();
    let summaries = 0;
    const runtime = () =>
      new AgentRuntime({
        runStore,
        stepExecutors: [new PromptStepExecutor()],
        model: {
          generate: async () => {
            summaries++;
            return reply("summary", [], 100);
          },
        },
      });
    const manifest: AgentManifest = {
      schemaVersion: "1.0",
      model: modelReference,
      variables: [{ key: "doc", type: "string", value: "x".repeat(10000) }],
      policies: {
        context: {
          strategy: "summarize",
          summarizer: { chunkBytes: 1024, maxCalls: 3 },
          variables: { doc: { maxBytes: 500 } },
        },
      },
      steps: [{ id: "s", type: "prompt", prompt: "{{ doc }}" }],
    };
    await expect(
      runtime().run({
        runId: "calls",
        manifest,
        budget: { maxTotalTokens: 150 },
      }),
    ).rejects.toMatchObject({ reason: "token-budget" });
    expect(summaries).toBe(2);
    await expect(
      runtime().run({
        runId: "calls",
        resume: true,
        budget: { maxTotalTokens: 10000 },
      }),
    ).rejects.toThrow("summarizer calls");
    expect(summaries).toBe(3);
    expect(
      (await runStore.loadLatestCheckpoint("calls"))?.budget?.consumedTokens,
    ).toBe(300);
    await expect(
      runtime().run({ runId: "calls", resume: true }),
    ).rejects.toThrow("summarizer calls");
    expect(summaries).toBe(3);
  });
});

describe("resume notices", () => {
  it("tells the model once, between turns, that workspace changes were not saved", async () => {
    const runStore = new MemoryRunStore();
    const requests: ModelRequest[] = [];
    let turns = 0;
    const model: ModelAdapter = {
      generate: async (request) => {
        requests.push(structuredClone(request));
        turns += 1;
        return turns === 1
          ? reply(undefined, [{ id: "one", name: "write", input: {} }])
          : reply("done");
      },
    };
    const tools: ToolAdapter = {
      listTools: async () => [tool],
      executeTool: async (call) => ({
        callId: call.id,
        name: call.name,
        output: "written",
      }),
    };
    const controller = new AbortController();
    const saveCheckpoint = runStore.saveCheckpoint.bind(runStore);
    runStore.saveCheckpoint = async (checkpoint) => {
      await saveCheckpoint(checkpoint);
      // Pause right after the model asked for the tool, before it runs.
      if (
        checkpoint.continuation?.phase === "model-completed" &&
        !controller.signal.aborted
      )
        controller.abort(new RunSuspendedError("paused"));
    };
    const runtime = () =>
      new AgentRuntime({
        runStore,
        model,
        tools,
        stepExecutors: [new PromptStepExecutor()],
      });
    const manifest: AgentManifest = {
      schemaVersion: "1.0",
      model: modelReference,
      steps: [{ id: "s", type: "prompt", prompt: "Write", tools: ["write"] }],
    };
    await expect(
      runtime().run({ runId: "notice", manifest, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RunSuspendedError);
    // As the runtime records a final sync failure on suspension.
    runStore.checkpoints.get("notice")!.at(-1)!.metadata = {
      workspaceSync: { failed: true, error: "disk full" },
    };
    await runtime().run({ runId: "notice", resume: true });

    const last = requests.at(-1)!.messages;
    const roles = last.map((message) => message.role);
    // The note follows the tool result; it never separates call and result.
    expect(roles.slice(-3)).toEqual(["assistant", "tool", "user"]);
    const noteText = JSON.stringify(last.at(-1));
    expect(noteText).toContain("could not be saved when its sandbox closed");
    expect(noteText).toContain("disk full");
    expect(
      requests
        .flatMap((request) => request.messages)
        .filter((message) =>
          JSON.stringify(message).includes("could not be saved"),
        ),
    ).toHaveLength(1);
  });
});

describe("turn limit", () => {
  it("suspends before a turn beyond maxTurnsPerPrompt and continues when more are granted", async () => {
    const runStore = new MemoryRunStore();
    let turns = 0;
    const model: ModelAdapter = {
      generate: async () => {
        turns += 1;
        return turns < 5
          ? reply(undefined, [
              { id: `call-${turns}`, name: "write", input: {} },
            ])
          : reply("done");
      },
    };
    const tools: ToolAdapter = {
      listTools: async () => [tool],
      executeTool: async (call) => ({
        callId: call.id,
        name: call.name,
        output: "ok",
      }),
    };
    const runtime = () =>
      new AgentRuntime({
        runStore,
        model,
        tools,
        stepExecutors: [new PromptStepExecutor()],
      });
    const manifest: AgentManifest = {
      schemaVersion: "1.0",
      model: modelReference,
      limits: { maxTurnsPerPrompt: 3 },
      steps: [{ id: "s", type: "prompt", prompt: "Go", tools: ["write"] }],
    };
    await expect(
      runtime().run({ runId: "turns", manifest }),
    ).rejects.toMatchObject({
      reason: "blocked",
      details: {
        cause: "limit",
        limit: "maxTurnsPerPrompt",
        used: 3,
        value: 3,
      },
    });
    expect(turns).toBe(3);
    const result = await runtime().run({
      runId: "turns",
      resume: true,
      limits: { maxTurnsPerPrompt: 10 },
    });
    expect(result.output).toBe("done");
    // The three completed turns were not repeated.
    expect(turns).toBe(5);
  });
});

describe("checkpoint volume", () => {
  it("commits about two checkpoints per tool call", async () => {
    const runStore = new MemoryRunStore();
    let saves = 0;
    const save = runStore.saveCheckpoint.bind(runStore);
    runStore.saveCheckpoint = async (checkpoint) => {
      saves += 1;
      return save(checkpoint);
    };
    const calls = 20;
    let turn = 0;
    const model: ModelAdapter = {
      generate: async () =>
        ++turn <= calls
          ? reply(undefined, [{ id: `call-${turn}`, name: "write", input: {} }])
          : reply("done"),
    };
    const tools: ToolAdapter = {
      listTools: async () => [tool],
      executeTool: async (call) => ({
        callId: call.id,
        name: call.name,
        output: "ok",
      }),
    };
    await new AgentRuntime({
      runStore,
      model,
      tools,
      stepExecutors: [new PromptStepExecutor()],
    }).run({
      manifest: {
        schemaVersion: "1.0",
        model: modelReference,
        limits: { maxToolCallsPerIteration: 100 },
        steps: [{ id: "s", type: "prompt", prompt: "Go", tools: ["write"] }],
      },
    });
    // One after each model response and one after each tool result, plus the
    // run's first checkpoint, the final answer, and the step commit.
    expect(saves).toBeLessThanOrEqual(2 * calls + 4);
  });
});
