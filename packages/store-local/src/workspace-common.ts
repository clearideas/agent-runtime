const MAXIMUM_GLOB_LENGTH = 512;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Compile a small, deterministic glob dialect to a RegExp: `**` matches any
 * number of path segments, `*` matches within a segment, and `?` matches one
 * character. Patterns are anchored to the complete relative path. Globs are
 * applied to file names only, never to content.
 */
export const compileGlob = (pattern: string): RegExp => {
  if (!pattern.trim() || pattern.length > MAXIMUM_GLOB_LENGTH) {
    throw new Error(`Invalid workspace glob: ${pattern}`);
  }
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const followedBySlash = pattern[index + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 3 : 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += escapeRegExp(character);
    index += 1;
  }
  return new RegExp(`^${source}$`, "u");
};

export interface WorkspaceVisibility {
  include?: readonly string[] | undefined;
  exclude?: readonly string[] | undefined;
}

export class WorkspacePathFilter {
  readonly #include: RegExp[];
  readonly #exclude: RegExp[];

  constructor(visibility: WorkspaceVisibility = {}) {
    this.#include = (visibility.include ?? []).map(compileGlob);
    this.#exclude = (visibility.exclude ?? []).map(compileGlob);
  }

  get isUnfiltered(): boolean {
    return this.#include.length === 0 && this.#exclude.length === 0;
  }

  /** True when a file path may be enumerated, read, written, or deleted. */
  isVisible(relativePath: string): boolean {
    if (this.#exclude.some((pattern) => pattern.test(relativePath)))
      return false;
    return (
      this.#include.length === 0 ||
      this.#include.some((pattern) => pattern.test(relativePath))
    );
  }

  /** True when a directory subtree is excluded as a whole and can be pruned. */
  isDirectoryExcluded(relativeDirectory: string): boolean {
    const probe = `${relativeDirectory}/`;
    return this.#exclude.some((pattern) => pattern.test(probe));
  }
}

export const positiveInteger = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
};

export const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Workspace operation was aborted");
};

export const compareNames = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const DEFAULT_WORKSPACE_MAX_FILES = 5_000;
export const DEFAULT_WORKSPACE_MAX_FILE_BYTES = 1_048_576;
export const DEFAULT_WORKSPACE_MAX_TOTAL_BYTES = 100 * 1_048_576;
