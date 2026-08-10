import type { AgentManifest } from "@clearideas/agent-runtime-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mcp = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  transportOptions: [] as unknown[],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mcp.connect;
    listTools = mcp.listTools;
    callTool = mcp.callTool;
    close = mcp.close;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) {
      mcp.transportOptions.push({ url: url.toString(), options });
    }
  },
}));

import { ConfiguredMcpToolAdapter, parseAgentRuntimeConfig } from "./index.js";

describe("configured MCP tool adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcp.transportOptions.length = 0;
    mcp.connect.mockResolvedValue(undefined);
    mcp.close.mockResolvedValue(undefined);
    mcp.listTools.mockResolvedValue({
      tools: [
        {
          name: "search",
          description: "Search documents",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
          annotations: { readOnlyHint: false },
        },
        {
          name: "delete",
          description: "Delete a document",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
    });
    mcp.callTool.mockResolvedValue({
      content: [{ type: "text", text: "found" }],
    });
  });

  it("namespaces tools, enforces read mode, resolves bearer secrets, and routes calls", async () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      connections: {
        documents: {
          driver: "mcp",
          url: "https://mcp.example.com",
          bearerToken: { env: "DOCUMENTS_TOKEN" },
          mode: "read",
          tools: ["search", "delete"],
          readTools: ["search"],
        },
      },
    });
    const manifest: AgentManifest = {
      schemaVersion: "1.0",
      connections: [{ ref: "documents", alias: "docs" }],
      steps: [],
    };
    const adapter = new ConfiguredMcpToolAdapter(
      config,
      manifest.connections!,
      {
        environment: { DOCUMENTS_TOKEN: "secret-token" },
      },
    );

    await expect(adapter.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "docs__search",
        description: "Search documents",
      }),
    ]);
    expect(mcp.transportOptions[0]).toMatchObject({
      url: "https://mcp.example.com/",
      options: {
        requestInit: { headers: { Authorization: "Bearer secret-token" } },
      },
    });

    await expect(
      adapter.executeTool(
        { id: "call-1", name: "docs__search", input: { query: "terms" } },
        {
          runId: "run-1",
          stepId: "answer",
          variables: {},
          idempotencyKey: "tool-key-1",
        },
      ),
    ).resolves.toMatchObject({
      callId: "call-1",
      name: "docs__search",
      output: { content: [{ type: "text", text: "found" }] },
    });
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { query: "terms" },
      _meta: { "agent-runtime/idempotency-key": "tool-key-1" },
    });
  });

  it("permits write tools only when both host and agent allow read-write access", async () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      connections: {
        documents: {
          driver: "mcp",
          url: "https://mcp.example.com",
          mode: "read_write",
          tools: ["search", "delete"],
          readTools: ["search"],
        },
      },
    });
    const adapter = new ConfiguredMcpToolAdapter(config, [
      { ref: "documents", alias: "docs", mode: "read_write" },
    ]);
    await expect(adapter.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "docs__search" }),
      expect.objectContaining({ name: "docs__delete" }),
    ]);
  });

  it("uses a credential provider for OAuth and retries once after unauthorized", async () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      connections: {
        documents: {
          driver: "mcp",
          url: "https://mcp.example.com",
          auth: { type: "oauth", profile: "documents-user" },
          mode: "read",
          tools: ["search"],
          readTools: ["search"],
          required: true,
        },
      },
    });
    const getCredential = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ready",
        headers: { Authorization: "Bearer initial-token" },
      })
      .mockResolvedValueOnce({
        status: "ready",
        headers: { Authorization: "Bearer initial-token" },
      })
      .mockResolvedValueOnce({
        status: "ready",
        headers: { Authorization: "Bearer refreshed-token" },
      });
    const invalidateCredential = vi.fn(async () => undefined);
    const adapter = new ConfiguredMcpToolAdapter(
      config,
      [{ ref: "documents", alias: "docs", required: true }],
      {},
      {
        credentialProvider: { getCredential, invalidateCredential },
      },
    );

    await adapter.listTools();
    const unauthorized = Object.assign(new Error("request failed"), {
      code: 401,
    });
    mcp.callTool.mockRejectedValueOnce(unauthorized).mockResolvedValueOnce({
      content: [{ type: "text", text: "refreshed result" }],
    });

    await expect(
      adapter.executeTool(
        { id: "call-oauth", name: "docs__search", input: { query: "terms" } },
        { runId: "run-1", stepId: "answer", variables: {} },
      ),
    ).resolves.toMatchObject({
      output: { content: [{ type: "text", text: "refreshed result" }] },
    });
    expect(invalidateCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionRef: "documents",
        credentialProfile: "documents-user",
        runId: "run-1",
        stepId: "answer",
        forceRefresh: true,
        reason: "unauthorized",
      }),
    );
    expect(mcp.transportOptions.at(-1)).toMatchObject({
      options: {
        requestInit: { headers: { Authorization: "Bearer refreshed-token" } },
      },
    });
    expect(mcp.callTool).toHaveBeenCalledTimes(2);
  });

  it("runs host authorization before connection discovery and tool execution", async () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      connections: {
        documents: {
          driver: "mcp",
          url: "https://mcp.example.com",
          mode: "read",
          tools: ["search"],
          readTools: ["search"],
        },
      },
    });
    const authorizeConnection = vi.fn(async () => undefined);
    const authorizeTool = vi.fn(async () => {
      throw new Error("Tool is not authorized for this run.");
    });
    const adapter = new ConfiguredMcpToolAdapter(
      config,
      [{ ref: "documents", alias: "docs" }],
      {},
      { authorizeConnection, authorizeTool },
    );

    await adapter.listTools();
    await expect(
      adapter.executeTool(
        { id: "call-denied", name: "docs__search", input: { query: "terms" } },
        { runId: "run-1", stepId: "answer", variables: {} },
      ),
    ).resolves.toMatchObject({
      error: {
        code: "tool_not_authorized",
        message: 'Tool "docs__search" is not authorized for this run.',
        retryable: false,
      },
    });
    expect(authorizeConnection).toHaveBeenCalledOnce();
    expect(authorizeTool).toHaveBeenCalledOnce();
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it("reports when an OAuth connection requires user authorization", async () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      connections: {
        documents: {
          driver: "mcp",
          url: "https://mcp.example.com",
          auth: { type: "oauth" },
          required: true,
          tools: ["search"],
          readTools: ["search"],
        },
      },
    });
    const adapter = new ConfiguredMcpToolAdapter(
      config,
      [{ ref: "documents", required: true }],
      {},
      {
        credentialProvider: {
          getCredential: vi.fn(async () => ({
            status: "authorization_required",
            authorizationUrl: "https://identity.example.com/authorize",
          })),
        },
      },
    );

    await expect(adapter.listTools()).rejects.toMatchObject({
      name: "ConnectionAuthorizationRequiredError",
      connectionRef: "documents",
      authorizationUrl: "https://identity.example.com/authorize",
    });
    expect(mcp.connect).not.toHaveBeenCalled();
  });

  it("configures native client-credentials authentication without exposing secrets as headers", async () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      connections: {
        service: {
          driver: "mcp",
          url: "https://mcp.example.com",
          auth: {
            type: "client_credentials",
            clientId: { env: "MCP_CLIENT_ID" },
            clientSecret: { env: "MCP_CLIENT_SECRET" },
            scopes: ["documents.read"],
          },
          tools: ["search"],
          readTools: ["search"],
        },
      },
    });
    const adapter = new ConfiguredMcpToolAdapter(config, [{ ref: "service" }], {
      environment: {
        MCP_CLIENT_ID: "client-id",
        MCP_CLIENT_SECRET: "client-secret",
      },
    });

    await adapter.listTools();

    expect(mcp.transportOptions[0]).toMatchObject({
      url: "https://mcp.example.com/",
      options: { authProvider: expect.any(Object) },
    });
    expect(mcp.transportOptions[0]).not.toMatchObject({
      options: {
        requestInit: { headers: { Authorization: expect.any(String) } },
      },
    });
  });
});
