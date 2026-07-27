import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileAgentManifestSource } from "./manifest-source.file.js";

const jsonManifest = {
  schemaVersion: "1.0",
  name: "Local manifest",
  variables: [{ key: "subject", type: "string", value: "Quarterly update" }],
  steps: [{ id: "draft", type: "prompt", prompt: "Draft {{subject}}" }],
};

describe("FileAgentManifestSource", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-manifests-"));
    await mkdir(path.join(directory, "nested"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("loads and validates JSON manifests", async () => {
    await writeFile(
      path.join(directory, "nested", "agent.json"),
      JSON.stringify(jsonManifest),
    );
    const source = new FileAgentManifestSource(directory, "nested/agent.json");

    await expect(source.loadManifest()).resolves.toEqual(jsonManifest);
  });

  it("loads and validates YAML manifests", async () => {
    await writeFile(
      path.join(directory, "agent.yaml"),
      'schemaVersion: "1.0"\nname: YAML agent\nsteps:\n  - id: draft\n    type: prompt\n    prompt: Write a draft\n',
    );

    await expect(
      new FileAgentManifestSource(directory).loadManifest("agent.yaml"),
    ).resolves.toMatchObject({
      schemaVersion: "1.0",
      name: "YAML agent",
      steps: [{ id: "draft", type: "prompt" }],
    });
  });

  it("rejects path traversal, absolute paths, and unknown formats", async () => {
    const source = new FileAgentManifestSource(directory);

    await expect(source.loadManifest("../agent.json")).rejects.toThrow(
      "escapes the configured root",
    );
    await expect(
      source.loadManifest(path.join(directory, "agent.json")),
    ).rejects.toThrow("must be relative");
    await expect(source.loadManifest("agent.txt")).rejects.toThrow(
      "Unsupported manifest format",
    );
  });

  it("returns contract validation errors for malformed manifests", async () => {
    await writeFile(
      path.join(directory, "bad.json"),
      JSON.stringify({ schemaVersion: "0", steps: [] }),
    );

    await expect(
      new FileAgentManifestSource(directory).loadManifest("bad.json"),
    ).rejects.toThrow();
  });

  it("rejects symlinks that resolve outside the configured root", async () => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "agent-runtime-outside-"),
    );
    try {
      const outsideManifest = path.join(outside, "agent.json");
      await writeFile(outsideManifest, JSON.stringify(jsonManifest));
      await symlink(outsideManifest, path.join(directory, "linked.json"));

      await expect(
        new FileAgentManifestSource(directory).loadManifest("linked.json"),
      ).rejects.toThrow("resolves outside the configured root");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
