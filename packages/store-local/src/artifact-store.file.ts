import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ArtifactRef } from "@clearideas/agent-runtime-contracts";
import type {
  ArtifactData,
  ArtifactInput,
  ArtifactStore,
} from "@clearideas/agent-runtime-core";

import { safePathComponent } from "./path-component.js";

interface StoredArtifact {
  ref: ArtifactRef;
}

const writeAtomically = async (
  filePath: string,
  data: Uint8Array | string,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

/** Stores artifact bytes and metadata beneath a caller-owned local directory. */
export class FileArtifactStore implements ArtifactStore {
  readonly #rootDirectory: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim())
      throw new Error("FileArtifactStore requires a root directory.");
    this.#rootDirectory = path.resolve(rootDirectory);
  }

  async put(input: ArtifactInput): Promise<ArtifactRef> {
    if (!input.name.trim()) throw new Error("Artifact name cannot be empty.");
    if (!input.mediaType.trim())
      throw new Error("Artifact media type cannot be empty.");

    const id = `artifact_${randomUUID()}`;
    const bytes =
      typeof input.data === "string"
        ? Buffer.from(input.data, "utf8")
        : Buffer.from(input.data);
    const dataPath = this.#dataPath(id);
    const ref: ArtifactRef = {
      id,
      name: input.name,
      mediaType: input.mediaType,
      uri: pathToFileURL(dataPath).href,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    await writeAtomically(dataPath, bytes);
    await writeAtomically(
      this.#metadataPath(id),
      `${JSON.stringify({ ref } satisfies StoredArtifact, null, 2)}\n`,
    );
    return ref;
  }

  async get(ref: ArtifactRef): Promise<ArtifactData> {
    const stored = JSON.parse(
      await readFile(this.#metadataPath(ref.id), "utf8"),
    ) as StoredArtifact;
    if (stored.ref.id !== ref.id)
      throw new Error(`Artifact metadata id mismatch: ${ref.id}`);
    if (
      stored.ref.name !== ref.name ||
      stored.ref.mediaType !== ref.mediaType
    ) {
      throw new Error(`Artifact reference mismatch: ${ref.id}`);
    }
    const data = await readFile(this.#dataPath(ref.id));
    const digest = createHash("sha256").update(data).digest("hex");
    if (
      (stored.ref.sha256 && stored.ref.sha256 !== digest) ||
      (ref.sha256 && ref.sha256 !== digest) ||
      (stored.ref.sha256 && ref.sha256 && stored.ref.sha256 !== ref.sha256)
    ) {
      throw new Error(`Artifact integrity check failed: ${ref.id}`);
    }
    if (
      (stored.ref.size != null && stored.ref.size !== data.byteLength) ||
      (ref.size != null && ref.size !== data.byteLength) ||
      (stored.ref.size != null &&
        ref.size != null &&
        stored.ref.size !== ref.size)
    ) {
      throw new Error(`Artifact size check failed: ${ref.id}`);
    }
    return {
      ref: stored.ref,
      data,
    };
  }

  #artifactDirectory(id: string): string {
    return path.join(
      this.#rootDirectory,
      "artifacts",
      safePathComponent(id, "Artifact id"),
    );
  }

  #dataPath(id: string): string {
    return path.join(this.#artifactDirectory(id), "data");
  }

  #metadataPath(id: string): string {
    return path.join(this.#artifactDirectory(id), "metadata.json");
  }
}
