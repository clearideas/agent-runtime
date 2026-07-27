import type { RunEvent, RunResult } from "@clearideas/agent-runtime-contracts";
import {
  AesGcmWorkerInvocationCodec,
  InMemoryRemoteExecutionControlPlane,
} from "@clearideas/agent-runtime-execution";
import { describe, expect, it } from "vitest";

import {
  ModalExecutionEngine,
  decodeModalWorkerInvocation,
  type ModalGateway,
  type ModalSdkClientLike,
  ModalSdkGateway,
  type ModalStreamingGateway,
} from "./index.js";

const development = { allowPlaintextInvocationForDevelopment: true } as const;
const encryptionKey = new Uint8Array(32).fill(11);
const invocationCodec = (time = Date.parse("2026-07-25T12:00:00.000Z")) =>
  new AesGcmWorkerInvocationCodec({
    activeKeyId: "modal-key-2026-07",
    keys: { "modal-key-2026-07": encryptionKey },
    now: () => time,
  });

const resultFor = (runId: string, output = "modal-ok"): RunResult => ({
  runId,
  state: {},
  stepResults: [],
  transcript: [],
  artifacts: [],
  output,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
});

describe("ModalExecutionEngine", () => {
  it("maps only compute lifecycle while the control plane owns events and results", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const spawnRequests: unknown[] = [];
    const cancelled: string[] = [];
    const gateway: ModalGateway = {
      spawn: async (request) => {
        spawnRequests.push(request);
        return { functionCallId: "fc-1", metadata: { region: "us-east" } };
      },
      cancel: async (id) => {
        cancelled.push(id);
      },
    };
    const engine = new ModalExecutionEngine(gateway, controlPlane, development);
    const handle = await engine.submit({
      runId: "modal-run",
      manifest: { schemaVersion: "1.0", steps: [] },
    });
    expect(handle.providerData).toEqual({
      functionCallId: "fc-1",
      region: "us-east",
    });
    expect(spawnRequests).toHaveLength(1);

    await controlPlane.acceptEvent(handle, {
      id: "event-1",
      runId: handle.runId,
      attempt: 1,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "run.started",
    });
    const result = resultFor(handle.runId);
    await controlPlane.complete(handle, result);
    await expect(engine.result(handle)).resolves.toMatchObject({
      output: "modal-ok",
    });
    expect(cancelled).toEqual([]);
  });

  it("pumps streamed worker events and the terminal result into the control plane", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const gateway: ModalStreamingGateway = {
      spawn: async () => ({
        functionCallId: "fc-stream",
        metadata: { queueName: "queue-1" },
      }),
      cancel: async () => undefined,
      messages: async function* (handle) {
        const event: RunEvent = {
          id: "event-stream-1",
          runId: handle.runId,
          attempt: 1,
          sequence: 1,
          timestamp: new Date().toISOString(),
          type: "run.started",
        };
        yield { protocolVersion: "1.0", type: "ready" };
        yield { protocolVersion: "1.0", type: "event", event };
        yield {
          protocolVersion: "1.0",
          type: "result",
          result: resultFor(handle.runId, "streamed"),
        };
      },
    };
    const engine = new ModalExecutionEngine(gateway, controlPlane, development);
    const handle = await engine.submit({
      runId: "modal-stream-run",
      manifest: { schemaVersion: "1.0", steps: [] },
    });

    const events: RunEvent[] = [];
    for await (const event of engine.events(handle)) events.push(event);

    expect(events.map((event) => event.id)).toEqual(["event-stream-1"]);
    await expect(engine.result(handle)).resolves.toMatchObject({
      output: "streamed",
    });
  });

  it("uses the Modal SDK function and queue services without leaking SDK types", async () => {
    const queueValues: unknown[] = [
      { protocolVersion: "1.0", type: "ready" },
      {
        protocolVersion: "1.0",
        type: "result",
        result: resultFor("sdk-run", "sdk-ok"),
      },
    ];
    const spawns: unknown[] = [];
    const deleted: string[] = [];
    const client: ModalSdkClientLike = {
      functions: {
        fromName: async (appName, functionName) => ({
          spawn: async (args, kwargs) => {
            spawns.push({ appName, functionName, args, kwargs });
            return {
              functionCallId: "fc-sdk",
              get: async () => undefined,
              cancel: async () => undefined,
            };
          },
        }),
      },
      functionCalls: {
        fromId: async (functionCallId) => ({
          functionCallId,
          get: async () => undefined,
          cancel: async () => undefined,
        }),
      },
      queues: {
        fromName: async () => ({ get: async () => queueValues.shift() }),
        delete: async (queueName) => {
          deleted.push(queueName);
        },
      },
    };
    const gateway = new ModalSdkGateway(client);
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const engine = new ModalExecutionEngine(gateway, controlPlane, {
      invocationCodec: invocationCodec(),
    });
    const handle = await engine.submit({
      runId: "sdk-run",
      manifest: { schemaVersion: "1.0", steps: [] },
    });

    await expect(engine.result(handle)).resolves.toMatchObject({
      output: "sdk-ok",
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      appName: "agent-runtime-dev",
      functionName: "run_worker",
      args: [],
      kwargs: { queue_name: handle.providerData?.queueName },
    });
    expect(
      (spawns[0] as { kwargs: Record<string, unknown> }).kwargs,
    ).toHaveProperty("invocation_envelope");
    expect(
      (spawns[0] as { kwargs: Record<string, unknown> }).kwargs,
    ).not.toHaveProperty("invocation");
    await expect.poll(() => deleted).toEqual([handle.providerData?.queueName]);
  });

  it("times out and cancels a Modal call that never starts the worker protocol", async () => {
    const cancelled: string[] = [];
    const empty = Object.assign(new Error("empty"), {
      name: "QueueEmptyError",
    });
    const client: ModalSdkClientLike = {
      functions: {
        fromName: async () => ({
          spawn: async () => ({
            functionCallId: "fc-stalled",
            get: async () => undefined,
            cancel: async () => undefined,
          }),
        }),
      },
      functionCalls: {
        fromId: async (functionCallId) => ({
          functionCallId,
          get: async () => {
            throw Object.assign(new Error("still running"), {
              name: "FunctionTimeoutError",
            });
          },
          cancel: async () => {
            cancelled.push(functionCallId);
          },
        }),
      },
      queues: {
        fromName: async () => ({
          get: async () => {
            throw empty;
          },
        }),
        delete: async () => undefined,
      },
    };
    const gateway = new ModalSdkGateway(client, {
      startupTimeoutMs: 10,
      allowPlaintextInvocationForDevelopment: true,
      now: (() => {
        let value = 0;
        return () => (value += 11);
      })(),
    });
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const engine = new ModalExecutionEngine(gateway, controlPlane, development);
    const handle = await engine.submit({
      runId: "stalled-run",
      manifest: { schemaVersion: "1.0", steps: [] },
    });

    await expect(engine.result(handle)).rejects.toThrow(
      "message delivery failed",
    );
    expect(cancelled).toEqual(["fc-stalled"]);
  });

  it("cancels the Modal function and the neutral lifecycle", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const cancelled: string[] = [];
    const engine = new ModalExecutionEngine(
      {
        spawn: async () => ({ functionCallId: "fc-cancel" }),
        cancel: async (id) => {
          cancelled.push(id);
        },
      },
      controlPlane,
      development,
    );
    const handle = await engine.submit({
      runId: "cancel-modal",
      manifest: { schemaVersion: "1.0", steps: [] },
    });
    await engine.cancel(handle);
    expect(cancelled).toEqual(["fc-cancel"]);
    expect((await engine.status(handle)).status).toBe("cancelled");
  });

  it("fails closed unless encryption or trusted-development plaintext is explicit", () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const gateway: ModalGateway = {
      spawn: async () => ({ functionCallId: "never" }),
      cancel: async () => undefined,
    };

    expect(() => new ModalExecutionEngine(gateway, controlPlane)).toThrow(
      "requires an invocation envelope codec",
    );
  });

  it("sends an authenticated envelope instead of a raw invocation", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const requests: Parameters<ModalGateway["spawn"]>[0][] = [];
    const gateway: ModalGateway = {
      spawn: async (request) => {
        requests.push(request);
        return { functionCallId: "fc-encrypted" };
      },
      cancel: async () => undefined,
    };
    const codec = invocationCodec();
    const engine = new ModalExecutionEngine(gateway, controlPlane, {
      invocationCodec: codec,
      audience: "modal-production-worker",
    });
    const handle = await engine.submit({
      manifest: { schemaVersion: "1.0", steps: [] },
      configuration: { providerApiKey: "test-only-provider-secret" },
    });

    const request = requests[0]!;
    expect("invocation" in request).toBe(false);
    expect(JSON.stringify(request)).not.toContain("test-only-provider-secret");
    expect(
      decodeModalWorkerInvocation(request, invocationCodec(), {
        executionId: handle.id,
        runId: handle.runId,
        audience: "modal-production-worker",
      }),
    ).toMatchObject({
      request: {
        runId: handle.runId,
        configuration: { providerApiKey: "test-only-provider-secret" },
      },
    });
  });

  it("requires explicit development opt-in to decode plaintext requests", () => {
    const request = {
      executionId: "execution-dev",
      runId: "run-dev",
      invocation: {
        protocolVersion: "1.0",
        action: "run",
        request: {
          runId: "run-dev",
          manifest: { schemaVersion: "1.0", steps: [] },
        },
      },
    } as const;

    expect(() =>
      decodeModalWorkerInvocation(request, undefined, {
        executionId: "execution-dev",
        runId: "run-dev",
        audience: "unused",
      }),
    ).toThrow("Plaintext Modal invocation is disabled");
    expect(
      decodeModalWorkerInvocation(request, undefined, {
        executionId: "execution-dev",
        runId: "run-dev",
        audience: "unused",
        allowPlaintextInvocationForDevelopment: true,
      }),
    ).toMatchObject({ action: "run" });
  });

  it("rejects ambiguous Modal payloads before worker decoding", () => {
    const codec = invocationCodec();
    const encrypted = codec.seal(
      {
        protocolVersion: "1.0",
        action: "run",
        request: {
          runId: "run-ambiguous",
          manifest: { schemaVersion: "1.0", steps: [] },
        },
      },
      {
        executionId: "execution-ambiguous",
        runId: "run-ambiguous",
        audience: "modal-worker",
      },
    );

    expect(() =>
      decodeModalWorkerInvocation(
        {
          executionId: "execution-ambiguous",
          runId: "run-ambiguous",
          invocationEnvelope: encrypted,
          invocation: {
            protocolVersion: "1.0",
            action: "run",
            request: {
              runId: "run-ambiguous",
              manifest: { schemaVersion: "1.0", steps: [] },
            },
          },
        } as never,
        codec,
        {
          executionId: "execution-ambiguous",
          runId: "run-ambiguous",
          audience: "modal-worker",
        },
      ),
    ).toThrow("exactly one envelope or plaintext payload");
  });

  it("deletes the per-execution queue after cancellation", async () => {
    const deleted: string[] = [];
    const client: ModalSdkClientLike = {
      functions: {
        fromName: async () => ({
          spawn: async () => ({
            functionCallId: "fc-cancel-cleanup",
            get: async () => undefined,
            cancel: async () => undefined,
          }),
        }),
      },
      functionCalls: {
        fromId: async (functionCallId) => ({
          functionCallId,
          get: async () => undefined,
          cancel: async () => undefined,
        }),
      },
      queues: {
        fromName: async () => ({ get: async () => undefined }),
        delete: async (queueName) => {
          deleted.push(queueName);
        },
      },
    };
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const engine = new ModalExecutionEngine(
      new ModalSdkGateway(client, {
        allowPlaintextInvocationForDevelopment: true,
      }),
      controlPlane,
      development,
    );
    const handle = await engine.submit({
      runId: "cancel-cleanup",
      manifest: { schemaVersion: "1.0", steps: [] },
    });

    await engine.cancel(handle);

    expect(deleted).toEqual([handle.providerData?.queueName]);
  });

  it("deletes the queue and does not persist provider stderr when observation fails", async () => {
    const deleted: string[] = [];
    const secretStderr = "provider stderr containing test-only-secret";
    const client: ModalSdkClientLike = {
      functions: {
        fromName: async () => ({
          spawn: async () => ({
            functionCallId: "fc-observer-failure",
            get: async () => undefined,
            cancel: async () => undefined,
          }),
        }),
      },
      functionCalls: {
        fromId: async (functionCallId) => ({
          functionCallId,
          get: async () => undefined,
          cancel: async () => undefined,
        }),
      },
      queues: {
        fromName: async () => ({
          get: async () => ({
            transport: "closed",
            exitCode: 1,
            stderr: secretStderr,
          }),
        }),
        delete: async (queueName) => {
          deleted.push(queueName);
        },
      },
    };
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const engine = new ModalExecutionEngine(
      new ModalSdkGateway(client, {
        allowPlaintextInvocationForDevelopment: true,
      }),
      controlPlane,
      development,
    );
    const handle = await engine.submit({
      runId: "observer-failure",
      manifest: { schemaVersion: "1.0", steps: [] },
    });

    await expect(engine.result(handle)).rejects.toThrow(
      "message delivery failed",
    );
    const status = await engine.status(handle);
    expect(JSON.stringify(status)).not.toContain(secretStderr);
    await expect.poll(() => deleted).toEqual([handle.providerData?.queueName]);
  });

  it("does not persist a raw worker error message or details", async () => {
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const secretMessage = "provider rejected test-only-secret";
    const gateway: ModalStreamingGateway = {
      spawn: async () => ({ functionCallId: "fc-worker-error" }),
      cancel: async () => undefined,
      messages: async function* () {
        yield {
          protocolVersion: "1.0",
          type: "error",
          error: {
            code: "MODEL_PROVIDER_FAILED",
            message: secretMessage,
            retryable: true,
            details: { response: secretMessage },
          },
        };
      },
    };
    const engine = new ModalExecutionEngine(gateway, controlPlane, development);
    const handle = await engine.submit({
      runId: "worker-error",
      manifest: { schemaVersion: "1.0", steps: [] },
    });

    await expect(engine.result(handle)).rejects.toThrow(
      "Modal worker reported an execution failure.",
    );
    const status = await engine.status(handle);
    expect(status.error).toEqual({
      code: "MODEL_PROVIDER_FAILED",
      message: "Modal worker reported an execution failure.",
      retryable: true,
    });
    expect(JSON.stringify(status)).not.toContain(secretMessage);
  });
});
