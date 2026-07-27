import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  InMemoryRemoteExecutionControlPlane,
  parseWorkerInvocation,
  parseWorkerMessage,
  RemoteExecutionEngine,
} from "@clearideas/agent-runtime-execution";
import { executeWorkerInvocation } from "@clearideas/agent-runtime-cli";

const json = (value) => JSON.parse(JSON.stringify(value));

const sendJson = (response, status, body) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
};

const readJson = async (request, maximumBytes = 2 * 1024 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const bearerMatches = (header, expected) => {
  if (typeof expected !== "string" || expected.length < 32) return false;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(
    header?.startsWith("Bearer ") ? header.slice(7) : "",
  );
  const wanted = Buffer.from(expected);
  return (
    supplied.length > 0 &&
    supplied.length === wanted.length &&
    timingSafeEqual(supplied, wanted)
  );
};

const post = async (url, token, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Remote endpoint returned HTTP ${response.status}.`);
  return response.status === 204 ? {} : response.json();
};

const workerError = (error, cancelled) => ({
  code: cancelled ? "EXECUTION_CANCELLED" : "WORKER_EXECUTION_FAILED",
  message: error instanceof Error ? error.message : String(error),
  retryable: false,
});

class InteractiveHttpLauncher {
  name = "interactive-http";
  #baseUrl;
  #workerToken;
  #reporter;
  #handles = new Map();
  #messages = new Set();

  constructor({ baseUrl, workerToken, reporter }) {
    this.#baseUrl = baseUrl;
    this.#workerToken = workerToken;
    this.#reporter = reporter;
  }

  async launch(invocation, { handle }) {
    this.#handles.set(handle.id, handle);
    const workerInvocation = json(invocation);
    workerInvocation.request.runId = handle.runId;
    const result = await post(
      `${this.#baseUrl()}/internal/executions`,
      this.#workerToken,
      {
        executionId: handle.id,
        invocation: workerInvocation,
      },
    );
    if (result.executionId !== handle.id)
      throw new Error("Worker execution ID mismatch.");
    return { workerExecutionId: handle.id };
  }

  async observe(handle) {
    await post(
      `${this.#baseUrl()}/internal/executions/${encodeURIComponent(handle.id)}/start`,
      this.#workerToken,
      {},
    );
  }

  async cancel(handle) {
    await post(
      `${this.#baseUrl()}/internal/executions/${encodeURIComponent(handle.id)}/cancel`,
      this.#workerToken,
      {},
    );
  }

  async accept(executionId, input) {
    const handle = this.#handles.get(executionId);
    if (!handle) throw new Error(`Unknown remote execution ${executionId}.`);
    const message = parseWorkerMessage(input);
    const key =
      message.type === "event"
        ? `${executionId}:event:${message.event.id}`
        : `${executionId}:${message.type}`;
    if (this.#messages.has(key)) return;

    if (message.type === "event")
      await this.#reporter.acceptEvent(handle, message.event);
    if (message.type === "result")
      await this.#reporter.complete(handle, message.result);
    if (message.type === "error")
      await this.#reporter.fail(handle, message.error);
    this.#messages.add(key);
  }
}

export const createRemoteExecution = (options) => {
  if (
    typeof options.workerToken !== "string" ||
    options.workerToken.length < 32 ||
    typeof options.callbackToken !== "string" ||
    options.callbackToken.length < 32 ||
    options.workerToken === options.callbackToken
  ) {
    throw new Error(
      "Remote worker and callback credentials must be distinct and at least 32 characters.",
    );
  }
  const callbackTokenFor = (executionId) =>
    createHmac("sha256", options.callbackToken)
      .update(executionId, "utf8")
      .digest("hex");
  const pending = new Map();
  const active = new Map();
  const controlPlane = new InMemoryRemoteExecutionControlPlane();
  const launcher = new InteractiveHttpLauncher({
    baseUrl: options.baseUrl,
    workerToken: options.workerToken,
    reporter: controlPlane,
  });

  const callback = async (executionId, message) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await post(
          `${options.baseUrl()}/internal/callbacks/${encodeURIComponent(executionId)}`,
          callbackTokenFor(executionId),
          message,
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3)
          await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
    throw lastError;
  };

  const execute = (executionId, invocation, controller) => {
    setImmediate(() => {
      void executeWorkerInvocation(invocation, {
        storeDirectory: path.join(options.dataDirectory, executionId),
        allowRequestConfiguration: true,
        environment: options.environment ?? {},
        modelPolicy: options.modelPolicy,
        toolOptions: options.toolOptions,
        signal: controller.signal,
        eventSinkFailurePolicy: "fail-run",
        runtime: options.runtime,
        onMessage: (message) => callback(executionId, message),
      })
        .then((result) =>
          callback(executionId, {
            protocolVersion: "1.0",
            type: "result",
            result,
          }),
        )
        .catch((error) =>
          callback(executionId, {
            protocolVersion: "1.0",
            type: "error",
            error: workerError(error, controller.signal.aborted),
          }),
        )
        .finally(() => active.delete(executionId));
    });
  };

  const route = async (request, response, url) => {
    const callbackMatch = /^\/internal\/callbacks\/([^/]+)$/u.exec(
      url.pathname,
    );
    if (request.method === "POST" && callbackMatch) {
      const executionId = decodeURIComponent(callbackMatch[1]);
      if (
        !bearerMatches(
          request.headers.authorization,
          callbackTokenFor(executionId),
        )
      ) {
        sendJson(response, 401, { error: "Unauthorized." });
        return true;
      }
      await launcher.accept(executionId, await readJson(request));
      response.writeHead(204);
      response.end();
      return true;
    }

    if (!url.pathname.startsWith("/internal/executions")) return false;
    if (!bearerMatches(request.headers.authorization, options.workerToken)) {
      sendJson(response, 401, { error: "Unauthorized." });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/internal/executions") {
      const body = await readJson(request);
      const executionId =
        typeof body.executionId === "string" ? body.executionId : "";
      if (!/^[A-Za-z0-9_-]{1,200}$/u.test(executionId)) {
        throw new Error("Invalid execution ID.");
      }
      if (pending.has(executionId) || active.has(executionId)) {
        sendJson(response, 409, { error: "Execution already exists." });
        return true;
      }
      pending.set(executionId, parseWorkerInvocation(body.invocation));
      sendJson(response, 202, { executionId });
      return true;
    }

    const actionMatch =
      /^\/internal\/executions\/([^/]+)\/(start|cancel)$/u.exec(url.pathname);
    if (request.method !== "POST" || !actionMatch) return false;
    const executionId = decodeURIComponent(actionMatch[1]);

    if (actionMatch[2] === "cancel") {
      pending.delete(executionId);
      active.get(executionId)?.abort(new Error("Execution cancelled by host."));
      sendJson(response, 202, { executionId });
      return true;
    }

    const invocation = pending.get(executionId);
    if (!invocation) {
      sendJson(response, 404, { error: "Execution not found." });
      return true;
    }
    pending.delete(executionId);
    const controller = new AbortController();
    active.set(executionId, controller);
    sendJson(response, 202, { executionId });
    execute(executionId, invocation, controller);
    return true;
  };

  return {
    engine: new RemoteExecutionEngine(launcher, controlPlane),
    route,
  };
};
