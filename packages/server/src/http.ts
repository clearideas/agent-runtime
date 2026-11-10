/**
 * Transport adapters for the agent service: a node:http request listener and
 * server, and a fetch-style handler for hosts built on Request/Response.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { ServerError } from "./errors.js";
import type {
  AgentServer,
  ServiceRequest,
  ServiceResponse,
} from "./service.js";

const readNodeBody = (
  request: IncomingMessage,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (error: unknown): void => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onAbort = (): void => onError(signal?.reason);
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > limit) onError(tooLarge(limit));
      else chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      onError(tooLarge(limit));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });

const tooLarge = (limit: number): ServerError =>
  new ServerError(
    413,
    "request_too_large",
    `The request body exceeds ${limit} bytes.`,
  );

const writeBody = async (
  response: ServerResponse,
  body: AsyncIterable<string>,
): Promise<void> => {
  response.flushHeaders();
  for await (const chunk of body) {
    if (response.destroyed) break;
    if (!response.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          response.off("drain", done);
          response.off("close", done);
          resolve();
        };
        response.on("drain", done);
        response.on("close", done);
      });
    }
  }
};

/** A node:http request listener for the service. */
export const createRequestListener =
  (server: AgentServer) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    const disconnected = new AbortController();
    // A closed socket before the response finished is a client disconnect.
    response.on("close", () => {
      if (!response.writableFinished) disconnected.abort();
    });
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Invalid request target.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_request",
          },
        }),
      );
      return;
    }
    const serviceRequest: ServiceRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      headers: request.headers,
      readBody: (limit, signal) => readNodeBody(request, limit, signal),
      signal: disconnected.signal,
    };
    void server
      .handle(serviceRequest)
      .then(async (result: ServiceResponse) => {
        if (response.destroyed) return;
        // Finish an error response before closing an unfinished upload.
        if (!request.complete) result.headers.connection = "close";
        response.writeHead(result.status, result.headers);
        if (result.body === undefined) response.end();
        else if (typeof result.body === "string") response.end(result.body);
        else {
          const iterator = result.body[Symbol.asyncIterator]();
          const closeIterator = (): void => {
            void iterator.return?.();
          };
          response.once("close", closeIterator);
          await writeBody(response, { [Symbol.asyncIterator]: () => iterator });
          response.off("close", closeIterator);
          response.end();
        }
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Internal server error.",
                type: "server_error",
                param: null,
                code: "internal_error",
              },
            }),
          );
        } else response.destroy();
      });
  };

export interface ListeningServer {
  /** Base URL, for example http://127.0.0.1:8000 */
  url: string;
  address: AddressInfo;
  http: Server;
  /** Stop accepting connections, drain runs, and release resources. */
  close(graceMs?: number): Promise<void>;
}

/** Listen on the configured host and port. */
export const listen = async (
  server: AgentServer,
  options: { host?: string; port?: number } = {},
): Promise<ListeningServer> => {
  const host = options.host ?? server.config.server.host;
  const port = options.port ?? server.config.server.port;
  const http = createServer(
    {
      // Keep idle connections longer than common load balancer timeouts.
      keepAliveTimeout: 65_000,
      headersTimeout: 66_000,
      // Runs are bounded by requestTimeoutMs, not the socket.
      requestTimeout: 0,
    },
    createRequestListener(server),
  );
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address() as AddressInfo;
  const displayHost =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${displayHost}:${address.port}`,
    address,
    http,
    close: async (graceMs?: number) => {
      const closed = new Promise<void>((resolve) =>
        http.close(() => resolve()),
      );
      http.closeIdleConnections();
      await server.shutdown(graceMs);
      http.closeAllConnections();
      await closed;
    },
  };
};

/**
 * A fetch-style handler, for hosts built on the Request/Response API. Mount
 * it under a path prefix by passing `basePath`.
 */
export const createFetchHandler =
  (server: AgentServer, options: { basePath?: string } = {}) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const basePath = options.basePath?.replace(/\/+$/u, "") ?? "";
    const pathname =
      basePath && url.pathname.startsWith(basePath)
        ? url.pathname.slice(basePath.length) || "/"
        : url.pathname;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const result = await server.handle({
      method: request.method,
      path: pathname,
      headers,
      readBody: async (limit, signal) => {
        if (!request.body) return Buffer.alloc(0);
        const reader = request.body.getReader();
        const chunks: Buffer[] = [];
        let size = 0;
        const cancel = (): void => {
          void reader.cancel().catch(() => undefined);
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          if (signal?.aborted) {
            cancel();
            signal.throwIfAborted();
          }
          while (true) {
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            if (done) return Buffer.concat(chunks, size);
            size += value.byteLength;
            if (size > limit) {
              cancel();
              throw tooLarge(limit);
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          signal?.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      },
      signal: request.signal,
    });
    if (result.body === undefined || typeof result.body === "string") {
      return new Response(result.body ?? null, {
        status: result.status,
        headers: result.headers,
      });
    }
    const iterator = result.body[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        },
        async cancel() {
          await iterator.return?.();
        },
      }),
      { status: result.status, headers: result.headers },
    );
  };
