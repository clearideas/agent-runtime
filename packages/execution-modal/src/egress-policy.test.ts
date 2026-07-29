import { describe, expect, it } from "vitest";

import {
  evaluateAgentRunnerEgressPolicyDestination,
  resolveAgentRunnerEgressPolicy,
} from "./egress-policy.js";

describe("agent runner egress policy resolution", () => {
  it("derives portable origins using only host-owned resolvers", async () => {
    const invalid: string[] = [];
    const policy = await resolveAgentRunnerEgressPolicy(
      {
        schemaVersion: "1.0",
        model: { ref: "default-model" },
        connections: [{ ref: "crm", tools: ["read-contact"] }],
        steps: [
          {
            id: "research",
            type: "prompt",
            prompt: "Research",
            tools: ["web-search"],
          },
          {
            id: "notify",
            name: "Notify",
            type: "webhook",
            url: "https://hooks.example.test/private/callback?tenant=1",
          },
          {
            id: "nested",
            type: "sub-run",
            manifest: {
              schemaVersion: "1.0",
              steps: [
                {
                  id: "specialist",
                  type: "prompt",
                  prompt: "Analyze",
                  model: { provider: "anthropic", model: "claude" },
                },
              ],
            },
          },
        ],
      },
      {
        controlPlaneOrigins: [
          "https://control.example.test/internal/path",
          "http://invalid-control-plane.test",
        ],
        resolveModelOrigins: async (model) =>
          "ref" in model
            ? ["https://api.openai.test/v1"]
            : [
                {
                  origin: "https://api.anthropic.test/v1",
                  provider: model.provider,
                },
              ],
        resolveConnectionOrigins: async (binding) => [
          {
            origin: "https://mcp.example.test/rpc",
            connectionRef: binding.ref,
          },
        ],
        resolveToolOrigins: async () => [
          { origin: "https://search.example.test/v1", provider: "search" },
        ],
        onInvalidOrigin: (origin) => invalid.push(origin),
      },
    );

    expect(policy).toEqual({
      mode: "enforce",
      allowedOrigins: [
        {
          type: "control_plane",
          origin: "https://control.example.test",
        },
        {
          type: "connection",
          origin: "https://mcp.example.test",
          connectionRef: "crm",
        },
        {
          type: "model",
          origin: "https://api.openai.test",
        },
        {
          type: "tool",
          origin: "https://search.example.test",
          provider: "search",
          tool: "web-search",
        },
        {
          type: "webhook",
          origin: "https://hooks.example.test",
          step: "Notify",
        },
        {
          type: "model",
          origin: "https://api.anthropic.test",
          provider: "anthropic",
        },
      ],
    });
    expect(invalid).toEqual(["http://invalid-control-plane.test"]);
  });

  it("matches Modal wildcard semantics while keeping suffixes bounded", () => {
    const policy = {
      mode: "enforce",
      allowedOrigins: [
        { type: "webhook", origin: "https://hooks.example.test" },
        {
          type: "connection",
          origin: "https://*.service.example.test:8443",
        },
      ],
    } as const;

    expect(
      evaluateAgentRunnerEgressPolicyDestination(
        policy,
        "hooks.example.test.",
        443,
      ),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAgentRunnerEgressPolicyDestination(
        policy,
        "child.service.example.test",
        8443,
      ),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAgentRunnerEgressPolicyDestination(
        policy,
        "service.example.test",
        8443,
      ),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAgentRunnerEgressPolicyDestination(
        policy,
        "evilservice.example.test",
        8443,
      ),
    ).toMatchObject({ allowed: false });
    expect(
      evaluateAgentRunnerEgressPolicyDestination(
        policy,
        "hooks.example.test",
        80,
      ),
    ).toMatchObject({ allowed: false });
  });

  it("fails resolution when a referenced sub-run cannot be inspected", async () => {
    await expect(
      resolveAgentRunnerEgressPolicy(
        {
          schemaVersion: "1.0",
          steps: [
            { id: "nested", type: "sub-run", manifestRef: "agent:private" },
          ],
        },
        {},
      ),
    ).rejects.toThrow("Cannot resolve egress for sub-run manifest ref");
  });

  it("allows the host to mark a referenced sub-run as externally coordinated", async () => {
    await expect(
      resolveAgentRunnerEgressPolicy(
        {
          schemaVersion: "1.0",
          steps: [
            { id: "nested", type: "sub-run", manifestRef: "agent:hosted" },
          ],
        },
        { resolveManifestRef: async () => null },
      ),
    ).resolves.toEqual({ mode: "enforce", allowedOrigins: [] });
  });
});
