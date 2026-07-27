import type { RunResult } from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  InMemoryRemoteExecutionControlPlane,
  type RemoteComputeLauncher,
  RemoteExecutionEngine,
} from "./remote.js";

const result = (runId: string): RunResult => ({
  runId,
  output: "remote-ok",
  state: {},
  stepResults: [],
  transcript: [],
  artifacts: [],
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
});

describe("RemoteExecutionEngine", () => {
  it("keeps compute launch separate from durable lifecycle control", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const launched: string[] = [];
    const launcher: RemoteComputeLauncher = {
      name: "test-compute",
      launch: async (invocation, { handle }) => {
        launched.push(invocation.action);
        queueMicrotask(() => {
          void (async () => {
            await controlPlane.acceptEvent(handle, {
              id: "event-1",
              runId: handle.runId,
              attempt: 1,
              sequence: 1,
              timestamp: new Date().toISOString(),
              type: "run.started",
            });
            await controlPlane.complete(handle, result(handle.runId));
          })();
        });
        return { jobId: "compute-1" };
      },
      cancel: async () => undefined,
    };
    const engine = new RemoteExecutionEngine(launcher, controlPlane);
    const handle = await engine.submit({
      runId: "remote-run",
      idempotencyKey: "remote-key",
      manifest: { schemaVersion: "1.0", steps: [] },
    });
    expect(handle.providerData).toEqual({ jobId: "compute-1" });
    await expect(engine.result(handle)).resolves.toMatchObject({
      output: "remote-ok",
    });
    const duplicate = await engine.submit({
      runId: "remote-run",
      idempotencyKey: "remote-key",
      manifest: { schemaVersion: "1.0", steps: [] },
    });
    expect(duplicate.id).toBe(handle.id);
    expect(launched).toEqual(["run"]);
  });

  it("normalizes launch failures through the control plane", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const engine = new RemoteExecutionEngine(
      {
        name: "broken-compute",
        launch: async () => {
          throw new Error("provider unavailable");
        },
        cancel: async () => undefined,
      },
      controlPlane,
    );
    await expect(
      engine.submit({ manifest: { schemaVersion: "1.0", steps: [] } }),
    ).rejects.toMatchObject({ code: "REMOTE_LAUNCH_FAILED", retryable: true });
  });

  it("rejects worker events that do not belong to the reserved attempt", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const reservation = await controlPlane.reserve({
      engine: "remote-test",
      mode: "resume",
      request: {
        runId: "remote-resume",
        attempt: 2,
        checkpointReference: "checkpoint-1",
        manifest: { schemaVersion: "1.0", steps: [] },
      },
    });
    await expect(
      controlPlane.acceptEvent(reservation.handle, {
        id: "stale-event",
        runId: "remote-resume",
        attempt: 1,
        sequence: 100,
        timestamp: new Date().toISOString(),
        type: "run.started",
      }),
    ).rejects.toThrow("attempt mismatch");
  });

  it("validates the handle before provider cancellation", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const cancelled: string[] = [];
    const engine = new RemoteExecutionEngine(
      {
        name: "remote-test",
        launch: async () => ({ providerJobId: "trusted-job" }),
        cancel: async (handle) => {
          cancelled.push(String(handle.providerData?.providerJobId));
        },
      },
      controlPlane,
    );
    const handle = await engine.submit({
      runId: "remote-cancel",
      manifest: { schemaVersion: "1.0", steps: [] },
    });

    await expect(
      engine.cancel({
        ...handle,
        id: "unknown-execution",
        providerData: { providerJobId: "attacker-selected-job" },
      }),
    ).rejects.toThrow("Unknown remote execution");
    expect(cancelled).toEqual([]);
  });

  it("does not report cancellation when the provider cannot stop execution", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const engine = new RemoteExecutionEngine(
      {
        name: "remote-test",
        launch: async () => ({ providerJobId: "provider-job" }),
        cancel: async () => {
          throw new Error("provider cancellation failed");
        },
      },
      controlPlane,
    );
    const handle = await engine.submit({
      runId: "remote-cancel-failed",
      manifest: { schemaVersion: "1.0", steps: [] },
    });

    await expect(engine.cancel(handle)).rejects.toThrow(
      "provider cancellation failed",
    );
    expect((await engine.status(handle)).status).toBe("running");
  });
});
