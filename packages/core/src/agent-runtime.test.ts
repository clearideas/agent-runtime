import type {
  JsonValue,
  RunCheckpoint,
  AgentManifest,
  AgentStep,
} from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  defaultManifestHasher,
  AgentRuntime,
  RunSuspendedError,
  type StepExecutor,
} from "./agent-runtime.js";
import {
  CollectingEventSink,
  MemoryRunStore,
  SequenceIdGenerator,
} from "./testing/index.js";

const manifest = (steps: AgentStep[]): AgentManifest =>
  ({
    schemaVersion: "1.0",
    id: "manifest-1",
    name: "Deterministic test",
    variables: [{ key: "count", type: "number", value: 0 }],
    steps,
  }) as AgentManifest;

const step = (id: string): AgentStep =>
  ({ id, type: "prompt", name: id, prompt: id }) as AgentStep;

describe("AgentRuntime", () => {
  it("uses a canonical SHA-256 manifest fingerprint by default", async () => {
    await expect(defaultManifestHasher.hash(manifest([]))).resolves.toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(await defaultManifestHasher.hash(manifest([]))).toBe(
      await defaultManifestHasher.hash(manifest([])),
    );
  });

  it("starts a run from a validated agent run manifest that references an agent", async () => {
    const agent: AgentManifest = {
      schemaVersion: "1.0",
      id: "release-brief",
      variables: [{ key: "audience", type: "string", requiresOverride: true }],
      steps: [
        { id: "answer", type: "prompt", prompt: "Answer for {{ audience }}." },
      ],
    };
    const runner = new AgentRuntime({
      runStore: new MemoryRunStore(),
      agentManifestSource: {
        loadManifest: async (reference) => {
          expect(reference).toBe("agents/release-brief.agent.yaml");
          return agent;
        },
      },
      stepExecutors: [
        {
          type: "prompt",
          execute: async ({ variables }) => ({ output: variables.audience }),
        },
      ],
    });

    await expect(
      runner.run({
        agentRunManifest: {
          schemaVersion: "1.0",
          agent: { ref: "agents/release-brief.agent.yaml" },
          runId: "release-run-1",
          variables: [{ key: "audience", value: "partners" }],
        },
      }),
    ).resolves.toMatchObject({
      runId: "release-run-1",
      output: "partners",
      state: { audience: "partners" },
    });
  });

  it("executes steps in order and checkpoints state before starting the next step", async () => {
    const store = new MemoryRunStore();
    const events = new CollectingEventSink();
    const observed: Array<{ stepId: string; count: JsonValue | undefined }> =
      [];
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ step: currentStep, variables }) => {
        observed.push({ stepId: currentStep.id, count: variables.count });
        const nextCount = Number(variables.count ?? 0) + 1;
        return {
          output: nextCount,
          statePatch: { set: { count: nextCount } },
        };
      },
    };
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      eventSinks: [events],
      idGenerator: new SequenceIdGenerator(),
    });

    const result = await runner.run({
      manifest: manifest([step("first"), step("second")]),
      runId: "run-1",
    });

    expect(observed).toEqual([
      { stepId: "first", count: 0 },
      { stepId: "second", count: 1 },
    ]);
    expect(result.variables).toEqual({ count: 2 });
    expect(store.checkpoints.get("run-1")).toHaveLength(3);
    expect(
      store.checkpoints.get("run-1")?.map((item) => item.cursor.stepIndex),
    ).toEqual([0, 1, 2]);
    expect(events.events.map((event) => event.sequence)).toEqual(
      events.events.map((_, index) => index + 1),
    );
    expect(events.events.map((event) => event.type)).toEqual([
      "run.started",
      "checkpoint.saved",
      "step.started",
      "checkpoint.saved",
      "step.completed",
      "step.started",
      "checkpoint.saved",
      "step.completed",
      "run.completed",
    ]);
  });

  it("runs independent steps concurrently and commits their outputs in manifest order", async () => {
    const store = new MemoryRunStore();
    const events = new CollectingEventSink();
    let releaseFirst!: () => void;
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ step: currentStep, variables }) => {
        expect(variables).toEqual({});
        if (currentStep.id === "first") {
          await Promise.race([
            secondStarted,
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(new Error("second step did not start concurrently")),
                500,
              ),
            ),
          ]);
          releaseFirst();
        } else {
          markSecondStarted();
          await firstReleased;
        }
        return {
          output: currentStep.id,
          statePatch: { set: { [currentStep.id]: currentStep.id } },
        };
      },
    };
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      eventSinks: [events],
      idGenerator: new SequenceIdGenerator(),
    });

    const result = await runner.run({
      manifest: {
        schemaVersion: "1.0",
        steps: [
          { ...step("first"), outputVariable: "first" },
          { ...step("second"), outputVariable: "second" },
        ],
      },
      runId: "parallel-run",
      execution: { mode: "parallel", maxConcurrency: 2 },
    });

    expect(result.state).toEqual({ first: "first", second: "second" });
    expect(result.stepResults.map((item) => item.stepId)).toEqual([
      "first",
      "second",
    ]);
    expect(
      store.checkpoints
        .get("parallel-run")
        ?.map((item) => item.cursor.stepIndex),
    ).toEqual([0, 2]);
    expect(events.events.map((event) => event.sequence)).toEqual(
      events.events.map((_, index) => index + 1),
    );
  });

  it("waits for producer outputs before executing a dependent step", async () => {
    const observed: Array<{
      stepId: string;
      variables: Record<string, JsonValue>;
    }> = [];
    const runner = new AgentRuntime({
      runStore: new MemoryRunStore(),
      stepExecutors: [
        {
          type: "prompt",
          execute: async ({ step: currentStep, variables }) => {
            observed.push({
              stepId: currentStep.id,
              variables: { ...variables },
            });
            return {
              output: currentStep.id,
              statePatch: {
                set: { [currentStep.outputVariable!]: currentStep.id },
              },
            };
          },
        },
      ],
    });
    const dependentManifest: AgentManifest = {
      schemaVersion: "1.0",
      steps: [
        {
          id: "facts",
          type: "prompt",
          prompt: "Facts",
          outputVariable: "facts",
        },
        {
          id: "audience",
          type: "prompt",
          prompt: "Audience",
          outputVariable: "audienceNotes",
        },
        {
          id: "final",
          type: "prompt",
          prompt: "{{ facts }} {{ audienceNotes }}",
          outputVariable: "final",
        },
      ],
    };

    const result = await runner.run({
      manifest: dependentManifest,
      execution: { mode: "parallel" },
    });

    expect(observed.slice(0, 2)).toEqual([
      { stepId: "facts", variables: {} },
      { stepId: "audience", variables: {} },
    ]);
    expect(observed[2]).toEqual({
      stepId: "final",
      variables: { facts: "facts", audienceNotes: "audience" },
    });
    expect(result.stepResults.map((item) => item.stepId)).toEqual([
      "facts",
      "audience",
      "final",
    ]);
  });

  it("rejects undeclared shared-state mutation from a parallel wave", async () => {
    const runner = new AgentRuntime({
      runStore: new MemoryRunStore(),
      stepExecutors: [
        {
          type: "prompt",
          execute: async ({ step: currentStep }) => ({
            output: currentStep.id,
            statePatch: { set: { shared: currentStep.id } },
          }),
        },
      ],
    });

    await expect(
      runner.run({
        manifest: {
          schemaVersion: "1.0",
          steps: [
            { ...step("first"), outputVariable: "first" },
            { ...step("second"), outputVariable: "second" },
          ],
        },
        execution: { mode: "parallel" },
      }),
    ).rejects.toThrow("attempted to mutate state outside its outputVariable");
  });

  it("does not execute a later step when a committed state checkpoint fails", async () => {
    const store = new MemoryRunStore();
    let checkpointCount = 0;
    store.saveCheckpoint = async (checkpoint) => {
      checkpointCount += 1;
      if (checkpointCount === 2) throw new Error("checkpoint unavailable");
      const checkpoints = store.checkpoints.get(checkpoint.runId) ?? [];
      checkpoints.push(structuredClone(checkpoint));
      store.checkpoints.set(checkpoint.runId, checkpoints);
    };
    const executed: string[] = [];
    const executor: StepExecutor = {
      type: "prompt",
      execute: async ({ step: currentStep }) => {
        executed.push(currentStep.id);
        return { statePatch: { set: { last: currentStep.id } } };
      },
    };
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      idGenerator: new SequenceIdGenerator(),
    });

    await expect(
      runner.run({
        manifest: manifest([step("first"), step("second")]),
        runId: "run-2",
      }),
    ).rejects.toThrow("checkpoint unavailable");

    expect(executed).toEqual(["first"]);
    expect(store.failures.has("run-2")).toBe(true);
  });

  it("rejects overlapping attempts for the same run in one Agent Runtime process", async () => {
    const store = new MemoryRunStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        {
          type: "prompt",
          execute: async () => {
            started();
            await blocked;
            return { output: "done" };
          },
        },
      ],
    });

    const first = runner.run({
      manifest: manifest([step("only")]),
      runId: "overlap",
    });
    await didStart;
    await expect(
      runner.run({ runId: "overlap", resume: true }),
    ).rejects.toThrow("already active in this Agent Runtime process");
    release();
    await expect(first).resolves.toMatchObject({ output: "done" });
  });

  it("rejects manifests and outputs that exceed declared limits", async () => {
    const store = new MemoryRunStore();
    const executor: StepExecutor = {
      type: "prompt",
      execute: async () => ({ output: "too large" }),
    };
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      idGenerator: new SequenceIdGenerator(),
    });

    await expect(
      runner.run({
        runId: "too-many-steps",
        manifest: {
          ...manifest([step("first"), step("second")]),
          limits: { maxSteps: 1 },
        },
      }),
    ).rejects.toThrow("exceeding its 1-step limit");
    expect(await store.loadRun("too-many-steps")).toBeNull();

    await expect(
      runner.run({
        runId: "output-too-large",
        manifest: {
          ...manifest([step("only")]),
          limits: { maxOutputBytes: 4 },
        },
      }),
    ).rejects.toThrow("exceeding the 4-byte output limit");
    expect((await store.loadRun("output-too-large"))?.status).toBe("failed");
  });

  it("validates runtime manifests before creating a run", async () => {
    const store = new MemoryRunStore();
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [],
      idGenerator: new SequenceIdGenerator(),
    });

    await expect(
      runner.run({
        runId: "invalid-manifest",
        manifest: {
          ...manifest([step("duplicate"), step("duplicate")]),
        },
      }),
    ).rejects.toThrow("Duplicate sibling step id: duplicate");
    expect(await store.loadRun("invalid-manifest")).toBeNull();
  });

  it("resolves typed agent variables and run overrides", async () => {
    const store = new MemoryRunStore();
    const observed: Array<Record<string, JsonValue>> = [];
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        {
          type: "prompt",
          execute: async ({ variables }) => {
            observed.push(
              structuredClone(variables as Record<string, JsonValue>),
            );
            return {};
          },
        },
      ],
      idGenerator: new SequenceIdGenerator(),
    });
    const configured: AgentManifest = {
      ...manifest([step("only")]),
      variables: [
        { key: "region", type: "string", value: "manifest" },
        {
          key: "nested",
          type: "object",
          value: { retained: true, defaulted: 42 },
        },
        { key: "required", type: "string", requiresOverride: true },
      ],
    };

    await runner.run({
      manifest: configured,
      runId: "variable-defaults",
      variables: [
        { key: "region", value: "supplied" },
        { key: "required", value: "present" },
      ],
    });
    expect(observed).toEqual([
      {
        region: "supplied",
        nested: { retained: true, defaulted: 42 },
        required: "present",
      },
    ]);

    await expect(
      runner.run({ manifest: configured, runId: "missing-required" }),
    ).rejects.toThrow("Missing required runtime variable overrides: required");
    expect(await store.loadRun("missing-required")).toBeNull();
  });

  it("rejects unknown, duplicate, and incorrectly typed run overrides", async () => {
    const runner = new AgentRuntime({
      runStore: new MemoryRunStore(),
      stepExecutors: [{ type: "prompt", execute: async () => ({}) }],
      idGenerator: new SequenceIdGenerator(),
    });
    const configured: AgentManifest = {
      ...manifest([step("only")]),
      variables: [{ key: "count", type: "number", value: 1 }],
    };

    await expect(
      runner.run({
        manifest: configured,
        runId: "unknown-variable",
        variables: [{ key: "other", value: 1 }],
      }),
    ).rejects.toThrow("Run variable is not declared by the agent: other");
    await expect(
      runner.run({
        manifest: configured,
        runId: "duplicate-variable",
        variables: [
          { key: "count", value: 1 },
          { key: "count", value: 2 },
        ],
      }),
    ).rejects.toThrow("Duplicate run variable override: count");
    await expect(
      runner.run({
        manifest: configured,
        runId: "wrong-variable-type",
        variables: [{ key: "count", value: "one" }],
      }),
    ).rejects.toThrow("Run variable count must be number");
  });

  it("does not let a non-critical event sink failure invalidate execution", async () => {
    const store = new MemoryRunStore();
    const executor: StepExecutor = {
      type: "prompt",
      execute: async () => ({ output: "done" }),
    };
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      eventSinks: [{ emit: () => Promise.reject(new Error("offline")) }],
      idGenerator: new SequenceIdGenerator(),
    });

    const result = await runner.run({
      manifest: manifest([step("only")]),
      runId: "run-3",
    });

    expect(result.output).toBe("done");
    expect(store.completed.has("run-3")).toBe(true);
  });

  it("persists cancellation as cancellation rather than failure", async () => {
    const store = new MemoryRunStore();
    const events = new CollectingEventSink();
    const controller = new AbortController();
    controller.abort(new Error("Run was aborted"));
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        { type: "prompt", execute: async () => ({ output: "unused" }) },
      ],
      eventSinks: [events],
      idGenerator: new SequenceIdGenerator(),
    });

    await expect(
      runner.run({
        manifest: manifest([step("only")]),
        runId: "run-cancelled",
        signal: controller.signal,
      }),
    ).rejects.toThrow("Run was aborted");

    expect((await store.loadRun("run-cancelled"))?.status).toBe("cancelled");
    expect(store.failures.has("run-cancelled")).toBe(false);
    expect(events.events.at(-1)?.type).toBe("run.cancelled");
  });

  it("cancels when a non-cooperative executor resolves after abort", async () => {
    const store = new MemoryRunStore();
    const controller = new AbortController();
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        {
          type: "prompt",
          execute: async () => {
            controller.abort(new Error("cancel after provider response"));
            return { output: "must not commit" };
          },
        },
      ],
      idGenerator: new SequenceIdGenerator(),
    });

    await expect(
      runner.run({
        manifest: manifest([step("only")]),
        runId: "non-cooperative-cancel",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancel after provider response");
    expect((await store.loadRun("non-cooperative-cancel"))?.status).toBe(
      "cancelled",
    );
    expect(store.checkpoints.get("non-cooperative-cancel")).toHaveLength(1);
  });

  it("does not roll back durable completion when the terminal event sink fails", async () => {
    const store = new MemoryRunStore();
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        { type: "prompt", execute: async () => ({ output: "done" }) },
      ],
      eventSinks: [
        {
          emit: (event) => {
            if (event.type === "run.completed")
              throw new Error("terminal observer unavailable");
          },
        },
      ],
      eventSinkFailurePolicy: "fail-run",
      idGenerator: new SequenceIdGenerator(),
    });

    await expect(
      runner.run({
        manifest: manifest([step("only")]),
        runId: "terminal-event-failure",
      }),
    ).resolves.toMatchObject({ output: "done" });
    expect((await store.loadRun("terminal-event-failure"))?.status).toBe(
      "completed",
    );
  });

  it.each([
    {
      name: "cross-run checkpoint",
      change: (checkpoint: RunCheckpoint) => ({
        ...checkpoint,
        runId: "another-run",
      }),
      message: "does not belong",
    },
    {
      name: "future attempt",
      change: (checkpoint: RunCheckpoint) => ({ ...checkpoint, attempt: 2 }),
      message: "not recoverable",
    },
    {
      name: "out-of-bounds cursor",
      change: (checkpoint: RunCheckpoint) => ({
        ...checkpoint,
        cursor: { stepIndex: 99 },
      }),
      message: "outside the manifest",
    },
  ])(
    "rejects a $name before reserving a new attempt",
    async ({ change, message }) => {
      const store = new MemoryRunStore();
      const configured = manifest([step("only")]);
      const runId = "corrupt-resume";
      store.runs.set(runId, {
        runId,
        manifest: configured,
        status: "failed",
        attempt: 1,
        state: { count: 0 },
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:01.000Z",
      });
      const valid: RunCheckpoint = {
        id: "checkpoint-1",
        runId,
        sequence: 1,
        attempt: 1,
        manifestHash: await defaultManifestHasher.hash(configured),
        contractVersion: "1.0",
        runtimeVersion: "0.1.0",
        cursor: { stepIndex: 0 },
        state: { count: 0 },
        stepResults: [],
        transcript: [],
        artifacts: [],
        createdAt: "2026-07-22T00:00:00.000Z",
      };
      store.checkpoints.set(runId, [change(valid)]);
      const runner = new AgentRuntime({
        runStore: store,
        stepExecutors: [{ type: "prompt", execute: async () => ({}) }],
      });

      await expect(runner.run({ runId, resume: true })).rejects.toThrow(
        message,
      );
      expect((await store.loadRun(runId))?.attempt).toBe(1);
    },
  );

  it("resumes at the latest committed cursor without replaying completed steps", async () => {
    const store = new MemoryRunStore();
    const firstEvents = new CollectingEventSink();
    const firstAttempt: string[] = [];
    const failingExecutor: StepExecutor = {
      type: "prompt",
      execute: async ({ step: currentStep, variables }) => {
        firstAttempt.push(currentStep.id);
        if (currentStep.id === "second") throw new Error("temporary failure");
        const count = Number(variables.count ?? 0) + 1;
        return {
          output: count,
          statePatch: { set: { count } },
        };
      },
    };
    const firstRunner = new AgentRuntime({
      runStore: store,
      stepExecutors: [failingExecutor],
      eventSinks: [firstEvents],
      idGenerator: new SequenceIdGenerator(),
    });
    const agentManifest = manifest([step("first"), step("second")]);

    await expect(
      firstRunner.run({ manifest: agentManifest, runId: "run-resume" }),
    ).rejects.toThrow("temporary failure");
    expect(firstAttempt).toEqual(["first", "second"]);
    expect(store.checkpoints.get("run-resume")?.at(-1)?.cursor.stepIndex).toBe(
      1,
    );

    const resumedAttempt: string[] = [];
    const resumedEvents = new CollectingEventSink();
    const resumedRunner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        {
          type: "prompt",
          execute: async ({ step: currentStep, variables }) => {
            resumedAttempt.push(currentStep.id);
            const count = Number(variables.count ?? 0) + 1;
            return {
              output: count,
              statePatch: { set: { count } },
            };
          },
        },
      ],
      eventSinks: [resumedEvents],
      idGenerator: new SequenceIdGenerator(),
    });

    const result = await resumedRunner.run({
      runId: "run-resume",
      resume: true,
    });

    expect(resumedAttempt).toEqual(["second"]);
    expect(result.variables).toEqual({ count: 2 });
    expect(result.stepResults.map((item) => item.stepId)).toEqual([
      "first",
      "second",
    ]);
    expect(store.completed.has("run-resume")).toBe(true);
    expect(firstEvents.events.every((event) => event.attempt === 1)).toBe(true);
    expect(resumedEvents.events.every((event) => event.attempt === 2)).toBe(
      true,
    );
    expect(resumedEvents.events[0]).toMatchObject({
      type: "run.resumed",
      attempt: 2,
      sequence: 1,
    });
    expect(store.checkpoints.get("run-resume")?.at(-1)?.attempt).toBe(2);
  });

  it("suspends after a committed continuation and resumes it on the next attempt", async () => {
    const store = new MemoryRunStore();
    const events = new CollectingEventSink();
    const executor: StepExecutor = {
      type: "prompt",
      execute: async (context) => {
        if (!context.resume) {
          await context.checkpoint({
            state: { count: 7 },
            continuation: { phase: "waiting-for-human" },
          });
          throw new RunSuspendedError("human-input", {
            stepId: context.step.id,
          });
        }
        expect(context.resume.continuation).toEqual({
          phase: "waiting-for-human",
        });
        return { output: "continued", statePatch: { set: { count: 8 } } };
      },
    };
    const first = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      eventSinks: [events],
      idGenerator: new SequenceIdGenerator(),
    });
    await expect(
      first.run({
        manifest: manifest([step("approval")]),
        runId: "run-suspend",
      }),
    ).rejects.toBeInstanceOf(RunSuspendedError);
    expect(await store.loadRun("run-suspend")).toMatchObject({
      status: "suspended",
      attempt: 1,
    });
    expect(events.events.some((event) => event.type === "run.suspended")).toBe(
      true,
    );
    expect(events.events.some((event) => event.type === "run.failed")).toBe(
      false,
    );

    const resumed = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      idGenerator: new SequenceIdGenerator(),
    });
    const result = await resumed.run({ runId: "run-suspend", resume: true });
    expect(result.output).toBe("continued");
    expect(result.state.count).toBe(8);
    expect(await store.loadRun("run-suspend")).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  });

  it("rejects resume when the supplied manifest differs from the checkpoint", async () => {
    const store = new MemoryRunStore();
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        {
          type: "prompt",
          execute: async () => {
            throw new Error("stop after initial checkpoint");
          },
        },
      ],
      idGenerator: new SequenceIdGenerator(),
    });
    await expect(
      runner.run({ manifest: manifest([step("only")]), runId: "run-mismatch" }),
    ).rejects.toThrow("stop after initial checkpoint");

    const changed = manifest([step("changed")]);
    await expect(
      runner.run({
        manifest: changed,
        runId: "run-mismatch",
        resume: true,
      }),
    ).rejects.toThrow("Manifest does not match checkpoint");
  });

  it("exposes nested continuation checkpoints to a resumed step", async () => {
    const store = new MemoryRunStore();
    const loopStep = {
      id: "loop",
      type: "loop",
      loop: { maxIterations: 2 },
      steps: [],
    } as AgentStep;
    const agentManifest = manifest([loopStep]);
    const executor: StepExecutor = {
      type: "loop",
      execute: async (context) => {
        if (!context.resume) {
          await context.checkpoint({
            state: { count: 1 },
            cursor: {
              stepId: context.step.id,
              stepPath: context.stepPath,
              loopIteration: 1,
              childIndex: 0,
            },
            continuation: { nextIteration: 1 },
          });
          throw new Error("interrupted inside loop");
        }
        expect(context.variables).toEqual({ count: 1 });
        expect(context.resume.cursor.loopIteration).toBe(1);
        expect(context.resume.continuation).toEqual({ nextIteration: 1 });
        return {
          output: "done",
          statePatch: { set: { count: 2 } },
        };
      },
    };
    const first = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      idGenerator: new SequenceIdGenerator(),
    });
    await expect(
      first.run({ manifest: agentManifest, runId: "run-nested" }),
    ).rejects.toThrow("interrupted inside loop");

    const checkpoint = store.checkpoints.get("run-nested")?.at(-1);
    expect(checkpoint?.cursor).toMatchObject({
      stepIndex: 0,
      stepPath: "loop",
      loopIteration: 1,
    });
    expect(checkpoint?.continuation).toEqual({ nextIteration: 1 });

    const resumed = new AgentRuntime({
      runStore: store,
      stepExecutors: [executor],
      idGenerator: new SequenceIdGenerator(),
    });
    const result = await resumed.run({ runId: "run-nested", resume: true });
    expect(result.variables).toEqual({ count: 2 });
  });

  it("executes registered child steps with nested event paths", async () => {
    const store = new MemoryRunStore();
    const events = new CollectingEventSink();
    const child = step("child");
    const loopStep = {
      id: "parent",
      type: "loop",
      loop: { maxIterations: 1 },
      steps: [child],
    } as AgentStep;
    const parentExecutor: StepExecutor = {
      type: "loop",
      execute: async (context) => {
        const childResult = await context.executeChild(
          child,
          context.variables,
          `${context.stepPath}/${child.id}`,
        );
        return childResult;
      },
    };
    const childExecutor: StepExecutor = {
      type: "prompt",
      execute: async () => ({
        output: "child output",
        statePatch: { set: { childCompleted: true } },
      }),
    };
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [parentExecutor, childExecutor],
      eventSinks: [events],
      idGenerator: new SequenceIdGenerator(),
    });

    const result = await runner.run({
      manifest: manifest([loopStep]),
      runId: "run-child",
    });

    expect(result.variables.childCompleted).toBe(true);
    expect(
      events.events
        .filter((event) => event.stepId === "child")
        .map((event) => ({
          type: event.type,
          stepPath: event.stepPath,
        })),
    ).toEqual([
      { type: "step.started", stepPath: "parent/child" },
      { type: "step.completed", stepPath: "parent/child" },
    ]);
  });

  it("selects steps marked for final output in manifest order", async () => {
    const store = new MemoryRunStore();
    const first = { ...step("first"), includeInFinalOutput: true };
    const second = step("second");
    const third = { ...step("third"), includeInFinalOutput: true };
    const agentManifest: AgentManifest = manifest([first, second, third]);
    const runner = new AgentRuntime({
      runStore: store,
      stepExecutors: [
        {
          type: "prompt",
          execute: async ({ step: currentStep }) => ({
            output: currentStep.id,
          }),
        },
      ],
      idGenerator: new SequenceIdGenerator(),
    });

    const result = await runner.run({
      manifest: agentManifest,
      runId: "run-output",
    });
    expect(result.output).toEqual(["first", "third"]);
    expect(result.state).toEqual(result.variables);
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
  });
});
