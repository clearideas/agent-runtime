/**
 * Deterministic, model-free reduction. Every function is pure: the same
 * input and budget always produce the same output, so a pruned view can be
 * rebuilt identically on resume.
 */
import type {
  ContentPart,
  JsonValue,
  ToolResult,
} from "@clearideas/agent-runtime-contracts";

import {
  headWithinBytes,
  jsonBytes,
  jsonTextBytes,
  tailWithinBytes,
} from "./measure.js";

const omissionMarker = (omittedCharacters: number, label?: string): string =>
  `\n…[agent-runtime omitted ${omittedCharacters} characters${label ? ` of ${label}` : ""} to fit the context window]…\n`;

/**
 * Keep the beginning and end of `text` within `maxBytes` (JSON-escaped), with
 * a marker where content was removed. Beginnings usually carry structure and
 * endings carry conclusions, so both are kept (70% / 30%).
 */
export const pruneText = (
  text: string,
  maxBytes: number,
  label?: string,
): string => {
  if (jsonTextBytes(text) <= maxBytes) return text;
  const marker = omissionMarker(text.length, label);
  const available = maxBytes - jsonTextBytes(marker);
  if (available <= 16) return headWithinBytes(marker.trim(), maxBytes);
  const head = headWithinBytes(text, Math.floor(available * 0.7));
  const tail = tailWithinBytes(
    text.slice(head.length),
    available - jsonTextBytes(head),
  );
  const omitted = text.length - head.length - tail.length;
  return `${head}${omissionMarker(omitted, label)}${tail}`;
};

type Leaf =
  | { kind: "string"; size: number; set(value: JsonValue): void; value: string }
  | {
      kind: "array";
      size: number;
      set(value: JsonValue): void;
      value: JsonValue[];
    };

const collectLeaves = (
  value: JsonValue,
  set: (value: JsonValue) => void,
  leaves: Leaf[],
): void => {
  if (typeof value === "string") {
    leaves.push({ kind: "string", size: jsonBytes(value), set, value });
    return;
  }
  if (Array.isArray(value)) {
    leaves.push({ kind: "array", size: jsonBytes(value), set, value });
    value.forEach((item, index) =>
      collectLeaves(item, (next) => (value[index] = next), leaves),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      collectLeaves(value[key]!, (next) => (value[key] = next), leaves);
    }
  }
};

const pruneArray = (items: JsonValue[], maxBytes: number): JsonValue[] => {
  if (jsonBytes(items) <= maxBytes || items.length <= 1) return items;
  let keep = items.length - 1;
  while (keep > 0) {
    const head = Math.ceil(keep * 0.7);
    const tail = keep - head;
    const candidate: JsonValue[] = [
      ...items.slice(0, head),
      `…[agent-runtime omitted ${items.length - keep} of ${items.length} items]…`,
      ...items.slice(items.length - tail),
    ];
    if (jsonBytes(candidate) <= maxBytes) return candidate;
    keep = keep > 16 ? Math.floor(keep * 0.75) : keep - 1;
  }
  return [`…[agent-runtime omitted all ${items.length} items]…`];
};

/**
 * Reduce a JSON value to at most `maxBytes` of JSON text. Large strings are
 * clipped and long arrays lose middle items, largest first, so the result
 * stays valid JSON whenever possible. Returns the JSON text.
 */
export const pruneJson = (value: JsonValue, maxBytes: number): string => {
  const original = JSON.stringify(value);
  if (jsonBytes(value) <= maxBytes) return original;
  if (typeof value === "string")
    return JSON.stringify(pruneText(value, maxBytes - 2));
  const working = structuredClone(value);
  for (let round = 0; round < 64; round += 1) {
    const size = jsonBytes(working);
    if (size <= maxBytes) return JSON.stringify(working);
    const overflow = size - maxBytes;
    const leaves: Leaf[] = [];
    collectLeaves(working, () => undefined, leaves);
    // The root itself cannot be replaced through its setter; skip it.
    const candidates = leaves
      .filter((leaf) => leaf.value !== working)
      .sort((left, right) => right.size - left.size);
    const largest = candidates[0];
    if (!largest || largest.size < 64) break;
    const target = Math.max(32, largest.size - overflow - 64);
    if (largest.kind === "string") {
      largest.set(pruneText(largest.value, target - 2));
    } else {
      largest.set(pruneArray(largest.value, target));
    }
  }
  if (Array.isArray(working)) {
    const pruned = pruneArray(working, maxBytes);
    if (jsonBytes(pruned) <= maxBytes) return JSON.stringify(pruned);
  }
  return pruneText(original, maxBytes);
};

const previewOf = (result: ToolResult, maxBytes: number): string => {
  const source =
    result.error != null
      ? result.error.message
      : typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output ?? null);
  return pruneText(source, maxBytes);
};

/** Replace a tool result's payload with a short, clearly marked stub. */
export const stubToolResultPart = (
  part: Extract<ContentPart, { type: "tool-result" }>,
  previewBytes = 200,
): Extract<ContentPart, { type: "tool-result" }> => {
  const { result } = part;
  const artifacts = result.artifacts?.map((artifact) => artifact.name) ?? [];
  const stub: JsonValue = {
    agentRuntime: "omitted",
    note: "This earlier tool output was removed to fit the context window. Call the tool again if you need it.",
    originalBytes: jsonBytes(result.output ?? result.error ?? null),
    preview: previewOf(result, previewBytes),
    ...(artifacts.length > 0 ? { omittedArtifacts: artifacts } : {}),
  };
  return {
    ...part,
    result: {
      callId: result.callId,
      name: result.name,
      ...(result.error
        ? {
            error: {
              ...result.error,
              message: previewOf(result, previewBytes),
            },
          }
        : { output: stub }),
    },
  };
};

/** Clip a tool result's payload to `maxBytes`, keeping as much as fits. */
export const clipToolResultPart = (
  part: Extract<ContentPart, { type: "tool-result" }>,
  maxBytes: number,
): Extract<ContentPart, { type: "tool-result" }> => {
  const { result } = part;
  const artifacts = result.artifacts?.map((artifact) => artifact.name) ?? [];
  const note =
    artifacts.length > 0
      ? { omittedArtifacts: artifacts }
      : ({} as Record<string, JsonValue>);
  if (result.error) {
    return {
      ...part,
      result: {
        callId: result.callId,
        name: result.name,
        error: {
          ...result.error,
          message: pruneText(result.error.message, maxBytes),
        },
      },
    };
  }
  const output = result.output ?? null;
  const clipped =
    typeof output === "string"
      ? pruneText(output, maxBytes)
      : pruneJson(output, maxBytes);
  return {
    ...part,
    result: {
      callId: result.callId,
      name: result.name,
      output:
        artifacts.length > 0
          ? {
              agentRuntime: "clipped",
              output: clipped,
              ...note,
            }
          : typeof output === "string"
            ? clipped
            : {
                agentRuntime: "clipped",
                note: "This tool output was shortened to fit the context window.",
                output: clipped,
              },
    },
  };
};
