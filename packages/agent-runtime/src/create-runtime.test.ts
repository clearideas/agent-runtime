import { describe, expect, it } from "vitest";
import { createAgentRuntime, defineAgent, MemoryRunStore } from "./index.js";

describe("standard composition", () => {
  it("runs a validated definition with injected adapters and retains durable state", async () => {
    const manifest = defineAgent({
      schemaVersion: "1.0",
      model: { provider: "openai", model: "test" },
      steps: [
        {
          id: "answer",
          type: "prompt",
          prompt: "Hello",
          includeInFinalOutput: true,
        },
      ],
    });
    const store = new MemoryRunStore();
    const runtime = createAgentRuntime({
      manifest,
      runStore: store,
      model: { generate: async () => ({ output: "Hello", transcript: [] }) },
    });
    const result = await runtime.run({ runId: "factory-test" });
    expect(result.output).toBe("Hello");
    expect((await store.loadRun(result.runId))?.status).toBe("completed");
  });
  it("rejects invalid definitions before creating adapters", () => {
    expect(() =>
      defineAgent({
        schemaVersion: "1.0",
        steps: [{ id: "", type: "prompt", prompt: "Hello" }],
      }),
    ).toThrow();
  });
});
