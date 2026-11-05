import { spawnSync } from "node:child_process";

import { HostProcessTestProvider } from "@clearideas/agent-runtime-sandbox/testing";
import { describe, expect, it } from "vitest";

import {
  createAgentRuntime,
  defineAgent,
  MemoryRunStore,
  MemoryWorkspace,
  ProviderRunSandbox,
  type ModelAdapter,
  type ToolCall,
} from "./index.js";

/** The helper and the host-process test provider run POSIX commands; skip elsewhere. */
const hasPython =
  process.platform !== "win32" &&
  spawnSync("python3", ["--version"]).status === 0;

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
  it.skipIf(!hasPython)(
    "serves host-supplied workspaces through the run sandbox and composed tools",
    { timeout: 60_000 },
    async () => {
      const manifest = defineAgent({
        schemaVersion: "1.0",
        model: { provider: "openai", model: "test" },
        workspaces: [{ ref: "docs", mode: "read" }],
        steps: [
          {
            id: "answer",
            type: "prompt",
            prompt: "Read the guide.",
            tools: ["docs__read_file"],
            includeInFinalOutput: true,
          },
        ],
      });
      let round = 0;
      const model: ModelAdapter = {
        generate: async (request) => {
          round += 1;
          if (round === 1) {
            const call: ToolCall = {
              id: "call-1",
              name: "docs__read_file",
              input: { path: "guide.md" },
            };
            return {
              transcript: [
                {
                  id: "t1",
                  type: "tool-call",
                  role: "assistant",
                  content: [{ type: "tool-call", call }],
                  createdAt: new Date().toISOString(),
                },
              ],
              toolCalls: [call],
            };
          }
          const part = request.messages.find(
            (message) => message.role === "tool",
          )?.content[0];
          return {
            output: JSON.stringify(
              part?.type === "tool-result" ? part.result.output : null,
            ),
            transcript: [],
          };
        },
      };
      const runtime = createAgentRuntime({
        manifest,
        model,
        workspaces: {
          resolveWorkspace: async () =>
            new MemoryWorkspace({
              files: { "guide.md": "# Guide\nUse it.\n" },
            }),
        },
        runSandbox: new ProviderRunSandbox({
          provider: new HostProcessTestProvider(),
          image: "test",
        }),
      });
      const result = await runtime.run({ runId: "workspace-test" });
      expect(JSON.parse(String(result.output))).toMatchObject({
        path: "guide.md",
        encoding: "utf-8",
        content: "# Guide\nUse it.",
      });
      const toolResult = result.transcript.find(
        (item) => item.type === "tool-result",
      );
      const part = toolResult?.content[0];
      expect(
        part?.type === "tool-result"
          ? part.result.metadata?.command
          : undefined,
      ).toMatchObject({
        kind: "builtin",
        name: "read_file",
      });
    },
  );
  it("rejects invalid definitions before creating adapters", () => {
    expect(() =>
      defineAgent({
        schemaVersion: "1.0",
        steps: [{ id: "", type: "prompt", prompt: "Hello" }],
      }),
    ).toThrow();
  });
});
