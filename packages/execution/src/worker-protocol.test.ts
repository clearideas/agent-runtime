import { describe, expect, it } from "vitest";

import { EXECUTION_PROTOCOL_VERSION } from "./contracts.js";
import {
  createWorkerInvocation,
  MAXIMUM_WORKER_INVOCATION_BYTES,
  parseWorkerInvocation,
  parseWorkerMessage,
  serializeWorkerMessage,
} from "./worker-protocol.js";

describe("portable worker protocol", () => {
  it("round-trips a neutral invocation", () => {
    const invocation = createWorkerInvocation({
      manifest: {
        schemaVersion: "1.0",
        variables: [{ key: "audience", type: "string", value: "customers" }],
        steps: [],
      },
      runId: "run-1",
      variables: [{ key: "audience", value: "partners" }],
      execution: { mode: "parallel", maxConcurrency: 4 },
      budget: { maxTotalTokens: 5_000 },
    });
    expect(parseWorkerInvocation(JSON.stringify(invocation))).toEqual(
      invocation,
    );
  });

  it("rejects object-shaped invocation variables", () => {
    expect(() =>
      parseWorkerInvocation({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        action: "run",
        request: {
          manifest: {
            schemaVersion: "1.0",
            variables: [{ key: "audience", type: "string" }],
            steps: [],
          },
          variables: { audience: "partners" },
        },
      }),
    ).toThrow();
  });

  it("rejects invocation overrides during resume", () => {
    expect(() =>
      parseWorkerInvocation({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        action: "resume",
        request: {
          manifest: {
            schemaVersion: "1.0",
            variables: [{ key: "audience", type: "string" }],
            steps: [],
          },
          runId: "run-1",
          attempt: 2,
          variables: [{ key: "audience", value: "partners" }],
          checkpointReference: "checkpoint-1",
        },
      }),
    ).toThrow("cannot include run variable overrides");
  });

  it("rejects invalid step scheduling at the worker boundary", () => {
    expect(() =>
      parseWorkerInvocation({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        action: "run",
        request: {
          manifest: { schemaVersion: "1.0", steps: [] },
          execution: { mode: "parallel", maxConcurrency: 0 },
        },
      }),
    ).toThrow();
  });

  it("rejects an invalid token budget at the worker boundary", () => {
    expect(() =>
      parseWorkerInvocation({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        action: "run",
        request: {
          manifest: { schemaVersion: "1.0", steps: [] },
          budget: { maxTotalTokens: 0 },
        },
      }),
    ).toThrow();
  });

  it("rejects oversized serialized invocations before JSON parsing", () => {
    expect(() =>
      parseWorkerInvocation(" ".repeat(MAXIMUM_WORKER_INVOCATION_BYTES + 1)),
    ).toThrow("Worker invocation exceeds the input size limit");
  });

  it("rejects deeply nested invocation values before recursive validation", () => {
    let nestedValue: Record<string, unknown> = {};
    for (let depth = 0; depth < 2_000; depth += 1) {
      nestedValue = { nested: nestedValue };
    }

    expect(() =>
      parseWorkerInvocation({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        action: "run",
        request: {
          manifest: {
            schemaVersion: "1.0",
            variables: [{ key: "payload", type: "json" }],
            steps: [],
          },
          variables: [{ key: "payload", value: nestedValue }],
        },
      }),
    ).toThrow("Worker invocation exceeds the structure depth limit");
  });

  it("serializes NDJSON messages and rejects protocol drift", () => {
    const message = {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      type: "ready" as const,
    };
    expect(parseWorkerMessage(serializeWorkerMessage(message).trim())).toEqual(
      message,
    );
    expect(() =>
      parseWorkerInvocation({
        protocolVersion: "2.0",
        action: "run",
        request: {},
      }),
    ).toThrow("Unsupported execution protocol");
  });

  it("rejects malformed manifests, resume ownership, and event cursors at the boundary", () => {
    expect(() =>
      parseWorkerInvocation({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        action: "run",
        request: {
          manifest: { schemaVersion: "1.0", steps: [{ type: "unknown" }] },
        },
      }),
    ).toThrow();
    expect(() =>
      parseWorkerInvocation({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        action: "resume",
        request: {
          manifest: { schemaVersion: "1.0", steps: [] },
          runId: "run-1",
          attempt: 1,
          checkpointReference: "checkpoint-1",
        },
      }),
    ).toThrow("greater than one");
    expect(() =>
      parseWorkerMessage({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        type: "event",
        event: {
          id: "event-1",
          runId: "run-1",
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: "run.started",
        },
      }),
    ).toThrow("positive safe integer");
  });
});
