import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { WorkspaceMode } from "@clearideas/agent-runtime-contracts";
import type {
  WorkspaceEntry,
  WorkspaceLimits,
  WorkspaceStore,
} from "@clearideas/agent-runtime-core";
import {
  assertWorkspacePath,
  isSafeWorkspacePath,
} from "@clearideas/agent-runtime-core";

import {
  DEFAULT_WORKSPACE_MAX_FILE_BYTES,
  DEFAULT_WORKSPACE_MAX_FILES,
  DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
  WorkspacePathFilter,
  compareNames,
  positiveInteger,
  throwIfAborted,
} from "./workspace-common.js";

export interface LocalDirectoryWorkspaceOptions {
  /** Host directory that becomes the workspace root. */
  root: string;
  /** Defaults to read. */
  mode?: WorkspaceMode;
  /** Glob allowlist over relative file paths. Defaults to every safe path. */
  include?: string[];
  /** Glob denylist over relative file and directory paths. */
  exclude?: string[];
  /** Ceiling on enumerated files. Defaults to 5000. */
  maxFiles?: number;
  /** Ceiling on bytes read or written for one file. Defaults to 1 MiB. */
  maxFileBytes?: number;
  /** Ceiling on total staged bytes, advertised to the run sandbox. Defaults to 100 MiB. */
  maxTotalBytes?: number;
  /** Ceiling on directory entries visited by one enumeration. Defaults to 200000. */
  maxScanEntries?: number;
}

const DEFAULT_MAX_SCAN_ENTRIES = 200_000;

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const writeAtomically = async (
  filePath: string,
  data: Uint8Array,
  mode: number,
): Promise<void> => {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", mode);
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

/**
 * A workspace backed by a host directory. It enumerates and moves opaque
 * bytes only. Every path is confined beneath the root, symbolic links are
 * never followed, hidden entries are unaddressable, invisible paths are
 * neither enumerated nor readable, and sizes are bounded.
 */
export class LocalDirectoryWorkspace implements WorkspaceStore {
  readonly mode: WorkspaceMode;
  readonly limits: WorkspaceLimits;
  readonly attachable?: { kind: "local-directory"; root: string };
  readonly #root: string;
  readonly #filter: WorkspacePathFilter;
  readonly #maxScanEntries: number;

  constructor(options: LocalDirectoryWorkspaceOptions) {
    if (!options.root.trim())
      throw new Error("LocalDirectoryWorkspace requires a root directory.");
    this.#root = path.resolve(options.root);
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
    this.#maxScanEntries = positiveInteger(
      options.maxScanEntries,
      DEFAULT_MAX_SCAN_ENTRIES,
      "Workspace maxScanEntries",
    );
    if (this.#filter.isUnfiltered) {
      this.attachable = { kind: "local-directory", root: this.#root };
    }
  }

  get root(): string {
    return this.#root;
  }

  async entries(
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceEntry[]> {
    const entries: WorkspaceEntry[] = [];
    const pending: string[] = [""];
    let visited = 0;
    while (pending.length > 0) {
      throwIfAborted(options.signal);
      const directory = pending.shift()!;
      let children: Dirent[];
      try {
        children = await readdir(this.#absolute(directory), {
          withFileTypes: true,
        });
      } catch (error) {
        if (isMissing(error) && directory === "") return [];
        throw error;
      }
      children.sort((left, right) => compareNames(left.name, right.name));
      for (const child of children) {
        visited += 1;
        if (visited > this.#maxScanEntries) {
          throw new Error(
            `Workspace enumeration exceeded ${this.#maxScanEntries} directory entries.`,
          );
        }
        const relativePath = directory
          ? `${directory}/${child.name}`
          : child.name;
        if (!isSafeWorkspacePath(relativePath)) continue;
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          if (!this.#filter.isDirectoryExcluded(relativePath))
            pending.push(relativePath);
          continue;
        }
        if (!child.isFile() || !this.#filter.isVisible(relativePath)) continue;
        const stats = await lstat(this.#absolute(relativePath));
        if (!stats.isFile()) continue;
        entries.push({
          path: relativePath,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        });
        if (entries.length > this.limits.maxFiles!) {
          throw new Error(
            `Workspace contains more than ${this.limits.maxFiles} visible files.`,
          );
        }
      }
    }
    entries.sort((left, right) => compareNames(left.path, right.path));
    return entries;
  }

  async read(
    relativePath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    throwIfAborted(options.signal);
    const entry = await this.#statVisibleFile(relativePath);
    if (entry.size > this.limits.maxFileBytes!) {
      throw new Error(
        `Workspace file ${relativePath} is ${entry.size} bytes, exceeding the ${this.limits.maxFileBytes}-byte limit.`,
      );
    }
    const data = await readFile(this.#absolute(entry.path));
    if (data.byteLength > this.limits.maxFileBytes!) {
      throw new Error(
        `Workspace file ${relativePath} exceeds the ${this.limits.maxFileBytes}-byte limit.`,
      );
    }
    return data;
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
    await this.#assertNoSymbolicLinks(target);
    const absolute = this.#absolute(target);
    const existing = await lstat(absolute).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (existing && !existing.isFile()) {
      throw new Error(`Workspace path ${relativePath} is not a regular file.`);
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeAtomically(absolute, data, existing?.mode ?? 0o600);
    const written = await lstat(absolute);
    return {
      path: target,
      size: written.size,
      modifiedAt: written.mtime.toISOString(),
    };
  }

  async delete(
    relativePath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    this.#assertWritable();
    throwIfAborted(options.signal);
    const entry = await this.#statVisibleFile(relativePath);
    await unlink(this.#absolute(entry.path));
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

  #absolute(relativePath: string): string {
    const absolute = relativePath
      ? path.resolve(this.#root, ...relativePath.split("/"))
      : this.#root;
    if (
      absolute !== this.#root &&
      !absolute.startsWith(`${this.#root}${path.sep}`)
    ) {
      throw new Error(`Workspace path escapes the root: ${relativePath}`);
    }
    return absolute;
  }

  async #assertNoSymbolicLinks(relativePath: string): Promise<void> {
    let current = this.#root;
    for (const segment of relativePath.split("/")) {
      current = path.join(current, segment);
      const stats = await lstat(current).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (!stats) return;
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Workspace path ${relativePath} crosses a symbolic link.`,
        );
      }
    }
  }

  async #statVisibleFile(relativePath: string): Promise<WorkspaceEntry> {
    const target = this.#visiblePath(relativePath);
    await this.#assertNoSymbolicLinks(target);
    const stats = await lstat(this.#absolute(target)).catch(
      (error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      },
    );
    if (!stats || !stats.isFile()) {
      throw new Error(`Workspace file is not available: ${relativePath}`);
    }
    return {
      path: target,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  }
}
