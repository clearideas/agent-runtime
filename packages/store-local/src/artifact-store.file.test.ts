import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileArtifactStore } from "./artifact-store.file.js";

describe("FileArtifactStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-artifacts-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips bytes with durable metadata and integrity information", async () => {
    const store = new FileArtifactStore(directory);
    const bytes = Buffer.from([0, 1, 2, 255]);

    const ref = await store.put({
      name: "../report.bin",
      mediaType: "application/octet-stream",
      data: bytes,
      metadata: { source: "test" },
    });
    const artifact = await store.get(ref);

    expect(artifact.data).toEqual(bytes);
    expect(artifact.ref).toEqual(ref);
    expect(ref.size).toBe(4);
    expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(ref.uri).toMatch(/^file:/);
    await expect(access(fileURLToPath(ref.uri!))).resolves.toBeUndefined();
    expect(fileURLToPath(ref.uri!)).toContain(
      path.join(directory, "artifacts"),
    );
  });

  it("does not use caller-provided names as filesystem paths", async () => {
    const store = new FileArtifactStore(directory);
    const ref = await store.put({
      name: "../../outside.txt",
      mediaType: "text/plain",
      data: "safe",
    });

    expect(fileURLToPath(ref.uri!)).not.toContain("outside.txt");
    await expect(store.get(ref)).resolves.toMatchObject({
      data: Buffer.from("safe"),
    });
  });

  it("rejects empty artifact identifiers on reads", async () => {
    const store = new FileArtifactStore(directory);
    await expect(
      store.get({ id: "", name: "x", mediaType: "text/plain" }),
    ).rejects.toThrow("Artifact id cannot be empty");
  });

  it("does not interpret dot-segment artifact ids as directories", async () => {
    const store = new FileArtifactStore(directory);
    await expect(
      store.get({ id: "..", name: "x", mediaType: "text/plain" }),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("detects artifact data corruption on read", async () => {
    const store = new FileArtifactStore(directory);
    const ref = await store.put({
      name: "report.txt",
      mediaType: "text/plain",
      data: "original",
    });
    await writeFile(fileURLToPath(ref.uri!), "changed");

    await expect(store.get(ref)).rejects.toThrow(
      "Artifact integrity check failed",
    );
  });

  it("validates bytes against the caller reference when data and metadata are replaced", async () => {
    const store = new FileArtifactStore(directory);
    const ref = await store.put({
      name: "report.txt",
      mediaType: "text/plain",
      data: "original",
    });
    const dataPath = fileURLToPath(ref.uri!);
    const metadataPath = path.join(path.dirname(dataPath), "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const replacement = Buffer.from("changed!");

    metadata.ref.sha256 = createHash("sha256")
      .update(replacement)
      .digest("hex");
    metadata.ref.size = replacement.byteLength;
    await writeFile(dataPath, replacement);
    await writeFile(metadataPath, JSON.stringify(metadata));

    await expect(store.get(ref)).rejects.toThrow(
      "Artifact integrity check failed",
    );
  });
});
