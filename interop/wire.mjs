#!/usr/bin/env node
/**
 * Provider-wire driver for the cross-language suite (TypeScript side).
 *
 * Reads `{ cases: [{ id, driver, name, baseURL, request, mode }] }` from
 * stdin. Each case creates the AI SDK provider the runtime configures for the
 * driver (pointed at a local mock server, with an `x-case` header), sends the
 * neutral `ModelRequest` through `AiSdkModelAdapter`, and reports the
 * `ModelResult` or error. The Python suite records the HTTP requests and
 * compares them with those its own adapter sends for the same cases.
 */
import { readFileSync } from "node:fs";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { AiSdkModelAdapter } from "@clearideas/agent-runtime-model-ai-sdk";

process.removeAllListeners("warning");
process.on("warning", () => {});
globalThis.AI_SDK_LOG_WARNINGS = false;

const factory = ({ driver, name, baseURL, id, options = {} }) => {
  const common = { apiKey: "test-key", baseURL, headers: { "x-case": id } };
  switch (driver) {
    case "openai":
      return createOpenAI(common);
    case "anthropic":
      return createAnthropic(common);
    case "google":
      return createGoogleGenerativeAI(common);
    case "xai":
      return createXai(common);
    case "groq":
      return createGroq(common);
    case "cohere":
      return createCohere(common);
    case "openai-compatible":
      return createOpenAICompatible({ name, ...common, ...options });
    default:
      throw new Error(`Unknown driver ${driver}`);
  }
};

const input = JSON.parse(readFileSync(0, "utf8"));
const results = [];
for (const entry of input.cases) {
  const provider = factory(entry);
  const adapter = new AiSdkModelAdapter({
    resolveModel: (model) => provider(model.slice(model.indexOf("/") + 1)),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    generateTranscriptId: () => "item",
  });
  try {
    if (entry.mode === "stream") {
      const events = [];
      for await (const event of adapter.stream(entry.request)) events.push(event);
      results.push({ ok: true, events });
    } else {
      results.push({ ok: true, result: await adapter.generate(entry.request) });
    }
  } catch (error) {
    results.push({
      ok: false,
      error: { name: error?.name, message: error?.message, statusCode: error?.statusCode },
    });
  }
}
process.stdout.write(JSON.stringify(results));
