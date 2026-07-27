import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEvent } from "@clearideas/agent-runtime-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConsoleEventSink, JsonlEventSink } from "./event-sinks.js";

const event = (sequence: number): RunEvent => ({
  id: `event-${sequence}`,
  runId: "run-events",
  type: sequence === 3 ? "run.completed" : "step.completed",
  sequence,
  timestamp: `2026-07-22T12:00:0${sequence}.000Z`,
  ...(sequence < 3 ? { stepId: `step-${sequence}` } : {}),
  data: { sequence },
});

describe("local event sinks", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-events-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes concurrent JSONL emissions in invocation order", async () => {
    const filePath = path.join(directory, "nested", "events.jsonl");
    const sink = new JsonlEventSink(filePath);

    await Promise.all([
      sink.emit(event(1)),
      sink.emit(event(2)),
      sink.emit(event(3)),
    ]);
    await sink.flush();

    const contents = await readFile(filePath, "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(
      contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([event(1), event(2), event(3)]);
  });

  it("emits the same structured JSON line format to an injected console writer", () => {
    const lines: string[] = [];
    const sink = new ConsoleEventSink((line) => lines.push(line));

    sink.emit(event(1));

    expect(lines).toEqual([`${JSON.stringify(event(1))}\n`]);
  });
});
