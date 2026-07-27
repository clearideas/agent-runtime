import type { ModelRequest } from "@clearideas/agent-runtime-core/ports";
import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  type AiSdkCallOptions,
  AiSdkModelAdapter,
  type AiSdkStreamPart,
  createProviderRegistryModelResolver,
  parseModelKey,
} from "./model-adapter.js";

const fakeModel = { specificationVersion: "v3" } as unknown as LanguageModel;

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "openai/gpt-test",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
    ...overrides,
  };
}

describe("AiSdkModelAdapter", () => {
  it("resolves provider/model keys through an open provider registry", () => {
    expect(parseModelKey("openai/gpt-test")).toEqual({
      provider: "openai",
      modelId: "gpt-test",
    });
    expect(parseModelKey("gpt-test", "local")).toEqual({
      provider: "local",
      modelId: "gpt-test",
    });
    const resolver = createProviderRegistryModelResolver({
      openai: (modelId) =>
        ({ ...fakeModel, modelId }) as unknown as LanguageModel,
    });
    expect(resolver("openai/gpt-test")).toMatchObject({ modelId: "gpt-test" });
    expect(() => resolver("anthropic/claude-test")).toThrow(
      "No AI SDK provider factory",
    );
  });

  it("maps neutral messages, tools, structured output, usage, and metadata", async () => {
    let received: AiSdkCallOptions | undefined;
    const generateText = vi.fn(async (options: AiSdkCallOptions) => {
      received = options;
      return {
        text: "",
        reasoningText: "checked the facts",
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "lookup",
            input: { term: "Example Corp" },
          },
        ],
        finishReason: "tool-calls",
        totalUsage: {
          inputTokens: 10,
          inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 },
          outputTokens: 7,
          outputTokenDetails: { reasoningTokens: 3 },
          totalTokens: 17,
        },
        providerMetadata: { openai: { responseId: "response_1" } },
        output: { answer: 42 },
      };
    });
    const adapter = new AiSdkModelAdapter({
      resolveModel: (model) => {
        expect(model).toBe("openai/gpt-test");
        return fakeModel;
      },
      generateText,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      generateTranscriptId: () => "message_1",
    });

    const modelRequest = request({
      messages: [
        { role: "system", content: [{ type: "text", text: "Be concise." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Use this" },
            { type: "json", value: { id: 1 } },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              call: {
                id: "prior_call",
                name: "lookup",
                input: { term: "prior" },
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
                callId: "prior_call",
                name: "lookup",
                output: { found: true },
              },
            },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look something up.",
          inputSchema: {
            type: "object",
            properties: { term: { type: "string" } },
            required: ["term"],
          },
        },
      ],
      outputSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
      providerOptions: { openai: { reasoningEffort: "low" } },
    });
    Object.assign(modelRequest, { maxOutputTokens: 256 });
    const result = await adapter.generate(modelRequest);

    expect(generateText).toHaveBeenCalledOnce();
    expect(received?.model).toBe(fakeModel);
    expect(received?.system).toBe("Be concise.");
    expect(received?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Use this" },
          { type: "text", text: '{"id":1}' },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "prior_call",
            toolName: "lookup",
            input: { term: "prior" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "prior_call",
            toolName: "lookup",
            output: { type: "json", value: { found: true } },
          },
        ],
      },
    ]);
    expect(received?.tools).toHaveProperty("lookup");
    expect(received?.output).toBeDefined();
    expect(received?.providerOptions).toEqual({
      openai: { reasoningEffort: "low" },
    });
    expect(received?.maxOutputTokens).toBe(256);
    expect(result).toEqual({
      output: { answer: 42 },
      transcript: [
        {
          id: "message_1",
          type: "message",
          role: "assistant",
          content: [
            { type: "reasoning", text: "checked the facts" },
            {
              type: "tool-call",
              call: {
                id: "call_1",
                name: "lookup",
                input: { term: "Example Corp" },
              },
            },
          ],
          createdAt: "2026-07-22T12:00:00.000Z",
          model: "openai/gpt-test",
          usage: {
            inputTokens: 10,
            outputTokens: 7,
            reasoningTokens: 3,
            cachedInputTokens: 4,
            cacheWriteTokens: 2,
            totalTokens: 17,
          },
        },
      ],
      toolCalls: [
        {
          id: "call_1",
          name: "lookup",
          input: { term: "Example Corp" },
        },
      ],
      finishReason: "tool-calls",
      providerMetadata: { openai: { responseId: "response_1" } },
    });
  });

  it("emits transient deltas and one completed neutral result in stream order", async () => {
    async function* parts(): AsyncIterable<AiSdkStreamPart> {
      yield { type: "text-start", id: "text_1" };
      yield { type: "reasoning-delta", text: "Think " };
      yield { type: "text-delta", text: "Hello" };
      yield {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "lookup",
        input: { id: 7 },
      };
      yield { type: "text-delta", text: " world" };
      yield {
        type: "finish-step",
        finishReason: "stop",
        providerMetadata: { test: { requestId: "req_1" } },
      };
      yield {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      };
    }

    const adapter = new AiSdkModelAdapter({
      resolveModel: () => fakeModel,
      streamText: () => ({ fullStream: parts() }),
      now: () => new Date("2026-07-22T13:00:00.000Z"),
      generateTranscriptId: () => "message_stream",
    });

    const events = [];
    for await (const event of adapter.stream(request())) events.push(event);

    expect(events).toEqual([
      { type: "reasoning-delta", delta: "Think " },
      { type: "text-delta", delta: "Hello" },
      {
        type: "tool-call",
        call: { id: "call_1", name: "lookup", input: { id: 7 } },
      },
      { type: "text-delta", delta: " world" },
      {
        type: "completed",
        result: {
          output: "Hello world",
          transcript: [
            {
              id: "message_stream",
              type: "message",
              role: "assistant",
              content: [
                { type: "reasoning", text: "Think " },
                { type: "text", text: "Hello world" },
                {
                  type: "tool-call",
                  call: { id: "call_1", name: "lookup", input: { id: 7 } },
                },
              ],
              createdAt: "2026-07-22T13:00:00.000Z",
              model: "openai/gpt-test",
              usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            },
          ],
          toolCalls: [{ id: "call_1", name: "lookup", input: { id: 7 } }],
          finishReason: "stop",
          providerMetadata: { test: { requestId: "req_1" } },
        },
      },
    ]);
  });

  it("awaits structured stream output before completing", async () => {
    async function* parts(): AsyncIterable<AiSdkStreamPart> {
      yield { type: "text-delta", text: '{"answer":42}' };
      yield { type: "finish", finishReason: "stop" };
    }
    const adapter = new AiSdkModelAdapter({
      resolveModel: () => fakeModel,
      streamText: () => ({
        fullStream: parts(),
        output: Promise.resolve({ answer: 42 }),
      }),
      generateTranscriptId: () => "message_structured",
    });

    const events = [];
    for await (const event of adapter.stream(
      request({
        outputSchema: { type: "object" },
      }),
    ))
      events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      result: { output: { answer: 42 } },
    });
  });

  it("surfaces SDK stream errors and aborts without a completed event", async () => {
    async function* errorParts(): AsyncIterable<AiSdkStreamPart> {
      yield { type: "text-delta", text: "partial" };
      yield { type: "error", error: "provider unavailable" };
    }
    const adapter = new AiSdkModelAdapter({
      resolveModel: () => fakeModel,
      streamText: () => ({ fullStream: errorParts() }),
    });

    const consume = async () => {
      for await (const _event of adapter.stream(request())) {
        // Consume until the adapter surfaces the provider error.
      }
    };
    await expect(consume()).rejects.toThrow("provider unavailable");

    async function* abortedParts(): AsyncIterable<AiSdkStreamPart> {
      yield { type: "abort", reason: "caller cancelled" };
    }
    const aborted = new AiSdkModelAdapter({
      resolveModel: () => fakeModel,
      streamText: () => ({ fullStream: abortedParts() }),
    });
    const consumeAbort = async () => {
      for await (const _event of aborted.stream(request())) {
        // Consume until abort.
      }
    };
    await expect(consumeAbort()).rejects.toThrow(
      "Model stream aborted: caller cancelled",
    );
  });
});
