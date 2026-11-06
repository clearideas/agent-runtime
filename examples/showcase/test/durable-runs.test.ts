/**
 * Durable Runs: a run pauses for approval or a token budget, is saved by the
 * RunStore, and resumes in a new attempt — even from a new server instance.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createShowcaseApp } from "../server.ts";
import {
  eventsOf,
  resultOf,
  runDemo,
  startShowcase,
  type Message,
  testEnvironment,
} from "./helpers.ts";

const environment = await testEnvironment();
const skip =
  environment.sandbox.kind === "none" ? "no sandbox available" : false;

const resume = async (
  baseURL: string,
  runId: string,
  options: Record<string, unknown>,
): Promise<Message[]> => {
  const response = await fetch(
    `${baseURL}/api/demos/durable-runs/runs/${runId}/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pace: 0, options }),
    },
  );
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);
};

const pendingOf = async (baseURL: string) =>
  (await (await fetch(`${baseURL}/api/demos/durable-runs/state`)).json())
    .pending;

const runIdOf = (messages: Message[]) =>
  messages.find((message) => message.kind === "accepted")!.runId as string;

test(
  "pauses for approval, closes the sandbox, and publishes after approval",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory } = await startShowcase(context);
    const first = await runDemo(baseURL, "durable-runs");
    const runId = runIdOf(first);
    assert.equal(eventsOf(first, "run.suspended")[0].data.reason, "approval");
    assert.equal(eventsOf(first, "sandbox.closed")[0].data.reason, "suspended");
    assert.equal(
      first.some((message) => message.kind === "result"),
      false,
    );
    const pending = await pendingOf(baseURL);
    assert.equal(pending.runId, runId);
    // The approval prompt is templated with run variables.
    assert.equal(pending.details.prompt, "Publish the Q3 revenue report?");

    const second = await resume(baseURL, runId, {
      decision: "approve",
      reviewer: "Dana",
    });
    const result = resultOf(second);
    assert.equal(eventsOf(second, "run.resumed")[0].attempt, 2);
    assert.equal(eventsOf(second, "approval.resolved")[0].data.approved, true);
    // The new attempt opened a new sandbox and read the draft from the host.
    assert.equal(eventsOf(second, "sandbox.opened").length, 1);
    assert.match(result.output, /\*\*Status:\*\* Approved by Dana/u);
    assert.match(
      result.output,
      /\| \*\*Total\*\* \| \$420,000 \| \$453,000 \|/u,
    );
    const published = await readFile(
      path.join(dataDirectory, "durable-runs", "reports", "Q3-report.md"),
      "utf8",
    );
    assert.match(published, /Approved by Dana/u);
    assert.equal(await pendingOf(baseURL), null);
  },
);

test(
  "a rejected approval ends the run without publishing",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory } = await startShowcase(context);
    const runId = runIdOf(await runDemo(baseURL, "durable-runs"));
    const second = await resume(baseURL, runId, { decision: "reject" });
    assert.equal(eventsOf(second, "approval.resolved")[0].data.approved, false);
    assert.match(
      eventsOf(second, "run.failed")[0].data.error.message,
      /Approval was rejected/u,
    );
    await assert.rejects(
      readFile(
        path.join(dataDirectory, "durable-runs", "reports", "Q3-report.md"),
      ),
    );
  },
);

test(
  "a token budget pauses mid-step; raising it continues without repeating tool calls",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const first = await runDemo(baseURL, "durable-runs", {
      options: { tokenBudget: true },
    });
    const runId = runIdOf(first);
    const suspended = eventsOf(first, "run.suspended")[0].data;
    assert.equal(suspended.reason, "token-budget");
    assert.equal(suspended.details.stepId, "draft");
    assert.ok(
      suspended.details.consumedTokens >= suspended.details.maxTotalTokens,
    );

    const tooLow = await resume(baseURL, runId, { maxTotalTokens: 10 });
    assert.match(
      tooLow.find((message) => message.kind === "error")!.error.message,
      /higher than the tokens used/u,
    );

    const second = await resume(baseURL, runId, { maxTotalTokens: 50_000 });
    assert.equal(eventsOf(second, "run.suspended")[0].data.reason, "approval");
    const third = await resume(baseURL, runId, { decision: "approve" });
    resultOf(third);

    const commands = [first, second, third].flatMap((messages) =>
      eventsOf(messages, "sandbox.command.completed").map(
        (event) => `${event.data.name}:${event.data.argv.at(-1)}`,
      ),
    );
    // Each file was read exactly once across all three attempts.
    const reads = commands.filter((name) => name.startsWith("read_file"));
    assert.equal(new Set(reads).size, reads.length);
    assert.equal(eventsOf(third, "run.resumed")[0].attempt, 3);
  },
);

test("a paused run survives a server restart", { skip }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "showcase-restart-"));
  try {
    const first = await createShowcaseApp({
      host: "127.0.0.1",
      port: 0,
      dataDirectory,
    });
    const firstAddress = await first.listen();
    const runId = runIdOf(
      await runDemo(`http://127.0.0.1:${firstAddress.port}`, "durable-runs"),
    );
    await first.close();

    const second = await createShowcaseApp({
      host: "127.0.0.1",
      port: 0,
      dataDirectory,
    });
    const secondAddress = await second.listen();
    try {
      const baseURL = `http://127.0.0.1:${secondAddress.port}`;
      assert.equal((await pendingOf(baseURL)).runId, runId);
      const result = resultOf(
        await resume(baseURL, runId, { decision: "approve" }),
      );
      assert.match(result.output, /Approved by the reviewer/u);
    } finally {
      await second.close();
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
