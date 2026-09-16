import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type ModelResult,
  type PromptMessage,
} from "@clearideas/agent-runtime";

import { createAgentRunnerApp, type AgentRunnerApp } from "./server.ts";

const promptText = (messages: PromptMessage[]): string =>
  messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

class TestModelAdapter implements ModelAdapter {
  async generate(request: ModelRequest): Promise<ModelResult> {
    let result: ModelResult | undefined;
    for await (const event of this.stream(request)) {
      if (event.type === "completed") result = event.result;
    }
    if (!result) throw new Error("Test model did not complete.");
    return result;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const prompt = promptText(request.messages);
    const text = prompt.includes("three-point outline")
      ? "1. Save progress. 2. Resume safely. 3. Observe every step."
      : "Durable checkpoints preserve completed work, make interrupted runs resumable, and give application developers a reliable execution history.";
    for (const delta of text.match(/\S+\s*/gu) ?? [text]) {
      if (request.signal?.aborted) throw request.signal.reason;
      yield { type: "text-delta", delta };
    }
    yield {
      type: "completed",
      result: {
        output: text,
        finishReason: "stop",
        transcript: [
          {
            id: crypto.randomUUID(),
            type: "message",
            role: "assistant",
            content: [{ type: "text", text }],
            createdAt: new Date().toISOString(),
            usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
          },
        ],
      },
    };
  }
}

class FailOnceModelAdapter extends TestModelAdapter {
  prompts: string[] = [];
  failed = false;

  override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const prompt = promptText(request.messages);
    this.prompts.push(prompt);
    if (!this.failed && !prompt.includes("three-point outline")) {
      this.failed = true;
      throw new Error("Temporary model failure.");
    }
    yield* super.stream(request);
  }
}

interface RunningApp {
  app: AgentRunnerApp;
  baseURL: string;
}

const listen = async (
  dataDirectory: string,
  modelAdapter: ModelAdapter = new TestModelAdapter(),
): Promise<RunningApp> => {
  const app = await createAgentRunnerApp({
    port: 0,
    dataDirectory,
    modelAdapter,
  });
  const address = await app.listen();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not return a TCP address.");
  }
  return { app, baseURL: `http://127.0.0.1:${address.port}` };
};

const itemAt = <T>(items: T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing item at index ${index}.`);
  return item;
};

interface NdjsonMessage {
  kind: string;
  runId?: string;
  event?: { type: string; stepId?: string };
  result?: {
    output: unknown;
    stepResults: Array<{ stepId: string }>;
  };
}

const readNdjson = async (response: Response): Promise<NdjsonMessage[]> =>
  (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NdjsonMessage);

test("serves the app and seeds a manifest", async (testContext: TestContext) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "agent-runner-"));
  const { app, baseURL } = await listen(dataDirectory);
  testContext.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const [pageResponse, aceResponse, manifestsResponse] = await Promise.all([
    fetch(baseURL),
    fetch(`${baseURL}/vendor/ace.js`),
    fetch(`${baseURL}/api/manifests`),
  ]);
  const page = await pageResponse.text();
  const manifests = (await manifestsResponse.json()) as Array<{
    id: string;
    manifest: { name?: string; variables?: unknown[] };
  }>;

  assert.equal(pageResponse.status, 200);
  assert.match(page, /id="new-manifest-button"/u);
  assert.match(page, /id="run-form"/u);
  assert.match(page, /id="manifest-source"/u);
  assert.equal(aceResponse.status, 200);
  assert.equal(manifests.length, 1);
  const manifest = itemAt(manifests, 0);
  assert.equal(manifest.id, "manifest-hello");
  assert.equal(manifest.manifest.name, "Hello brief");
  assert.equal(manifest.manifest.variables?.length, 3);
});

test("validates and saves an added manifest", async (testContext: TestContext) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "agent-runner-"));
  const { app, baseURL } = await listen(dataDirectory);
  testContext.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const invalid = await fetch(`${baseURL}/api/manifests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "name: missing schema" }),
  });
  assert.equal(invalid.status, 400);
  assert.match(
    ((await invalid.json()) as { error: string }).error,
    /schemaVersion/u,
  );

  const source = `schemaVersion: "1.0"
id: one-step
name: One step
model:
  ref: default
steps:
  - id: answer
    type: prompt
    prompt: Say hello.
    includeInFinalOutput: true
`;
  const added = await fetch(`${baseURL}/api/manifests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  const saved = (await added.json()) as {
    id: string;
    manifest: { id?: string };
  };
  assert.equal(added.status, 201);
  assert.match(saved.id, /^manifest-/u);
  assert.equal(saved.manifest.id, "one-step");

  const manifests = (await fetch(`${baseURL}/api/manifests`).then((response) =>
    response.json(),
  )) as Array<{ source: string }>;
  assert.equal(manifests.length, 2);
  assert.ok(manifests.some((manifest) => manifest.source === source));
});

test("runs a saved manifest, streams events, and persists output", async (testContext: TestContext) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "agent-runner-"));
  let running = await listen(dataDirectory);
  testContext.after(async () => {
    await running.app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const response = await fetch(`${running.baseURL}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      manifestId: "manifest-hello",
      variables: [
        { key: "topic", value: "durable checkpoints" },
        { key: "audience", value: "application developers" },
        { key: "concise", value: true },
      ],
    }),
  });
  const messages = await readNdjson(response);

  assert.equal(response.status, 200);
  const accepted = itemAt(messages, 0);
  assert.equal(accepted.kind, "accepted");
  assert.match(accepted.runId ?? "", /^run-/u);
  const eventTypes = messages
    .filter((message) => message.kind === "event")
    .map((message) => message.event?.type);
  assert.ok(eventTypes.includes("run.started"));
  assert.ok(eventTypes.includes("step.started"));
  assert.ok(eventTypes.includes("step.skipped"));
  assert.ok(eventTypes.includes("model.text.delta"));
  assert.ok(eventTypes.includes("checkpoint.saved"));
  assert.ok(eventTypes.includes("run.completed"));
  const result = messages.find((message) => message.kind === "result")?.result;
  assert.ok(result);
  if (typeof result.output !== "string") {
    throw new Error("Expected the test model to return text output.");
  }
  assert.match(result.output, /Durable checkpoints preserve completed work/u);
  assert.deepEqual(
    result.stepResults.map((step: { stepId: string }) => step.stepId),
    ["outline", "write-concise"],
  );

  const runs = (await fetch(`${running.baseURL}/api/runs`).then((runResponse) =>
    runResponse.json(),
  )) as Array<{
    status: string;
    agentName: string;
    updatedAt: string;
    output: unknown;
    stepResults: Array<{ stepId: string; output?: unknown }>;
  }>;
  assert.equal(runs.length, 1);
  const completedRun = itemAt(runs, 0);
  assert.equal(completedRun.status, "completed");
  assert.equal(completedRun.agentName, "Hello brief");
  assert.ok(Number.isFinite(Date.parse(completedRun.updatedAt)));
  assert.equal(completedRun.output, result.output);
  assert.deepEqual(
    completedRun.stepResults.map((step) => step.stepId),
    ["outline", "write-concise"],
  );

  await running.app.close();
  running = await listen(dataDirectory);
  const [reloadedManifests, reloadedRuns] = (await Promise.all([
    fetch(`${running.baseURL}/api/manifests`).then((item) => item.json()),
    fetch(`${running.baseURL}/api/runs`).then((item) => item.json()),
  ])) as [unknown[], Array<{ output: unknown }>];
  assert.equal(reloadedManifests.length, 1);
  assert.equal(reloadedRuns.length, 1);
  assert.equal(itemAt(reloadedRuns, 0).output, result.output);
});

test("resumes a failed run from its last step checkpoint", async (testContext: TestContext) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "agent-runner-"));
  const modelAdapter = new FailOnceModelAdapter();
  const { app, baseURL } = await listen(dataDirectory, modelAdapter);
  testContext.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const failedMessages = await fetch(`${baseURL}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      manifestId: "manifest-hello",
      variables: [
        { key: "topic", value: "durable checkpoints" },
        { key: "audience", value: "application developers" },
        { key: "concise", value: true },
      ],
    }),
  }).then(readNdjson);
  const runId = itemAt(failedMessages, 0).runId;
  assert.ok(runId);
  assert.equal(failedMessages.at(-1)?.kind, "error");

  const resumedMessages = await fetch(`${baseURL}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  }).then(readNdjson);
  const resumedEvents = resumedMessages
    .filter((message) => message.kind === "event")
    .map((message) => message.event);

  assert.ok(resumedEvents.some((event) => event?.type === "run.resumed"));
  assert.equal(
    resumedEvents.some(
      (event) => event?.type === "step.started" && event.stepId === "outline",
    ),
    false,
  );
  assert.equal(
    modelAdapter.prompts.filter((prompt) =>
      prompt.includes("three-point outline"),
    ).length,
    1,
  );
  assert.equal(resumedMessages.at(-1)?.kind, "result");
});
