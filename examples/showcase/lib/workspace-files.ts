/**
 * Host-side helpers for demo workspaces: seed a directory from a fixture and
 * describe it for the browser, including files the agent can never see.
 *
 * Visibility is decided by the same LocalDirectoryWorkspace store Agent
 * Runtime uses, so "hidden" in the UI means "never staged into the sandbox".
 */
import { cp, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { LocalDirectoryWorkspace } from "@clearideas/agent-runtime";

export interface HostFile {
  path: string;
  size: number;
  /** True when the workspace store exposes the file to the run sandbox. */
  visible: boolean;
  /** Why an invisible file is hidden. */
  hiddenReason?: string;
  /** Text content for small files, so the browser can render diffs. */
  content?: string;
  /** Fixture content when it differs from the current file. */
  baseline?: string;
  status: "unchanged" | "modified" | "created";
}

const MAX_TEXT_BYTES = 64 * 1024;

/** Replace `target` with a fresh copy of `fixture`. */
export const seedWorkspace = async (fixture: string, target: string) => {
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(fixture, target, { recursive: true });
};

const walk = async (root: string, relative = ""): Promise<string[]> => {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(root, child)));
    else files.push(child);
  }
  return files.sort();
};

const readText = async (file: string) => {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_TEXT_BYTES) return undefined;
  const bytes = await readFile(file);
  return bytes.includes(0) ? undefined : bytes.toString("utf8");
};

export const describeWorkspace = async (options: {
  root: string;
  fixture: string;
  include?: string[];
  exclude?: string[];
  maxFileBytes?: number;
}): Promise<HostFile[]> => {
  const store = new LocalDirectoryWorkspace({
    root: options.root,
    mode: "read",
    ...(options.include ? { include: options.include } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
  });
  const visible = new Set(
    (await store.entries().catch(() => [])).map((entry) => entry.path),
  );
  const files: HostFile[] = [];
  for (const relative of await walk(options.root)) {
    const absolute = path.join(options.root, relative);
    const info = await lstat(absolute);
    const content = await readText(absolute);
    const baseline = await readText(path.join(options.fixture, relative));
    const original = await readFile(path.join(options.fixture, relative)).catch(
      () => undefined,
    );
    const current = info.isFile() ? await readFile(absolute) : undefined;
    const isVisible =
      visible.has(relative) &&
      !(options.maxFileBytes && info.size > options.maxFileBytes);
    const hiddenReason = info.isSymbolicLink()
      ? "symbolic links are never followed"
      : relative.split("/").some((segment) => !/^[A-Za-z0-9_]/u.test(segment))
        ? "dot-files are never addressable"
        : options.maxFileBytes && info.size > options.maxFileBytes
          ? "larger than the host's file size limit"
          : "outside the host's include/exclude globs";
    files.push({
      path: relative,
      size: info.size,
      visible: isVisible,
      ...(isVisible ? {} : { hiddenReason }),
      ...(content !== undefined ? { content } : {}),
      ...(baseline !== undefined && baseline !== content ? { baseline } : {}),
      // Only files the agent can see can have been changed by it.
      status: !isVisible
        ? "unchanged"
        : !original
          ? "created"
          : current && Buffer.compare(original, current) === 0
            ? "unchanged"
            : "modified",
    });
  }
  return files;
};
