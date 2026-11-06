import assert from "node:assert/strict";
import test from "node:test";

import { diffLines, hunk } from "../public/assets/lib/diff.js";
import {
  applyMessage,
  createRunState,
  describeCommand,
} from "../public/assets/lib/run-state.js";

let sequence = 0;
const event = (type: string, data: object = {}, stepId?: string) => ({
  kind: "event",
  event: {
    id: `e${++sequence}`,
    runId: "run-1",
    sequence,
    timestamp: new Date().toISOString(),
    type,
    ...(stepId ? { stepId } : {}),
    data,
  },
});

const effectTypes = (effects: Array<{ type: string }>) =>
  effects.map((effect) => effect.type).filter((type) => type !== "event");

test("describes built-in helper commands by operation and path", () => {
  assert.deepEqual(
    describeCommand("builtin", "read_file", [
      "python3",
      "/workspace/bin/agent-fs",
      "read",
      "--mount",
      "/workspace/mounts/repo",
      "--path",
      "src/invoice.py",
    ]),
    {
      op: "read",
      path: "src/invoice.py",
      query: undefined,
      display: "agent-fs read src/invoice.py",
    },
  );
  assert.equal(
    describeCommand("command", "run_tests", ["python3", "-m", "unittest"])
      .display,
    "python3 -m unittest",
  );
});

test("tracks a tool call through admission, execution, and sync-back", () => {
  const state = createRunState();
  applyMessage(state, {
    kind: "accepted",
    runId: "run-1",
    mode: "scripted",
    sandbox: "bubblewrap",
  });
  applyMessage(state, event("run.started"));
  applyMessage(state, event("step.started", {}, "fix"));
  const dispatched = applyMessage(
    state,
    event(
      "model.tool.started",
      { toolCallId: "call-1", toolName: "repo__write_file" },
      "fix",
    ),
  );
  assert.deepEqual(effectTypes(dispatched), ["tool-dispatched"]);
  applyMessage(
    state,
    event("sandbox.opened", {
      sandboxId: "sb-1",
      provider: "bubblewrap",
      mounts: [{ alias: "repo", mode: "read_write", fileCount: 4 }],
    }),
  );
  applyMessage(
    state,
    event(
      "sandbox.command.started",
      {
        commandId: "cmd-1-1",
        toolCallId: "call-1",
        kind: "builtin",
        name: "write_file",
        argv: ["python3", "/workspace/bin/agent-fs", "write", "--path", "a.py"],
      },
      "fix",
    ),
  );
  const completed = applyMessage(
    state,
    event(
      "sandbox.command.completed",
      {
        id: "cmd-1-1",
        kind: "builtin",
        name: "write_file",
        argv: [],
        exitCode: 0,
        durationMs: 40,
        filesChanged: [{ alias: "repo", path: "a.py", action: "modified" }],
        ignoredPaths: [],
        budget: {
          commandsUsed: 1,
          commandsLimit: 16,
          sandboxSecondsUsed: 0.04,
          sandboxSecondsLimit: 120,
        },
      },
      "fix",
    ),
  );
  assert.deepEqual(effectTypes(completed), ["command-completed", "sync-back"]);
  applyMessage(
    state,
    event(
      "model.tool.completed",
      { toolCallId: "call-1", toolName: "repo__write_file", failed: false },
      "fix",
    ),
  );
  assert.equal(state.tools.get("call-1").commandId, "cmd-1-1");
  assert.equal(state.tools.get("call-1").state, "complete");
  assert.equal(state.commands.get("cmd-1-1").path, "a.py");
  assert.equal(state.admitted, 1);
  assert.equal(
    (state.budget as unknown as { commandsUsed: number }).commandsUsed,
    1,
  );
  assert.equal(state.sandbox.state, "open");
});

test("classifies host-policy denials separately from tool failures", () => {
  const state = createRunState();
  applyMessage(
    state,
    event(
      "model.tool.started",
      { toolCallId: "c", toolName: "repo__write_file" },
      "fix",
    ),
  );
  const denied = applyMessage(
    state,
    event(
      "model.tool.completed",
      {
        toolCallId: "c",
        toolName: "repo__write_file",
        failed: true,
        errorCode: "tool_not_authorized",
      },
      "fix",
    ),
  );
  assert.deepEqual(effectTypes(denied), ["tool-denied"]);
  assert.equal(state.denied, 1);
  assert.equal(state.tools.get("c").state, "denied");
});

test("streams text, sums usage, and finishes steps", () => {
  const state = createRunState();
  applyMessage(state, event("step.started", {}, "report"));
  applyMessage(state, event("model.started", {}, "report"));
  applyMessage(state, event("model.text.delta", { delta: "Hello " }, "report"));
  applyMessage(state, event("model.text.delta", { delta: "world" }, "report"));
  applyMessage(
    state,
    event(
      "model.usage",
      { usage: { inputTokens: 10, outputTokens: 5 } },
      "report",
    ),
  );
  applyMessage(state, event("step.skipped", {}, "fix"));
  applyMessage(state, event("run.completed"));
  assert.equal(state.steps.get("report").text, "Hello world");
  assert.equal(state.steps.get("report").state, "complete");
  assert.equal(state.steps.get("fix").state, "skipped");
  assert.equal(state.usage.totalTokens, 15);
  assert.equal(state.status, "completed");
});

test("ignores unknown event types", () => {
  const state = createRunState();
  const effects = applyMessage(state, event("future.event.type", { x: 1 }));
  assert.deepEqual(effectTypes(effects), []);
  assert.equal(state.eventCount, 1);
});

test("diffs and trims changed lines with context", () => {
  const lines = hunk(
    diffLines("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nd\nE\nf\ng\nh"),
    1,
  );
  assert.deepEqual(
    lines.map(
      (line: { type: string; text: string }) => `${line.type}:${line.text}`,
    ),
    ["same:d", "remove:e", "add:E", "same:f"],
  );
});
