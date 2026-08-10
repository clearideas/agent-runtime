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
