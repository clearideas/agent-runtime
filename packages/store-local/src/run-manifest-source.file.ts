import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  parseAgentRunManifest,
  type AgentRunManifest,
} from "@clearideas/agent-runtime-contracts";
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

/** Loads and validates an agent run manifest from a constrained directory. */
export class FileAgentRunManifestSource {
  readonly #rootDirectory: string;
  readonly #defaultReference: string | undefined;

  constructor(rootDirectory: string, defaultReference?: string) {
    if (!rootDirectory.trim()) {
      throw new Error("FileAgentRunManifestSource requires a root directory.");
    }
    this.#rootDirectory = path.resolve(rootDirectory);
    this.#defaultReference = defaultReference;
  }

  async loadAgentRunManifest(
    reference = this.#defaultReference,
  ): Promise<AgentRunManifest> {
    if (!reference?.trim())
      throw new Error("An agent run manifest reference is required.");
    if (path.isAbsolute(reference)) {
      throw new Error(
        "Agent run manifest references must be relative to the configured root.",
      );
    }
    const filePath = path.resolve(this.#rootDirectory, reference);
    if (!isInside(this.#rootDirectory, filePath)) {
      throw new Error(
        "Agent run manifest reference escapes the configured root.",
      );
    }
    const extension = path.extname(filePath).toLowerCase();
    if (![".json", ".yaml", ".yml"].includes(extension)) {
      throw new Error(
        `Unsupported agent run manifest format "${extension || "(none)"}". Use .json, .yaml, or .yml.`,
      );
    }
    const [realRoot, realFile] = await Promise.all([
      realpath(this.#rootDirectory),
      realpath(filePath),
    ]);
    if (!isInside(realRoot, realFile)) {
      throw new Error(
        "Agent run manifest reference resolves outside the configured root.",
      );
    }
    const source = await readFile(realFile, "utf8");
    return parseAgentRunManifest(
      extension === ".json" ? JSON.parse(source) : parseYaml(source),
    );
  }
}
