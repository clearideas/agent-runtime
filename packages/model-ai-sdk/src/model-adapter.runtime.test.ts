/**
 * End to end: a prompt step that uses tools and returns structured output,
 * run by Agent Runtime through this adapter and the real AI SDK. The AI SDK's
 * mock language model stands in for a provider: it calls a tool that returns
 * an image, then answers with JSON.
 */
import { createAgentRuntime, defineAgent } from "@clearideas/agent-runtime";
import type { ArtifactRef } from "@clearideas/agent-runtime-contracts";
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
