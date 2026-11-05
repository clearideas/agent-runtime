import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createAnthropic } from "@ai-sdk/anthropic";
import {
  AiSdkModelAdapter,
  createAgentRuntime,
  defineAgent,
} from "@clearideas/agent-runtime";

const providerVersion = JSON.parse(
  readFileSync(
    new URL(
      "../../node_modules/@ai-sdk/anthropic/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
).version;
if (process.env.EXPECTED_ANTHROPIC_VERSION) {
  assert.equal(providerVersion, process.env.EXPECTED_ANTHROPIC_VERSION);
}

const modelId = "claude-sonnet-4-5-20250929";
const response = (toolCall = false) => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: toolCall
        ? { type: "tool_use", id: "call_1", name: "lookup", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: toolCall
        ? { type: "input_json_delta", partial_json: '{"query":"release"}' }
        : { type: "text_delta", text: "Hello" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: toolCall ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
};

const adapter = (fetch) => {
  const anthropic = createAnthropic({ apiKey: "offline-test-only", fetch });
  return new AiSdkModelAdapter({ resolveModel: () => anthropic(modelId) });
};

test(`Anthropic ${providerVersion} streams text through the installed SDK`, async () => {
  const model = adapter(async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return response();
  });
  const events = [];
  for await (const event of model.stream({
    model: `anthropic/${modelId}`,
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  })) {
    events.push(event);
  }
  const result = events.at(-1);
  assert.equal(result.type, "completed");
  assert.equal(result.result.output, "Hello");
  assert.deepEqual(result.result.transcript[0].content, [
    { type: "text", text: "Hello" },
  ]);
  assert.equal(result.result.transcript[0].usage.totalTokens, 8);
});

test(`Anthropic ${providerVersion} replays a tool round through AgentRuntime`, async () => {
  let requests = 0;
  const model = adapter(async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.stream, true);
    if (requests++ === 0) return response(true);
    assert.equal(requests, 2);
    const content = request.messages.flatMap((message) => message.content);
    assert.ok(
      content.some((part) => part.type === "tool_use" && part.id === "call_1"),
    );
    assert.ok(
      content.some(
        (part) => part.type === "tool_result" && part.tool_use_id === "call_1",
      ),
    );
    return response();
  });
  const manifest = defineAgent({
    schemaVersion: "1.0",
    model: { provider: "anthropic", model: modelId },
    steps: [
      {
        id: "lookup",
        type: "prompt",
        prompt: "Look up the release.",
        tools: ["lookup"],
        includeInFinalOutput: true,
      },
    ],
  });
  let calls = 0;
  const result = await createAgentRuntime({
    manifest,
    model,
    tools: {
      listTools: async () => [
        {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
      executeTool: async (call) => {
        calls += 1;
        assert.equal(call.name, "lookup");
        assert.deepEqual(call.input, { query: "release" });
        return { callId: call.id, name: call.name, output: { found: true } };
      },
    },
  }).run({});
  assert.equal(result.output, "Hello");
  assert.equal(calls, 1);
  assert.equal(requests, 2);
});
