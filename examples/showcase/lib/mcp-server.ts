/**
 * A minimal MCP Streamable HTTP endpoint on 127.0.0.1, for demos and tests.
 * It answers initialize, tools/list, and tools/call with plain JSON-RPC, which
 * is all an MCP client needs to discover and call tools. Real deployments use
 * an MCP server SDK; the runtime's client is the same either way.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import type { JsonObject, JsonValue } from "@clearideas/agent-runtime";

export interface DemoMcpTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  call(input: JsonObject): JsonValue | Promise<JsonValue>;
}

export interface DemoMcpServer {
  url: string;
  /** Every tools/call received, in order. */
  calls: Array<{ name: string; input: JsonObject }>;
  close(): Promise<void>;
}

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>)
    chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
    id?: number | string;
    method?: string;
    params?: JsonObject;
  };
};

export const startMcpServer = async (
  name: string,
  tools: DemoMcpTool[],
): Promise<DemoMcpServer> => {
  const calls: DemoMcpServer["calls"] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") return response.writeHead(405).end();
    const message = await readBody(request).catch(() => undefined);
    if (!message) return response.writeHead(400).end();
    const reply = (result: JsonValue) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize")
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name, version: "1.0.0" },
      });
    if (message.method?.startsWith("notifications/"))
      return response.writeHead(202).end();
    if (message.method === "tools/list")
      return reply({
        tools: tools.map(({ name: toolName, description, inputSchema }) => ({
          name: toolName,
          description,
          inputSchema,
        })),
      });
    if (message.method === "tools/call") {
      const toolName = String(message.params?.name ?? "");
      const input = (message.params?.arguments ?? {}) as JsonObject;
      const tool = tools.find((entry) => entry.name === toolName);
      calls.push({ name: toolName, input });
      if (!tool)
        return reply({
          isError: true,
          content: [{ type: "text", text: `Unknown tool ${toolName}` }],
        });
      const output = await tool.call(input);
      return reply({
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output as JsonObject,
      });
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
