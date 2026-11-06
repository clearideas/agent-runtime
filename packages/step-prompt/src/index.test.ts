import type {
  JsonObject,
  ModelUsage,
  PromptStep,
  RunBudgetState,
  RunEvent,
  AgentManifest,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import type {
  NestedCheckpointInput,
  TokenBudgetContext,
} from "@clearideas/agent-runtime-core";
import type {
  ModelAdapter,
  ModelRequest,
  ToolAdapter,
} from "@clearideas/agent-runtime-core/ports";
import { describe, expect, it } from "vitest";

import { ModelCompletionError, PromptStepExecutor } from "./index.js";

const step: PromptStep = {
  id: "prompt-1",
  type: "prompt",
  prompt: "Review {{ Item.Name }}",
  systemPrompt: "Audience: {{ audience }}",
  model: { provider: "openai", model: "gpt-test" },
  tools: ["lookup"],
  outputVariable: "answer",
  maxOutputTokens: 200,
};

const manifest: AgentManifest = {
  schemaVersion: "1.0",
  steps: [step],
  limits: { maxToolCallsPerIteration: 3 },
};

describe("PromptStepExecutor", () => {
  it("replays complete rich histories, templates text only, and resolves artifact media", async () => {
    const requests: ModelRequest[] = [];
    const historyStep: PromptStep = {
      id: "history",
      type: "prompt",
      model: { provider: "openai", model: "gpt-test" },
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "Topic: {{ topic }}" }],
          metadata: { source: "fixture" },
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect {{ imageLabel }}" },
            {
              type: "image",
              artifact: {
                id: "artifact-1",
                name: "diagram.png",
                mediaType: "image/png",
              },
              metadata: { alt: "{{ shouldNotCompile }}" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              call: {
                id: "historical-call",
                name: "lookup",
                input: { query: "{{ shouldNotCompile }}" },
              },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              result: {
                callId: "historical-call",
                name: "lookup",
                output: { answer: "{{ shouldNotCompile }}" },
                metadata: { cached: true },
                artifacts: [
                  {
                    id: "artifact-2",
                    name: "tool-image.png",
                    mediaType: "image/png",
                  },
                ],
              },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Continue." }],
        },
      ],
    };
    const model: ModelAdapter = {
      generate: async (request) => {
        requests.push(structuredClone(request));
        return {
          output: "done",
          transcript: [
            {
              id: "assistant-history",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              createdAt: "2026-07-22T00:00:00.000Z",
            },
          ],
        };
      },
    };

    await new PromptStepExecutor().execute({
      runId: "run-history",
      manifest: { schemaVersion: "1.0", steps: [historyStep] },
      step: historyStep,
      stepIndex: 0,
      variables: {
        topic: "architecture",
        imageLabel: "the diagram",
        shouldNotCompile: "secret",
      },
      model,
      artifacts: {
        put: async () => {
          throw new Error("not used");
        },
        get: async (ref) => ({
          ref: { ...ref, size: 3 },
          data: new Uint8Array([1, 2, 3]),
        }),
      },
      emit: async (type) => ({
        id: type,
        runId: "run-history",
        sequence: 1,
        timestamp: "2026-07-22T00:00:00.000Z",
        type,
      }),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toHaveLength(5);
    expect(requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: [{ type: "text", text: "Topic: architecture" }],
      metadata: { source: "fixture" },
    });
    expect(requests[0]?.messages[1]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Inspect the diagram" },
        {
          type: "image",
          data: "AQID",
          mediaType: "image/png",
          metadata: { alt: "{{ shouldNotCompile }}" },
        },
      ],
    });
    expect(requests[0]?.messages[2]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          call: {
            id: "historical-call",
            input: { query: "{{ shouldNotCompile }}" },
          },
        },
      ],
    });
    expect(requests[0]?.messages[3]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          result: {
            output: { answer: "{{ shouldNotCompile }}" },
            metadata: { cached: true },
            artifacts: [
              {
                id: "artifact-2",
                uri: "data:image/png;base64,AQID",
                size: 3,
              },
            ],
          },
        },
      ],
    });
  });

  it("enforces configured complete-history input limits", async () => {
    const limitedStep: PromptStep = {
      id: "limited",
      type: "prompt",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "one" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "two" }],
        },
      ],
      model: { provider: "openai", model: "gpt-test" },
    };
    await expect(
      new PromptStepExecutor().execute({
        runId: "run-limited",
        manifest: {
          schemaVersion: "1.0",
          steps: [limitedStep],
          limits: { maxMessagesPerPrompt: 1 },
        },
        step: limitedStep,
        stepIndex: 0,
        variables: {},
        model: {
          generate: async () => ({
            output: "should not run",
            transcript: [],
          }),
        },
        emit: async (type) => ({
          id: type,
          runId: "run-limited",
          sequence: 1,
          timestamp: "2026-07-22T00:00:00.000Z",
          type,
        }),
      }),
    ).rejects.toThrow("exceeding the 1-message input limit");
  });

  it("streams deltas and executes tool calls sequentially before continuing", async () => {
    const requests: ModelRequest[] = [];
    const executionOrder: string[] = [];
    const model: ModelAdapter = {
      generate: async () => {
        throw new Error("stream should be used");
      },
      stream: async function* (request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: "text-delta", delta: "Checking" };
          yield {
            type: "completed",
            result: {
              output: "",
              transcript: [
                {
                  id: "assistant-1",
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "tool-call",
                      call: { id: "call-1", name: "lookup", input: { id: 1 } },
                    },
                  ],
                  createdAt: "2026-07-22T00:00:00.000Z",
                },
              ],
              toolCalls: [{ id: "call-1", name: "lookup", input: { id: 1 } }],
              finishReason: "tool-calls",
            },
          };
          return;
        }
        yield { type: "text-delta", delta: "Approved" };
        yield {
          type: "completed",
          result: {
            output: "Approved",
            transcript: [
              {
                id: "assistant-2",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Approved" }],
                createdAt: "2026-07-22T00:00:01.000Z",
              },
            ],
            finishReason: "stop",
          },
        };
      },
    };
    const tools: ToolAdapter = {
      listTools: async () => [
        {
          name: "lookup",
          inputSchema: { type: "object" },
        },
      ],
      executeTool: async (call) => {
        executionOrder.push(call.id);
        return { callId: call.id, name: call.name, output: { found: true } };
      },
    };
    const events: RunEvent[] = [];
    let eventSequence = 0;
    const result = await new PromptStepExecutor({
      now: () => new Date("2026-07-22T00:00:02.000Z"),
      generateTranscriptId: () => "tool-result-1",
    }).execute({
      runId: "run-1",
      manifest,
      step,
      stepIndex: 0,
      variables: { Item: { Name: "Proposal" }, audience: "board" },
      model,
      tools,
      emit: async (type, data) => {
        const event: RunEvent = {
          id: `event-${++eventSequence}`,
          runId: "run-1",
          sequence: eventSequence,
          timestamp: "2026-07-22T00:00:00.000Z",
          type,
          ...(data ? { data } : {}),
        };
        events.push(event);
        return event;
      },
    });

    expect(executionOrder).toEqual(["call-1"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: "openai/gpt-test",
      maxOutputTokens: 200,
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "Audience: board" }],
        },
        { role: "user", content: [{ type: "text", text: "Review Proposal" }] },
      ],
    });
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          result: { callId: "call-1", output: { found: true } },
        },
      ],
    });
    expect(result.output).toBe("Approved");
    expect(result.statePatch).toEqual({ set: { answer: "Approved" } });
    expect(
      events.filter((event) => event.type === "model.text.delta"),
    ).toHaveLength(2);
    expect(events.map((event) => event.type)).toContain("model.tool.completed");
  });

  it("suspends at the cumulative token limit and resumes without replay", async () => {
    const modelRequests: ModelRequest[] = [];
    const toolCalls: string[] = [];
    const events: string[] = [];
    const usageTranscript = (
      id: string,
      content: TranscriptItem["content"],
      usage: ModelUsage,
    ): TranscriptItem => ({
      id,
      type: "message",
      role: "assistant",
      content,
      usage,
      createdAt: "2026-07-22T00:00:00.000Z",
    });
    const model: ModelAdapter = {
      generate: async (request) => {
        modelRequests.push(structuredClone(request));
        if (modelRequests.length === 1) {
          const call = { id: "call-1", name: "lookup", input: { id: 1 } };
          return {
            output: "",
            transcript: [
              usageTranscript("assistant-1", [{ type: "tool-call", call }], {
                totalTokens: 10,
              }),
            ],
            toolCalls: [call],
            finishReason: "tool-calls",
          };
        }
        return {
          output: "done",
          transcript: [
            usageTranscript("assistant-2", [{ type: "text", text: "done" }], {
              totalTokens: 2,
            }),
          ],
          finishReason: "stop",
        };
      },
    };
    const tools: ToolAdapter = {
      listTools: async () => [
        { name: "lookup", inputSchema: { type: "object" } },
      ],
      executeTool: async (call) => {
        toolCalls.push(call.id);
        return { callId: call.id, name: call.name, output: { found: true } };
      },
    };
    const makeBudget = (
      maxTotalTokens: number,
      initialConsumedTokens: number,
    ): TokenBudgetContext => {
      let consumedTokens = initialConsumedTokens;
      return {
        maxTotalTokens,
        get consumedTokens() {
          return consumedTokens;
        },
        consume(usage): RunBudgetState {
          consumedTokens +=
            usage.totalTokens ??
            (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          return { maxTotalTokens, consumedTokens };
        },
      };
    };
    let saved: NestedCheckpointInput | undefined;
    const execute = (
      tokenBudget: TokenBudgetContext,
      resume?: { continuation?: JsonObject; transcript?: TranscriptItem[] },
    ) =>
      new PromptStepExecutor({
        generateTranscriptId: () => "tool-result-1",
      }).execute({
        runId: "run-budget",
        manifest,
        step,
        stepIndex: 0,
        variables: { Item: { Name: "Proposal" }, audience: "board" },
        model,
        tools,
        tokenBudget,
        ...(resume
          ? {
              resume: {
                cursor: { stepIndex: 0, stepId: step.id },
                ...(resume.continuation
                  ? { continuation: resume.continuation }
                  : {}),
                ...(resume.transcript ? { transcript: resume.transcript } : {}),
              },
            }
          : {}),
        checkpoint: async (checkpoint) => {
          saved = structuredClone(checkpoint);
        },
        emit: async (type) => {
          events.push(type);
          return {
            id: type,
            runId: "run-budget",
            sequence: events.length,
            timestamp: "2026-07-22T00:00:00.000Z",
            type,
          };
        },
      });

    await expect(execute(makeBudget(10, 0))).rejects.toMatchObject({
      reason: "token-budget",
    });
    expect(modelRequests).toHaveLength(1);
    expect(toolCalls).toEqual([]);
    expect(saved?.continuation).toMatchObject({
      type: "prompt",
      nextToolIndex: 0,
      toolCallCount: 0,
    });

    await expect(
      execute(makeBudget(10, 10), {
        continuation: saved?.continuation,
        transcript: saved?.transcript,
      }),
    ).rejects.toMatchObject({ reason: "token-budget" });
    expect(modelRequests).toHaveLength(1);
    expect(toolCalls).toEqual([]);

    await expect(
      execute(makeBudget(12, 10), {
        continuation: saved?.continuation,
        transcript: saved?.transcript,
      }),
    ).resolves.toMatchObject({ output: "done" });
    expect(modelRequests).toHaveLength(2);
    expect(toolCalls).toEqual(["call-1"]);
    expect(events.filter((event) => event === "model.usage")).toHaveLength(2);
  });

  it("reuses a checkpointed tool idempotency key after a lost result", async () => {
    const modelRequests: ModelRequest[] = [];
    const idempotencyKeys: string[] = [];
    const appliedEffects = new Set<string>();
    let effectCount = 0;
    const model: ModelAdapter = {
      generate: async (request) => {
        modelRequests.push(structuredClone(request));
        if (modelRequests.length === 1) {
          const call = { id: "side-effect-1", name: "lookup", input: {} };
          return {
            transcript: [
              {
                id: "assistant-side-effect",
                type: "message",
                role: "assistant",
                content: [{ type: "tool-call", call }],
                createdAt: "2026-07-22T00:00:00.000Z",
              },
            ],
            toolCalls: [call],
          };
        }
        return { output: "done", transcript: [] };
      },
    };
    const tools: ToolAdapter = {
      listTools: async () => [
        { name: "lookup", inputSchema: { type: "object" } },
      ],
      executeTool: async (call, context) => {
        const key = context.idempotencyKey!;
        idempotencyKeys.push(key);
        if (!appliedEffects.has(key)) {
          appliedEffects.add(key);
          effectCount += 1;
          throw new Error("process exited after the external effect");
        }
        return { callId: call.id, name: call.name, output: { applied: true } };
      },
    };
    let saved: NestedCheckpointInput | undefined;
    const execute = (resume?: NestedCheckpointInput) =>
      new PromptStepExecutor({
        generateTranscriptId: () => "tool-result-side-effect",
        generateToolIdempotencyKey: () => "stable-tool-key",
      }).execute({
        runId: "run-side-effect",
        manifest,
        step,
        stepIndex: 0,
        variables: { Item: { Name: "Proposal" }, audience: "board" },
        model,
        tools,
        ...(resume
          ? {
              resume: {
                cursor: { stepIndex: 0, stepId: step.id },
                ...(resume.continuation
                  ? { continuation: resume.continuation }
                  : {}),
                ...(resume.transcript ? { transcript: resume.transcript } : {}),
              },
            }
          : {}),
        checkpoint: async (checkpoint) => {
          saved = structuredClone(checkpoint);
        },
        emit: async (type) => ({
          id: type,
          runId: "run-side-effect",
          sequence: 1,
          timestamp: "2026-07-22T00:00:00.000Z",
          type,
        }),
      });

    await expect(execute()).rejects.toThrow(
      "process exited after the external effect",
    );
    expect(saved?.continuation).toMatchObject({
      type: "prompt",
      nextToolIndex: 0,
      toolIdempotencyKeys: ["stable-tool-key"],
    });

    await expect(execute(saved)).resolves.toMatchObject({ output: "done" });
    expect(modelRequests).toHaveLength(2);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(effectCount).toBe(1);
  });

  it("counts tool calls across model turns and checkpoint resumes", async () => {
    let turns = 0;
    let executed = 0;
    let saved: NestedCheckpointInput | undefined;
    const model: ModelAdapter = {
      generate: async () => ({
        transcript: [],
        toolCalls: [{ id: String(++turns), name: "lookup", input: {} }],
      }),
    };
    const tools: ToolAdapter = {
      listTools: async () => [
        { name: "lookup", inputSchema: { type: "object" } },
      ],
      executeTool: async (call) => {
        executed++;
        return { callId: call.id, name: call.name, output: {} };
      },
    };
    const execute = (resume?: NestedCheckpointInput) =>
      new PromptStepExecutor().execute({
        runId: "limit",
        manifest: { ...manifest, limits: { maxToolCallsPerIteration: 2 } },
        step,
        stepIndex: 0,
        variables: { Item: { Name: "test" }, audience: "test" },
        model,
        tools,
        ...(resume
          ? {
              resume: {
                cursor: { stepIndex: 0, stepId: step.id },
                continuation: resume.continuation!,
                transcript: resume.transcript!,
              },
            }
          : {}),
        checkpoint: async (checkpoint) => {
          saved = structuredClone(checkpoint);
        },
        emit: async (type) => ({
          id: type,
          runId: "limit",
          sequence: 1,
          timestamp: "2026-07-22T00:00:00.000Z",
          type,
        }),
      });
    await expect(execute()).rejects.toThrow(
      "tool-call limit across the prompt step",
    );
    expect(turns).toBe(3);
    expect(executed).toBe(2);
    expect(saved?.continuation).toMatchObject({ toolCallCount: 2 });
    await expect(execute(saved)).rejects.toThrow(
      "tool-call limit across the prompt step",
    );
    expect(turns).toBe(3);
    expect(executed).toBe(2);
  });

  it("uses non-streaming generation when stream is unavailable", async () => {
    const model: ModelAdapter = {
      generate: async (request) => ({
        output:
          request.messages[0]?.content[0]?.type === "text" ? "done" : "bad",
        transcript: [],
      }),
    };
    const noToolStep: PromptStep = {
      ...step,
      tools: undefined,
      systemPrompt: undefined,
    };
    const result = await new PromptStepExecutor().execute({
      runId: "run-2",
      manifest: { ...manifest, steps: [noToolStep] },
      step: noToolStep,
      stepIndex: 0,
      variables: { Item: { Name: "Proposal" } },
      model,
      emit: async (type) => ({
        id: type,
        runId: "run-2",
        sequence: 1,
        timestamp: "2026-07-22T00:00:00.000Z",
        type,
      }),
    });
    expect(result.output).toBe("done");
  });

  it("enforces provider timeout when an adapter ignores abort", async () => {
    const noToolStep: PromptStep = {
      ...step,
      tools: undefined,
      systemPrompt: undefined,
    };
    const never = new Promise<never>(() => undefined);

    await expect(
      new PromptStepExecutor().execute({
        runId: "run-timeout",
        manifest: {
          ...manifest,
          steps: [noToolStep],
          limits: { providerTimeoutMs: 5 },
        },
        step: noToolStep,
        stepIndex: 0,
        variables: {},
        model: { generate: async () => never },
        emit: async (type) => ({
          id: type,
          runId: "run-timeout",
          sequence: 1,
          timestamp: "2026-07-22T00:00:00.000Z",
          type,
        }),
      }),
    ).rejects.toMatchObject({ name: "ModelTimeoutError", timeoutMs: 5 });
  });

  describe("cancellation", () => {
    const noToolStep: PromptStep = {
      ...step,
      tools: undefined,
      systemPrompt: undefined,
    };
    /** Collects unhandled rejections raised while `run` executes. */
    const unhandledDuring = async (run: () => Promise<unknown>) => {
      const seen: unknown[] = [];
      const listener = (reason: unknown) => seen.push(reason);
      process.on("unhandledRejection", listener);
      try {
        await run();
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.off("unhandledRejection", listener);
      }
      return seen;
    };
    const execute = (
      model: ModelAdapter,
      controller: AbortController,
      abortOn: string,
      limits: AgentManifest["limits"] = {},
    ) =>
      new PromptStepExecutor().execute({
        runId: "run-cancel",
        manifest: { ...manifest, steps: [noToolStep], limits },
        step: noToolStep,
        stepIndex: 0,
        variables: {},
        model,
        signal: controller.signal,
        emit: async (type) => {
          // A host cancels while handling an event, e.g. a user clicks Stop.
          if (type === abortOn) controller.abort(new Error("cancelled"));
          return {
            id: type,
            runId: "run-cancel",
            sequence: 1,
            timestamp: "2026-07-22T00:00:00.000Z",
            type,
          };
        },
      });

    it("does not create a stream when cancelled by model.started", async () => {
      const controller = new AbortController();
      let started = 0;
      const model: ModelAdapter = {
        generate: async () => ({ transcript: [] }),
        stream: () => {
          started++;
          return (async function* () {
            yield { type: "completed" as const, result: { transcript: [] } };
          })();
        },
      };
      await expect(execute(model, controller, "model.started")).rejects.toThrow(
        "cancelled",
      );
      expect(started).toBe(0);
    });

    it.each(["generate", "stream"] as const)(
      "settles cancellation raised synchronously during %s startup",
      async (mode) => {
        const controller = new AbortController();
        const never = new Promise<never>(() => undefined);
        const model: ModelAdapter =
          mode === "generate"
            ? {
                generate: () => {
                  controller.abort(new Error("cancelled at startup"));
                  return never;
                },
              }
            : {
                generate: async () => ({ transcript: [] }),
                stream: () => ({
                  [Symbol.asyncIterator]: () => ({
                    next: () => {
                      controller.abort(new Error("cancelled at startup"));
                      return never;
                    },
                  }),
                }),
              };
        await expect(execute(model, controller, "none")).rejects.toThrow(
          "cancelled at startup",
        );
      },
      1_000,
    );

    it.each(["throw", "reject"] as const)(
      "preserves cancellation when iterator cleanup can %s",
      async (cleanup) => {
        const controller = new AbortController();
        let cleaned = 0;
        const model: ModelAdapter = {
          generate: async () => ({ transcript: [] }),
          stream: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => ({
                done: false,
                value: { type: "text-delta" as const, delta: "Working" },
              }),
              return: () => {
                cleaned++;
                if (cleanup === "throw") throw new Error("cleanup failure");
                return Promise.reject(new Error("cleanup failure"));
              },
            }),
          }),
        };
        const unhandled = await unhandledDuring(async () => {
          await expect(
            execute(model, controller, "model.text.delta"),
          ).rejects.toThrow("cancelled");
        });
        expect(cleaned).toBe(1);
        expect(unhandled).toEqual([]);
      },
    );

    it("observes a late rejected read after cancelling an in-flight stream", async () => {
      const controller = new AbortController();
      let pending: Promise<never> | undefined;
      const model: ModelAdapter = {
        generate: async () => ({ transcript: [] }),
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => {
              pending = new Promise((_resolve, reject) => {
                setTimeout(() => controller.abort(new Error("cancelled")), 5);
                setTimeout(
                  () => reject(new Error("late provider failure")),
                  15,
                );
              });
              return pending;
            },
          }),
        }),
      };
      const unhandled = await unhandledDuring(async () => {
        await expect(execute(model, controller, "none")).rejects.toThrow(
          "cancelled",
        );
      });
      expect(pending).toBeDefined();
      expect(unhandled).toEqual([]);
    });

    it("does not leave a rejected stream read unobserved", async () => {
      const controller = new AbortController();
      // Like the AI SDK adapter: once aborted, the next read fails.
      const model: ModelAdapter = {
        generate: async () => ({ transcript: [] }),
        async *stream(request) {
          yield { type: "text-delta", delta: "Working" };
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (request.signal?.aborted) throw new Error("Model stream aborted.");
          yield {
            type: "completed",
            result: { output: "done", transcript: [] },
          };
        },
      };
      const unhandled = await unhandledDuring(async () => {
        await expect(
          execute(model, controller, "model.text.delta"),
        ).rejects.toThrow("cancelled");
      });
      expect(unhandled).toEqual([]);
    });

    it("does not start another model turn when cancelled during a tool call", async () => {
      const controller = new AbortController();
      const toolStep: PromptStep = { ...noToolStep, tools: ["lookup"] };
      let modelCalls = 0;
      const model: ModelAdapter = {
        generate: async () => ({ transcript: [] }),
        async *stream(request) {
          modelCalls += 1;
          // Like the AI SDK adapter: an aborted request fails when read.
          if (request.signal?.aborted) throw new Error("Model stream aborted.");
          const call = { id: "call-1", name: "lookup", input: {} };
          yield { type: "tool-call", call };
          yield {
            type: "completed",
            result: { toolCalls: [call], transcript: [] },
          };
        },
      };
      const tools: ToolAdapter = {
        listTools: async () => [
          { name: "lookup", inputSchema: { type: "object" } },
        ],
        executeTool: async (call) => {
          // The user cancels while a sandbox command runs.
          controller.abort(new Error("cancelled"));
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            callId: call.id,
            name: call.name,
            error: { code: "sandbox_unavailable", message: "cancelled" },
          };
        },
      };
      const unhandled = await unhandledDuring(async () => {
        await expect(
          new PromptStepExecutor().execute({
            runId: "run-cancel",
            manifest: { ...manifest, steps: [toolStep] },
            step: toolStep,
            stepIndex: 0,
            variables: {},
            model,
            tools,
            signal: controller.signal,
            emit: async (type) => ({
              id: type,
              runId: "run-cancel",
              sequence: 1,
              timestamp: "2026-07-22T00:00:00.000Z",
              type,
            }),
          }),
        ).rejects.toThrow("cancelled");
      });
      expect(unhandled).toEqual([]);
      expect(modelCalls).toBe(1);
    });

    it("does not leave a rejected generate call unobserved", async () => {
      const controller = new AbortController();
      const model: ModelAdapter = {
        generate: async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (request.signal?.aborted) throw new Error("Request aborted.");
          return { output: "done", transcript: [] };
        },
      };
      const unhandled = await unhandledDuring(async () => {
        await expect(
          execute(model, controller, "model.started"),
        ).rejects.toThrow("cancelled");
      });
      expect(unhandled).toEqual([]);
    });

    it("enforces provider timeout when a streaming adapter ignores abort", async () => {
      const never = new Promise<never>(() => undefined);
      const model: ModelAdapter = {
        generate: async () => never,
        async *stream() {
          yield { type: "text-delta", delta: "Working" };
          await never;
        },
      };
      await expect(
        execute(model, new AbortController(), "none", {
          providerTimeoutMs: 20,
        }),
      ).rejects.toMatchObject({ name: "ModelTimeoutError", timeoutMs: 20 });
    }, 2_000);
  });

  it("fails truncated output by default and allows an explicit partial-output policy", async () => {
    const truncatedModel: ModelAdapter = {
      generate: async () => ({
        output: "",
        transcript: [],
        finishReason: "length",
      }),
    };
    const truncatedStep: PromptStep = {
      id: "truncated",
      type: "prompt",
      prompt: "Answer.",
      model: { provider: "local", model: "reasoning-model" },
    };
    const context = {
      runId: "run-truncated",
      manifest: {
        schemaVersion: "1.0",
        steps: [truncatedStep],
      } satisfies AgentManifest,
      step: truncatedStep,
      stepIndex: 0,
      variables: {},
      model: truncatedModel,
      emit: async (type: string) => ({
        id: type,
        runId: "run-truncated",
        sequence: 1,
        timestamp: "2026-07-22T00:00:00.000Z",
        type,
      }),
    };

    await expect(
      new PromptStepExecutor().execute(context),
    ).rejects.toMatchObject<Partial<ModelCompletionError>>({
      name: "ModelCompletionError",
      finishReason: "length",
    });

    const acceptedStep: PromptStep = {
      ...truncatedStep,
      completionPolicy: { onTruncation: "accept" },
    };
    await expect(
      new PromptStepExecutor().execute({
        ...context,
        manifest: { ...context.manifest, steps: [acceptedStep] },
        step: acceptedStep,
      }),
    ).resolves.toMatchObject({ output: "" });
  });

  it("can require non-empty final output", async () => {
    const requiredStep: PromptStep = {
      id: "required-output",
      type: "prompt",
      prompt: "Answer.",
      model: { provider: "local", model: "test" },
      completionPolicy: { requireOutput: true },
    };
    await expect(
      new PromptStepExecutor().execute({
        runId: "run-required-output",
        manifest: { schemaVersion: "1.0", steps: [requiredStep] },
        step: requiredStep,
        stepIndex: 0,
        variables: {},
        model: {
          generate: async () => ({
            output: "   ",
            transcript: [],
            finishReason: "stop",
          }),
        },
        emit: async (type) => ({
          id: type,
          runId: "run-required-output",
          sequence: 1,
          timestamp: "2026-07-22T00:00:00.000Z",
          type,
        }),
      }),
    ).rejects.toThrow("did not contain required output");
  });
});
