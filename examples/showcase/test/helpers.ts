import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { detectEnvironment } from "../lib/environment.ts";
import { createShowcaseApp, type ShowcaseOptions } from "../server.ts";

// Several tests fail tool calls on purpose; keep their console reports quiet.
process.env.SHOWCASE_QUIET ??= "1";

/** The environment the showcase will use, honouring SHOWCASE_SANDBOX. */
export const testEnvironment = () =>
  detectEnvironment({
    host: "127.0.0.1",
    ...(process.env.SHOWCASE_SANDBOX
      ? { preference: process.env.SHOWCASE_SANDBOX }
      : {}),
  });

export interface Started {
  baseURL: string;
  dataDirectory: string;
  sandbox: string;
}

/** Start the showcase on an ephemeral port with a private data directory. */
export const startShowcase = async (
  context: TestContext,
  options: ShowcaseOptions = {},
): Promise<Started> => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "showcase-test-"));
  const app = await createShowcaseApp({
    host: "127.0.0.1",
    port: 0,
    dataDirectory,
    ...options,
  });
  const address = await app.listen();
  context.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    dataDirectory,
    sandbox: app.environment.sandbox.kind,
  };
};

export interface Message {
  kind: string;
  [key: string]: any;
}

/** POST a run and collect every NDJSON message. */
export const runDemo = async (
  baseURL: string,
  demo: string,
  body: Record<string, unknown> = {},
): Promise<Message[]> => {
  const response = await fetch(`${baseURL}/api/demos/${demo}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pace: 0, ...body }),
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/x-ndjson/u,
  );
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);
};

export const events = (messages: Message[]) =>
  messages
    .filter((message) => message.kind === "event")
    .map((message) => message.event);

export const eventsOf = (messages: Message[], type: string) =>
  events(messages).filter((event) => event.type === type);

export const resultOf = (messages: Message[]) => {
  const error = messages.find((message) => message.kind === "error");
  assert.equal(error, undefined, error?.error?.message);
  const result = messages.find((message) => message.kind === "result");
  assert.ok(result, "the run produced a result");
  return result.result;
};
