import type {
  RunEvent,
  RunResult,
  AgentManifest,
} from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import { ExecutionClient } from "./client.js";
import { ExecutionEngineError } from "./contracts.js";
import { InProcessExecutionEngine } from "./in-process.js";
import { runExecutionEngineConformance } from "./testing.js";

const manifest: AgentManifest = {
  schemaVersion: "1.0",
  id: "execution-test",
  steps: [],
};

const result = (runId: string): RunResult => ({
  runId,
  output: "done",
  state: {},
  stepResults: [],
  transcript: [],
  artifacts: [],
  startedAt: "2026-07-22T00:00:00.000Z",
  completedAt: "2026-07-22T00:00:01.000Z",
});

const event = (runId: string, sequence: number, type: string): RunEvent => ({
  id: `event-${sequence}`,
  runId,
  sequence,
  attempt: 1,
  timestamp: `2026-07-22T00:00:0${sequence}.000Z`,
  type,
});

describe("InProcessExecutionEngine", () => {
  it("passes the provider-neutral conformance checks", async () => {
    await runExecutionEngineConformance({
      manifest,
      result,
      create: () =>
        new InProcessExecutionEngine(async (request, context) => {
          await context.emit(event(context.handle.runId, 1, "run.started"));
          await context.emit(event(context.handle.runId, 2, "run.completed"));
          return result(context.handle.runId);
        }),
    });
  });

  it("streams events through the client and reconnects from a cursor", async () => {
    const engine = new InProcessExecutionEngine(async (_request, context) => {
      await context.emit(event(context.handle.runId, 1, "run.started"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await context.emit(event(context.handle.runId, 2, "model.text.delta"));
      await context.emit(event(context.handle.runId, 3, "run.completed"));
      return result(context.handle.runId);
    });
    const handle = await engine.submit({ manifest, runId: "stream-run" });
    const seen: string[] = [];
    const followed = await new ExecutionClient(engine).follow(handle, {
      onEvent: (emitted) => seen.push(emitted.type),
    });
    expect(seen).toEqual(["run.started", "model.text.delta", "run.completed"]);
    expect(followed.result?.output).toBe("done");

    const replayed: string[] = [];
    for await (const emitted of engine.events(handle, {
      after: { attempt: 1, sequence: 1 },
    })) {
      replayed.push(emitted.type);
    }
    expect(replayed).toEqual(["model.text.delta", "run.completed"]);
  });

  it("rejects conflicting idempotency reuse", async () => {
    const engine = new InProcessExecutionEngine(async (_request, context) =>
      result(context.handle.runId),
    );
    await engine.submit({ manifest, idempotencyKey: "same" });
    await expect(
      engine.submit({
        manifest: { ...manifest, id: "different" },
        idempotencyKey: "same",
      }),
    ).rejects.toThrow("reused with another request");
  });

  it("cancels active work and rejects result retrieval consistently", async () => {
    const engine = new InProcessExecutionEngine(
      async (_request, context) =>
        new Promise<RunResult>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            {
              once: true,
            },
          );
        }),
    );
    const handle = await engine.submit({ manifest, runId: "cancel-run" });
    await engine.cancel(handle);
    expect((await engine.status(handle)).status).toBe("cancelled");
    await expect(engine.result(handle)).rejects.toMatchObject<
      Partial<ExecutionEngineError>
    >({
      code: "EXECUTION_CANCELLED",
    });
  });

  it("validates resume ownership metadata", async () => {
    const engine = new InProcessExecutionEngine(async (_request, context) =>
      result(context.handle.runId),
    );
    await expect(
      engine.resume({
        manifest,
        runId: "resume-run",
        attempt: 1,
        checkpointReference: "cp",
      }),
    ).rejects.toThrow("greater than one");
    await expect(
      engine.resume({ manifest, runId: "resume-run", attempt: 2 }),
    ).rejects.toThrow("requires a checkpoint");
  });

  it("rejects events from the wrong attempt", async () => {
    const engine = new InProcessExecutionEngine(async (_request, context) => {
      await context.emit({
        ...event(context.handle.runId, 1, "run.started"),
        attempt: 2,
      });
      return result(context.handle.runId);
    });
    const handle = await engine.submit({ manifest, runId: "wrong-attempt" });
    await expect(engine.result(handle)).rejects.toThrow(
      "does not match execution attempt",
    );
  });

  it("reports timeouts with a stable retryable error code", async () => {
    const engine = new InProcessExecutionEngine(
      async (_request, context) =>
        new Promise<RunResult>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            {
              once: true,
            },
          );
        }),
    );
    const handle = await engine.submit({
      manifest,
      runId: "timeout-run",
      timeoutMs: 5,
    });
    await expect(engine.result(handle)).rejects.toMatchObject<
      Partial<ExecutionEngineError>
    >({
      code: "EXECUTION_TIMEOUT",
      retryable: true,
    });
    expect((await engine.status(handle)).status).toBe("failed");
  });
});
