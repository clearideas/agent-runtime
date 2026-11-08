/**
 * Long Investigation: a step reads more than twice its input limit. With a
 * reducing strategy it finishes with every request under the limit; with the
 * strategy Off it fails at the limit, as before context management existed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { longInvestigation } from "../demos/long-investigation/host.ts";
import {
  eventsOf,
  resultOf,
  runDemo,
  startShowcase,
  type Message,
  testEnvironment,
} from "./helpers.ts";

const environment = await testEnvironment();
// An older installed runtime cannot run this demo (see its `unavailable`).
const skip =
  longInvestigation.unavailable ??
  (environment.sandbox.kind === "none" ? "no sandbox available" : false);
const LIMIT = 40_000;

const investigate = (baseURL: string, strategy: string) =>
  runDemo(baseURL, "long-investigation", { options: { strategy } });

const inputs = (messages: Message[], purpose = "step") =>
  messages.filter(
    (message) => message.kind === "model-input" && message.purpose === purpose,
  );

const reads = (messages: Message[]) =>
  messages.filter(
    (message) =>
      message.kind === "tool-io" && message.name === "logs__read_file",
  );

const reductions = (messages: Message[]) =>
  eventsOf(messages, "context.reduced").map((event) => event.data);

test(
  "Prune: reads every log inside the limit and finds the root cause",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const messages = await investigate(baseURL, "prune");
    const result = resultOf(messages);

    assert.equal(reads(messages).length, 16);
    for (const input of inputs(messages))
      assert.ok(input.bytes <= LIMIT, `request of ${input.bytes} bytes`);
    // The runbook was clipped before the first request, then old rounds.
    const reduced = reductions(messages);
    assert.ok(
      reduced.some(
        (data) =>
          data.scope === "input" &&
          data.variable === "runbook" &&
          data.strategy === "prune",
      ),
    );
    assert.ok(
      reduced.some(
        (data) => data.scope === "transcript" && data.strategy === "prune",
      ),
    );
    // No summarizer calls with Prune.
    assert.equal(inputs(messages, "summarize").length, 0);
    // With reduceTo: 0.25, a few deep reductions rather than one per round.
    const transcript = reduced.filter((data) => data.scope === "transcript");
    assert.ok(
      transcript.length > 0 && transcript.length <= 6,
      `${transcript.length} transcript reductions`,
    );
    for (const data of transcript)
      assert.ok(data.bytesAfter <= LIMIT / 2, `reduced to ${data.bytesAfter}`);
    // The model saw a removal note in place of the removed rounds.
    const kinds = new Set(
      inputs(messages).flatMap((input) =>
        input.segments.map((segment: { kind: string }) => segment.kind),
      ),
    );
    assert.ok(kinds.has("note"));

    const findings = result.state.findings;
    assert.equal(findings.filesRead, 16);
    assert.match(findings.rootCause, /payments-db/u);
    assert.match(findings.trigger, /max_connections 200 -> 20/u);
    assert.ok(
      findings.ruledOut.some((entry: string) => entry.startsWith("cdn-edge")),
    );
    assert.match(result.output, /## Root cause/u);
  },
);

test(
  "Summarize: a summarizer condenses the runbook and older rounds",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const messages = await investigate(baseURL, "summarize-or-prune");
    const result = resultOf(messages);

    assert.equal(reads(messages).length, 16);
    for (const input of [...inputs(messages), ...inputs(messages, "summarize")])
      assert.ok(input.bytes <= LIMIT, `request of ${input.bytes} bytes`);
    const summarizerCalls = eventsOf(messages, "model.started").filter(
      (event) => event.data.purpose === "summarize",
    );
    assert.ok(summarizerCalls.length > 1);
    assert.equal(summarizerCalls.length, inputs(messages, "summarize").length);
    const reduced = reductions(messages);
    assert.ok(
      reduced.some(
        (data) =>
          data.scope === "input" &&
          data.variable === "runbook" &&
          data.strategy === "summarize",
      ),
    );
    const compactions = reduced.filter(
      (data) => data.scope === "transcript" && data.strategy === "summarize",
    );
    assert.ok(
      compactions.length > 0 && compactions.length <= 5,
      `${compactions.length} compactions`,
    );
    assert.ok(
      inputs(messages).some((input) =>
        input.segments.some(
          (segment: { kind: string }) => segment.kind === "summary",
        ),
      ),
    );
    assert.match(result.state.findings.rootCause, /payments-db/u);
    // The host's summarizer adapter saw every summarization. Transcript
    // summaries respect the manifest's maxSummaryBytes (4000).
    const summaries = messages.filter(
      (message) => message.kind === "summarizer",
    );
    assert.ok(summaries.some((summary) => summary.summaryKind === "input"));
    const transcripts = summaries.filter(
      (summary) => summary.summaryKind === "transcript",
    );
    assert.ok(transcripts.length > 0);
    for (const summary of transcripts) {
      assert.ok(
        summary.targetBytes <= 4_000,
        `asked for ${summary.targetBytes}`,
      );
      assert.ok(summary.outputBytes < summary.inputBytes);
    }
    // Summarizer usage is part of the run's usage.
    assert.ok(result.usage.totalTokens > 0);
  },
);

test("Off: the step fails at the input limit", { skip }, async (context) => {
  const { baseURL } = await startShowcase(context);
  const messages = await investigate(baseURL, "fail");
  const error = messages.find((message) => message.kind === "error");
  assert.match(
    error?.error.message ?? "",
    /exceeding the 40000-byte input limit/u,
  );
  assert.equal(reductions(messages).length, 0);
  assert.equal(eventsOf(messages, "run.failed").length, 1);
});
