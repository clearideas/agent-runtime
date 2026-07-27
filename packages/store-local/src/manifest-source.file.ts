import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  parseAgentManifest,
  type AgentManifest,
} from "@clearideas/agent-runtime-contracts";
import type { AgentManifestSource } from "@clearideas/agent-runtime-core";
import { parse as parseYaml } from "yaml";

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

/** Loads and validates JSON or YAML manifests from a constrained directory. */
export class FileAgentManifestSource implements AgentManifestSource {
  readonly #rootDirectory: string;
  readonly #defaultReference: string | undefined;

  constructor(rootDirectory: string, defaultReference?: string) {
    if (!rootDirectory.trim())
      throw new Error("FileAgentManifestSource requires a root directory.");
    this.#rootDirectory = path.resolve(rootDirectory);
    this.#defaultReference = defaultReference;
  }

  async loadManifest(
    reference = this.#defaultReference,
  ): Promise<AgentManifest> {
    if (!reference?.trim())
      throw new Error("A manifest reference is required.");
    const filePath = this.#resolveReference(reference);
    const extension = path.extname(filePath).toLowerCase();
    if (![".json", ".yaml", ".yml"].includes(extension)) {
      throw new Error(
        `Unsupported manifest format "${extension || "(none)"}". Use .json, .yaml, or .yml.`,
      );
    }
    const [realRoot, realFile] = await Promise.all([
      realpath(this.#rootDirectory),
      realpath(filePath),
    ]);
    if (!isInside(realRoot, realFile)) {
      throw new Error(
        "Manifest reference resolves outside the configured root.",
      );
    }
    const source = await readFile(realFile, "utf8");
    const input: unknown =
      extension === ".json" ? JSON.parse(source) : parseYaml(source);
    return parseAgentManifest(input);
  }

  #resolveReference(reference: string): string {
    if (path.isAbsolute(reference))
      throw new Error(
        "Manifest references must be relative to the configured root.",
      );
    const candidate = path.resolve(this.#rootDirectory, reference);
    if (!isInside(this.#rootDirectory, candidate)) {
      throw new Error("Manifest reference escapes the configured root.");
    }
    return candidate;
  }
}
