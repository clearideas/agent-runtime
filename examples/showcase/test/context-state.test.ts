import assert from "node:assert/strict";
import test from "node:test";

import {
  applyContextMessage,
  bytesByKind,
  createContextState,
  describeReduction,
  kb,
} from "../public/assets/lib/context-state.js";

const reduced = (data: object, stepId = "investigate") => ({
  kind: "event",
  event: { type: "context.reduced", stepId, data },
});

const input = (bytes: number, purpose = "step", segments: object[] = []) => ({
  kind: "model-input",
  stepId: "investigate",
  purpose,
  bytes,
  limit: 40_000,
  segments,
});

test("attaches reductions and summarizer calls to the next request", () => {
  const state = createContextState();
  applyContextMessage(state, input(20_000));
  applyContextMessage(
    state,
    reduced({
      scope: "transcript",
      strategy: "summarize",
      summarizedRounds: 3,
      bytesBefore: 43_600,
      bytesAfter: 26_000,
    }),
  );
  const effects = applyContextMessage(state, input(9_000, "summarize"));
  assert.deepEqual(
    effects.map((effect: { type: string }) => effect.type),
    ["summarizer"],
  );
  applyContextMessage(state, input(26_000));

  assert.equal(state.requests.length, 2);
  assert.equal(state.summarizerCalls, 1);
  assert.equal(state.peak, 26_000);
  assert.equal(state.limit, 40_000);
  assert.equal(state.bytesKeptOut, 17_600);
  const [first, second] = state.requests;
  assert.ok(first && second);
  assert.equal(first.reductions.length, 0);
  assert.equal(second.reductions.length, 1);
  assert.equal(second.summarizerCalls, 1);
  assert.equal(second.reductions[0]?.beforeRequest, 2);
});

test("reads a limit failure from the run error", () => {
  const state = createContextState(40_000);
  const effects = applyContextMessage(state, {
    kind: "error",
    error: {
      message:
        "Prompt step investigate input is 40721 bytes, exceeding the 40000-byte input limit",
    },
  });
  assert.equal(effects[0]?.type, "failure");
  assert.deepEqual(state.failure, { bytes: 40_721, limit: 40_000 });
  assert.deepEqual(
    applyContextMessage(state, { kind: "error", error: { message: "other" } }),
    [],
  );
});

test("describes each kind of reduction in one sentence", () => {
  assert.equal(
    describeReduction({
      scope: "input",
      strategy: "prune",
      variable: "runbook",
      bytesBefore: 29_331,
      bytesAfter: 19_375,
    }),
    "Clipped the runbook variable in the opening prompt · 29.3 KB → 19.4 KB",
  );
  assert.match(
    describeReduction({ scope: "transcript", stubbedResults: 2 }),
    /^Replaced 2 older tool outputs with stubs$/u,
  );
  assert.match(
    describeReduction({ scope: "transcript", removedRounds: 1 }),
    /Removed older rounds \(1 removed so far\)/u,
  );
  assert.match(
    describeReduction({ scope: "tool-result", toolName: "logs__read_file" }),
    /Shortened a large logs__read_file result/u,
  );
  assert.equal(kb(40_000), "40.0 KB");
  assert.deepEqual(
    [
      ...bytesByKind([
        { kind: "result", bytes: 10 },
        { kind: "result", bytes: 5 },
        { kind: "stub", bytes: 1 },
      ]),
    ],
    [
      ["result", 15],
      ["stub", 1],
    ],
  );
});
