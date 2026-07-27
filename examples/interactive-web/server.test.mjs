import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRemoteExecution } from "./remote-execution.mjs";
import { createExampleApp } from "./server.mjs";
import { TestModelAdapter, TestToolAdapter } from "./test-fixtures.mjs";

const startApp = async (testContext, overrides = {}) => {
  const { manualClose = false, ...appOverrides } = overrides;
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "agent-runtime-interactive-example-"),
  );
  const app = await createExampleApp({
    host: "127.0.0.1",
    port: 0,
    modelAdapter: new TestModelAdapter(),
    toolAdapter: new TestToolAdapter(),
    dataDirectory,
    ...appOverrides,
  });
  const address = await app.listen();
  assert.equal(typeof address, "object");
  const baseURL = `http://127.0.0.1:${address.port}`;
  if (!manualClose) {
    testContext.after(async () => {
      await app.close();
      await rm(dataDirectory, { recursive: true, force: true });
    });
  }
  return { app, baseURL, dataDirectory };
};

const postRun = async (baseURL, overrides = {}) => {
  const response = await fetch(`${baseURL}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: "Portable local agents",
      audience: "software teams",
      libraryId: "/modelcontextprotocol/typescript-sdk",
      documentationQuestion:
        "How should a TypeScript client connect to a remote MCP server with Streamable HTTP?",
      tone: "practical",
      maxWords: 220,
      includeRisks: true,
      ...overrides,
    }),
  });
  const messages = (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { response, messages };
};

test("rejects missing, weak, or shared remote credentials", () => {
  const base = {
    baseUrl: () => "http://127.0.0.1:4178",
    dataDirectory: ".data",
    runtime: {},
  };
  assert.throws(
    () =>
      createRemoteExecution({ ...base, workerToken: "", callbackToken: "" }),
    /distinct and at least 32 characters/,
  );
  const shared = "a".repeat(32);
  assert.throws(
    () =>
      createRemoteExecution({
        ...base,
        workerToken: shared,
        callbackToken: shared,
      }),
    /distinct and at least 32 characters/,
  );
});

test("serves the agent contracts without exposing credentials", async (testContext) => {
  const { baseURL } = await startApp(testContext);
  const [config, agent, page] = await Promise.all([
    fetch(`${baseURL}/api/config`).then((response) => response.json()),
    fetch(`${baseURL}/api/agent`).then((response) => response.json()),
    fetch(baseURL).then((response) => response.text()),
  ]);

  assert.deepEqual(config, {
    execution: ["local", "remote"],
    streaming: "ndjson",
    provider: "openai",
    model: "gpt-5.6-luna",
    mcp: "Context7",
    telemetry: "OpenTelemetry / none",
  });
  assert.equal(agent.id, "interactive-brief");
  assert.equal(
    agent.variables.find((variable) => variable.key === "topic")
      .requiresOverride,
    true,
  );
  assert.equal(agent.connections[0].ref, "context7");
  assert.deepEqual(agent.steps[0].tools, ["context7__query-docs"]);
  assert.equal(agent.steps.at(-1).outputVariable, "finalBrief");
  assert.match(page, /id="step-output-list"/);
  assert.match(page, /id="final-output-section"[\s\S]*?hidden/);
  assert.ok(
    page.indexOf('id="step-output-list"') <
      page.indexOf('id="final-output-section"'),
  );
  assert.match(page, /style · object/);
  assert.match(page, /maxWords · number property/);
  assert.match(page, /name="execution" value="local"/);
  assert.match(page, /name="execution" value="remote"/);
  assert.match(page, /name="scheduling" value="sequential"/);
  assert.match(page, /name="scheduling" value="parallel"/);
  assert.match(page, /id="telemetry-value"/);
  assert.equal(JSON.stringify(config).includes("KEY"), false);
});

test("serves local Markdown, sanitizer, and syntax-highlighting assets", async (testContext) => {
  const { baseURL } = await startApp(testContext);
  const paths = [
    "/vendor/marked.js",
    "/vendor/purify.js",
    "/vendor/highlight.js",
    "/vendor/highlight.css",
  ];
  const assets = await Promise.all(
    paths.map(async (asset) => {
      const response = await fetch(`${baseURL}${asset}`);
      return { response, content: await response.text() };
    }),
  );

  assert.equal(
    assets.every(({ response }) => response.status === 200),
    true,
  );
  assert.match(assets[0].response.headers.get("content-type"), /javascript/);
  assert.match(assets[3].response.headers.get("content-type"), /text\/css/);
  assert.match(assets[0].content, /marked/);
  assert.match(assets[1].content, /DOMPurify/);
  assert.match(assets[2].content, /hljs/);
  assert.match(assets[3].content, /pre code/);
});

test("protects remote worker and callback endpoints", async (testContext) => {
  const { baseURL } = await startApp(testContext);
  const [worker, callback] = await Promise.all([
    fetch(`${baseURL}/internal/executions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    fetch(`${baseURL}/internal/callbacks/unknown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  ]);

  assert.equal(worker.status, 401);
  assert.equal(callback.status, 401);
});

test("executes locally and streams tools, checkpoints, tokens, and a result", async (testContext) => {
  const { baseURL } = await startApp(testContext);
  const { response, messages } = await postRun(baseURL);

  assert.equal(response.status, 200);
  const accepted = messages.find((message) => message.kind === "accepted");
  assert.equal(
    accepted.agentRunManifest.agent.ref,
    "interactive-brief.agent.yaml",
  );
  assert.equal(accepted.execution, "local");
  assert.deepEqual(accepted.agentRunManifest.execution, {
    mode: "parallel",
    maxConcurrency: 4,
  });
  assert.deepEqual(
    accepted.agentRunManifest.variables.map((variable) => variable.key),
    [
      "topic",
      "audience",
      "libraryId",
      "documentationQuestion",
      "includeRisks",
      "style",
    ],
  );

  const eventTypes = messages
    .filter((message) => message.kind === "event")
    .map((message) => message.event.type);
  assert.ok(eventTypes.includes("run.started"));
  assert.ok(eventTypes.includes("model.tool.completed"));
  assert.ok(eventTypes.includes("checkpoint.saved"));
  assert.ok(eventTypes.includes("model.text.delta"));
  assert.ok(eventTypes.includes("run.completed"));
  const runCompletedIndex = messages.findIndex(
    (message) =>
      message.kind === "event" && message.event.type === "run.completed",
  );
  const resultMessageIndex = messages.findIndex(
    (message) => message.kind === "result",
  );
  assert.ok(runCompletedIndex >= 0);
  assert.ok(resultMessageIndex > runCompletedIndex);
  const toolStarted = messages.find(
    (message) =>
      message.kind === "event" && message.event.type === "model.tool.started",
  );
  assert.equal(toolStarted.event.data.toolName, "context7__query-docs");

  const result = messages.find((message) => message.kind === "result").result;
  assert.match(result.output, /StreamableHTTPClientTransport/);
  assert.deepEqual(
    result.stepResults.map((stepResult) => stepResult.stepId),
    ["gather-context", "draft", "extract-evidence", "review-risks", "finalize"],
  );
  assert.equal(
    result.stepResults.every((stepResult) => stepResult.output != null),
    true,
  );
  assert.match(result.state.contextNotes, /StreamableHTTPClientTransport/);
  assert.equal(typeof result.usage.totalTokens, "number");
  assert.equal(result.state.finalBrief, result.output);
});

test("lets the run choose sequential or dependency-safe parallel step scheduling", async (testContext) => {
  const { baseURL } = await startApp(testContext, {
    modelAdapter: new TestModelAdapter(2),
  });
  const parallel = await postRun(baseURL, { scheduling: "parallel" });
  const parallelEvents = parallel.messages
    .filter((message) => message.kind === "event")
    .map((message) => message.event);
  const draftStarted = parallelEvents.findIndex(
    (event) => event.type === "step.started" && event.stepId === "draft",
  );
  const evidenceStarted = parallelEvents.findIndex(
    (event) =>
      event.type === "step.started" && event.stepId === "extract-evidence",
  );
  const firstFanOutCompleted = parallelEvents.findIndex(
    (event) =>
      event.type === "step.completed" &&
      (event.stepId === "draft" || event.stepId === "extract-evidence"),
  );
  assert.ok(draftStarted >= 0);
  assert.ok(evidenceStarted >= 0);
  assert.ok(evidenceStarted < firstFanOutCompleted);

  const sequential = await postRun(baseURL, { scheduling: "sequential" });
  const sequentialEvents = sequential.messages
    .filter((message) => message.kind === "event")
    .map((message) => message.event);
  const sequentialDraftCompleted = sequentialEvents.findIndex(
    (event) => event.type === "step.completed" && event.stepId === "draft",
  );
  const sequentialEvidenceStarted = sequentialEvents.findIndex(
    (event) =>
      event.type === "step.started" && event.stepId === "extract-evidence",
  );
  assert.ok(sequentialDraftCompleted < sequentialEvidenceStarted);
  assert.deepEqual(
    sequential.messages.find((message) => message.kind === "accepted")
      .agentRunManifest.execution,
    { mode: "sequential" },
  );
});

test("runs the same agent through the remote HTTP execution path", async (testContext) => {
  const { baseURL } = await startApp(testContext);
  const { response, messages } = await postRun(baseURL, {
    execution: "remote",
  });

  assert.equal(response.status, 200);
  assert.equal(
    messages.find((message) => message.kind === "accepted").execution,
    "remote",
  );
  assert.ok(
    messages.some(
      (message) =>
        message.kind === "event" &&
        message.event.type === "model.tool.completed",
    ),
  );
  assert.ok(
    messages.some(
      (message) =>
        message.kind === "event" && message.event.type === "checkpoint.saved",
    ),
  );
  const result = messages.find((message) => message.kind === "result").result;
  assert.equal(result.runId.startsWith("run-"), true);
  assert.equal(result.state.finalBrief, result.output);
});

test("sends run, step, model, and tool events to the telemetry sink", async (testContext) => {
  const telemetryEvents = [];
  let telemetryShutdown = false;
  const { baseURL, app, dataDirectory } = await startApp(testContext, {
    manualClose: true,
    telemetrySink: {
      emit(event) {
        telemetryEvents.push(event);
      },
    },
    telemetryExporter: "test",
    telemetryShutdown() {
      telemetryShutdown = true;
    },
  });
  try {
    const { messages } = await postRun(baseURL, { execution: "remote" });

    assert.ok(telemetryEvents.some((event) => event.type === "run.started"));
    assert.ok(telemetryEvents.some((event) => event.type === "step.started"));
    assert.ok(telemetryEvents.some((event) => event.type === "model.started"));
    assert.ok(
      telemetryEvents.some((event) => event.type === "model.tool.completed"),
    );
    assert.ok(telemetryEvents.some((event) => event.type === "run.completed"));
    assert.equal(
      telemetryEvents.filter((event) => event.type === "run.completed").length,
      1,
    );
    assert.equal(
      messages.some((message) => message.kind === "result"),
      true,
    );
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
  assert.equal(telemetryShutdown, true);
});

test("skips the conditional risk step when the run override is false", async (testContext) => {
  const { baseURL } = await startApp(testContext);
  const { messages } = await postRun(baseURL, { includeRisks: false });
  const skipped = messages.find(
    (message) =>
      message.kind === "event" &&
      message.event.type === "step.skipped" &&
      message.event.stepId === "review-risks",
  );

  assert.ok(skipped);
  assert.equal(
    messages.some((message) => message.kind === "result"),
    true,
  );
});
