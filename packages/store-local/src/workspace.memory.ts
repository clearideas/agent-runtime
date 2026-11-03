import type { WorkspaceMode } from "@clearideas/agent-runtime-contracts";
import type {
  WorkspaceEntry,
  WorkspaceLimits,
  WorkspaceStore,
} from "@clearideas/agent-runtime-core";
import { assertWorkspacePath } from "@clearideas/agent-runtime-core";

import {
  DEFAULT_WORKSPACE_MAX_FILE_BYTES,
  DEFAULT_WORKSPACE_MAX_FILES,
  DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
  WorkspacePathFilter,
  compareNames,
  positiveInteger,
  throwIfAborted,
} from "./workspace-common.js";

export interface MemoryWorkspaceOptions {
  mode?: WorkspaceMode;
  /** Initial files keyed by relative path. Strings are stored as UTF-8. */
  files?: Record<string, Uint8Array | string>;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => Date;
}

interface StoredFile {
  data: Uint8Array;
  modifiedAt: string;
}

/** An in-memory workspace for tests, examples, and ephemeral embedding hosts. */
export class MemoryWorkspace implements WorkspaceStore {
  readonly mode: WorkspaceMode;
  readonly limits: WorkspaceLimits;
  readonly #files = new Map<string, StoredFile>();
  readonly #filter: WorkspacePathFilter;
  readonly #now: () => Date;

  constructor(options: MemoryWorkspaceOptions = {}) {
    this.mode = options.mode ?? "read";
    this.#filter = new WorkspacePathFilter(options);
    this.limits = {
      maxFiles: positiveInteger(
        options.maxFiles,
        DEFAULT_WORKSPACE_MAX_FILES,
        "Workspace maxFiles",
      ),
      maxFileBytes: positiveInteger(
        options.maxFileBytes,
        DEFAULT_WORKSPACE_MAX_FILE_BYTES,
        "Workspace maxFileBytes",
      ),
      maxTotalBytes: positiveInteger(
        options.maxTotalBytes,
        DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
        "Workspace maxTotalBytes",
      ),
    };
    this.#now = options.now ?? (() => new Date());
    for (const [relativePath, content] of Object.entries(options.files ?? {})) {
      this.#store(assertWorkspacePath(relativePath), content);
    }
  }

  /** Current file paths, for assertions in tests. */
  get paths(): string[] {
    return [...this.#files.keys()].sort(compareNames);
  }

  /** Current file contents decoded as UTF-8, for assertions in tests. */
  text(relativePath: string): string | undefined {
    const stored = this.#files.get(relativePath);
    return stored ? new TextDecoder().decode(stored.data) : undefined;
  }

  async entries(
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceEntry[]> {
    throwIfAborted(options.signal);
    return this.paths
      .filter((relativePath) => this.#filter.isVisible(relativePath))
      .map((relativePath) =>
        this.#entry(relativePath, this.#files.get(relativePath)!),
      );
  }

  async read(
    relativePath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    throwIfAborted(options.signal);
    const target = this.#visiblePath(relativePath);
    const stored = this.#files.get(target);
    if (!stored)
      throw new Error(`Workspace file is not available: ${relativePath}`);
    if (stored.data.byteLength > this.limits.maxFileBytes!) {
      throw new Error(
        `Workspace file ${relativePath} exceeds the ${this.limits.maxFileBytes}-byte limit.`,
      );
    }
    return new Uint8Array(stored.data);
  }

  async write(
    relativePath: string,
    data: Uint8Array,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceEntry> {
    this.#assertWritable();
    throwIfAborted(options.signal);
    const target = this.#visiblePath(relativePath);
    if (data.byteLength > this.limits.maxFileBytes!) {
      throw new Error(
        `Workspace write to ${relativePath} is ${data.byteLength} bytes, exceeding the ${this.limits.maxFileBytes}-byte limit.`,
      );
    }
    if (!this.#files.has(target) && this.#files.size >= this.limits.maxFiles!) {
      throw new Error(
        `Workspace cannot hold more than ${this.limits.maxFiles} files.`,
      );
    }
    return this.#entry(target, this.#store(target, data));
  }

  async delete(
    relativePath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    this.#assertWritable();
    throwIfAborted(options.signal);
    const target = this.#visiblePath(relativePath);
    if (!this.#files.delete(target)) {
      throw new Error(`Workspace file is not available: ${relativePath}`);
    }
  }

  #assertWritable(): void {
    if (this.mode !== "read_write") throw new Error("Workspace is read-only.");
  }

  #visiblePath(relativePath: string): string {
    const normalized = assertWorkspacePath(relativePath);
    if (!this.#filter.isVisible(normalized)) {
      throw new Error(`Workspace file is not available: ${relativePath}`);
    }
    return normalized;
  }

  #store(relativePath: string, content: Uint8Array | string): StoredFile {
    const stored: StoredFile = {
      data:
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : new Uint8Array(content),
      modifiedAt: this.#now().toISOString(),
    };
    this.#files.set(relativePath, stored);
    return stored;
  }

  #entry(relativePath: string, stored: StoredFile): WorkspaceEntry {
    return {
      path: relativePath,
      size: stored.data.byteLength,
      modifiedAt: stored.modifiedAt,
    };
  }
}
