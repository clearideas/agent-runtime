import { describe, expect, it } from "vitest";

import {
  canonicalizeMcpToolMetadata,
  computeMcpToolDigest,
  McpToolIntegrityError,
  mcpToolDigestPattern,
} from "./index.js";

describe("MCP tool metadata digests", () => {
  it("canonicalizes key order and omits undefined members", () => {
    const canonical = canonicalizeMcpToolMetadata({
      name: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Terms" } },
        required: ["query"],
      },
      description: "Search documents",
    });
    expect(canonical).toBe(
      '{"description":"Search documents","inputSchema":{"properties":{"query":{"description":"Terms","type":"string"}},"required":["query"],"type":"object"},"name":"search"}',
    );
    expect(
      canonicalizeMcpToolMetadata({
        name: "search",
        description: "Search documents",
        inputSchema: {
          required: ["query"],
          properties: { query: { description: "Terms", type: "string" } },
          type: "object",
          nested: undefined,
        },
      }),
    ).toBe(canonical);
  });

  it("treats absent, null, empty-string, and empty-object top-level fields alike", () => {
    const base = computeMcpToolDigest({ name: "search" });
    expect(
      computeMcpToolDigest({
        name: "search",
        title: "",
        description: null as unknown as string,
        annotations: {},
        inputSchema: undefined,
      }),
    ).toBe(base);
    expect(computeMcpToolDigest({ name: "search", description: "x" })).not.toBe(
      base,
    );
  });

  it("preserves nested null values and array order", () => {
    const ordered = computeMcpToolDigest({
      name: "pick",
      inputSchema: { enum: ["a", "b"], default: null },
    });
    expect(
      computeMcpToolDigest({
        name: "pick",
        inputSchema: { enum: ["b", "a"], default: null },
      }),
    ).not.toBe(ordered);
    expect(
      computeMcpToolDigest({ name: "pick", inputSchema: { enum: ["a", "b"] } }),
    ).not.toBe(ordered);
  });

  it("produces a stable sha256 digest and ignores fields a model never sees", () => {
    const tool = {
      name: "search",
      title: "Search",
      description: "Search documents",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    };
    const digest = computeMcpToolDigest(tool);
    expect(digest).toMatch(mcpToolDigestPattern);
    expect(digest).toBe(
      "sha256:8c0eab7c1016d957f3a9d650ffd8aba314e576d1c47751ec16b4365ac89876a1",
    );
    expect(
      computeMcpToolDigest({
        ...tool,
        outputSchema: { type: "object" },
        _meta: { hidden: true },
      } as never),
    ).toBe(digest);
    expect(computeMcpToolDigest({ ...tool, title: "Find" })).not.toBe(digest);
    expect(
      computeMcpToolDigest({
        ...tool,
        inputSchema: {
          type: "object",
          properties: { q: { description: "Injected instructions" } },
        },
      }),
    ).not.toBe(digest);
    expect(() => computeMcpToolDigest({ name: "" })).toThrow("non-empty name");
  });

  it("describes integrity failures with the digests and the offending definition", () => {
    const tool = { name: "search", description: "changed" };
    const mismatch = new McpToolIntegrityError({
      connectionRef: "documents",
      toolName: "search",
      reason: "mismatch",
      expectedDigest: "sha256:expected",
      actualDigest: "sha256:actual",
      tool,
    });
    expect(mismatch.name).toBe("McpToolIntegrityError");
    expect(mismatch.message).toContain('Connection "documents" tool "search"');
    expect(mismatch.message).toContain("sha256:actual");
    expect(mismatch.message).toContain("sha256:expected");
    expect(mismatch.tool).toBe(tool);

    const rejected = new McpToolIntegrityError({
      connectionRef: "documents",
      toolName: "search",
      reason: "rejected",
      actualDigest: "sha256:actual",
      tool,
      cause: new Error("not approved by tenant"),
    });
    expect(rejected.message).toContain("rejected by the host");
    expect(rejected.message).toContain("not approved by tenant");
    expect(rejected.cause).toBeInstanceOf(Error);
  });
});
