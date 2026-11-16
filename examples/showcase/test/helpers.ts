import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { detectEnvironment } from "../lib/environment.ts";
import {
  createShowcaseApp as createTypeScriptShowcase,
  type ShowcaseOptions,
} from "../server.ts";
import { startLiveProvider } from "./python-live-provider.ts";

// Several tests fail tool calls on purpose; keep their console reports quiet.
process.env.SHOWCASE_QUIET ??= "1";

/**
 * Which showcase server the HTTP tests start: `typescript` (server.ts, the
 * default) or `python` (server.py on the Python Agent Runtime). The tests are
 * the same for both; set SHOWCASE_RUNTIME=python to run them against Python.
 */
export const runtime: "typescript" | "python" =
  process.env.SHOWCASE_RUNTIME === "python" ? "python" : "typescript";

/** A demo's host source file for the selected runtime. */
export const hostSource = (demo: string) =>
  `demos/${demo}/host.${runtime === "python" ? "py" : "ts"}`;

/** The environment the showcase will use, honouring SHOWCASE_SANDBOX. */
export const testEnvironment = () =>
  detectEnvironment({
    host: "127.0.0.1",
    ...(process.env.SHOWCASE_SANDBOX
      ? { preference: process.env.SHOWCASE_SANDBOX }
      : {}),
  });

/** Server options, plus which runtime serves them (default: SHOWCASE_RUNTIME). */
export interface TestShowcaseOptions extends ShowcaseOptions {
  runtime?: "typescript" | "python";
  /** Python only: extra environment variables for server.py. */
  environment?: Record<string, string>;
}

export interface ShowcaseHandle {
  environment: { sandbox: { kind: string } };
  dataDirectory: string;
  listen(): Promise<Pick<AddressInfo, "port">>;
  close(): Promise<void>;
}

const showcaseDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repository = path.resolve(showcaseDirectory, "..", "..");

/** The Python interpreter of the repository's python/ project (`make test` installs it). */
const pythonExecutable = path.join(
  repository,
  "python",
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);

/** Whether the repository's Python runtime is installed. */
export const pythonAvailable = () => existsSync(pythonExecutable);

/** How to start Python: the project's interpreter, or `uv run` to create it. */
const pythonCommand = (): [string, string[]] =>
  pythonAvailable()
    ? [pythonExecutable, []]
    : [
        "uv",
        [
          "run",
          "--project",
          path.join(repository, "python"),
          "--all-extras",
          "python",
        ],
      ];

/**
 * Start server.py with the options a test gave, as environment variables.
 * Resolves once it listens; rejects with its error output if it exits first.
 */
const createPythonShowcase = async (
  options: TestShowcaseOptions,
): Promise<ShowcaseHandle> => {
  const dataDirectory =
    options.dataDirectory ?? path.join(showcaseDirectory, ".data-python");
  const environment: Record<string, string | undefined> = {
    ...process.env,
    SHOWCASE_HOST: options.host ?? "127.0.0.1",
    SHOWCASE_PORT: String(options.port ?? 0),
    SHOWCASE_DATA: dataDirectory,
    PYTHONUNBUFFERED: "1",
    ...options.environment,
  };
  // The parent decides which failure reports to show (see below).
  delete environment.SHOWCASE_QUIET;
  if (options.sandbox) environment.SHOWCASE_SANDBOX = options.sandbox;
  if (options.publicOrigin)
    environment.SHOWCASE_PUBLIC_ORIGIN = options.publicOrigin;
  if (options.frameAncestors)
    environment.SHOWCASE_FRAME_ANCESTORS = options.frameAncestors.join(",");
  if (options.sessions !== undefined)
    environment.SHOWCASE_SESSIONS = options.sessions ? "1" : "0";
  if (options.requireIsolation !== undefined)
    environment.SHOWCASE_REQUIRE_ISOLATION = options.requireIsolation
      ? "1"
      : "0";
  if (options.maxActiveRuns !== undefined)
    environment.SHOWCASE_MAX_ACTIVE_RUNS = String(options.maxActiveRuns);
  if (options.analytics !== undefined) {
    delete environment.SHOWCASE_ANALYTICS_API_BASE_URL;
    delete environment.SHOWCASE_ANALYTICS_SITE_KEY;
    if (options.analytics) {
      environment.SHOWCASE_ANALYTICS_API_BASE_URL =
        options.analytics.apiBaseUrl;
      environment.SHOWCASE_ANALYTICS_SITE_KEY = options.analytics.siteKey;
    }
  }
  const provider = options.liveModel
    ? await startLiveProvider(options.liveModel)
    : undefined;
  if (provider) environment.SHOWCASE_TEST_LIVE_URL = provider.url;

  const [command, prefix] = pythonCommand();
  const child = spawn(command, [...prefix, "server.py"], {
    cwd: showcaseDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startup: string[] = [];
  let started = false;
  // Failure reports go to console.error, like server.ts, unless a test
  // asked for quiet; anything else (such as a traceback) is always shown.
  createInterface({ input: child.stderr! }).on("line", (line) => {
    if (!started) startup.push(line);
    else if (!line.startsWith("[showcase]")) process.stderr.write(`${line}\n`);
    else if (!process.env.SHOWCASE_QUIET) console.error(line);
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      createInterface({ input: child.stdout! }).on("line", (line) => {
        const match =
          /^Agent Runtime showcase \(Python\): http:\/\/\S+:(\d+)$/u.exec(line);
        if (match) resolve(Number(match[1]));
      });
      child.once("exit", (code) =>
        reject(
          new Error(
            startup.join("\n").trim() ||
              `The Python showcase exited with ${code}.`,
          ),
        ),
      );
    });
  } catch (error) {
    await provider?.close();
    throw error;
  }
  started = true;
  if (startup.length) process.stderr.write(`${startup.join("\n")}\n`);
  const described = (await (
    await fetch(`http://127.0.0.1:${port}/api/environment`)
  ).json()) as ShowcaseHandle["environment"];
  return {
    environment: described,
    dataDirectory,
    listen: async () => ({ port }),
    close: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        await exited;
        clearTimeout(timer);
      }
      await provider?.close();
    },
  };
};

/**
 * Create the showcase server for the selected runtime. Call `listen()` to
 * serve (the Python server is already listening) and `close()` to stop it.
 */
export const createShowcaseApp = async ({
  runtime: selected = runtime,
  environment: _environment,
  ...options
}: TestShowcaseOptions = {}): Promise<ShowcaseHandle> =>
  selected === "python"
    ? createPythonShowcase({
        ...options,
        ...(_environment ? { environment: _environment } : {}),
      })
    : createTypeScriptShowcase(options);

export interface Started {
  baseURL: string;
  dataDirectory: string;
  sandbox: string;
}

/** Start the showcase on an ephemeral port with a private data directory. */
export const startShowcase = async (
  context: TestContext,
  options: TestShowcaseOptions = {},
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
