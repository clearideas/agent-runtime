/**
 * Durable Runs: a run pauses for approval, a token limit, or a provider
 * outage, is saved by the RunStore, and resumes in a new attempt — even from
 * a new server instance. Completed steps are restart points with workspace
 * snapshots, and edits to the agent are checked against what already ran.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createShowcaseApp,
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

const stateOf = async (baseURL: string, edit?: string) =>
  (
    await fetch(
      `${baseURL}/api/demos/durable-runs/state${edit ? `?edit=${edit}` : ""}`,
    )
  ).json();

const pendingOf = async (baseURL: string) => (await stateOf(baseURL)).pending;

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
  "a token limit blocks the run mid-step; raising it continues without repeating tool calls",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const first = await runDemo(baseURL, "durable-runs", {
      options: { tokenLimit: true },
    });
    const runId = runIdOf(first);
    const suspended = eventsOf(first, "run.suspended")[0].data;
    assert.equal(suspended.reason, "blocked");
    assert.equal(suspended.kind, "awaiting-host");
    assert.equal(suspended.details.cause, "limit");
    assert.equal(suspended.details.limit, "maxTotalTokens");
    assert.ok(suspended.details.used >= suspended.details.value);

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

test(
  "a provider outage blocks the run instead of failing it; resuming publishes",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const runId = runIdOf(
      await runDemo(baseURL, "durable-runs", { options: { outage: true } }),
    );
    const second = await resume(baseURL, runId, { decision: "approve" });
    // The step retried once (policies.modelRetry), then the run was blocked.
    assert.equal(eventsOf(second, "model.retry").length, 1);
    assert.equal(eventsOf(second, "run.failed").length, 0);
    assert.equal(eventsOf(second, "step.failed")[0].data.paused, true);
    const suspended = eventsOf(second, "run.suspended")[0].data;
    assert.equal(suspended.reason, "blocked");
    assert.equal(suspended.details.cause, "error");
    assert.equal(suspended.details.error.code, "MODEL_PROVIDER_UNAVAILABLE");
    assert.equal(suspended.details.stepId, "publish");
    // Why the run is blocked is saved with it.
    const state = await stateOf(baseURL);
    assert.equal(state.pending.reason, "blocked");
    assert.equal(
      state.history.ledger.blocked.code,
      "MODEL_PROVIDER_UNAVAILABLE",
    );

    const third = await resume(baseURL, runId, {});
    const result = resultOf(third);
    assert.match(result.output, /Approved by the reviewer/u);
    // The draft and the approval were not repeated.
    assert.equal(eventsOf(third, "approval.requested").length, 0);
    assert.equal((await stateOf(baseURL)).history.ledger.recoveries, 1);
  },
);

test(
  "restarting from a step restores its snapshot and asks for approval again",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory } = await startShowcase(context);
    const reports = path.join(dataDirectory, "durable-runs", "reports");
    const runId = runIdOf(await runDemo(baseURL, "durable-runs"));
    resultOf(await resume(baseURL, runId, { decision: "approve" }));
    assert.ok((await readdir(reports)).includes("Q3-report.md"));

    const { history } = await stateOf(baseURL);
    assert.equal(history.status, "completed");
    assert.deepEqual(
      history.restartPoints.map((point: Message) => point.stepId),
      ["draft", "review"],
    );
    const afterDraft = history.restartPoints[0];
    assert.deepEqual(afterDraft.snapshot.files, ["Q3-draft.md", "README.md"]);

    const restarted = await runDemo(baseURL, "durable-runs", {
      options: { restartFrom: { runId, sequence: afterDraft.sequence } },
    });
    const newRunId = runIdOf(restarted);
    assert.notEqual(newRunId, runId);
    assert.deepEqual(eventsOf(restarted, "run.started")[0].data.seededFrom, {
      runId,
      checkpointSequence: afterDraft.sequence,
      stepPath: "draft",
      executionKey: "draft",
    });
    // Draft is not repeated, the folder is as it was after Draft, and the
    // new run asks for approval again.
    assert.equal(eventsOf(restarted, "sandbox.command.completed").length, 0);
    assert.deepEqual((await readdir(reports)).sort(), [
      "Q3-draft.md",
      "README.md",
    ]);
    assert.equal(
      eventsOf(restarted, "run.suspended")[0].data.reason,
      "approval",
    );
    const restartedState = await stateOf(baseURL);
    assert.equal(restartedState.pending.runId, newRunId);
    assert.equal(restartedState.history.seededFrom.runId, runId);

    const result = resultOf(
      await resume(baseURL, newRunId, { decision: "approve", reviewer: "Lee" }),
    );
    assert.match(result.output, /Approved by Lee/u);
  },
);

test(
  "edits are checked against what already ran",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory } = await startShowcase(context);
    const runId = runIdOf(await runDemo(baseURL, "durable-runs"));
    const outcomes: Record<string, string> = {};
    for (const edit of [
      "turn-limit",
      "publish-summary",
      "draft-thousands",
      "quarter-q2",
    ])
      outcomes[edit] = (await stateOf(baseURL, edit)).resumeAssessment.outcome;
    // Paused for approval after Draft: a limit or a step not yet run may
    // change; the completed Draft and the run's variables may not.
    assert.deepEqual(outcomes, {
      "turn-limit": "accepted",
      "publish-summary": "accepted",
      "draft-thousands": "refused",
      "quarter-q2": "refused",
    });

    const refused = await resume(baseURL, runId, {
      decision: "approve",
      edit: "draft-thousands",
    });
    assert.match(
      refused.find((message) => message.kind === "error")!.error.message,
      /Step draft already completed and its definition changed/u,
    );
    // The refused resume left the run as it was, with no decision recorded.
    assert.equal((await stateOf(baseURL)).pending.runId, runId);
    await assert.rejects(
      readFile(
        path.join(
          dataDirectory,
          "durable-runs",
          "decisions",
          `${runId}.review.json`,
        ),
      ),
    );

    const result = resultOf(
      await resume(baseURL, runId, {
        decision: "approve",
        edit: "publish-summary",
      }),
    );
    assert.match(
      result.output,
      /^# Q3 revenue report\n\n> Revenue \$453,000, \+7\.9% on the previous quarter\./u,
    );

    // Restarting after Draft cannot change Draft either: a new run can.
    const { history } = await stateOf(baseURL, "draft-thousands");
    assert.deepEqual(
      history.restartPoints.map((point: Message) => point.assessment.outcome),
      ["refused", "refused"],
    );
    const restart = await runDemo(baseURL, "durable-runs", {
      options: {
        edit: "draft-thousands",
        restartFrom: { runId, sequence: history.restartPoints[0].sequence },
      },
    });
    assert.match(
      restart.find((message) => message.kind === "error")!.error.message,
      /Step draft already completed/u,
    );
    // Nothing was reset: the last run and its published report remain.
    assert.equal((await stateOf(baseURL)).history.runId, runId);
    await readFile(
      path.join(dataDirectory, "durable-runs", "reports", "Q3-report.md"),
    );
  },
);

test(
  "an edit to the step in progress runs that step again",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const first = await runDemo(baseURL, "durable-runs", {
      options: { tokenLimit: true },
    });
    const runId = runIdOf(first);
    const { resumeAssessment } = await stateOf(baseURL, "draft-thousands");
    assert.equal(resumeAssessment.outcome, "restarts-step");
    assert.equal(resumeAssessment.step, "draft");

    const second = await resume(baseURL, runId, {
      maxTotalTokens: 50_000,
      edit: "draft-thousands",
    });
    assert.equal(
      eventsOf(second, "diagnostic").find(
        (event) => event.data.code === "STEP_RESTARTED_AFTER_MANIFEST_CHANGE",
      )?.stepId,
      "draft",
    );
    // Draft started over under the new instruction.
    const written = second.find(
      (message) =>
        message.kind === "tool-io" && message.name === "reports__write_file",
    );
    assert.match(
      written!.input.content,
      /\| \*\*Total\*\* \| \$420K \| \$453K \|/u,
    );
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
