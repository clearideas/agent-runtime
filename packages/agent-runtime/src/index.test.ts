import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  agentManifestSchema,
  parseAgentRuntimeConfig,
} from "./index.js";

describe("@clearideas/agent-runtime", () => {
  it("exposes the primary contracts, runtime, and configuration entry points", () => {
    expect(AgentRuntime).toBeTypeOf("function");
    expect(agentManifestSchema.safeParse).toBeTypeOf("function");
    expect(parseAgentRuntimeConfig).toBeTypeOf("function");
  });
});
