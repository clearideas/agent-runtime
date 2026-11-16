/**
 * End-to-end behavior of the guaranteed-execution features through the
 * primary package: interrupted runs resume, approvals can continue or end a
 * run, and a long tool loop finishes inside a small input limit.
 */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  ApprovalStepExecutor,
  composeRuntime,
  createAgentRuntime,
  defineAgent,
  InProcessExecutionEngine,
  JexlConditionEvaluator,
  LoopStepExecutor,
  MemoryRunStore,
  parseAgentRuntimeConfig,
  PromptStepExecutor,
  RunInterruptedError,
  type ModelAdapter,
  type ModelResult,
  type ToolCall,
} from "./index.js";

/** The helper and the host-process test provider run POSIX commands; skip elsewhere. */
const hasPython =
  process.platform !== "win32" &&
  spawnSync("python3", ["--version"]).status === 0;

const at = "2026-07-22T00:00:00.000Z";
let counter = 0;
const reply = (text: string, calls: ToolCall[] = []): ModelResult => ({
  ...(calls.length === 0 ? { output: text } : {}),
  toolCalls: calls,
  transcript: [
    {
      id: `reply-${++counter}`,
      type: "message",
      role: "assistant",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...calls.map((call) => ({ type: "tool-call" as const, call })),
      ],
      createdAt: at,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  ],
});

describe("parallel prompt checkpoints", () => {
  const manifest = defineAgent({
    schemaVersion: "1.0",
    model: { provider: "test", model: "m" },
    policies: { modelRetry: { maxAttempts: 1 } },
    steps: ["first", "second", "third"].map((id) => ({
      id,
      type: "prompt" as const,
      prompt: id,
      outputVariable: id,
    })),
  });

  it("commits simultaneous prompt responses as one complete wave", async () => {
    const runStore = new MemoryRunStore();
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkpoints: number[] = [];
    const runtime = new AgentRuntime({
      runStore,
      stepExecutors: [new PromptStepExecutor()],
      eventSinks: [
        {
          emit: async (event) => {
            if (event.type === "checkpoint.saved")
              checkpoints.push(
                (await runStore.loadLatestCheckpoint(event.runId))!.cursor
                  .stepIndex,
              );
          },
        },
      ],
      model: {
        generate: async (request) => {
          if (++started === 3) release();
          await barrier;
          const part = request.messages[0]!.content[0]!;
          return reply(part.type === "text" ? part.text : "");
        },
      },
    });
    const result = await runtime.run({
      runId: "parallel",
      manifest,
      execution: { mode: "parallel", maxConcurrency: 3 },
    });
    expect(result.state).toEqual({
      first: "first",
      second: "second",
      third: "third",
    });
    expect(result.stepResults.map((step) => step.stepId)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(checkpoints).toEqual([0, 3]);
  });

  it("resumes an interrupted parallel wave from its start without skipping sibling outputs", async () => {
    const runStore = new MemoryRunStore();
    const calls: string[] = [];
    let interrupt = true;
    const runtime = new AgentRuntime({
      runStore,
      stepExecutors: [new PromptStepExecutor()],
      model: {
        generate: async (request) => {
          const part = request.messages[0]!.content[0]!;
          const text = part.type === "text" ? part.text : "";
          calls.push(text);
          if (text === "third" && interrupt) {
            interrupt = false;
            throw new RunInterruptedError("shutdown");
          }
          return reply(text);
        },
      },
    });
    await expect(
      runtime.run({
        runId: "interrupted-wave",
        manifest,
        execution: { mode: "parallel" },
      }),
    ).rejects.toMatchObject({ code: "RUN_INTERRUPTED" });
    expect(
      (await runStore.loadLatestCheckpoint("interrupted-wave"))?.cursor
        .stepIndex,
    ).toBe(0);
    const result = await runtime.run({
      runId: "interrupted-wave",
      resume: true,
      execution: { mode: "parallel" },
    });
    expect(result.state).toEqual({
      first: "first",
      second: "second",
      third: "third",
    });
    expect(calls).toEqual([
      "first",
      "second",
      "third",
      "first",
      "second",
      "third",
    ]);
  });
});

describe("interrupted executions", () => {
  it("an execution timeout leaves the run interrupted, and resuming completes it", async () => {
    const runStore = new MemoryRunStore();
    const manifest = defineAgent({
      schemaVersion: "1.0",
      model: { provider: "test", model: "m" },
      steps: [
        { id: "first", type: "prompt", prompt: "one" },
        { id: "slow", type: "prompt", prompt: "two" },
      ],
    });
    let hung = false;
    let underEngine = true;
    const model: ModelAdapter = {
      generate: async (request) => {
        const prompt = JSON.stringify(request.messages);
        // Under the engine, hang once until its timeout aborts the request.
        // Every request has a signal (run limits use it), so the direct
        // resume is told apart explicitly: under load, the timeout can fire
        // before this step is reached.
        if (prompt.includes("two") && underEngine && !hung) {
          hung = true;
          await new Promise((_resolve, reject) =>
            request.signal!.addEventListener("abort", () =>
              reject(request.signal!.reason),
            ),
          );
        }
        return reply(prompt.includes("two") ? "second" : "first");
      },
    };
    const agentRuntime = new AgentRuntime({
      runStore,
      model,
      stepExecutors: [new PromptStepExecutor()],
    });
    const engine = new InProcessExecutionEngine((request, execution) =>
      agentRuntime.run({
        manifest: request.manifest,
        runId: execution.handle.runId,
        signal: execution.signal,
      }),
    );
    const handle = await engine.submit({
      manifest,
      runId: "timed-out",
      timeoutMs: 300,
    });
    await expect(engine.result(handle)).rejects.toMatchObject({
      code: "EXECUTION_TIMEOUT",
    });
    expect((await runStore.loadRun("timed-out"))?.status).toBe("interrupted");

    underEngine = false;
    const resumed = await agentRuntime.run({
      runId: "timed-out",
      manifest,
      resume: true,
    });
    expect(resumed.stepResults.map((result) => result.stepId)).toEqual([
      "first",
      "slow",
    ]);
    expect(resumed.output).toBe("second");
  });
});

describe("approval rejections", () => {
  const manifest = (onReject: "continue" | "complete") =>
    defineAgent({
      schemaVersion: "1.0",
      model: { provider: "test", model: "m" },
      steps: [
        {
          id: "draft",
          type: "prompt",
          prompt: "draft",
          outputVariable: "draft",
        },
        {
          id: "review",
          type: "approval",
          prompt: "Publish?",
          outputVariable: "review",
          onReject,
        },
        {
          id: "publish",
          type: "prompt",
          prompt: "publish",
          when: "review.approved == true",
          includeInFinalOutput: true,
        },
        {
          id: "revise",
          type: "prompt",
          prompt: "revise",
          when: "review.approved == false",
          includeInFinalOutput: true,
        },
      ],
    });
  const run = (onReject: "continue" | "complete") => {
    const prompts: string[] = [];
    const agentRuntime = new AgentRuntime({
      runStore: new MemoryRunStore(),
      model: {
        generate: async (request) => {
          const text = JSON.stringify(request.messages);
          const name = ["draft", "publish", "revise"].find((value) =>
            text.includes(`"${value}"`),
          )!;
          prompts.push(name);
          return reply(`${name} done`);
        },
      },
      approvals: {
        requestApproval: async () => ({ approved: false, respondedAt: at }),
      },
      conditionEvaluator: new JexlConditionEvaluator(),
      stepExecutors: [new PromptStepExecutor(), new ApprovalStepExecutor()],
    });
    return {
      prompts,
      result: agentRuntime.run({ manifest: manifest(onReject) }),
    };
  };

  it("continue lets later steps branch on the rejection", async () => {
    const { prompts, result } = run("continue");
    await expect(result).resolves.toMatchObject({ output: "revise done" });
    expect(prompts).toEqual(["draft", "revise"]);
  });

  it("complete ends the run successfully at the rejection", async () => {
    const { prompts, result } = run("complete");
    const completed = await result;
    expect(prompts).toEqual(["draft"]);
    expect(completed.stepResults.map((entry) => entry.stepId)).toEqual([
      "draft",
      "review",
    ]);
  });
});

// Thirty tool rounds with pruning: about a second alone, much longer when the
// whole suite runs in parallel on a busy machine.
describe(
  "a long tool loop under a small input limit",
  { timeout: 30_000 },
  () => {
    it("finishes with the default prune policy and keeps every tool result durably", async () => {
      let reads = 0;
      const executed: string[] = [];
      const runtime = createAgentRuntime({
        manifest: defineAgent({
          schemaVersion: "1.0",
          model: { provider: "test", model: "m" },
          limits: { maxInputBytes: 16_000, maxToolCallsPerIteration: 50 },
          steps: [
            {
              id: "investigate",
              type: "prompt",
              prompt: "Read all 30 log files, then summarize.",
              tools: ["logs__read"],
            },
          ],
        }),
        model: {
          generate: async () =>
            reads >= 30
              ? reply("All 30 logs read; no anomalies.")
              : reply("", [
                  {
                    id: `read-${++reads}`,
                    name: "logs__read",
                    input: { file: `log-${reads}.txt` },
                  },
                ]),
        },
        tools: {
          listTools: async () => [
            { name: "logs__read", inputSchema: { type: "object" } },
          ],
          executeTool: async (call) => {
            executed.push(call.id);
            return {
              callId: call.id,
              name: call.name,
              output: `${String(call.input.file)}\n${"INFO request ok\n".repeat(250)}`,
            };
          },
        },
      });
      const result = await runtime.run({});
      expect(result.output).toBe("All 30 logs read; no anomalies.");
      expect(executed).toHaveLength(30);
      expect(
        result.transcript.filter((item) => item.role === "tool"),
      ).toHaveLength(30);
    });
  },
);

describe("a tool-using prompt step inside a loop", () => {
  it("resumes a token-budget suspension in its iteration without repeating earlier work", async () => {
    const toolRuns: string[] = [];
    const modelCalls: string[] = [];
    const model: ModelAdapter = {
      generate: async (request) => {
        const text = JSON.stringify(request.messages);
        const item = /Research (\w+)/.exec(text)![1]!;
        const looked = text.includes(`facts about ${item}`);
        modelCalls.push(`${item}:${looked ? "answer" : "tool"}`);
        return looked
          ? reply(`summary of ${item}`)
          : reply("", [
              {
                id: `lookup-${item}`,
                name: "lookup",
                input: { item },
              },
            ]);
      },
    };
    const tools = {
      listTools: async () => [
        { name: "lookup", inputSchema: { type: "object" } },
      ],
      executeTool: async (call: ToolCall) => {
        toolRuns.push(String(call.input.item));
        return {
          callId: call.id,
          name: call.name,
          output: `facts about ${String(call.input.item)}`,
        };
      },
    };
    const manifest = defineAgent({
      schemaVersion: "1.0",
      model: { provider: "test", model: "m" },
      variables: [
        { key: "items", type: "array", value: ["alpha", "beta", "gamma"] },
      ],
      steps: [
        {
          id: "each",
          type: "loop",
          loop: { source: "items", itemVariable: "item" },
          outputVariable: "summaries",
          steps: [
            {
              id: "research",
              type: "prompt",
              prompt: "Research {{ item }}",
              tools: ["lookup"],
            },
          ],
        },
      ],
    });
    const runStore = new MemoryRunStore();
    const runtime = () =>
      new AgentRuntime({
        runStore,
        model,
        tools,
        stepExecutors: [new PromptStepExecutor(), new LoopStepExecutor()],
      });
    // Each model call reports 15 tokens: alpha uses 30, beta's first call 45.
    await expect(
      runtime().run({
        runId: "loop-budget",
        manifest,
        budget: { maxTotalTokens: 45 },
      }),
    ).rejects.toMatchObject({ reason: "token-budget" });
    const result = await runtime().run({
      runId: "loop-budget",
      resume: true,
      budget: { maxTotalTokens: 1_000 },
    });
    expect(toolRuns).toEqual(["alpha", "beta", "gamma"]);
    expect(modelCalls).toEqual([
      "alpha:tool",
      "alpha:answer",
      "beta:tool",
      "beta:answer",
      "gamma:tool",
      "gamma:answer",
    ]);
    expect(result.output).toEqual([
      "summary of alpha",
      "summary of beta",
      "summary of gamma",
    ]);
    const ids = result.transcript.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const toolOutputs = result.transcript.flatMap((item) =>
      item.content.flatMap((part) =>
        part.type === "tool-result" ? [part.result.output] : [],
      ),
    );
    expect(toolOutputs).toEqual([
      "facts about alpha",
      "facts about beta",
      "facts about gamma",
    ]);
  });
});

describe.skipIf(!hasPython)("sandbox usage limits", { timeout: 60_000 }, () => {
  it("blocks at the manifest's command limit and continues when the host grants more, within its ceiling", async () => {
    const { HostProcessTestProvider } =
      await import("@clearideas/agent-runtime-sandbox/testing");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "sandbox-limits-"));
    try {
      const config = parseAgentRuntimeConfig({
        version: "1.0",
        workspaces: {
          notes: { driver: "local", root, mode: "read_write" },
        },
        sandbox: {
          driver: "host",
          // The host ceiling: no run may exceed three commands.
          limits: { maxCommandsPerRun: 3 },
        },
      });
      const manifest = defineAgent({
        schemaVersion: "1.0",
        model: { provider: "test", model: "m" },
        limits: { sandbox: { maxCommands: 1 } },
        workspaces: [{ ref: "notes" }],
        steps: [
          {
            id: "write",
            type: "prompt",
            prompt: "Write three notes",
            tools: ["notes__write_file"],
          },
        ],
      });
      let turn = 0;
      const model: ModelAdapter = {
        generate: async () => {
          turn += 1;
          return turn <= 4
            ? reply("", [
                {
                  id: `write-${turn}`,
                  name: "notes__write_file",
                  input: { path: `note-${turn}.md`, content: String(turn) },
                },
              ])
            : reply("done");
        },
      };
      const runStore = new MemoryRunStore();
      const runtime = () => {
        const composed = composeRuntime(
          manifest,
          config,
          {},
          {
            model: false,
            workspaceOptions: {
              sandboxProvider: new HostProcessTestProvider(),
            },
          },
        );
        return new AgentRuntime({
          runStore,
          model,
          stepExecutors: [new PromptStepExecutor()],
          ...composed,
        });
      };
      await expect(
        runtime().run({ runId: "sandbox-limit", manifest }),
      ).rejects.toMatchObject({
        reason: "blocked",
        details: { limit: "sandbox.maxCommands", used: 1, value: 1 },
      });
      // The grant asks for ten; the host ceiling of three applies.
      await expect(
        runtime().run({
          runId: "sandbox-limit",
          resume: true,
          limits: { sandbox: { maxCommands: 10 } },
        }),
      ).rejects.toMatchObject({
        reason: "blocked",
        details: { limit: "sandbox.maxCommands", used: 3, value: 3 },
      });
      expect(await readFile(path.join(root, "note-3.md"), "utf8")).toBe("3");
      await expect(
        readFile(path.join(root, "note-4.md"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasPython)(
  "interrupted workspace commands",
  { timeout: 60_000 },
  () => {
    const crashAfterFirstResult = (runStore: MemoryRunStore) => {
      let armed = true;
      const save = runStore.saveCheckpoint.bind(runStore);
      runStore.saveCheckpoint = async (checkpoint) => {
        // The process dies after the command ran and its changes were copied
        // back, before the checkpoint recording its result.
        if (
          armed &&
          checkpoint.transcript.some((item) => item.type === "tool-result")
        ) {
          armed = false;
          throw new Error("simulated crash");
        }
        return save(checkpoint);
      };
    };

    const setup = async (call: ToolCall) => {
      const { HostProcessTestProvider } =
        await import("@clearideas/agent-runtime-sandbox/testing");
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const root = await mkdtemp(path.join(tmpdir(), "in-doubt-"));
      const config = parseAgentRuntimeConfig({
        version: "1.0",
        workspaces: { ledger: { driver: "local", root, mode: "read_write" } },
        sandbox: { driver: "host", shell: { enabled: true } },
      });
      const manifest = defineAgent({
        schemaVersion: "1.0",
        model: { provider: "test", model: "m" },
        workspaces: [{ ref: "ledger" }],
        steps: [
          {
            id: "charge",
            type: "prompt",
            prompt: "Record the charge",
            tools: ["ledger__shell", "ledger__write_file"],
          },
        ],
      });
      const requests: string[] = [];
      let turn = 0;
      const model: ModelAdapter = {
        generate: async (request) => {
          requests.push(JSON.stringify(request.messages));
          turn += 1;
          return turn === 1 ? reply("", [call]) : reply("done");
        },
      };
      const runStore = new MemoryRunStore();
      crashAfterFirstResult(runStore);
      const runtime = () =>
        new AgentRuntime({
          runStore,
          model,
          stepExecutors: [new PromptStepExecutor()],
          ...composeRuntime(
            manifest,
            config,
            {},
            {
              model: false,
              workspaceOptions: {
                sandboxProvider: new HostProcessTestProvider(),
              },
            },
          ),
        });
      return { root, manifest, runtime, requests, path };
    };

    it("does not repeat a shell command whose outcome is unknown, and tells the model", async () => {
      const { readFile, rm } = await import("node:fs/promises");
      const { root, manifest, runtime, requests, path } = await setup({
        id: "append",
        name: "ledger__shell",
        input: { command: "echo charge-customer >> ledger.txt" },
      });
      try {
        await expect(
          runtime().run({ runId: "in-doubt", manifest }),
        ).rejects.toThrow("simulated crash");
        const result = await runtime().run({ runId: "in-doubt", resume: true });
        expect(result.output).toBe("done");
        expect(await readFile(path.join(root, "ledger.txt"), "utf8")).toBe(
          "charge-customer\n",
        );
        expect(requests.at(-1)).toContain("tool_call_interrupted");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("repeats an interrupted built-in write, which only sets a file's content", async () => {
      const { readFile, rm } = await import("node:fs/promises");
      const { root, manifest, runtime, requests, path } = await setup({
        id: "write",
        name: "ledger__write_file",
        input: { path: "note.md", content: "hello" },
      });
      try {
        await expect(
          runtime().run({ runId: "replay", manifest }),
        ).rejects.toThrow("simulated crash");
        await runtime().run({ runId: "replay", resume: true });
        expect(await readFile(path.join(root, "note.md"), "utf8")).toBe(
          "hello",
        );
        expect(requests.at(-1)).not.toContain("tool_call_interrupted");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
