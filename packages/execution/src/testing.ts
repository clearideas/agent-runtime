import type {
  AgentManifest,
  RunEvent,
  RunResult,
} from "@clearideas/agent-runtime-contracts";

import {
  type ExecutionEngine,
  type ExecutionHandle,
  type ExecutionRequest,
  eventCursor,
} from "./contracts.js";

export interface ExecutionEngineConformanceFactory {
  create(): Promise<ExecutionEngine> | ExecutionEngine;
  manifest: AgentManifest;
  result(runId: string): RunResult;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`Execution engine conformance failed: ${message}`);
}

const collect = async (
  engine: ExecutionEngine,
  handle: ExecutionHandle,
): Promise<RunEvent[]> => {
  const events: RunEvent[] = [];
  for await (const event of engine.events(handle)) events.push(event);
  return events;
};

/** Framework-neutral minimum conformance checks reusable by provider packages. */
export const runExecutionEngineConformance = async (
  factory: ExecutionEngineConformanceFactory,
): Promise<void> => {
  const engine = await factory.create();
  const request: ExecutionRequest = {
    manifest: factory.manifest,
    runId: "conformance-run",
    idempotencyKey: "conformance-key",
  };
  const first = await engine.submit(request);
  const duplicate = await engine.submit(request);
  assert(
    first.id === duplicate.id,
    "idempotent submission returned another handle",
  );
  const events = await collect(engine, first);
  const status = await engine.status(first);
  assert(
    status.status === "completed",
    `expected completed status, got ${status.status}`,
  );
  const result = await engine.result(first);
  assert(result.runId === first.runId, "result runId did not match the handle");
  for (let index = 1; index < events.length; index += 1) {
    const previous = eventCursor(events[index - 1]!);
    const current = eventCursor(events[index]!);
    assert(
      current.attempt > previous.attempt ||
        (current.attempt === previous.attempt &&
          current.sequence > previous.sequence),
      "events were not strictly ordered",
    );
  }
  if (events.length > 1) {
    const replayed: RunEvent[] = [];
    for await (const event of engine.events(first, {
      after: eventCursor(events[0]!),
    })) {
      replayed.push(event);
    }
    assert(
      replayed.length === events.length - 1,
      "cursor replay returned an incorrect event count",
    );
  }
};
