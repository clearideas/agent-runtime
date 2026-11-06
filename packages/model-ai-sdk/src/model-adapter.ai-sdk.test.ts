/**
 * Contract tests against the real AI SDK: these use the default generateText
 * and streamText (no stubs) with the AI SDK's own mock language model, so the
 * AI SDK validates every prompt the adapter builds and parses every result
 * the way it does for real providers.
 */
import type { ModelRequest } from "@clearideas/agent-runtime-core/ports";
import {
  describeWorkspaceTools,
  resolveRunSandboxPolicy,
} from "@clearideas/agent-runtime-sandbox";
import { generateText, jsonSchema, tool } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";

import { AiSdkModelAdapter } from "./model-adapter.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

type Turn =
  | { text?: string; toolCall: { name: string; input: object } }
  | { text: string };

/** A provider that answers with the given turn and records what it received. */
const provider = (turn: Turn) => {
  const calls: any[] = [];
  const parts = () => [
    ...(turn.text
      ? [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: turn.text },
          { type: "text-end", id: "t" },
        ]
      : []),
    ...("toolCall" in turn
      ? [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: turn.toolCall.name,
            input: JSON.stringify(turn.toolCall.input),
          },
        ]
      : []),
  ];
  const finishReason =
    "toolCall" in turn
      ? { unified: "tool-calls", raw: "tool_calls" }
      : { unified: "stop", raw: "stop" };
  const model = new MockLanguageModelV4({
    doGenerate: async (options: any) => {
      calls.push(options);
      return {
        content: parts()
          .filter(
            (part) => part.type === "text-delta" || part.type === "tool-call",
          )
          .map((part: any) =>
            part.type === "text-delta"
              ? { type: "text", text: part.delta }
              : part,
          ),
        finishReason,
        usage,
        warnings: [],
      } as never;
    },
    doStream: async (options: any) => {
      calls.push(options);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          ...parts(),
          { type: "finish", finishReason, usage },
        ] as never[]),
      };
    },
  });
  return {
    calls,
    model,
    adapter: new AiSdkModelAdapter({ resolveModel: () => model as never }),
  };
};

const lookupTool = {
  name: "lookup",
  description: "Look something up.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const schema = {
  type: "object",
  properties: { status: { type: "string" } },
  required: ["status"],
  additionalProperties: false,
};
const ask = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "mock/model",
  messages: [{ role: "user", content: [{ type: "text", text: "Check it." }] }],
  ...overrides,
});

const streamed = async (adapter: AiSdkModelAdapter, request: ModelRequest) => {
  let completed;
  for await (const event of adapter.stream(request))
    if (event.type === "completed") completed = event.result;
  return completed!;
};

describe("workspace root spelling through the real AI SDK schema", () => {
  it.each(["", ".", "/", "\\"])(
    "accepts a list_files root path %j",
    async (path) => {
      const workspace = {
        binding: { ref: "docs" },
        alias: "docs",
        mode: "read" as const,
        store: {
          mode: "read" as const,
          entries: async () => [],
          read: async () => new Uint8Array(),
        },
      };
      const definitions = describeWorkspaceTools(
        workspace,
        resolveRunSandboxPolicy({}),
      );
      const list = definitions.find((item) => item.name === "list_files")!;
      const read = definitions.find((item) => item.name === "read_file")!;
      expect(read.inputSchema.properties).toMatchObject({
        path: { minLength: 1 },
      });
      const { model, calls } = provider({
        toolCall: { name: "list_files", input: { path } },
      });
      const result = await generateText({
        model,
        prompt: "List the workspace root.",
        tools: {
          list_files: tool({ inputSchema: jsonSchema(list.inputSchema) }),
        },
      });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        toolName: "list_files",
        input: { path },
      });
      expect(result.toolCalls[0]).not.toHaveProperty("invalid", true);
      expect(calls[0].tools[0].inputSchema.properties.path.minLength).toBe(0);
    },
  );
});

describe("AiSdkModelAdapter with the real AI SDK", () => {
  describe("a step with tools and an outputSchema", () => {
    const toolTurn: Turn = {
      text: "Let me look that up.",
      toolCall: { name: "lookup", input: { query: "status" } },
    };
    const request = ask({ tools: [lookupTool], outputSchema: schema });

    it("stream: returns the tool call from a tool-call turn", async () => {
      const { adapter, calls } = provider(toolTurn);
      const result = await streamed(adapter, request);
      expect(result.toolCalls).toEqual([
        { id: "call-1", name: "lookup", input: { query: "status" } },
      ]);
      // Both the tools and the schema reach the provider.
      expect(calls[0].tools).toHaveLength(1);
      expect(calls[0].responseFormat).toMatchObject({ type: "json" });
    });

    it("generate: returns the tool call from a tool-call turn", async () => {
      const { adapter } = provider(toolTurn);
      const result = await adapter.generate(request);
      expect(result.toolCalls).toEqual([
        { id: "call-1", name: "lookup", input: { query: "status" } },
      ]);
    });

    it.each(["stream", "generate"] as const)(
      "%s: accepts a silent tool-call turn",
      async (mode) => {
        const { adapter } = provider({
          toolCall: { name: "lookup", input: { query: "status" } },
        });
        const result =
          mode === "stream"
            ? await streamed(adapter, request)
            : await adapter.generate(request);
        expect(result.toolCalls).toHaveLength(1);
        expect(result.output).toBe("");
      },
    );

    it.each(["stream", "generate"] as const)(
      "%s: still rejects malformed final structured output",
      async (mode) => {
        const { adapter } = provider({ text: "This is not JSON." });
        await expect(
          mode === "stream"
            ? streamed(adapter, request)
            : adapter.generate(request),
        ).rejects.toThrow(/No object generated/u);
      },
    );

    it("stream and generate: parse the final structured answer", async () => {
      const { adapter } = provider({ text: '{"status":"ok"}' });
      expect((await streamed(adapter, request)).output).toEqual({
        status: "ok",
      });
      expect((await adapter.generate(request)).output).toEqual({
        status: "ok",
      });
    });
  });

  describe("a tool result with a file artifact", () => {
    const png = "iVBORw0KGgo=";
    const request = ask({
      messages: [
        { role: "user", content: [{ type: "text", text: "Describe it." }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              call: {
                id: "call-1",
                name: "read_file",
                input: { path: "a.png" },
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
                callId: "call-1",
                name: "read_file",
                output: { path: "a.png", encoding: "binary" },
                artifacts: [
                  {
                    id: "artifact-1",
                    name: "a.png",
                    mediaType: "image/png",
                    // step-prompt resolves tool artifacts to data: URLs.
                    uri: `data:image/png;base64,${png}`,
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    it.each(["stream", "generate"] as const)(
      "%s: sends the file to the provider",
      async (mode) => {
        const { adapter, calls } = provider({ text: "A diagram." });
        const result =
          mode === "stream"
            ? await streamed(adapter, request)
            : await adapter.generate(request);
        expect(result.output).toBe("A diagram.");
        const toolMessage = calls[0].prompt.find(
          (message: any) => message.role === "tool",
        );
        const output = toolMessage.content[0].output;
        expect(output.type).toBe("content");
        const file = output.value.find((part: any) => part.type === "file");
        expect(file.mediaType).toBe("image/png");
        expect(file.data).toMatchObject({ type: "data" });
      },
    );
  });
});
