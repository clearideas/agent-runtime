import {
  isSafeVariablePath,
  type JsonValue,
  type StatePatch,
  type VariableState,
} from "@clearideas/agent-runtime-contracts";

const clone = <T>(value: T): T => structuredClone(value);

const pathSegments = (path: string): string[] => {
  if (!isSafeVariablePath(path))
    throw new Error(`Unsafe variable path: ${path}`);
  return path.split(".").map((segment) => segment.trim());
};

export const getVariableAtPath = (
  state: Readonly<VariableState>,
  path: string,
): JsonValue | undefined => {
  let current: unknown = state;
  for (const segment of pathSegments(path)) {
    if (
      current == null ||
      typeof current !== "object" ||
      Array.isArray(current)
    )
      return undefined;
    current = (current as Record<string, JsonValue>)[segment];
  }
  return current as JsonValue | undefined;
};

/** Mutates a state snapshot at a validated dotted variable path. */
export const setVariableAtPath = (
  state: VariableState,
  path: string,
  value: JsonValue,
): void => {
  const segments = pathSegments(path);
  let current: Record<string, JsonValue> = state;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (
      existing == null ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, JsonValue>;
  }
  current[segments.at(-1)!] = clone(value);
};

/** Mutates a state snapshot by removing a validated dotted variable path. */
export const unsetVariableAtPath = (
  state: VariableState,
  path: string,
): void => {
  const segments = pathSegments(path);
  let current: Record<string, JsonValue> = state;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (
      existing == null ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    )
      return;
    current = existing as Record<string, JsonValue>;
  }
  delete current[segments.at(-1)!];
};

/** Applies a top-level variable patch without mutating either input. */
export const applyStatePatch = (
  state: Readonly<VariableState>,
  patch?: StatePatch,
): VariableState => {
  if (!patch) return clone(state);

  const next: VariableState = clone(state);

  for (const name of patch.unset ?? []) unsetVariableAtPath(next, name);
  for (const [name, value] of Object.entries(patch.set ?? {})) {
    setVariableAtPath(next, name, value as JsonValue);
  }

  return next;
};

export const snapshotState = (
  state: Readonly<VariableState>,
): Readonly<VariableState> => Object.freeze(clone(state));
