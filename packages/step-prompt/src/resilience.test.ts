import type {
  AgentManifest,
  ExecutionPolicies,
  JsonObject,
  ModelUsage,
  PromptStep,
  ToolCall,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import type {
  NestedCheckpointInput,
  StepExecutionContext,
  TokenBudgetContext,
} from "@clearideas/agent-runtime-core";
import type {
  ContextSummarizeRequest,
  ContextSummarizerAdapter,
  ModelAdapter,
  ModelRequest,
  ModelResult,
  ToolAdapter,
} from "@clearideas/agent-runtime-core/ports";
import { describe, expect, it } from "vitest";

import { jsonBytes } from "./context/measure.js";
import { DEFAULT_SUMMARIZER_SYSTEM_PROMPT } from "./context/summarize.js";
import { compactedView, contextMarker } from "./context/transcript.js";
import { PromptStepExecutor } from "./index.js";

const at = "2026-07-22T00:00:00.000Z";
let sequence = 0;
const nextId = () => `item-${++sequence}`;

const assistant = (
  content: { text?: string; calls?: ToolCall[] },
  usage?: ModelUsage,
): ModelResult => ({
  ...(content.text !== undefined ? { output: content.text } : {}),
  toolCalls: content.calls ?? [],
  finishReason: content.calls?.length ? "tool-calls" : "stop",
  transcript: [
    {
      id: nextId(),
      type: "message",
      role: "assistant",
      content: [
        ...(content.text
          ? [{ type: "text" as const, text: content.text }]
          : []),
        ...(content.calls ?? []).map((call) => ({
          type: "tool-call" as const,
          call,
        })),
      ],
      createdAt: at,
      ...(usage ? { usage } : {}),
    },
  ],
});

const call = (name: string, input: JsonObject = {}): ToolCall => ({
  id: `call-${++sequence}`,
  name,
  input,
});

const isSummarizerRequest = (request: ModelRequest): boolean =>
  request.messages.some(
    (message) =>
      message.role === "system" &&
      message.content.some(
        (part) =>
          part.type === "text" &&
          part.text === DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
      ),
  );

const requestText = (request: ModelRequest): string =>
  JSON.stringify(request.messages);

interface Harness {
  requests: ModelRequest[];
  events: Array<{ type: string; data?: JsonObject }>;
  checkpoints: NestedCheckpointInput[];
}

const execute = async (input: {
  step: PromptStep;
  model: ModelAdapter;
  tools?: ToolAdapter;
  variables?: Record<string, unknown>;
  limits?: AgentManifest["limits"];
  policies?: ExecutionPolicies;
  tokenBudget?: TokenBudgetContext;
  resume?: NestedCheckpointInput;
  harness?: Harness;
  summarizer?: ContextSummarizerAdapter;
}) => {
  const harness: Harness = input.harness ?? {
    requests: [],
    events: [],
    checkpoints: [],
  };
  const recordingModel: ModelAdapter = {
    generate: async (request) => {
      harness.requests.push(structuredClone({ ...request, signal: undefined }));
      return input.model.generate(request);
    },
    ...(input.model.describeModel
      ? { describeModel: input.model.describeModel.bind(input.model) }
      : {}),
  };
  const context: StepExecutionContext & { step: PromptStep } = {
    runId: "run",
    manifest: {
      schemaVersion: "1.0",
      steps: [input.step],
      ...(input.limits ? { limits: input.limits } : {}),
    },
    step: input.step,
    stepIndex: 0,
    variables: (input.variables ?? {}) as StepExecutionContext["variables"],
    model: recordingModel,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.policies ? { policies: input.policies } : {}),
    ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
    ...(input.summarizer ? { summarizer: input.summarizer } : {}),
    ...(input.resume
      ? {
          resume: {
            cursor: { stepIndex: 0, stepId: input.step.id },
            ...(input.resume.continuation
              ? { continuation: input.resume.continuation }
              : {}),
            transcript: input.resume.transcript ?? [],
          },
        }
      : {}),
    checkpoint: async (checkpoint) => {
      harness.checkpoints.push(structuredClone(checkpoint));
    },
    emit: async (type, data) => {
      harness.events.push({ type, ...(data ? { data } : {}) });
      return { id: type, runId: "run", sequence: 1, timestamp: at, type };
    },
  };
  const result = await new PromptStepExecutor({
    sleep: async () => undefined,
  }).execute(context);
  return { result, ...harness };
};

const readerTools = (size: number, executed: ToolCall[] = []): ToolAdapter => ({
  listTools: async () => [
    { name: "docs__read", inputSchema: { type: "object" } },
    { name: "docs__write", inputSchema: { type: "object" } },
  ],
  executeTool: async (toolCall) => {
    executed.push(toolCall);
    return {
      callId: toolCall.id,
      name: toolCall.name,
      output: `${String(toolCall.input.path ?? "file")}: ${"data ".repeat(size / 5)}`,
    };
  },
});

const reducedEvents = (events: Harness["events"]) =>
  events.filter((event) => event.type === "context.reduced");

describe("opening prompt reduction", () => {
  const bigStep: PromptStep = {
    id: "analyze",
    type: "prompt",
    model: { provider: "test", model: "m" },
    systemPrompt: "You review contracts.",
    prompt:
      "Check this contract:\n{{ contract }}\nAgainst policy: {{ policy }}",
  };
  const variables = {
    contract: `CONTRACT START ${"clause ".repeat(30_000)} CONTRACT END`,
    policy: `POLICY ${"rule ".repeat(2_000)}`,
  };

  it("prunes interpolated variables by default so the request fits", async () => {
    const { result, requests, events } = await execute({
      step: bigStep,
      variables,
      limits: { maxInputBytes: 20_000 },
      model: { generate: async () => assistant({ text: "ok" }) },
    });
    expect(result.output).toBe("ok");
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(jsonBytes(sent.messages)).toBeLessThanOrEqual(20_000);
    const text = requestText(sent);
    expect(text).toContain("Check this contract:");
    expect(text).toContain("CONTRACT START");
    expect(text).toContain("CONTRACT END");
    expect(text).toContain("omitted");
    expect(reducedEvents(events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            scope: "input",
            strategy: "prune",
            variable: "contract",
          }),
        }),
      ]),
    );
  });

  it("never shortens a kept variable and always caps a variable with maxBytes", async () => {
    const { requests } = await execute({
      step: bigStep,
      variables,
      limits: { maxInputBytes: 30_000 },
      policies: {
        context: {
          variables: {
            policy: { keep: true },
            contract: { maxBytes: 2_000 },
          },
        },
      },
      model: { generate: async () => assistant({ text: "ok" }) },
    });
    const text = requestText(requests[0]!);
    expect(text).toContain(variables.policy);
    expect(text.length).toBeLessThan(variables.policy.length + 4_000);
  });

  it("summarizes oversized variables in chunks, keeping the step's task in view", async () => {
    const { result, requests, events } = await execute({
      step: bigStep,
      variables,
      limits: { maxInputBytes: 20_000 },
      policies: { context: { strategy: "summarize" } },
      model: {
        generate: async (request) =>
          isSummarizerRequest(request)
            ? assistant(
                { text: "Key clause: payment in 30 days." },
                { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
              )
            : assistant({ text: "reviewed" }),
      },
    });
    expect(result.output).toBe("reviewed");
    const summarizerRequests = requests.filter(isSummarizerRequest);
    expect(summarizerRequests.length).toBeGreaterThan(2);
    for (const request of summarizerRequests) {
      expect(jsonBytes(request.messages)).toBeLessThanOrEqual(20_000);
      expect(requestText(request)).toContain("Check this contract:");
    }
    const main = requests.at(-1)!;
    expect(requestText(main)).toContain("payment in 30 days");
    expect(requestText(main)).not.toContain("CONTRACT END");
    expect(
      events.filter(
        (event) =>
          event.type === "model.started" && event.data?.purpose === "summarize",
      ).length,
    ).toBe(summarizerRequests.length);
    // Summarizer usage counts toward the step.
    const usage = result.transcript!.flatMap((item) =>
      item.usage ? [item.usage.totalTokens ?? 0] : [],
    );
    expect(usage.reduce((total, value) => total + value, 0)).toBe(
      110 * summarizerRequests.length,
    );
  });

  it("falls back to pruning when summarizing fails, unless the strategy is summarize", async () => {
    const failing: ModelAdapter = {
      generate: async (request) => {
        if (isSummarizerRequest(request)) throw new Error("summarizer down");
        return assistant({ text: "ok" });
      },
    };
    const { result, events } = await execute({
      step: bigStep,
      variables,
      limits: { maxInputBytes: 20_000 },
      policies: { context: { strategy: "summarize-or-prune" } },
      model: failing,
    });
    expect(result.output).toBe("ok");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "diagnostic",
          data: expect.objectContaining({ code: "CONTEXT_SUMMARY_FAILED" }),
        }),
      ]),
    );
    await expect(
      execute({
        step: bigStep,
        variables,
        limits: { maxInputBytes: 20_000 },
        policies: { context: { strategy: "summarize" } },
        model: failing,
      }),
    ).rejects.toThrow('context strategy "summarize"');
  });

  it("fails as before when the strategy is fail", async () => {
    await expect(
      execute({
        step: bigStep,
        variables,
        limits: { maxInputBytes: 20_000 },
        policies: { context: { strategy: "fail" } },
        model: { generate: async () => assistant({ text: "ok" }) },
      }),
    ).rejects.toThrow("exceeding the 20000-byte input limit");
  });
});

describe("tool-loop compaction", () => {
  const researchStep: PromptStep = {
    id: "research",
    type: "prompt",
    model: { provider: "test", model: "m" },
    prompt: "Read every file and report.",
    tools: ["docs__read"],
  };
  /** Reads `turns` files, one per model turn, then answers. */
  const reader = (turns = 10): ModelAdapter => {
    let reads = 0;
    return {
      generate: async (request) => {
        if (isSummarizerRequest(request))
          return assistant({ text: "Read files so far; all contain data." });
        if (reads >= turns) return assistant({ text: "report complete" });
        reads += 1;
        return assistant({
          calls: [call("docs__read", { path: `file-${reads}.txt` })],
        });
      },
    };
  };

  it("prunes older rounds so every request stays under the limit, keeping the full transcript", async () => {
    const executed: ToolCall[] = [];
    const { result, requests, events } = await execute({
      step: researchStep,
      tools: readerTools(6_000, executed),
      limits: { maxInputBytes: 24_000, maxToolCallsPerIteration: 30 },
      model: reader(),
    });
    expect(result.output).toBe("report complete");
    expect(executed).toHaveLength(10);
    for (const request of requests) {
      expect(jsonBytes(request.messages)).toBeLessThanOrEqual(24_000);
    }
    expect(reducedEvents(events).length).toBeGreaterThan(0);
    // Every tool result is still in the durable transcript.
    const toolResults = result.transcript!.filter(
      (item) => item.role === "tool",
    );
    expect(toolResults).toHaveLength(executed.length);
    expect(
      toolResults.every((item) =>
        JSON.stringify(item.content).includes("data data"),
      ),
    ).toBe(true);
  });

  it.each(["prune", "summarize", "summarize-or-prune"] as const)(
    "%s: a 40-turn loop finishes with every request under the limit",
    async (strategy) => {
      const executed: ToolCall[] = [];
      const { result, requests } = await execute({
        step: researchStep,
        tools: readerTools(5_000, executed),
        limits: { maxInputBytes: 20_000, maxToolCallsPerIteration: 100 },
        policies: { context: { strategy } },
        model: reader(40),
      });
      expect(result.output).toBe("report complete");
      expect(executed).toHaveLength(40);
      for (const request of requests)
        expect(jsonBytes(request.messages)).toBeLessThanOrEqual(20_000);
    },
  );

  it.each(["prune", "summarize-or-prune"] as const)(
    "%s: the newest tool result always reaches the model in full",
    async (strategy) => {
      // A large kept variable uses most of the budget, so the 60% goal is
      // out of reach; reduction must still never cut the newest result.
      const step: PromptStep = {
        ...researchStep,
        prompt: "Context: {{ background }}\nRead every file and report.",
      };
      const { result, requests } = await execute({
        step,
        variables: { background: "b".repeat(14_000) },
        tools: readerTools(5_000),
        limits: { maxInputBytes: 30_000, maxToolCallsPerIteration: 50 },
        policies: {
          context: { strategy, variables: { background: { keep: true } } },
        },
        model: reader(12),
      });
      expect(result.output).toBe("report complete");
      for (const request of requests.filter(
        (entry) => !isSummarizerRequest(entry),
      )) {
        expect(jsonBytes(request.messages)).toBeLessThanOrEqual(30_000);
        const newest = request.messages
          .filter((message) => message.role === "tool")
          .at(-1);
        if (!newest) continue;
        const part = newest.content[0];
        expect(part?.type === "tool-result" && part.result.output).toMatch(
          /^file-\d+\.txt: (data ){900}/u,
        );
      }
    },
  );

  it.each(["prune", "summarize-or-prune"] as const)(
    "%s: a lower reduceTo reduces less often, and deeper",
    async (strategy) => {
      const run = async (reduceTo: number) => {
        // A summarizer that writes as much as it is asked for, like a model.
        const base = reader(30);
        const { result, events } = await execute({
          step: researchStep,
          tools: readerTools(5_000),
          limits: { maxInputBytes: 40_000, maxToolCallsPerIteration: 50 },
          policies: { context: { strategy, reduceTo } },
          model: {
            generate: async (request) => {
              if (!isSummarizerRequest(request)) return base.generate(request);
              const words = Number(
                /about (\d+) words/u.exec(requestText(request))?.[1] ?? 100,
              );
              return assistant({ text: "note ".repeat(words).trim() });
            },
          },
        });
        expect(result.output).toBe("report complete");
        // One reduction may emit several events (stub, then remove).
        const before = reducedEvents(events).map(
          (event) => event.data!.bytesBefore as number,
        );
        const compactions = new Set(before).size;
        const after = reducedEvents(events).map(
          (event) => event.data!.bytesAfter as number,
        );
        return { compactions, lowest: Math.min(...after) };
      };
      const deep = await run(0.25);
      const shallow = await run(0.6);
      expect(deep.compactions).toBeLessThan(shallow.compactions);
      // With a small opening prompt the 25% goal is reachable: 10 KB.
      expect(deep.lowest).toBeLessThanOrEqual(10_000);
    },
  );

  it("a removal note lists the calls it removed, so the model need not repeat them", async () => {
    const { requests } = await execute({
      step: researchStep,
      tools: readerTools(5_000),
      limits: { maxInputBytes: 30_000, maxToolCallsPerIteration: 50 },
      policies: { context: { strategy: "prune" } },
      model: reader(12),
    });
    const noted = requests
      .map(requestText)
      .filter((text) => text.includes("Calls already made"));
    expect(noted.length).toBeGreaterThan(0);
    expect(noted.at(-1)).toContain("docs__read(file-1.txt)");
  });

  it("keeps fewer rounds than retain asks for when that is what reaches the goal", async () => {
    const { events } = await execute({
      step: researchStep,
      tools: readerTools(5_000),
      limits: { maxInputBytes: 40_000, maxToolCallsPerIteration: 50 },
      policies: {
        context: {
          strategy: "summarize",
          reduceTo: 0.25,
          retain: { recentToolRounds: 3 },
        },
      },
      model: reader(12),
    });
    const summaries = reducedEvents(events).filter(
      (event) => event.data?.strategy === "summarize",
    );
    expect(summaries.length).toBeGreaterThan(0);
    // Three 5 KB rounds cannot fit a 10 KB goal; one can.
    for (const event of summaries) {
      expect(event.data?.retainedRounds).toBe(1);
      expect(event.data?.bytesAfter as number).toBeLessThanOrEqual(10_000);
    }
  });

  it("uses openingShare and toolResultShare to size the opening prompt and single results", async () => {
    const step: PromptStep = {
      ...researchStep,
      prompt: "Context: {{ background }}\nRead every file and report.",
    };
    const { requests, events } = await execute({
      step,
      variables: { background: "b".repeat(30_000) },
      tools: readerTools(20_000),
      limits: { maxInputBytes: 50_000, maxToolCallsPerIteration: 50 },
      policies: {
        context: { openingShare: 0.2, toolResultShare: 0.1 },
      },
      model: reader(1),
    });
    // The opening prompt alone fits 20% of the 50 KB trigger.
    expect(jsonBytes(requests[0]!.messages)).toBeLessThanOrEqual(10_000);
    // The 20 KB tool result was cut to about 10% of the trigger.
    const capped = reducedEvents(events).find(
      (event) => event.data?.scope === "tool-result",
    );
    expect(capped?.data?.bytesAfter as number).toBeLessThanOrEqual(5_000);
  });

  it("summarizes older rounds, then resumes from the checkpoint without summarizing again", async () => {
    const harness: Harness = { requests: [], events: [], checkpoints: [] };
    const { result } = await execute({
      step: researchStep,
      tools: readerTools(6_000),
      limits: { maxInputBytes: 24_000, maxToolCallsPerIteration: 30 },
      policies: { context: { strategy: "summarize" } },
      model: reader(),
      harness,
    });
    expect(result.output).toBe("report complete");
    const summaries = result.transcript!.filter(
      (item) => contextMarker(item)?.kind === "summary",
    );
    expect(summaries.length).toBeGreaterThan(0);
    const main = harness.requests.filter(
      (request) => !isSummarizerRequest(request),
    );
    expect(requestText(main.at(-1)!)).toContain("Summary of earlier work");

    // Resume from the checkpoint taken right after the first compaction.
    const afterCompaction = harness.checkpoints.find(
      (checkpoint) =>
        checkpoint.continuation?.phase === "ready" &&
        checkpoint.transcript!.some(
          (item) => contextMarker(item)?.kind === "summary",
        ),
    )!;
    expect(afterCompaction).toBeDefined();
    const resumed: Harness = { requests: [], events: [], checkpoints: [] };
    await execute({
      step: researchStep,
      tools: readerTools(6_000),
      limits: { maxInputBytes: 24_000, maxToolCallsPerIteration: 30 },
      policies: { context: { strategy: "summarize" } },
      model: reader(),
      resume: afterCompaction,
      harness: resumed,
    });
    const firstResumed = resumed.requests[0]!;
    expect(isSummarizerRequest(firstResumed)).toBe(false);
    expect(requestText(firstResumed)).toContain("Summary of earlier work");
    // The rebuilt view is the same one the original run would have sent.
    expect(compactedView(afterCompaction.transcript!).length).toBeGreaterThan(
      0,
    );
  });

  it("compacts on a tool-round trigger even when the input is small", async () => {
    const { result, events } = await execute({
      step: researchStep,
      tools: readerTools(100),
      policies: {
        context: {
          strategy: "summarize",
          trigger: { toolRounds: 3 },
          retain: { recentToolRounds: 1 },
        },
      },
      model: reader(6),
    });
    expect(result.output).toBe("report complete");
    expect(
      reducedEvents(events).some(
        (event) =>
          event.data?.reason === "tool-rounds" &&
          event.data?.strategy === "summarize",
      ),
    ).toBe(true);
  });

  it("caps a single oversized tool result", async () => {
    const { result, requests, events } = await execute({
      step: researchStep,
      tools: readerTools(200_000),
      limits: { maxInputBytes: 50_000 },
      model: reader(1),
    });
    expect(result.output).toBe("report complete");
    expect(jsonBytes(requests.at(-1)!.messages)).toBeLessThanOrEqual(50_000);
    expect(
      reducedEvents(events).some(
        (event) => event.data?.scope === "tool-result",
      ),
    ).toBe(true);
  });

  it("uses the model's described input window as the trigger", async () => {
    const model = reader();
    const { result, requests } = await execute({
      step: researchStep,
      tools: readerTools(6_000),
      model: {
        generate: model.generate,
        describeModel: () => ({ maxInputTokens: 8_000 }),
      },
    });
    expect(result.output).toBe("report complete");
    // 80% of 8,000 tokens at the default 4 bytes per token.
    for (const request of requests) {
      expect(jsonBytes(request.messages)).toBeLessThanOrEqual(25_600 + 8_000);
    }
    expect(result.transcript!.some((item) => contextMarker(item) != null)).toBe(
      true,
    );
  });

  it("recovers from a provider context overflow by compacting and retrying", async () => {
    const base = reader();
    let overflowed = 0;
    const { result, events } = await execute({
      step: researchStep,
      tools: readerTools(6_000),
      model: {
        generate: async (request) => {
          if (jsonBytes(request.messages) > 30_000) {
            overflowed += 1;
            throw Object.assign(
              new Error(
                "This model's maximum context length is 8192 tokens. Please reduce the length of the messages.",
              ),
              { statusCode: 400 },
            );
          }
          return base.generate(request);
        },
      },
    });
    expect(result.output).toBe("report complete");
    expect(overflowed).toBeGreaterThan(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "model.retry",
          data: expect.objectContaining({ reason: "context-overflow" }),
        }),
      ]),
    );
  });
});

describe("model and output recovery", () => {
  const simpleStep: PromptStep = {
    id: "answer",
    type: "prompt",
    model: { provider: "test", model: "m" },
    prompt: "Answer.",
  };

  it("retries retryable provider errors with backoff", async () => {
    let attempts = 0;
    const { result, events } = await execute({
      step: simpleStep,
      model: {
        generate: async () => {
          attempts += 1;
          if (attempts < 3)
            throw Object.assign(new Error("rate limited"), { statusCode: 429 });
          return assistant({ text: "ok" });
        },
      },
    });
    expect(result.output).toBe("ok");
    expect(events.filter((event) => event.type === "model.retry")).toHaveLength(
      2,
    );
  });

  it("does not retry errors that are not retryable", async () => {
    let attempts = 0;
    await expect(
      execute({
        step: simpleStep,
        model: {
          generate: async () => {
            attempts += 1;
            throw Object.assign(new Error("bad key"), { statusCode: 401 });
          },
        },
      }),
    ).rejects.toThrow("bad key");
    expect(attempts).toBe(1);
  });

  it("repairs invalid structured output once", async () => {
    let attempts = 0;
    const { result, requests } = await execute({
      step: { ...simpleStep, outputSchema: { type: "object" } },
      model: {
        generate: async () => {
          attempts += 1;
          if (attempts === 1)
            throw Object.assign(new Error("No object generated: bad JSON"), {
              name: "AI_NoObjectGeneratedError",
            });
          return { ...assistant({ text: "{}" }), output: { ok: true } };
        },
      },
    });
    expect(result.output).toEqual({ ok: true });
    expect(requestText(requests[1]!)).toContain("could not be used");
  });

  it("re-asks once for an empty required answer", async () => {
    let attempts = 0;
    const { result } = await execute({
      step: { ...simpleStep, completionPolicy: { requireOutput: true } },
      model: {
        generate: async () =>
          ++attempts === 1
            ? assistant({ text: "" })
            : assistant({ text: "now" }),
      },
    });
    expect(result.output).toBe("now");
  });

  it("retries a truncated answer with a larger output budget", async () => {
    const budgets: Array<number | undefined> = [];
    const { result } = await execute({
      step: { ...simpleStep, maxOutputTokens: 100 },
      model: {
        generate: async (request) => {
          budgets.push(request.maxOutputTokens);
          return budgets.length === 1
            ? { ...assistant({ text: "partial" }), finishReason: "length" }
            : assistant({ text: "complete" });
        },
      },
    });
    expect(result.output).toBe("complete");
    expect(budgets).toEqual([100, 200]);
    // The truncated response is kept durably but hidden from the retry.
    expect(JSON.stringify(result.transcript)).toContain("partial");
  });

  it("estimates usage for a budgeted provider that reports none", async () => {
    let consumed = 0;
    const budget: TokenBudgetContext = {
      maxTotalTokens: 1_000_000,
      get consumedTokens() {
        return consumed;
      },
      consume(usage) {
        consumed += usage.totalTokens ?? 0;
        return { maxTotalTokens: 1_000_000, consumedTokens: consumed };
      },
    };
    const { result, events } = await execute({
      step: simpleStep,
      tokenBudget: budget,
      model: { generate: async () => assistant({ text: "ok" }) },
    });
    expect(result.output).toBe("ok");
    expect(consumed).toBeGreaterThan(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ code: "USAGE_ESTIMATED" }),
        }),
      ]),
    );
  });
});

describe("tool-call safeguards", () => {
  const toolStep: PromptStep = {
    id: "tools",
    type: "prompt",
    model: { provider: "test", model: "m" },
    prompt: "Use tools.",
    tools: ["docs__read"],
  };

  it("never runs invalid calls or tools outside the step, and never duplicates results", async () => {
    const executed: ToolCall[] = [];
    let turn = 0;
    const invalid: ToolCall = {
      ...call("docs__read"),
      metadata: { agentRuntime: { invalid: true, error: "bad input" } },
    };
    const outOfScope = call("docs__write", { path: "x" });
    const { result } = await execute({
      step: toolStep,
      tools: readerTools(10, executed),
      model: {
        generate: async () => {
          turn += 1;
          if (turn > 1) return assistant({ text: "done" });
          const response = assistant({ calls: [invalid, outOfScope] });
          // The AI SDK answers invalid calls itself.
          response.transcript.push({
            id: nextId(),
            type: "tool-result",
            role: "tool",
            content: [
              {
                type: "tool-result",
                result: {
                  callId: invalid.id,
                  name: invalid.name,
                  error: { code: "tool_error", message: "bad input" },
                },
              },
            ],
            createdAt: at,
          });
          return response;
        },
      },
    });
    expect(result.output).toBe("done");
    expect(executed).toHaveLength(0);
    const results = result.transcript!.flatMap((item) =>
      item.content.flatMap((part) =>
        part.type === "tool-result" ? [part.result] : [],
      ),
    );
    expect(results.filter((entry) => entry.callId === invalid.id)).toHaveLength(
      1,
    );
    expect(
      results.find((entry) => entry.callId === outOfScope.id),
    ).toMatchObject({ error: { code: "tool_not_allowed" } });
  });

  it("asks for a final answer without tools once the tool-call limit is reached", async () => {
    const { result, requests, events } = await execute({
      step: toolStep,
      tools: readerTools(10),
      limits: { maxToolCallsPerIteration: 2 },
      model: {
        generate: async (request) =>
          request.toolChoice === "none"
            ? assistant({ text: "final from gathered data" })
            : assistant({ calls: [call("docs__read")] }),
      },
    });
    expect(result.output).toBe("final from gathered data");
    expect(requests.at(-1)?.toolChoice).toBe("none");
    expect(requestText(requests.at(-1)!)).toContain("limit of 2 tool calls");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ code: "TOOL_CALL_LIMIT_REACHED" }),
        }),
      ]),
    );
  });

  it("runs without tools from an unavailable optional source and tells the model", async () => {
    const { result, requests, events } = await execute({
      step: { ...toolStep, tools: ["docs__read", "tickets__create"] },
      tools: {
        ...readerTools(10),
        unavailableToolReason: (name) =>
          name === "tickets__create"
            ? 'Connection "tickets" is unavailable: connect ECONNREFUSED'
            : undefined,
      },
      model: { generate: async () => assistant({ text: "answered" }) },
    });
    expect(result.output).toBe("answered");
    expect(requests[0]!.tools!.map((tool) => tool.name)).toEqual([
      "docs__read",
    ]);
    expect(requestText(requests[0]!)).toContain("tickets__create");
    expect(requestText(requests[0]!)).toContain("ECONNREFUSED");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            code: "TOOLS_UNAVAILABLE",
            tools: ["tickets__create"],
          }),
        }),
      ]),
    );
  });
});

describe("durability of reductions", () => {
  it("stores opening-prompt reductions as invisible markers reused on resume", async () => {
    const step: PromptStep = {
      id: "tooling",
      type: "prompt",
      model: { provider: "test", model: "m" },
      prompt: "Use {{ doc }}",
      tools: ["docs__read"],
    };
    const variables = { doc: "d".repeat(100_000) };
    let summarizerCalls = 0;
    const model: ModelAdapter = {
      generate: async (request) => {
        if (isSummarizerRequest(request)) {
          summarizerCalls += 1;
          return assistant({ text: "doc summary" });
        }
        return assistant({ text: "ok" });
      },
    };
    const first = await execute({
      step,
      variables,
      tools: readerTools(10),
      limits: { maxInputBytes: 30_000 },
      policies: { context: { strategy: "summarize" } },
      model,
    });
    const callsAfterFirst = summarizerCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const marker = first.result.transcript!.find(
      (item: TranscriptItem) => contextMarker(item)?.kind === "input",
    );
    expect(marker?.role).toBeUndefined();
    const ready = first.checkpoints.find(
      (checkpoint) =>
        checkpoint.continuation?.phase === "ready" &&
        checkpoint.transcript?.some(
          (item) => contextMarker(item)?.kind === "input",
        ),
    )!;
    const resumed = await execute({
      step,
      variables,
      tools: readerTools(10),
      limits: { maxInputBytes: 30_000 },
      policies: { context: { strategy: "summarize" } },
      model,
      resume: ready,
    });
    expect(summarizerCalls).toBe(callsAfterFirst);
    expect(requestText(resumed.requests[0]!)).toContain("doc summary");
  });
});

describe("summarizer control", () => {
  const researchStep: PromptStep = {
    id: "research",
    type: "prompt",
    model: { provider: "test", model: "m" },
    prompt: "Read every file and report.",
    tools: ["docs__read"],
  };
  const material = (request: ModelRequest) =>
    /<material>\n([\s\S]*?)\n<\/material>/u.exec(requestText(request))?.[1] ??
    "";
  const wordsAsked = (request: ModelRequest) =>
    Number(/about (\d+) words/u.exec(requestText(request))?.[1] ?? 0);
  /** Reads `turns` files, and summarizes as much as it is asked to. */
  const model = (turns: number): ModelAdapter => {
    let reads = 0;
    return {
      generate: async (request) => {
        if (isSummarizerRequest(request))
          return assistant({
            text: "note ".repeat(Math.max(1, wordsAsked(request))).trim(),
          });
        if (reads >= turns) return assistant({ text: "report complete" });
        reads += 1;
        return assistant({
          calls: [call("docs__read", { path: `file-${reads}.txt` })],
        });
      },
    };
  };

  it("bounds each transcript summary with summaryShare and maxSummaryBytes", async () => {
    const run = async (summarizer: object) => {
      const { requests, events } = await execute({
        step: researchStep,
        tools: readerTools(5_000),
        limits: { maxInputBytes: 60_000, maxToolCallsPerIteration: 50 },
        policies: {
          context: { strategy: "summarize", reduceTo: 0.5, summarizer },
        },
        model: model(14),
      });
      const targets = reducedEvents(events).map(
        (event) => event.data?.summaryTargetBytes as number,
      );
      return {
        targets,
        words: requests.filter(isSummarizerRequest).map(wordsAsked),
      };
    };
    const capped = await run({ maxSummaryBytes: 1_200 });
    expect(capped.targets.length).toBeGreaterThan(0);
    for (const target of capped.targets)
      expect(target).toBeLessThanOrEqual(1_200);
    const generous = await run({ summaryShare: 0.5, maxSummaryBytes: 50_000 });
    expect(Math.max(...generous.targets)).toBeGreaterThan(
      Math.max(...capped.targets),
    );
  });

  it("splits material by chunkBytes and honors per-kind prompts", async () => {
    const { requests, events } = await execute({
      step: researchStep,
      tools: readerTools(5_000),
      limits: { maxInputBytes: 40_000, maxToolCallsPerIteration: 50 },
      policies: {
        context: {
          strategy: "summarize",
          summarizer: {
            chunkBytes: 8_000,
            prompts: {
              transcript:
                "TRANSCRIPT NOTES for {{ context.label }}, {{ context.targetWords }} words.",
            },
          },
        },
      },
      model: model(12),
    });
    const summarizerRequests = requests.filter(isSummarizerRequest);
    expect(summarizerRequests.length).toBeGreaterThan(2);
    for (const request of summarizerRequests) {
      expect(jsonBytes(material(request)) - 2).toBeLessThanOrEqual(8_000);
      expect(requestText(request)).toContain("TRANSCRIPT NOTES for");
    }
    const compaction = reducedEvents(events).find(
      (event) => event.data?.strategy === "summarize",
    );
    expect(compaction?.data?.summarizerCalls as number).toBeGreaterThan(1);
  });

  it("stops at maxCalls: summarize-or-prune prunes, summarize fails", async () => {
    const limited = {
      strategy: "summarize-or-prune" as const,
      summarizer: { maxCalls: 1, chunkBytes: 4_000 },
    };
    const { result, events } = await execute({
      step: researchStep,
      tools: readerTools(5_000),
      limits: { maxInputBytes: 40_000, maxToolCallsPerIteration: 50 },
      policies: { context: limited },
      model: model(12),
    });
    expect(result.output).toBe("report complete");
    expect(
      events.filter(
        (event) =>
          event.type === "model.started" && event.data?.purpose === "summarize",
      ),
    ).toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ code: "CONTEXT_SUMMARY_FAILED" }),
        }),
      ]),
    );
    await expect(
      execute({
        step: researchStep,
        tools: readerTools(5_000),
        limits: { maxInputBytes: 40_000, maxToolCallsPerIteration: 50 },
        policies: { context: { ...limited, strategy: "summarize" } },
        model: model(12),
      }),
    ).rejects.toThrow("summarizer calls");
  });

  it("lets a host summarizer observe, change, or replace each request", async () => {
    const seen: ContextSummarizeRequest[] = [];
    const wrapped: ContextSummarizerAdapter = {
      summarize: async (request, next) => {
        seen.push(structuredClone({ ...request, text: "", signal: undefined }));
        // Ask the built-in summarizer for half the size, with a host prompt.
        return next({
          ...request,
          targetBytes: Math.floor(request.targetBytes / 2),
          settings: {
            ...request.settings,
            prompt: "HOST PROMPT {{ context.kind }}",
          },
        });
      },
    };
    const step: PromptStep = {
      ...researchStep,
      prompt: "Use {{ doc }}. Read every file and report.",
    };
    const harness: Harness = { requests: [], events: [], checkpoints: [] };
    await execute({
      step,
      variables: { doc: "d".repeat(40_000) },
      tools: readerTools(5_000),
      limits: { maxInputBytes: 40_000, maxToolCallsPerIteration: 50 },
      policies: {
        context: {
          strategy: "summarize",
          summarizer: { maxSummaryBytes: 3_000 },
        },
      },
      summarizer: wrapped,
      model: model(8),
      harness,
    });
    expect(seen.map((request) => request.kind)).toEqual(
      expect.arrayContaining(["input", "transcript"]),
    );
    expect(seen[0]).toMatchObject({
      stepId: "research",
      label: "the variable doc",
      settings: { maxSummaryBytes: 3_000 },
    });
    const summarizerRequests = harness.requests.filter(isSummarizerRequest);
    expect(summarizerRequests.length).toBeGreaterThan(0);
    for (const request of summarizerRequests)
      expect(requestText(request)).toContain("HOST PROMPT");

    // A host can also summarize without the model, reporting its own usage.
    let modelSummaries = 0;
    const replacing: ContextSummarizerAdapter = {
      summarize: async (request) => ({
        text: `host summary of ${request.label}`,
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      }),
    };
    const replaced = await execute({
      step,
      variables: { doc: "d".repeat(40_000) },
      tools: readerTools(5_000),
      limits: { maxInputBytes: 40_000, maxToolCallsPerIteration: 50 },
      policies: { context: { strategy: "summarize" } },
      summarizer: replacing,
      model: {
        generate: async (request) => {
          if (isSummarizerRequest(request)) modelSummaries += 1;
          return model(8).generate(request);
        },
      },
    });
    expect(modelSummaries).toBe(0);
    expect(requestText(replaced.requests[0]!)).toContain(
      "host summary of the variable doc",
    );
    expect(
      replaced.events.filter(
        (event) =>
          event.type === "model.usage" && event.data?.source === "host",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("uses overflowRetries for provider context-overflow errors", async () => {
    let calls = 0;
    const overflowing: ModelAdapter = {
      generate: async () => {
        calls += 1;
        throw Object.assign(new Error("prompt is too long: 9000 tokens"), {
          statusCode: 400,
        });
      },
    };
    await expect(
      execute({
        step: { ...researchStep, tools: undefined },
        policies: { context: { overflowRetries: 0 } },
        model: overflowing,
      }),
    ).rejects.toThrow("prompt is too long");
    expect(calls).toBe(1);
  });
});
