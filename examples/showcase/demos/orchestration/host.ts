/**
 * Orchestration — one manifest, two execution engines.
 *
 *   agent.yaml   parallel research, a condition, a collection loop, a goal loop
 *   runtime.ts   builds the AgentRuntime (used in this process and the worker)
 *   worker.ts    a separate process that runs invocations it receives over HTTP
 *   this file    picks an ExecutionEngine and follows its events
 *
 * The browser code is identical for both engines: ExecutionClient.follow()
 * yields the same events whether the agent runs here or in the worker.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExecutionClient,
  InMemoryRemoteExecutionControlPlane,
  InProcessExecutionEngine,
  parseWorkerMessage,
  RemoteExecutionEngine,
  type ExecutionEngine,
  type ExecutionHandle,
  type RemoteComputeLauncher,
} from "@clearideas/agent-runtime";

import type { DemoContext, ShowcaseDemo } from "../../lib/demo.ts";
import { summarizeResult, toJson } from "../../lib/host-kit.ts";
import { createLaunchRuntime, manifest } from "./runtime.ts";

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));

// ─── 1. In this process ──────────────────────────────────────────────────────
// InProcessExecutionEngine calls a handler for each submitted request and
// keeps the events, status, and result for ExecutionClient.
const localEngine = (
  context: DemoContext,
  pace: number,
  mode: "scripted" | "live",
) =>
  new InProcessExecutionEngine((request, execution) =>
    createLaunchRuntime({
      mode,
      pace,
      storeDirectory: path.join(context.dataDirectory, "runs"),
      onEvent: (event) => execution.emit(event),
      ...(context.liveModel ? { liveModel: context.liveModel() } : {}),
    }).run({
      manifest: request.manifest,
      runId: execution.handle.runId,
      ...("variables" in request && request.variables
        ? { variables: request.variables }
        : {}),
      ...(request.execution ? { execution: request.execution } : {}),
      signal: execution.signal,
    }),
  );

// ─── 2. In a remote worker ───────────────────────────────────────────────────
// RemoteExecutionEngine = a launcher (starts work somewhere else) + a control
// plane (records the events and result the worker reports back).

const workerToken = randomBytes(32).toString("hex");
const callbackSecret = randomBytes(32).toString("hex");
const callbackToken = (executionId: string) =>
  createHmac("sha256", callbackSecret).update(executionId).digest("hex");

const controlPlane = new InMemoryRemoteExecutionControlPlane();
const handles = new Map<string, ExecutionHandle>();
let worker: { process: ChildProcess; url: string } | undefined;

/** Start the worker process once, and learn its address from stdout. */
const startWorker = async (context: DemoContext) => {
  if (worker && worker.process.exitCode === null) return worker;
  const child = spawn(
    process.execPath,
    [path.join(demoDirectory, "worker.ts")],
    {
      env: {
        ...process.env,
        SHOWCASE_WORKER_TOKEN: workerToken,
        SHOWCASE_WORKER_DATA: path.join(context.dataDirectory, "worker"),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const url = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const match = /worker listening (\S+)/u.exec(line);
      if (match) resolve(match[1]!);
    });
    child.once("exit", (code) =>
      reject(new Error(`Worker exited with ${code}.`)),
    );
  });
  worker = { process: child, url };
  return worker;
};

const launcher = (
  context: DemoContext,
  pace: number,
  mode: string,
): RemoteComputeLauncher => ({
  name: "http-worker",
  async launch(invocation, { handle }) {
    const { url } = await startWorker(context);
    handles.set(handle.id, handle);
    const response = await fetch(`${url}/executions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        executionId: handle.id,
        invocation: {
          ...invocation,
          request: { ...invocation.request, runId: handle.runId },
        },
        callbackUrl: `${context.serverUrl()}/internal/worker-callbacks/${handle.id}`,
        callbackToken: callbackToken(handle.id),
        mode,
        pace,
      }),
    });
    if (!response.ok)
      throw new Error(`Worker returned HTTP ${response.status}.`);
    const { pid } = (await response.json()) as { pid: number };
    return { worker: url, pid };
  },
  async cancel(handle) {
    if (!worker) return;
    await fetch(`${worker.url}/executions/${handle.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${workerToken}` },
    }).catch(() => undefined);
  },
});

const remoteEngine = (context: DemoContext, pace: number, mode: string) =>
  new RemoteExecutionEngine(launcher(context, pace, mode), controlPlane);

export const orchestration: ShowcaseDemo = {
  id: "orchestration",
  title: "Orchestration",
  summary: "Steps run in parallel, branch, and loop, locally or in a worker.",
  tagline:
    "A launch-plan agent fans research out in parallel, branches on risk, loops over channels, and refines a headline until it is approved, in this process or in a separate worker process.",
  features: ["Parallel graph", "Conditions", "Loops", "Remote workers"],
  sources: [
    {
      path: "demos/orchestration/agent.yaml",
      language: "yaml",
      caption:
        "The agent: the graph comes from which variables each step reads and writes.",
    },
    {
      path: "demos/orchestration/host.ts",
      language: "typescript",
      caption:
        "The integration: two execution engines behind one ExecutionClient.",
    },
    {
      path: "demos/orchestration/worker.ts",
      language: "typescript",
      caption:
        "The remote worker: receives an invocation, runs it, reports events back.",
    },
    {
      path: "demos/orchestration/runtime.ts",
      language: "typescript",
      caption:
        "The runtime both engines build: prompt and loop executors, conditions.",
    },
    {
      path: "demos/orchestration/script.ts",
      language: "typescript",
      caption: "Scripted mode only: the model's answers.",
    },
  ],

  async describe() {
    return toJson({ manifest, needsSandbox: false });
  },

  // ─── 3. Worker callbacks: the worker reports to the control plane ─────────
  async route(_context, request, response, url) {
    const match = /^\/internal\/worker-callbacks\/([A-Za-z0-9_-]+)$/u.exec(
      url.pathname,
    );
    if (!match || request.method !== "POST") return false;
    const executionId = match[1]!;
    const supplied = Buffer.from(
      (request.headers.authorization ?? "").replace(/^Bearer /u, ""),
    );
    const expected = Buffer.from(callbackToken(executionId));
    const handle = handles.get(executionId);
    if (
      !handle ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(401).end();
      return true;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>)
      chunks.push(chunk);
    const message = parseWorkerMessage(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (message.type === "event")
      await controlPlane.acceptEvent(handle, message.event);
    if (message.type === "result")
      await controlPlane.complete(handle, message.result);
    if (message.type === "error")
      await controlPlane.fail(handle, message.error);
    response.writeHead(204).end();
    return true;
  },

  async close() {
    worker?.process.kill("SIGTERM");
    worker = undefined;
  },

  async run(context, request, emit, signal) {
    const remote = request.options.engine === "remote";
    const engine: ExecutionEngine = remote
      ? remoteEngine(context, request.pace, request.mode)
      : localEngine(context, request.pace, request.mode);
    const client = new ExecutionClient(engine);

    // ─── 4. Submit and follow: identical for both engines ───────────────────
    const handle = await client.submit({
      manifest,
      runId: `launch-${randomUUID()}`,
      variables: [
        {
          key: "regulatedMarket",
          value: request.options.regulatedMarket !== false,
        },
      ],
      execution:
        request.options.scheduling === "sequential"
          ? { mode: "sequential" }
          : { mode: "parallel", maxConcurrency: 4 },
    });
    const status = await engine.status(handle);
    emit({
      kind: "accepted",
      runId: handle.runId,
      mode: request.mode,
      sandbox: context.environment.sandbox.kind,
    });
    emit({
      kind: "engine",
      engine: engine.name,
      ...(status.handle.providerData
        ? { providerData: toJson(status.handle.providerData) }
        : {}),
    });
    const onAbort = () => void client.cancel(handle).catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const followed = await client.follow(handle, {
        signal,
        onEvent: (event) => emit({ kind: "event", event }),
      });
      if (!followed.result)
        throw new Error(
          followed.status.error?.message ??
            `Execution ${followed.status.status}.`,
        );
      emit({ kind: "result", result: summarizeResult(followed.result) });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  },
};
