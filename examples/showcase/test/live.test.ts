/**
 * The Live path, without an API key.
 *
 * Live mode swaps the scripted adapter for Agent Runtime's AI SDK adapter.
 * These tests run each Live-capable demo through that real adapter, answered
 * by an AI SDK mock model that follows the demo script (see live-model.ts),
 * and expect the same outcomes as Scripted mode.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { documentLibraryScript } from "../demos/document-library/script.ts";
import { durableRunsScript } from "../demos/durable-runs/script.ts";
import { orchestrationScript } from "../demos/orchestration/script.ts";
import { repoMechanicScript } from "../demos/repo-mechanic/script.ts";
import { lastResult, outputOf, type Script } from "../lib/scripted-model.ts";
import {
  eventsOf,
  resultOf,
  runDemo,
  startShowcase,
  testEnvironment,
  type Message,
} from "./helpers.ts";
import { checkLiveModel } from "../lib/live-check.ts";
import { liveModel, type LiveModelLog } from "./live-model.ts";

const environment = await testEnvironment();
const skip =
  environment.sandbox.kind === "none" ? "no sandbox available" : false;

const scripts: Record<string, Script> = {
  "repo-mechanic": repoMechanicScript,
  "document-library": documentLibraryScript,
  "durable-runs": durableRunsScript,
  orchestration: orchestrationScript,
};

/**
 * A showcase whose Live mode is answered by the AI SDK mock. `overrides`
 * replaces a demo's script, e.g. to try a different (mis)behaved model.
 */
const startLive = async (
  context: test.TestContext,
  overrides: Record<string, Script> = {},
) => {
  const log: LiveModelLog = { calls: [] };
  const started = await startShowcase(context, {
    liveModel: (demoId) => {
      const script = overrides[demoId] ?? scripts[demoId];
      if (!script) throw new Error(`No live script for ${demoId}`);
      return liveModel(script, log);
    },
  });
  return { ...started, log };
};

const live = (
  baseURL: string,
  demo: string,
  options: Record<string, unknown> = {},
) => runDemo(baseURL, demo, { mode: "live", options });

const toolNames = (messages: Message[]) =>
  messages
    .filter((message) => message.kind === "tool-io")
    .map((message) => message.name as string);

test(
  "Repo Mechanic fixes the bug through the AI SDK adapter",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory, log } = await startLive(context);
    const messages = await live(baseURL, "repo-mechanic");
    const result = resultOf(messages);
    assert.equal(result.state.diagnosis.status, "bug");
    assert.deepEqual(JSON.parse(result.state.verification), {
      testsRun: 4,
      failed: [],
      passed: true,
    });
    assert.match(result.output, /4 tests run, 0 failed/u);
    assert.ok(toolNames(messages).includes("repo__write_file"));
    const source = await readFile(
      path.join(
        dataDirectory,
        "repo-mechanic",
        "invoice-service",
        "src",
        "invoice.py",
      ),
      "utf8",
    );
    assert.match(source, /discounted = subtotal \* \(1 - discount_rate\)/u);
    // The investigate step offered tools and an output schema together: the
    // model called tools in structured turns, then answered with JSON.
    const structured = log.calls.filter(
      (call) => call.structured && call.tools.length > 0,
    );
    assert.ok(structured.some((call) => call.toolCall));
    assert.ok(structured.some((call) => !call.toolCall));
  },
);

test(
  "Document Library answers text and image questions through the AI SDK adapter",
  { skip },
  async (context) => {
    const { baseURL, log } = await startLive(context);
    const leave = resultOf(
      await live(baseURL, "document-library", {
        question: "How many days of annual leave do I get?",
      }),
    );
    assert.match(leave.output, /25 days/u);
    assert.deepEqual(leave.state.research.sources, ["policies/leave.md"]);

    // The diagram reaches the provider as a file part in the tool result.
    const expenses = resultOf(
      await live(baseURL, "document-library", {
        question: "How does expense approval work?",
      }),
    );
    assert.deepEqual(expenses.state.research.sources, [
      "policies/expenses/approval-flow.md",
      "policies/expenses/approval-flow.png",
    ]);
    const [image] = log.calls.flatMap((call) => call.files);
    assert.equal(image?.mediaType, "image/png");
    assert.ok(image.bytes > 1000, `received ${image.bytes} bytes`);
  },
);

test(
  "Durable Runs pauses and resumes a Live run",
  { skip },
  async (context) => {
    const { baseURL } = await startLive(context);
    const first = await live(baseURL, "durable-runs");
    assert.equal(eventsOf(first, "run.suspended")[0].data.reason, "approval");
    const runId = first.find((message) => message.kind === "accepted")!
      .runId as string;
    const response = await fetch(
      `${baseURL}/api/demos/durable-runs/runs/${runId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pace: 0,
          options: { decision: "approve", reviewer: "Dana" },
        }),
      },
    );
    const second = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Message);
    const result = resultOf(second);
    assert.match(result.output, /\*\*Status:\*\* Approved by Dana/u);
  },
);

test(
  "Durable Runs still publishes when the model nests the draft in a subfolder",
  { skip },
  async (context) => {
    // A live model can invent its own layout for a file it writes from
    // scratch, and sometimes nests it under a folder named after the
    // workspace even though the path is already relative to that workspace.
    // The publish step must find it anyway: it lists before it reads.
    const misnamed: Script = (request) => {
      if (request.prompt.includes("Prepare the draft")) {
        switch (request.turn) {
          case 0:
            return { call: { name: "data__list_files", input: {} } };
          case 1:
            return {
              call: { name: "data__read_file", input: { path: "q3.csv" } },
            };
          case 2:
            return {
              call: { name: "data__read_file", input: { path: "q2.csv" } },
            };
          case 3:
            // The mistake: nested under "reports/" instead of the root.
            return {
              call: {
                name: "reports__write_file",
                input: {
                  path: "reports/Q3-draft.md",
                  content:
                    "# Q3 report\n\n**Status:** Draft, awaiting approval\n",
                },
              },
            };
          default:
            return { output: "Drafted the Q3 report." };
        }
      }
      switch (request.turn) {
        case 0:
          return { call: { name: "reports__list_files", input: {} } };
        case 1: {
          const files =
            outputOf<{ files: Array<{ path: string }> }>(lastResult(request))
              ?.files ?? [];
          const draft = files.find((file) => file.path.endsWith("Q3-draft.md"));
          assert.ok(draft, "the listing includes the misplaced draft");
          return {
            call: { name: "reports__read_file", input: { path: draft!.path } },
          };
        }
        case 2: {
          const content =
            outputOf<{ content: string }>(lastResult(request))?.content ?? "";
          return {
            call: {
              name: "reports__write_file",
              input: {
                path: "Q3-report.md",
                content: content.replace(
                  "Draft, awaiting approval",
                  "Approved by Dana",
                ),
              },
            },
          };
        }
        default: {
          const draftContent =
            outputOf<{ content: string }>(request.results[1])?.content ?? "";
          return {
            output: draftContent.replace(
              "Draft, awaiting approval",
              "Approved by Dana",
            ),
          };
        }
      }
    };
    const { baseURL } = await startLive(context, { "durable-runs": misnamed });
    const first = await live(baseURL, "durable-runs");
    const runId = first.find((message) => message.kind === "accepted")!
      .runId as string;
    const response = await fetch(
      `${baseURL}/api/demos/durable-runs/runs/${runId}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pace: 0,
          options: { decision: "approve", reviewer: "Dana" },
        }),
      },
    );
    const second = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Message);
    const result = resultOf(second);
    assert.match(result.output, /Approved by Dana/u);
  },
);

test("Orchestration runs every step shape through the AI SDK adapter", async (context) => {
  const { baseURL, log } = await startLive(context);
  const messages = await live(baseURL, "orchestration", {
    engine: "local",
    regulatedMarket: true,
  });
  const result = resultOf(messages);
  assert.equal(result.state.pitches.length, 3);
  assert.match(result.output, /Risk mitigation/u);
  assert.ok(log.calls.some((call) => call.structured));
});

test("the doctor's live check passes through the AI SDK adapter", async () => {
  const script: Script = (request) =>
    request.structured
      ? { output: { code: /AR-\S+/u.exec(request.prompt)?.[0] ?? "" } }
      : request.turn === 0
        ? { call: { name: "lookup_code", input: {} } }
        : {
            output: String(
              (request.results[0]?.output as { code?: string })?.code,
            ),
          };
  const check = await checkLiveModel({
    provider: "openai",
    model: "test",
    modelAdapter: liveModel(script),
  });
  assert.equal(check.error, undefined);
  assert.deepEqual(
    check.lines.map((line) => line.ok),
    [true, true],
  );

  // A model that never calls the tool is reported, not hidden.
  const lazy = await checkLiveModel({
    provider: "openai",
    model: "test",
    modelAdapter: liveModel((request) => ({
      output: request.structured ? { code: "none" } : "AR-0600-OK",
    })),
  });
  assert.equal(lazy.ok, false);
  assert.match(lazy.lines[0]!.text, /without calling the tool/u);
});
