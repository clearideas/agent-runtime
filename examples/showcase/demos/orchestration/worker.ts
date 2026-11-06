/**
 * The remote worker: a separate process that runs agents it is sent.
 *
 * A real deployment runs this on other compute (a container, Modal, a job
 * queue). The protocol is the same: receive a versioned WorkerInvocation,
 * run it, and post every event and the final result to a callback URL.
 *
 *   POST /executions              { executionId, invocation, callbackUrl,
 *                                   callbackToken, pace }
 *   POST /executions/:id/cancel
 */
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  EXECUTION_PROTOCOL_VERSION,
  parseWorkerInvocation,
  type ExecutionRequest,
  type RunEvent,
  type WorkerMessage,
} from "@clearideas/agent-runtime";

import { createLaunchRuntime } from "./runtime.ts";

const workerToken = process.env.SHOWCASE_WORKER_TOKEN ?? "";
const dataDirectory = process.env.SHOWCASE_WORKER_DATA ?? ".data/worker";
if (workerToken.length < 32)
  throw new Error("SHOWCASE_WORKER_TOKEN is required.");

const active = new Map<string, AbortController>();

const authorized = (request: IncomingMessage) => {
  const supplied = Buffer.from(
    (request.headers.authorization ?? "").replace(/^Bearer /u, ""),
  );
  const expected = Buffer.from(workerToken);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
};

const readJson = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>)
    chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
};

const reply = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** Run one invocation and report back, one message at a time, in order. */
const execute = async (body: Record<string, unknown>) => {
  const executionId = String(body.executionId);
  const invocation = parseWorkerInvocation(body.invocation);
  const callbackUrl = String(body.callbackUrl);
  const callbackToken = String(body.callbackToken);
  const send = async (message: WorkerMessage) => {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${callbackToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
    });
    if (!response.ok)
      throw new Error(`Callback returned HTTP ${response.status}.`);
  };

  const controller = new AbortController();
  active.set(executionId, controller);
  const runtime = createLaunchRuntime({
    mode: body.mode === "live" ? "live" : "scripted",
    pace: Number(body.pace ?? 1),
    storeDirectory: path.join(dataDirectory, executionId),
    onEvent: (event: RunEvent) =>
      send({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        type: "event",
        event,
      }),
  });
  try {
    const request = invocation.request as ExecutionRequest;
    const result = await runtime.run({
      manifest: request.manifest,
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.variables ? { variables: request.variables } : {}),
      ...(request.execution ? { execution: request.execution } : {}),
      signal: controller.signal,
    });
    await send({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      type: "result",
      result,
    });
  } catch (error) {
    await send({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      type: "error",
      error: {
        code: controller.signal.aborted
          ? "EXECUTION_CANCELLED"
          : "WORKER_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    }).catch(() => undefined);
  } finally {
    active.delete(executionId);
  }
};

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || !authorized(request))
      return reply(response, 401, { error: "Unauthorized." });
    const url = new URL(request.url ?? "/", "http://worker");
    if (url.pathname === "/executions") {
      const body = await readJson(request);
      if (!/^[A-Za-z0-9_-]{1,200}$/u.test(String(body.executionId)))
        return reply(response, 400, { error: "Invalid execution ID." });
      reply(response, 202, { executionId: body.executionId, pid: process.pid });
      void execute(body);
      return;
    }
    const cancel = /^\/executions\/([A-Za-z0-9_-]+)\/cancel$/u.exec(
      url.pathname,
    );
    if (cancel) {
      active.get(cancel[1]!)?.abort(new Error("Cancelled by the host."));
      return reply(response, 202, {});
    }
    reply(response, 404, { error: "Not found." });
  } catch (error) {
    reply(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  // The host waits for this line to learn the worker's address.
  process.stdout.write(`worker listening http://127.0.0.1:${port}\n`);
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
