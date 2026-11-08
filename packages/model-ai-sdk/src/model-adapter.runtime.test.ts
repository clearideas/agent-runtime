/**
 * End to end: a prompt step that uses tools and returns structured output,
 * run by Agent Runtime through this adapter and the real AI SDK. The AI SDK's
 * mock language model stands in for a provider: it calls a tool that returns
 * an image, then answers with JSON.
 */
import { createAgentRuntime, defineAgent } from "@clearideas/agent-runtime";
import type { ArtifactRef } from "@clearideas/agent-runtime-contracts";
import { APICallError } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";

import { AiSdkModelAdapter } from "./model-adapter.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

describe("a prompt step with tools and an outputSchema", () => {
  it.each(["stream", "generate"] as const)(
    "%s: calls a tool that returns an image, then returns structured output",
    async (mode) => {
      const prompts: any[] = [];
      const answer = (options: any) => {
        prompts.push(options.prompt);
        const first = prompts.length === 1;
        return {
          parts: first
            ? [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "Let me look." },
                { type: "text-end", id: "t" },
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "read_diagram",
                  input: "{}",
                },
              ]
            : [
                { type: "text-start", id: "t" },
                {
                  type: "text-delta",
                  id: "t",
                  delta: '{"steps":3,"sawImage":true}',
                },
                { type: "text-end", id: "t" },
              ],
          finishReason: first
            ? { unified: "tool-calls", raw: "tool_calls" }
            : { unified: "stop", raw: "stop" },
        };
      };
      const model = new MockLanguageModelV4({
        doStream: async (options: any) => {
          const { parts, finishReason } = answer(options);
          return {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              ...parts,
              { type: "finish", finishReason, usage },
            ] as never[]),
          };
        },
        doGenerate: async (options: any) => {
          const { parts, finishReason } = answer(options);
          return {
            content: parts.flatMap((part: any) =>
              part.type === "text-delta"
                ? [{ type: "text", text: part.delta }]
                : part.type === "tool-call"
                  ? [part]
                  : [],
            ),
            finishReason,
            usage,
            warnings: [],
          } as never;
        },
      });
      const adapter = new AiSdkModelAdapter({
        resolveModel: () => model as never,
      });

      const stored = new Map<string, { ref: ArtifactRef; data: Uint8Array }>();
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const runtime = createAgentRuntime({
        manifest: defineAgent({
          schemaVersion: "1.0",
          model: { provider: "mock", model: "model" },
          steps: [
            {
              id: "describe",
              type: "prompt",
              prompt: "How many steps does the diagram show?",
              tools: ["read_diagram"],
              outputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["steps", "sawImage"],
                properties: {
                  steps: { type: "number" },
                  sawImage: { type: "boolean" },
                },
              },
              outputVariable: "answer",
              includeInFinalOutput: true,
            },
          ],
        }),
        model:
          mode === "stream"
            ? adapter
            : { generate: (request) => adapter.generate(request) },
        artifacts: {
          put: async (input) => {
            const ref: ArtifactRef = {
              id: `artifact-${stored.size + 1}`,
              name: input.name,
              mediaType: input.mediaType,
            };
            stored.set(ref.id, {
              ref,
              data:
                typeof input.data === "string"
                  ? new TextEncoder().encode(input.data)
                  : input.data,
            });
            return ref;
          },
          get: async (ref) => stored.get(ref.id)!,
        },
        tools: {
          listTools: async () => [
            {
              name: "read_diagram",
              description: "Read the approval diagram.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
          executeTool: async (call) => {
            const ref = {
              id: "artifact-diagram",
              name: "diagram.png",
              mediaType: "image/png",
            };
            stored.set(ref.id, { ref, data: png });
            return {
              callId: call.id,
              name: call.name,
              output: { path: "diagram.png" },
              artifacts: [ref],
            };
          },
        },
      });

      const result = await runtime.run({});

      expect(result.state.answer).toEqual({ steps: 3, sawImage: true });
      // The second provider call received the image inside the tool result.
      const toolMessage = prompts[1].find(
        (message: any) => message.role === "tool",
      );
      const file = toolMessage.content[0].output.value.find(
        (part: any) => part.type === "file",
      );
      expect(file.mediaType).toBe("image/png");
      expect(file.data).toEqual({
        type: "data",
        data: Buffer.from(png).toString("base64"),
      });
    },
  );
});

/** A mock provider whose turns are produced by `answer`, in both modes. */
const mockProvider = (
  answer: (options: any) => { parts: any[]; finishReason: any },
) =>
  new MockLanguageModelV4({
    doStream: async (options: any) => {
      const { parts, finishReason } = answer(options);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          ...parts,
          { type: "finish", finishReason, usage },
        ] as never[]),
      };
    },
    doGenerate: async (options: any) => {
      const { parts, finishReason } = answer(options);
      return {
        content: parts.flatMap((part: any) =>
          part.type === "text-delta"
            ? [{ type: "text", text: part.delta }]
            : part.type === "tool-call"
              ? [part]
              : [],
        ),
        finishReason,
        usage,
        warnings: [],
      } as never;
    },
  });

const text = (value: string) => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: value },
  { type: "text-end", id: "t" },
];
const stop = { unified: "stop", raw: "stop" };

describe("recoverable provider behavior through the real AI SDK", () => {
  it.each(["stream", "generate"] as const)(
    "%s: a call to a tool outside the step is answered once and never run",
    async (mode) => {
      const prompts: any[] = [];
      const model = mockProvider((options) => {
        prompts.push(options.prompt);
        return prompts.length === 1
          ? {
              parts: [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "docs__delete",
                  input: '{"id":"all"}',
                },
              ],
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
            }
          : { parts: text("I cannot delete documents."), finishReason: stop };
      });
      const adapter = new AiSdkModelAdapter({
        resolveModel: () => model as never,
      });
      const executed: string[] = [];
      const runtime = createAgentRuntime({
        manifest: defineAgent({
          schemaVersion: "1.0",
          model: { provider: "mock", model: "model" },
          steps: [
            {
              id: "read",
              type: "prompt",
              prompt: "Summarize the documents.",
              tools: ["docs__read"],
            },
          ],
        }),
        model:
          mode === "stream"
            ? adapter
            : { generate: (request) => adapter.generate(request) },
        tools: {
          // The host exposes a destructive tool to other steps of this agent.
          listTools: async () => [
            { name: "docs__read", inputSchema: { type: "object" } },
            { name: "docs__delete", inputSchema: { type: "object" } },
          ],
          executeTool: async (call) => {
            executed.push(call.name);
            return { callId: call.id, name: call.name, output: "deleted" };
          },
        },
      });
      const result = await runtime.run({});
      expect(result.output).toBe("I cannot delete documents.");
      expect(executed).toEqual([]);
      const toolResults = prompts[1]
        .filter((message: any) => message.role === "tool")
        .flatMap((message: any) => message.content)
        .filter((part: any) => part.type === "tool-result");
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolCallId).toBe("call-1");
    },
  );

  it.each(["stream", "generate"] as const)(
    "%s: a provider context-overflow error shrinks the opening prompt and retries",
    async (mode) => {
      const sizes: number[] = [];
      const model = mockProvider((options) => {
        const size = JSON.stringify(options.prompt).length;
        sizes.push(size);
        if (size > 20_000) {
          throw new APICallError({
            message:
              "This model's maximum context length is 5000 tokens. Please reduce the length of the messages.",
            url: "https://provider.example/v1/chat",
            requestBodyValues: {},
            statusCode: 400,
            isRetryable: false,
          });
        }
        return { parts: text("summary written"), finishReason: stop };
      });
      const adapter = new AiSdkModelAdapter({
        resolveModel: () => model as never,
      });
      const runtime = createAgentRuntime({
        manifest: defineAgent({
          schemaVersion: "1.0",
          model: { provider: "mock", model: "model" },
          variables: [{ key: "report", type: "string" }],
          steps: [
            {
              id: "summarize",
              type: "prompt",
              prompt: "Summarize this report:\n{{ report }}",
            },
          ],
        }),
        model:
          mode === "stream"
            ? adapter
            : { generate: (request) => adapter.generate(request) },
      });
      const result = await runtime.run({
        variables: [{ key: "report", value: "finding ".repeat(10_000) }],
      });
      expect(result.output).toBe("summary written");
      expect(sizes[0]).toBeGreaterThan(20_000);
      expect(sizes.at(-1)).toBeLessThanOrEqual(20_000);
    },
  );
});
