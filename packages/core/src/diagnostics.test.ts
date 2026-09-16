import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentRuntime, AgentRuntimeError } from "./agent-runtime.js";
import { MemoryRunStore } from "./testing/index.js";
const manifest = {
  schemaVersion: "1.0" as const,
  steps: [{ id: "work", type: "prompt" as const, prompt: "Work" }],
};

describe("durable diagnostics", () => {
  it("preserves a classified failure and recovery hint", async () => {
    const store = new MemoryRunStore();
    const error = new AgentRuntimeError(
      "Unavailable",
      "PROVIDER_UNAVAILABLE",
      true,
      "Try again later.",
    );
    const runtime = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        {
          type: "prompt",
          execute: async () => {
            throw error;
          },
        },
      ],
    });
    await expect(runtime.run({ manifest, runId: "failed" })).rejects.toBe(
      error,
    );
    expect(store.failures.get("failed")?.error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      details: { suggestedAction: "Try again later." },
    });
  });
  it("writes the package version and can resume a checkpoint from an earlier runtime", async () => {
    const store = new MemoryRunStore();
    let fail = true;
    const runtime = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        {
          type: "prompt",
          execute: async () => {
            if (fail) throw new Error("Interrupted");
            return { output: "Recovered" };
          },
        },
      ],
    });
    await expect(runtime.run({ manifest, runId: "version" })).rejects.toThrow(
      "Interrupted",
    );
    const checkpoint = (await store.loadLatestCheckpoint("version"))!;
    const version = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
    expect(checkpoint.runtimeVersion).toBe(version);
    // A prior release has the same contract and manifest fingerprint.
    const legacy = { ...checkpoint, runtimeVersion: "0.1.0" };
    const original = store.loadLatestCheckpoint.bind(store);
    store.loadLatestCheckpoint = async () => legacy;
    fail = false;
    expect(
      (await runtime.run({ manifest, runId: "version", resume: true })).output,
    ).toBe("Recovered");
    store.loadLatestCheckpoint = original;
  });
});
