import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";

import { ScriptedModelAdapter } from "../lib/scripted-model.ts";

test("stops with a clear error when the sandbox could not run a command", async () => {
  const model = new ScriptedModelAdapter(() => ({ output: "unreachable" }), {
    pace: 0,
  });
  await assert.rejects(
    model.generate({
      model: "scripted",
      messages: [
        { role: "user", content: [{ type: "text", text: "Go." }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              result: {
                callId: "c1",
                name: "repo__list_files",
                error: {
                  code: "sandbox_command_failed",
                  message: "helper exited 1",
                },
              },
            },
          ],
        },
      ],
    }),
    /The sandbox could not run repo__list_files \(sandbox_command_failed\)/u,
  );
});

test("streams narration, then calls a tool with usage reported", async () => {
  const model = new ScriptedModelAdapter(
    () => ({
      say: "Looking around.",
      call: { name: "repo__list_files", input: {} },
    }),
    { pace: 0 },
  );
  const deltas: string[] = [];
  let toolCalls = 0;
  let totalTokens = 0;
  for await (const event of model.stream({
    model: "scripted",
    messages: [{ role: "user", content: [{ type: "text", text: "Go." }] }],
  })) {
    if (event.type === "text-delta") deltas.push(event.delta);
    if (event.type === "completed") {
      toolCalls = event.result.toolCalls?.length ?? 0;
      totalTokens = event.result.transcript[0]?.usage?.totalTokens ?? 0;
    }
  }
  assert.equal(deltas.join(""), "Looking around.");
  assert.equal(toolCalls, 1);
  assert.ok(totalTokens > 0);
});

test("paced narration releases abort listeners after completion and cancellation", async () => {
  const controller = new AbortController();
  const model = new ScriptedModelAdapter(
    () => ({ output: Array(30).fill("word").join(" ") }),
    { pace: 0.001 },
  );
  const request = {
    model: "scripted",
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Go." }],
      },
    ],
    signal: controller.signal,
  };
  await model.generate(request);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  const pending = new ScriptedModelAdapter(
    () => ({ output: "never reached" }),
    { pace: 1 },
  ).generate(request);
  controller.abort(new Error("browser disconnected"));
  await assert.rejects(pending, /browser disconnected/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(model.generate(request), /browser disconnected/);
});
