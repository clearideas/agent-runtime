import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseAgentManifest,
  type AgentManifest,
  type CompletedRunRecord,
  type RunCheckpoint,
  type RunError,
  type RunRecord,
  type RunStatus,
  type StepResult,
} from "@clearideas/agent-runtime";
import { parse as parseYaml } from "yaml";

export interface SavedManifest {
  id: string;
  source: string;
  manifest: AgentManifest;
}

type StoredRunRecord = RunRecord &
  Partial<Pick<CompletedRunRecord, "output">> & {
    error?: RunError;
  };

export interface SavedRunSummary {
  runId: string;
  status: RunStatus;
  agentId: string | null;
  agentName: string;
  updatedAt: string;
  output: CompletedRunRecord["output"] | null;
  stepResults: StepResult[];
  error: RunError | null;
}

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

const readJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

const parseManifest = (source: string): AgentManifest => {
  if (!source.trim()) {
    throw new Error("Manifest source is required.");
  }
  return parseAgentManifest(parseYaml(source));
};

export class AgentRunnerStorage {
  readonly manifestFile: string;
  readonly runDirectory: string;
  readonly seedManifestPath: string;

  constructor(dataDirectory: string, seedManifestPath: string) {
    this.manifestFile = path.join(dataDirectory, "manifests.json");
    this.runDirectory = path.join(dataDirectory, "runtime", "runs");
    this.seedManifestPath = seedManifestPath;
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.manifestFile), { recursive: true });
    try {
      await readFile(this.manifestFile);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const source = await readFile(this.seedManifestPath, "utf8");
      await this.writeManifests([
        { id: "manifest-hello", source, manifest: parseManifest(source) },
      ]);
    }
  }

  async listManifests(): Promise<SavedManifest[]> {
    return JSON.parse(
      await readFile(this.manifestFile, "utf8"),
    ) as SavedManifest[];
  }

  async loadManifest(id: unknown): Promise<SavedManifest> {
    if (typeof id !== "string") throw new Error("Manifest id is required.");
    const manifest = (await this.listManifests()).find(
      (item) => item.id === id,
    );
    if (!manifest) throw new Error("Manifest not found.");
    return manifest;
  }

  async saveManifest(
    source: unknown,
    requestedId?: unknown,
  ): Promise<SavedManifest> {
    if (typeof source !== "string") {
      throw new Error("Manifest source is required.");
    }
    const manifest = parseManifest(source);
    const id = requestedId ?? `manifest-${randomUUID()}`;
    if (typeof id !== "string") throw new Error("Invalid manifest id.");

    const saved = { id, source, manifest };
    const manifests = await this.listManifests();
    const existing = manifests.findIndex((item) => item.id === id);
    if (existing === -1) manifests.push(saved);
    else manifests[existing] = saved;
    await this.writeManifests(manifests);
    return saved;
  }

  async listRuns(): Promise<SavedRunSummary[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.runDirectory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }

    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const directory = path.join(this.runDirectory, entry.name);
          const record = await readJson<StoredRunRecord>(
            path.join(directory, "run.json"),
          );
          if (!record) return null;
          const checkpoint = await readJson<RunCheckpoint>(
            path.join(directory, "checkpoint.json"),
          );
          return { record, stepResults: checkpoint?.stepResults ?? [] };
        }),
    );

    return records
      .filter((item): item is NonNullable<typeof item> => item != null)
      .sort((left, right) =>
        right.record.updatedAt.localeCompare(left.record.updatedAt),
      )
      .slice(0, 20)
      .map(({ record, stepResults }) => ({
        runId: record.runId,
        status: record.status,
        agentId: record.manifest?.id ?? null,
        agentName:
          record.manifest?.name ?? record.manifest?.id ?? "Untitled agent",
        updatedAt: record.updatedAt,
        output: record.output ?? null,
        stepResults,
        error: record.error ?? null,
      }));
  }

  private async writeManifests(manifests: SavedManifest[]): Promise<void> {
    await writeFile(
      this.manifestFile,
      `${JSON.stringify(manifests, null, 2)}\n`,
      "utf8",
    );
  }
}
