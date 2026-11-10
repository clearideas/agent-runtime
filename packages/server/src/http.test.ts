import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { ServerError } from "./errors.js";
import { createFetchHandler, createRequestListener } from "./http.js";
import type { AgentServer, ServiceRequest } from "./service.js";

describe("HTTP transport boundaries", () => {
  it("returns a client error for a malformed request target", () => {
    const handle = vi.fn();
    const service = { handle } as unknown as AgentServer;
    const response = {
      on: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    expect(() =>
      createRequestListener(service)(
        { url: "http://[", headers: {} } as IncomingMessage,
        response as unknown as ServerResponse,
      ),
    ).not.toThrow();
    expect(response.writeHead).toHaveBeenCalledWith(400, {
      "content-type": "application/json",
    });
    expect(JSON.parse(response.end.mock.calls[0]![0]).error.code).toBe(
      "invalid_request",
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("stops reading a fetch body as soon as it exceeds its limit", async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1;
          controller.enqueue(new Uint8Array(8));
          if (reads === 3) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const service = {
      async handle(request: ServiceRequest) {
        try {
          await request.readBody(10);
          throw new Error("Oversized request was accepted");
        } catch (error) {
          if (!(error instanceof ServerError)) throw error;
          return { status: error.status, headers: {}, body: error.code };
        }
      },
    } as unknown as AgentServer;
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body,
      // Node requires this option when a request body is a stream.
      ...{ duplex: "half" },
    });
    const response = await createFetchHandler(service)(request);
    expect(response.status).toBe(413);
    expect(reads).toBe(2);
    expect(cancelled).toBe(true);
  });
});
