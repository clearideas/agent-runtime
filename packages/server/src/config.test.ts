import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultServedModelName,
  discoverServerConfigFile,
  loadServerConfig,
  parseDuration,
  parseServerConfig,
  singleManifestServerConfig,
} from "./config.js";

describe("parseDuration", () => {
  it("accepts milliseconds and unit suffixes", () => {
    expect(parseDuration(250)).toBe(250);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("15s")).toBe(15_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("7d")).toBe(604_800_000);
  });

  it("rejects malformed and non-positive durations", () => {
    expect(() => parseDuration("7 days")).toThrow(/Invalid duration/u);
    expect(() => parseDuration(0)).toThrow(/positive/u);
    expect(() => parseDuration("0s")).toThrow(/out of range/u);
  });
});

describe("server configuration schema", () => {
  const minimal = {
    version: "1.0",
    models: [{ name: "agent", manifest: "./agent.yaml" }],
  };

  it("applies safe defaults", () => {
    const config = parseServerConfig(minimal);
    expect(config.server).toMatchObject({
      host: "127.0.0.1",
      port: 8000,
      exposeErrors: false,
      allowUnauthenticated: false,
    });
    expect(config.store.driver).toBe("memory");
    expect(config.conversations).toMatchObject({
      match: "exact",
      onManifestChange: "continue",
      media: { urls: "reject", allowOrigins: [] },
    });
    expect(config.conversations.onUnrecognized).toBeUndefined();
    expect(config.models[0]).toMatchObject({
      clientInstructions: "drop",
      onDisconnect: "cancel",
      maxTokens: "ignore",
      stream: { mode: "auto", progress: "none", reasoning: "none" },
    });
  });

  it("parses durations in every time field", () => {
    const config = parseServerConfig({
      ...minimal,
      server: { requestTimeoutMs: "2m", shutdownGraceMs: 5000 },
      store: { retention: { completed: "1h", failed: "2d" } },
      conversations: { ledger: { ttl: "12h" } },
    });
    expect(config.server.requestTimeoutMs).toBe(120_000);
    expect(config.store.retention).toEqual({
      completed: 3_600_000,
      failed: 172_800_000,
    });
    expect(config.conversations.ledger.ttl).toBe(43_200_000);
  });

  it("rejects configurations that could not run as intended", () => {
    const problems = (input: unknown): string => {
      try {
        parseServerConfig(input);
        return "";
      } catch (error) {
        return String(error);
      }
    };
    expect(
      problems({ ...minimal, models: [...minimal.models, ...minimal.models] }),
    ).toContain("Duplicate served model name: agent");
    expect(
      problems({
        ...minimal,
        auth: {
          apiKeys: [{ id: "k", key: { env: "KEY" }, models: ["missing"] }],
        },
      }),
    ).toContain("names unknown model missing");
    expect(problems({ ...minimal, store: { driver: "sqlite" } })).toContain(
      "store.path is required",
    );
    expect(
      problems({ ...minimal, conversations: { media: { urls: "allow" } } }),
    ).toContain("requires at least one allowOrigins");
    expect(
      problems({ ...minimal, conversations: { ledger: { store: "shared" } } }),
    ).toContain("names unknown store");
    expect(problems({ ...minimal, surprise: true })).toContain(
      "Unrecognized key",
    );
    expect(
      problems({
        ...minimal,
        auth: {
          apiKeys: [{ id: "k", key: { sha256: "ABC" }, models: "*" }],
        },
      }),
    ).toContain("64 lowercase hex");
  });
});

describe("configuration files", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-server-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("discovers server files in order and resolves paths against the file", async () => {
    expect(await discoverServerConfigFile(directory)).toBeUndefined();
    await writeFile(
      path.join(directory, "agent-runtime.server.json"),
      JSON.stringify({
        version: "1.0",
        models: [{ name: "json", manifest: "agent.yaml" }],
      }),
    );
    await writeFile(
      path.join(directory, "agent-runtime.server.yml"),
      [
        'version: "1.0"',
        "runtimeConfig: ./runtime.yaml",
        "store: { driver: sqlite, path: state/runs.sqlite }",
        "models:",
        "  - name: yml",
        "    manifest: agents/agent.yaml",
      ].join("\n"),
    );
    const discovered = await discoverServerConfigFile(directory);
    expect(path.basename(discovered!)).toBe("agent-runtime.server.yml");
    const loaded = await loadServerConfig(discovered!);
    // What the file leaves out is durable, beside the file.
    expect(loaded.config.stores.default).toEqual({
      driver: "sqlite",
      path: path.join(directory, ".agent-runtime/serve/state.sqlite"),
    });
    expect(loaded.config.artifacts.path).toBe(
      path.join(directory, ".agent-runtime/serve/artifacts"),
    );
    expect(loaded.config.models[0]!.manifest).toBe(
      path.join(directory, "agents/agent.yaml"),
    );
    expect(loaded.config.runtimeConfig).toBe(
      path.join(directory, "runtime.yaml"),
    );
    expect(loaded.config.store.path).toBe(
      path.join(directory, "state/runs.sqlite"),
    );
  });

  it("keeps durable defaults for a file that leaves storage out", async () => {
    const file = path.join(directory, "server.yaml");
    await writeFile(
      file,
      'version: "1.0"\nstore: { retention: { completed: 1h } }\nmodels: [{ name: a, manifest: a.yaml }]\n',
    );
    const { config } = await loadServerConfig(file);
    expect(config.store).toEqual({
      driver: "sqlite",
      path: path.join(directory, ".agent-runtime/serve/runs.sqlite"),
      retention: { completed: 3_600_000, failed: 604_800_000 },
    });
    await writeFile(
      file,
      'version: "1.0"\nstore: { driver: memory }\nstores: { default: { driver: memory } }\nmodels: [{ name: a, manifest: a.yaml }]\n',
    );
    const explicit = (await loadServerConfig(file)).config;
    expect(explicit.store.driver).toBe("memory");
    expect(explicit.stores.default).toEqual({
      driver: "memory",
      maxEntries: 100_000,
    });
  });

  it("reports the file and field of a problem", async () => {
    const file = path.join(directory, "server.yaml");
    await writeFile(file, 'version: "1.0"\nmodels: []\n');
    await expect(loadServerConfig(file)).rejects.toThrow(
      /Invalid server configuration .*server\.yaml: models/u,
    );
    await expect(
      loadServerConfig(path.join(directory, "missing.yaml")),
    ).rejects.toThrow(/Server configuration not found/u);
  });
});

describe("single-manifest mode", () => {
  it("names the model after the manifest id, else the file", () => {
    expect(defaultServedModelName("/a/review.agent.yaml", "doc-review")).toBe(
      "doc-review",
    );
    expect(defaultServedModelName("/a/review.agent.yaml")).toBe("review");
    expect(defaultServedModelName("/a/My Agent.yml", "has space")).toBe(
      "My-Agent",
    );
  });

  it("keeps runs and the ledger in memory unless told otherwise", () => {
    const loaded = singleManifestServerConfig({
      manifest: "/agents/review.agent.yaml",
      servedModelName: "document-reviewer",
      input: { document: "last-user" },
    });
    expect(loaded.baseDirectory).toBe("/agents");
    expect(loaded.config.store.driver).toBe("memory");
    expect(loaded.config.stores.default).toEqual({
      driver: "memory",
      maxEntries: 100_000,
    });
    expect(loaded.config.models[0]).toMatchObject({
      name: "document-reviewer",
      manifest: "/agents/review.agent.yaml",
      input: { document: "last-user" },
    });
    expect(loaded.config.artifacts.path).toBeUndefined();
    const durable = singleManifestServerConfig({
      manifest: "/agents/review.agent.yaml",
      servedModelName: "document-reviewer",
      ledger: { driver: "sqlite", path: "/state/ledger.sqlite" },
    });
    expect(durable.config.artifacts.path).toBe("/state/artifacts");
  });
});
