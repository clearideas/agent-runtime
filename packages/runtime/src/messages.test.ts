import type { AgentManifest } from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  composeRuntime,
  createConfiguredMessagesOptions,
  parseAgentRuntimeConfig,
} from "./index.js";

const chat: AgentManifest = {
  schemaVersion: "1.0",
  model: { ref: "main" },
  messages: { required: true },
  steps: [
    { id: "answer", type: "prompt", systemPrompt: "Answer.", history: "all" },
  ],
};

describe("messages host configuration", () => {
  it("composes a signer from environment keys, limits, and the host requirement", async () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      providers: { openai: { driver: "openai" } },
      models: { main: { provider: "openai", model: "gpt-test" } },
      messages: {
        signing: {
          activeKeyId: "k2026",
          keys: {
            k2026: { env: "MESSAGES_KEY_2026" },
            k2025: { env: "MESSAGES_KEY_2025" },
          },
          require: true,
        },
        media: { maxInlineBytes: 1024 },
        limits: { maxSuppliedMessages: 50, maxSuppliedBytes: 100_000 },
      },
    });
    const context = {
      environment: {
        OPENAI_API_KEY: "test",
        MESSAGES_KEY_2026: `hex:${"26".repeat(32)}`,
        MESSAGES_KEY_2025: `hex:${"25".repeat(32)}`,
      },
    };
    const { messages } = composeRuntime(chat, config, context);
    expect(messages).toMatchObject({
      requireSignature: true,
      maxInlineBytes: 1024,
      maxSuppliedMessages: 50,
      maxSuppliedBytes: 100_000,
    });
    const history = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Hi" }],
      },
    ];
    const signature = await messages!.signer!.sign({ messages: history });
    expect(signature.keyId).toBe("k2026");
    await expect(
      messages!.signer!.verify({ messages: history, signature }),
    ).resolves.toEqual({ valid: true });
    expect(
      composeRuntime(chat, config, context, { messages: false }).messages,
    ).toBeUndefined();
  });

  it("requires an environment key and a configured active key", () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      messages: {
        signing: { activeKeyId: "k1", keys: { k1: { env: "MISSING_KEY" } } },
      },
    });
    expect(() =>
      createConfiguredMessagesOptions(config, { environment: {} }),
    ).toThrow(
      "Message signing key k1 requires environment variable MISSING_KEY.",
    );
    expect(() =>
      parseAgentRuntimeConfig({
        version: "1.0",
        messages: {
          signing: { activeKeyId: "k2", keys: { k1: { env: "KEY" } } },
        },
      }),
    ).toThrow(/must name a key/u);
    expect(() =>
      parseAgentRuntimeConfig({
        version: "1.0",
        messages: {
          signing: { activeKeyId: "k1", keys: { k1: "hex:00" } },
        },
      }),
    ).toThrow();
    expect(
      createConfiguredMessagesOptions(
        parseAgentRuntimeConfig({ version: "1.0" }),
      ),
    ).toBeUndefined();
  });

  it("describes declared image input", async () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      providers: { openai: { driver: "openai" } },
      models: {
        main: {
          provider: "openai",
          model: "gpt-test",
          capabilities: { imageInput: false },
        },
      },
    });
    const { model } = composeRuntime(chat, config, {
      environment: { OPENAI_API_KEY: "test" },
    });
    expect(await model!.describeModel!("ref/main")).toEqual({
      imageInput: false,
    });
  });
});
