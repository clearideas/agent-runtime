import type { AgentManifest } from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  composeRuntime,
  parseAgentRuntimeConfig,
  resolveModelReference,
  validateRuntimeConfiguration,
} from "./index.js";

const promptManifest = (model: AgentManifest["model"]): AgentManifest => ({
  schemaVersion: "1.0",
  ...(model ? { model } : {}),
  steps: [{ id: "answer", type: "prompt", prompt: "Answer." }],
});

describe("runner runtime configuration", () => {
  it("parses common, local, and remote provider definitions without inline secrets", () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      providers: {
        openai: { driver: "openai" },
        ollama: {
          driver: "openai-compatible",
          baseURL: "http://127.0.0.1:11434/v1",
        },
        modal: {
          driver: "openai-compatible",
          baseURL: { env: "MODAL_MODEL_URL" },
          apiKey: { env: "MODAL_MODEL_API_KEY" },
        },
      },
      models: {
        quality: { provider: "openai", model: "gpt-test" },
        local: { provider: "ollama", model: "qwen-test" },
      },
    });

    expect(config.providers.ollama?.driver).toBe("openai-compatible");
    expect(config.models.local).toMatchObject({
      provider: "ollama",
      model: "qwen-test",
    });
    expect(() =>
      parseAgentRuntimeConfig({
        version: "1.0",
        providers: { openai: { driver: "openai", apiKey: "inline-secret" } },
      }),
    ).toThrow();
  });

  it("resolves model profiles while allowing an agent to override safe provider options", () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      providers: {
        local: {
          driver: "openai-compatible",
          baseURL: "http://localhost:11434/v1",
        },
      },
      models: {
        private: {
          provider: "local",
          model: "qwen-test",
          options: { temperature: 0.2 },
          capabilities: { tools: false, maxOutputTokens: 1000 },
        },
      },
    });

    expect(
      resolveModelReference(
        { ref: "private", options: { temperature: 0.5 } },
        config,
      ),
    ).toMatchObject({
      provider: "local",
      model: "qwen-test",
      profile: "private",
      options: { temperature: 0.5 },
    });
  });

  it("auto-registers a common provider when its conventional API key is available", () => {
    const config = parseAgentRuntimeConfig({ version: "1.0" });
    const runtime = composeRuntime(
      promptManifest({ provider: "openai", model: "gpt-test" }),
      config,
      { environment: { OPENAI_API_KEY: "test-key" } },
    );
    expect(runtime.model).toBeDefined();
  });

  it("enforces host model policy for untrusted agent manifests", () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      providers: {
        primary: { driver: "openai", apiKey: { env: "OPENAI_API_KEY" } },
      },
      models: {
        approved: { provider: "primary", model: "gpt-test" },
      },
    });
    const context = { environment: { OPENAI_API_KEY: "test-key" } };

    expect(() =>
      composeRuntime(
        promptManifest({ provider: "primary", model: "gpt-test" }),
        config,
        context,
        { modelPolicy: { requireProfiles: true } },
      ),
    ).toThrow("requires agent manifests to use configured model profiles");

    expect(() =>
      composeRuntime(promptManifest({ ref: "approved" }), config, context, {
        modelPolicy: { allowedModels: ["primary/other-model"] },
      }),
    ).toThrow("is not authorized by this host");

    expect(() =>
      composeRuntime(
        promptManifest({ ref: "approved", options: { temperature: 0.9 } }),
        config,
        context,
        { modelPolicy: { allowManifestOptions: false } },
      ),
    ).toThrow("option overrides are not authorized");
  });

  it("rejects provider endpoint credentials embedded in URLs", () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      providers: {
        private: {
          driver: "openai-compatible",
          baseURL: "https://user:secret@example.com/v1",
        },
      },
    });
    expect(() =>
      composeRuntime(
        promptManifest({ provider: "private", model: "model" }),
        config,
      ),
    ).toThrow("without URL credentials");
  });

  it("accepts explicit MCP auth modes and rejects ambiguous authorization configuration", () => {
    expect(
      parseAgentRuntimeConfig({
        version: "1.0",
        connections: {
          delegated: {
            driver: "mcp",
            url: "https://mcp.example.com",
            auth: { type: "oauth", profile: "customer-documents" },
            tools: ["search"],
            readTools: ["search"],
          },
          service: {
            driver: "mcp",
            url: "https://service.example.com/mcp",
            auth: {
              type: "client_credentials",
              clientId: { env: "MCP_CLIENT_ID" },
              clientSecret: { env: "MCP_CLIENT_SECRET" },
            },
            tools: ["search"],
            readTools: ["search"],
          },
        },
      }).connections,
    ).toMatchObject({
      delegated: { auth: { type: "oauth", profile: "customer-documents" } },
      service: { auth: { type: "client_credentials" } },
    });

    expect(() =>
      parseAgentRuntimeConfig({
        version: "1.0",
        connections: {
          invalid: {
            driver: "mcp",
            url: "https://mcp.example.com",
            auth: { type: "none" },
            bearerToken: { env: "MCP_TOKEN" },
            tools: ["search"],
            readTools: ["search"],
          },
        },
      }),
    ).toThrow("cannot define both auth and bearerToken");
  });

  it("rejects missing profiles, capability mismatches, and connection elevation", () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      providers: {
        local: {
          driver: "openai-compatible",
          baseURL: "http://localhost:11434/v1",
        },
      },
      models: {
        local: {
          provider: "local",
          model: "qwen-test",
          capabilities: { tools: false },
        },
      },
      connections: {
        documents: {
          driver: "mcp",
          url: "https://mcp.example.com",
          mode: "read",
          tools: ["read"],
          readTools: ["read"],
        },
      },
    });
    expect(() =>
      validateRuntimeConfiguration(promptManifest({ ref: "missing" }), config),
    ).toThrow("Unknown model profile");
    expect(() =>
      validateRuntimeConfiguration(
        {
          ...promptManifest({ ref: "local" }),
          steps: [
            {
              id: "answer",
              type: "prompt",
              prompt: "Answer.",
              tools: ["docs__read"],
            },
          ],
        },
        config,
      ),
    ).toThrow("does not support tools");
    expect(() =>
      validateRuntimeConfiguration(
        {
          schemaVersion: "1.0",
          connections: [{ ref: "documents", mode: "read_write" }],
          steps: [],
        },
        config,
      ),
    ).toThrow("cannot be elevated");
  });
});
