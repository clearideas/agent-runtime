/**
 * Orchestration: parallel waves, a condition, a collection loop, and a goal
 * loop, run in this process and in a separate worker process.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  eventsOf,
  resultOf,
  runDemo,
  startShowcase,
  type Message,
} from "./helpers.ts";

const run = (baseURL: string, options: Record<string, unknown>) =>
  runDemo(baseURL, "orchestration", { options });

/** Top-level steps that were running at the same time as another one. */
const overlapping = (messages: Message[]) => {
  const running = new Set<string>();
  const overlaps = new Set<string>();
  for (const event of eventsOf(messages, "step.started")
    .concat(eventsOf(messages, "step.completed"))
    .sort((a, b) => a.sequence - b.sequence)) {
    if (event.stepPath !== event.stepId) continue;
    if (event.type === "step.started") {
      if (running.size)
        [...running, event.stepId].forEach((id) => overlaps.add(id));
      running.add(event.stepId);
    } else running.delete(event.stepId);
  }
  return [...overlaps].sort();
};

test("parallel scheduling runs independent research steps together", async (context) => {
  const { baseURL } = await startShowcase(context);
  const parallel = await run(baseURL, { scheduling: "parallel" });
  resultOf(parallel);
  assert.deepEqual(overlapping(parallel), ["audience", "pricing", "risks"]);
  const sequential = await run(baseURL, { scheduling: "sequential" });
  resultOf(sequential);
  assert.deepEqual(overlapping(sequential), []);
});

test("branches on a condition and runs both kinds of loop", async (context) => {
  const { baseURL } = await startShowcase(context);
  const regulated = await run(baseURL, { regulatedMarket: true });
  const result = resultOf(regulated);
  assert.equal(eventsOf(regulated, "step.skipped").length, 0);
  assert.match(result.output, /Risk mitigation/u);

  const pitches = eventsOf(regulated, "loop.iteration.started").filter(
    (event) => event.stepId === "pitches",
  );
  assert.equal(pitches.length, 3);
  assert.equal(result.state.pitches.length, 3);

  const passes = eventsOf(regulated, "loop.iteration.started").filter(
    (event) => event.stepId === "headline",
  );
  assert.equal(passes.length, 2, "the first headline is rejected");
  assert.equal(eventsOf(regulated, "loop.goal.met")[0].data.iteration, 2);
  assert.equal(
    result.state.headline,
    "Give your agents a workspace, not the keys",
  );

  const unregulated = await run(baseURL, { regulatedMarket: false });
  resultOf(unregulated);
  assert.deepEqual(
    eventsOf(unregulated, "step.skipped").map((event) => event.stepId),
    ["mitigation"],
  );
});

test("a remote worker process produces the same run", async (context) => {
  const { baseURL } = await startShowcase(context);
  const local = await run(baseURL, { engine: "local", scheduling: "parallel" });
  const remote = await run(baseURL, {
    engine: "remote",
    scheduling: "parallel",
  });
  const engine = remote.find((message) => message.kind === "engine");
  assert.equal(engine?.engine, "http-worker");
  assert.ok(Number.isInteger(engine?.providerData.pid));
  assert.notEqual(engine?.providerData.pid, process.pid);

  const completedSteps = (messages: Message[]) =>
    eventsOf(messages, "step.completed")
      .map((event) => event.stepPath)
      .sort();
  assert.deepEqual(completedSteps(remote), completedSteps(local));
  assert.equal(resultOf(remote).output, resultOf(local).output);
});
