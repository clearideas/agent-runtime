import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { emptyAgentRuntimeConfig } from "@clearideas/agent-runtime-config";
import type { AgentManifest } from "@clearideas/agent-runtime-contracts";
import type {
  ConnectionCredentialProvider,
  ModelAdapter,
  StepExecutor,
} from "@clearideas/agent-runtime-core";
import { MemoryRunStore } from "@clearideas/agent-runtime-store-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  composeHostRuntime,
  hostRuntimeDependencies,
  loadHostRuntime,
  mergeHostRuntimes,
  resolveHostStepExecutors,
} from "./host.js";
import { resolveServeConfig } from "./serve.js";

const manifest: AgentManifest = {
  schemaVersion: "1.0",
  model: { provider: "openai", model: "gpt-test" },
  steps: [{ id: "a", type: "prompt", prompt: "hi" }],
};
const model = (name: string): ModelAdapter & { name: string } => ({
  name,
  generate: async () => ({ output: name, transcript: [] }),
});

describe("host composition", () => {
  it("grants webhooks only to a local operator unless the host supplies an authorizing executor", () => {
    const types = (
      trust: "local-operator" | "untrusted-request",
      runtime = {},
    ) =>
      resolveHostStepExecutors(runtime, trust).map((executor) => executor.type);
    expect(types("local-operator")).toContain("webhook");
    expect(types("untrusted-request")).not.toContain("webhook");
    const authorized: StepExecutor = {
      type: "webhook",
      execute: async () => ({}),
    };
    const resolved = resolveHostStepExecutors(
      { stepExecutors: [authorized] },
      "untrusted-request",
    );
    expect(resolved.find((executor) => executor.type === "webhook")).toBe(
      authorized,
    );
    expect(resolved.map((executor) => executor.type).sort()).toEqual([
      "approval",
      "code",
      "loop",
      "prompt",
      "sub-run",
      "webhook",
    ]);
  });

  it("lets later supplied runtimes take precedence and combines message options", () => {
    const credentials: ConnectionCredentialProvider = {
      getCredential: async () => ({ type: "bearer", token: "t" }) as never,
    };
    const composed = composeHostRuntime(
      manifest,
      emptyAgentRuntimeConfig(),
      [
        { model: model("module"), messages: { maxInlineBytes: 10 } },
        {
          model: model("host"),
          connectionCredentials: credentials,
          messages: { requireSignature: true },
        },
      ],
      {},
    );
    expect((composed.model as { name?: string }).name).toBe("host");
    expect(composed.messages).toEqual({
      maxInlineBytes: 10,
      requireSignature: true,
    });
    const merged = mergeHostRuntimes(
      { eventSinks: [{ emit: () => undefined }] },
      { eventSinks: [{ emit: () => undefined }] },
    );
    expect(merged.eventSinks).toHaveLength(2);
  });

  it("assembles runtime dependencies with the history compactor", () => {
    const dependencies = hostRuntimeDependencies(
      { model: model("m"), messages: { requireSignature: true } },
      { trust: "untrusted-request", runStore: new MemoryRunStore() },
    );
    expect(dependencies.messages?.compactor).toBeDefined();
    expect(dependencies.messages?.requireSignature).toBe(true);
    expect(
      [...dependencies.stepExecutors].map((executor) => executor.type),
    ).not.toContain("webhook");
  });

  it("rejects runtime modules whose adapters do not implement their ports", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-host-"));
    try {
      const file = path.join(directory, "bad.mjs");
      await writeFile(file, "export const model = { notGenerate() {} };");
      await expect(
        loadHostRuntime(file, { manifest, storeDirectory: directory }),
      ).rejects.toThrow(/must implement ModelAdapter.generate/u);
      const good = path.join(directory, "good.mjs");
      await writeFile(
        good,
        "export const messages = { requireSignature: true };",
      );
      await expect(
        loadHostRuntime(good, { manifest, storeDirectory: directory }),
      ).resolves.toEqual({ messages: { requireSignature: true } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("serve configuration resolution", () => {
  let directory: string;
  const MANIFEST = `schemaVersion: "1.0"
id: review
model: { provider: openai, model: gpt-test }
messages: { required: true }
steps: [{ id: a, type: prompt, systemPrompt: S., history: all }]
`;
  const SERVER = `version: "1.0"
models:
  - { name: from-file, manifest: review.agent.yaml }
`;
  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(tmpdir(), "agent-runtime-serve-config-"),
    );
    await writeFile(path.join(directory, "review.agent.yaml"), MANIFEST);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("uses a discovered server file when no manifest is given", async () => {
    await expect(resolveServeConfig({ cwd: directory }, {})).rejects.toThrow(
      /No server configuration found. Looked for agent-runtime\.server\.yaml/u,
    );
    await writeFile(path.join(directory, "agent-runtime.server.yaml"), SERVER);
    const { loaded, notes } = await resolveServeConfig({ cwd: directory }, {});
    expect(loaded.config.models[0]!.name).toBe("from-file");
    expect(notes[0]).toContain("agent-runtime.server.yaml");
  });

  it("lets an explicit manifest win over a discovered file, with a note", async () => {
    await writeFile(path.join(directory, "agent-runtime.server.yaml"), SERVER);
    const { loaded, notes } = await resolveServeConfig(
      {
        cwd: directory,
        manifest: "review.agent.yaml",
        servedModelName: "document-reviewer",
      },
      {},
    );
    expect(loaded.config.models.map((entry) => entry.name)).toEqual([
      "document-reviewer",
    ]);
    expect(notes).toEqual([
      "Ignoring agent-runtime.server.yaml: a manifest argument selects single-manifest mode.",
    ]);
    const quiet = await resolveServeConfig(
      { cwd: directory, manifest: "review.agent.yaml", noServerConfig: true },
      {},
    );
    expect(quiet.notes).toEqual([]);
    expect(quiet.loaded.config.models[0]!.name).toBe("review");
  });

  it("refuses ambiguous or missing sources", async () => {
    await expect(
      resolveServeConfig(
        {
          cwd: directory,
          manifest: "review.agent.yaml",
          serverConfig: "x.yaml",
        },
        {},
      ),
    ).rejects.toThrow(/not both/u);
    await expect(
      resolveServeConfig({ cwd: directory, serverConfig: "missing.yaml" }, {}),
    ).rejects.toThrow(/Server configuration not found/u);
    await writeFile(path.join(directory, "server.yaml"), SERVER);
    await expect(
      resolveServeConfig(
        { cwd: directory, serverConfig: "server.yaml", servedModelName: "x" },
        {},
      ),
    ).rejects.toThrow(/apply to single-manifest mode/u);
  });

  it("lets --config and --runtime-module override a configuration file", async () => {
    await writeFile(path.join(directory, "server.yaml"), SERVER);
    const { loaded } = await resolveServeConfig(
      {
        cwd: directory,
        serverConfig: "server.yaml",
        runtimeConfig: "other.config.yaml",
        runtimeModule: "scripted.mjs",
      },
      {},
    );
    expect(loaded.config.runtimeConfig).toBe(
      path.join(directory, "other.config.yaml"),
    );
    expect(loaded.config.runtimeModule).toBe(
      path.join(directory, "scripted.mjs"),
    );
  });

  it("adds an API key from the environment and applies command-line overrides", async () => {
    await writeFile(path.join(directory, "server.yaml"), SERVER);
    const implicit = await resolveServeConfig(
      {
        cwd: directory,
        serverConfig: "server.yaml",
        port: 9000,
        host: "0.0.0.0",
      },
      { AGENT_RUNTIME_API_KEY: "k" },
    );
    expect(implicit.loaded.config.server).toMatchObject({
      port: 9000,
      host: "0.0.0.0",
    });
    expect(implicit.loaded.config.auth.apiKeys).toEqual([
      { id: "default", key: { env: "AGENT_RUNTIME_API_KEY" }, models: "*" },
    ]);
    const none = await resolveServeConfig(
      { cwd: directory, serverConfig: "server.yaml" },
      {},
    );
    expect(none.loaded.config.auth.apiKeys).toEqual([]);
    await expect(
      resolveServeConfig(
        { cwd: directory, serverConfig: "server.yaml", apiKeyEnv: "MISSING" },
        {},
      ),
    ).rejects.toThrow(/MISSING, which is not set/u);
  });
});
