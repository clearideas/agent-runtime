import type {
  AgentManifest,
  AgentStep,
  ExecutionPolicies,
} from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  createRunPauseRequest,
  RunCancelledError,
  RunInterruptedError,
  suspensionKind,
  type StepExecutor,
} from "./agent-runtime.js";
import { mergeExecutionPolicies } from "./policies.js";
import {
  CollectingEventSink,
  MemoryRunStore,
  SequenceIdGenerator,
} from "./testing/index.js";

const manifest = (
  steps: AgentStep[],
  extra: Partial<AgentManifest> = {},
): AgentManifest => ({ schemaVersion: "1.0", steps, ...extra });

const prompt = (id: string, extra: Partial<AgentStep> = {}): AgentStep =>
  ({ id, type: "prompt", prompt: id, ...extra }) as AgentStep;

const runtime = (
  executors: StepExecutor[],
  extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
) => {
  const runStore = new MemoryRunStore();
  const events = new CollectingEventSink();
  const agentRuntime = new AgentRuntime({
    runStore,
    eventSinks: [events],
    idGenerator: new SequenceIdGenerator(),
    stepExecutors: executors,
    ...extra,
  });
  return { agentRuntime, runStore, events };
};

describe("step onError policy", () => {
  it("records a failed step as its output and continues when onError is continue", async () => {
    const { agentRuntime, events } = runtime([
      {
        type: "prompt",
        execute: async ({ step }) => {
          if (step.id === "flaky") throw new Error("upstream is down");
          return { output: `ran ${step.id}` };
        },
      },
    ]);
    const result = await agentRuntime.run({
      manifest: manifest([
        prompt("flaky", {
          outputVariable: "flakyResult",
          policies: { onError: "continue" },
        }),
        prompt("after"),
      ]),
    });
    expect(result.state.flakyResult).toEqual({
      error: { code: "AGENT_EXECUTION_FAILED", message: "upstream is down" },
    });
    expect(result.stepResults.map((entry) => entry.stepId)).toEqual([
      "flaky",
      "after",
    ]);
    expect(result.stepResults[0]?.metadata).toMatchObject({
      failed: true,
      handled: true,
    });
    expect(
      events.events.find(
        (event) => event.type === "step.failed" && event.stepId === "flaky",
      )?.data,
    ).toMatchObject({ handled: true });
  });

  it("uses the manifest default and lets a step override it", async () => {
    const failing: StepExecutor = {
      type: "prompt",
      execute: async () => {
        throw new Error("nope");
      },
    };
    const tolerant = runtime([failing]);
    await expect(
      tolerant.agentRuntime.run({
        manifest: manifest([prompt("a")], {
          policies: { onError: "continue" },
        }),
      }),
    ).resolves.toMatchObject({ stepResults: [{ stepId: "a" }] });
    const strict = runtime([failing]);
    await expect(
      strict.agentRuntime.run({
        manifest: manifest([prompt("a", { policies: { onError: "fail" } })], {
          policies: { onError: "continue" },
        }),
      }),
    ).rejects.toThrow("nope");
  });

  it("never continues past a cancellation or suspension", async () => {
    const { agentRuntime, runStore } = runtime([
      {
        type: "prompt",
        execute: async () => {
          throw new RunCancelledError("rejected");
        },
      },
    ]);
    await expect(
      agentRuntime.run({
        runId: "cancelled",
        manifest: manifest([
          prompt("a", { policies: { onError: "continue" } }),
        ]),
      }),
    ).rejects.toThrow("rejected");
    expect(runStore.runs.get("cancelled")?.status).toBe("cancelled");
  });
});

describe("ending a run early", () => {
  it("completes the run after a step returns endRun", async () => {
    const ran: string[] = [];
    const { agentRuntime, events } = runtime([
      {
        type: "prompt",
        execute: async ({ step }) => {
          ran.push(step.id);
          return step.id === "stop"
            ? { output: "stopped here", endRun: true }
            : { output: step.id };
        },
      },
    ]);
    const result = await agentRuntime.run({
      manifest: manifest([prompt("first"), prompt("stop"), prompt("never")]),
    });
    expect(ran).toEqual(["first", "stop"]);
    expect(result.output).toBe("stopped here");
    expect(
      events.events.some(
        (event) =>
          event.type === "diagnostic" &&
          event.data?.code === "RUN_ENDED_BY_STEP",
      ),
    ).toBe(true);
  });
});

describe("preflight", () => {
  it("reports every configuration gap before the run is created", async () => {
    let executed = 0;
    const { agentRuntime, runStore } = runtime(
      [
        {
          type: "prompt",
          execute: async () => {
            executed += 1;
            return {};
          },
          preflight: (step) =>
            step.id === "needs-more" ? ["needs-more needs a widget."] : [],
        },
      ],
      {
        conditionEvaluator: {
          evaluate: () => true,
          validate: (expression) => {
            if (expression.includes("===")) throw new Error("bad token");
          },
        },
        tools: {
          listTools: async () => [{ name: "docs__read", inputSchema: {} }],
          executeTool: async () => ({ callId: "x", name: "x" }),
          unavailableToolReason: (name) =>
            name === "tickets__create" ? "down" : undefined,
        },
      },
    );
    const run = agentRuntime.run({
      runId: "preflight",
      manifest: manifest([
        prompt("ok", { tools: ["docs__read", "tickets__create"] }),
        prompt("typo", { tools: ["docs__raed"] }),
        prompt("bad-when", { when: "status === " }),
        prompt("needs-more"),
        { id: "hook", type: "webhook", url: "https://example.test/hook" },
      ]),
    });
    await expect(run).rejects.toMatchObject({
      code: "MANIFEST_PREFLIGHT_FAILED",
    });
    await expect(run).rejects.toThrow(/names unknown tools: docs__raed/u);
    await expect(run).rejects.toThrow(
      /bad-when has an invalid when expression/u,
    );
    await expect(run).rejects.toThrow(/needs-more needs a widget/u);
    await expect(run).rejects.toThrow(
      /no webhook step executor is registered/u,
    );
    expect(executed).toBe(0);
    expect(runStore.runs.has("preflight")).toBe(false);
  });

  it("requires a condition evaluator when conditions are used", async () => {
    const { agentRuntime } = runtime([
      { type: "prompt", execute: async () => ({}) },
    ]);
    await expect(
      agentRuntime.run({ manifest: manifest([prompt("a", { when: "x" })]) }),
    ).rejects.toThrow(/use conditions, but no ConditionEvaluator/u);
  });
});

describe("interruption, pause, and cancellation", () => {
  const twoSteps = manifest([prompt("first"), prompt("second")]);

  const abortingOn = (
    stepId: string,
    controller: AbortController,
    reason: unknown,
  ): StepExecutor => ({
    type: "prompt",
    execute: async ({ step, signal }) => {
      if (step.id === stepId) {
        controller.abort(reason);
        if (signal?.aborted) throw signal.reason;
      }
      return { output: step.id };
    },
  });

  it("records an interrupted run as resumable and resumes it", async () => {
    const controller = new AbortController();
    let interrupt = true;
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ step, signal }) => {
        if (step.id === "second" && interrupt) {
          interrupt = false;
          controller.abort(new RunInterruptedError("execution-timeout"));
          throw signal!.reason;
        }
        return { output: step.id };
      },
    };
    const { agentRuntime, runStore, events } = runtime([executor]);
    await expect(
      agentRuntime.run({
        runId: "interrupted",
        manifest: twoSteps,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "RUN_INTERRUPTED" });
    // The test store has no interruptRun, so the runtime records a retryable failure.
    expect(runStore.runs.get("interrupted")?.status).toBe("failed");
    expect(runStore.failures.get("interrupted")?.error).toMatchObject({
      code: "RUN_INTERRUPTED",
      retryable: true,
    });
    expect(
      events.events.find((event) => event.type === "run.interrupted")?.data,
    ).toMatchObject({ reason: "execution-timeout" });
    const resumed = await agentRuntime.run({
      runId: "interrupted",
      manifest: twoSteps,
      resume: true,
    });
    expect(resumed.stepResults.map((entry) => entry.stepId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("uses interruptRun when the store supports it", async () => {
    const controller = new AbortController();
    const { agentRuntime, runStore } = runtime([
      abortingOn(
        "first",
        controller,
        Object.assign(new Error("Execution timed out."), {
          code: "EXECUTION_TIMEOUT",
          interruption: "execution-timeout",
        }),
      ),
    ]);
    const interrupted: string[] = [];
    Object.assign(runStore, {
      interruptRun: async (runId: string) => {
        interrupted.push(runId);
        const record = runStore.runs.get(runId)!;
        runStore.runs.set(runId, { ...record, status: "interrupted" });
      },
    });
    await expect(
      agentRuntime.run({
        runId: "engine-timeout",
        manifest: twoSteps,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Execution timed out.");
    expect(interrupted).toEqual(["engine-timeout"]);
    expect(runStore.runs.get("engine-timeout")?.status).toBe("interrupted");
  });

  it("suspends a paused run instead of cancelling it", async () => {
    const controller = new AbortController();
    const { agentRuntime, runStore, events } = runtime([
      abortingOn("second", controller, createRunPauseRequest({ by: "user" })),
    ]);
    await expect(
      agentRuntime.run({
        runId: "paused",
        manifest: twoSteps,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "paused" });
    expect(runStore.runs.get("paused")?.status).toBe("suspended");
    expect(
      events.events.find((event) => event.type === "run.suspended")?.data,
    ).toMatchObject({ reason: "paused", kind: "paused" });
  });

  it("still cancels on any other abort reason", async () => {
    const controller = new AbortController();
    const { agentRuntime, runStore } = runtime([
      abortingOn("second", controller, new Error("user stopped it")),
    ]);
    await expect(
      agentRuntime.run({
        runId: "stopped",
        manifest: twoSteps,
        signal: controller.signal,
      }),
    ).rejects.toThrow("user stopped it");
    expect(runStore.runs.get("stopped")?.status).toBe("cancelled");
  });

  it("classifies suspension reasons", () => {
    expect(suspensionKind("approval")).toBe("awaiting-input");
    expect(suspensionKind("sub-run")).toBe("awaiting-child");
    expect(suspensionKind("token-budget")).toBe("awaiting-budget");
    expect(suspensionKind("paused")).toBe("paused");
    expect(suspensionKind("custom")).toBe("other");
  });
});

describe("policy layering", () => {
  it("merges host, manifest, and step policies field by field", () => {
    const host: ExecutionPolicies = {
      context: {
        strategy: "prune",
        trigger: { contextRatio: 0.7 },
        variables: { doc: { keep: true } },
      },
      modelRetry: { maxAttempts: 5 },
    };
    const manifestPolicies: ExecutionPolicies = {
      context: {
        strategy: "summarize-or-prune",
        summarizer: { model: { ref: "fast" } },
      },
      onError: "continue",
    };
    const stepPolicies: ExecutionPolicies = {
      context: {
        trigger: { toolRounds: 4 },
        variables: { doc: { maxBytes: 100 } },
        reduceTo: 0.2,
        openingShare: 0.3,
        toolResultShare: 0.25,
      },
      modelRetry: { initialDelayMs: 10 },
    };
    expect(
      mergeExecutionPolicies(host, manifestPolicies, stepPolicies),
    ).toEqual({
      context: {
        strategy: "summarize-or-prune",
        summarizer: { model: { ref: "fast" } },
        trigger: { contextRatio: 0.7, toolRounds: 4 },
        variables: { doc: { keep: true, maxBytes: 100 } },
        reduceTo: 0.2,
        openingShare: 0.3,
        toolResultShare: 0.25,
      },
      modelRetry: { maxAttempts: 5, initialDelayMs: 10 },
      onError: "continue",
    });
  });

  it("passes resolved policies to the executor", async () => {
    let seen: ExecutionPolicies | undefined;
    const { agentRuntime } = runtime(
      [
        {
          type: "prompt",
          execute: async ({ policies }) => {
            seen = policies;
            return {};
          },
        },
      ],
      { policies: { toolCallLimit: "fail", context: { strategy: "fail" } } },
    );
    await agentRuntime.run({
      manifest: manifest(
        [prompt("a", { policies: { context: { strategy: "prune" } } })],
        { policies: { toolCallLimit: "finalize" } },
      ),
    });
    expect(seen).toEqual({
      toolCallLimit: "finalize",
      context: { strategy: "prune" },
    });
  });

  it("applies host-enforced policies after the manifest and step, and passes the host summarizer", async () => {
    let seen: ExecutionPolicies | undefined;
    let summarizer: unknown;
    const hostSummarizer = {
      summarize: async () => ({ text: "summary" }),
    };
    const { agentRuntime } = runtime(
      [
        {
          type: "prompt",
          execute: async (context) => {
            seen = context.policies;
            summarizer = context.summarizer;
            return {};
          },
        },
      ],
      {
        policies: { context: { reduceTo: 0.3 } },
        enforcedPolicies: {
          context: { summarizer: { maxSummaryBytes: 2_000, maxCalls: 8 } },
        },
        summarizer: hostSummarizer,
      },
    );
    await agentRuntime.run({
      manifest: manifest(
        [
          prompt("a", {
            policies: {
              context: {
                summarizer: { maxSummaryBytes: 100_000, chunkBytes: 20_000 },
              },
            },
          }),
        ],
        { policies: { context: { reduceTo: 0.2 } } },
      ),
    });
    expect(seen?.context).toEqual({
      reduceTo: 0.2,
      summarizer: { maxSummaryBytes: 2_000, chunkBytes: 20_000, maxCalls: 8 },
    });
    expect(summarizer).toBe(hostSummarizer);
  });
});
