import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ConfiguredMcpToolAdapter, parseAgentRuntimeConfig } from "./index.js";

const servers: Server[] = [];
const listen = async (handler: RequestListener): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
};

const adapterFor = (url: string) =>
  new ConfiguredMcpToolAdapter(
    parseAgentRuntimeConfig({
      version: "1.0",
      connections: {
        documents: {
          driver: "mcp",
          url,
          auth: { type: "bearer", token: { env: "DOCUMENTS_TOKEN" } },
          mode: "read",
          tools: ["search"],
          readTools: ["search"],
          required: true,
          connectTimeoutMs: 2_000,
          toolTimeoutMs: 2_000,
        },
      },
    }),
    [{ ref: "documents", alias: "docs" }],
    { environment: { DOCUMENTS_TOKEN: "test-only-token" } },
  );

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("MCP HTTP transport with the installed SDK", () => {
  it("discovers and calls authorized tools with bearer credentials and idempotency metadata", async () => {
    const requests: Array<{
      authorization: string | undefined;
      method: string;
      params?: Record<string, unknown>;
    }> = [];
    const url = await listen((request, response) => {
      if (request.method !== "POST") return response.writeHead(405).end();
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body);
        requests.push({
          authorization: request.headers.authorization,
          method: message.method,
          params: message.params,
        });
        if (message.method.startsWith("notifications/"))
          return response.writeHead(202).end();
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "test-documents", version: "1.0" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "search",
                      inputSchema: {
                        type: "object",
                        properties: { query: { type: "string" } },
                      },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "found" }] };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
        );
      });
    });
    const adapter = adapterFor(url);
    await expect(adapter.listTools()).resolves.toMatchObject([
      { name: "docs__search" },
    ]);
    await expect(
      adapter.executeTool(
        { id: "call-1", name: "docs__search", input: { query: "release" } },
        {
          runId: "run-1",
          stepId: "lookup",
          variables: {},
          idempotencyKey: "test-call-1",
        },
      ),
    ).resolves.toMatchObject({
      output: { content: [{ type: "text", text: "found" }] },
    });
    expect(
      requests.every((r) => r.authorization === "Bearer test-only-token"),
    ).toBe(true);
    expect(
      requests.find((r) => r.method === "tools/call")?.params,
    ).toMatchObject({
      name: "search",
      arguments: { query: "release" },
      _meta: { "agent-runtime/idempotency-key": "test-call-1" },
    });
  });

  it.each([302, 307, 308])(
    "refuses HTTP %i redirects without forwarding credentials or request bodies",
    async (status) => {
      let redirectedRequests = 0;
      const target = await listen((request, response) => {
        redirectedRequests += 1;
        request.resume();
        response.writeHead(500).end();
      });
      let originalAuthorization: string | undefined;
      const source = await listen((request, response) => {
        originalAuthorization = request.headers.authorization;
        request.resume();
        response.writeHead(status, { Location: target }).end();
      });
      await expect(adapterFor(source).listTools()).rejects.toThrow();
      expect(originalAuthorization).toBe("Bearer test-only-token");
      expect(redirectedRequests).toBe(0);
    },
  );
});
