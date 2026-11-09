/**
 * The durable transcript is never edited. Context reductions are recorded as
 * marker items, and the model's input is a pure function of the transcript:
 * markers hide superseded items, substitute reduced content, and insert
 * summaries. Resume rebuilds the same view without any model call.
 */
import type {
  ContentPart,
  JsonObject,
  JsonValue,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import type { ModelMessage } from "@clearideas/agent-runtime-core/ports";

export type ContextMarkerKind =
  /** A visible summary that replaces earlier items. */
  | "summary"
  /** A visible runtime note (removed rounds, tool-call limit, repair request). */
  | "note"
  /** An invisible substitution of item content (clipped or stubbed tool output). */
  | "rewrite"
  /** Invisible accounting for a completed summarizer call. */
  | "usage"
  /** Invisible reductions of the step's opening prompt variables. */
  | "input";

export interface InputSlotReduction {
  location: string;
  index: number;
  path: string;
  sourceHash: string;
  text: string;
  strategy: "summarize" | "prune";
}

/** A step-level reduction of the conversation history inserted by `history`. */
export interface HistoryReduction {
  /** Fingerprint of the inserted history the reduction applies to. */
  sourceHash: string;
  /** Oldest inserted messages replaced. */
  dropped: number;
  /** The summary or note that stands for them. */
  text: string;
  strategy: "summarize" | "prune";
}

export interface ContextMarker {
  kind: ContextMarkerKind;
  sequence: number;
  strategy: "summarize" | "prune" | "none";
  reason: string;
  replaces?: string[];
  rewrites?: Record<string, ContentPart[]>;
  /** A visible marker is shown immediately before this item. */
  anchor?: string;
  slots?: InputSlotReduction[];
  /** Reduction of the inserted conversation history (kind `input`). */
  history?: HistoryReduction;
  /** Notes that remove rounds keep a running tally across compactions. */
  removedRounds?: number;
  removedTools?: Record<string, number>;
  /** `name(argument)` of removed calls, newest last, capped. */
  removedCalls?: string[];
}

const isObject = (value: unknown): value is JsonObject =>
  value != null && typeof value === "object" && !Array.isArray(value);

export const contextMarker = (
  item: TranscriptItem,
): ContextMarker | undefined => {
  const runtime = item.metadata?.agentRuntime;
  if (!isObject(runtime)) return undefined;
  const marker = runtime.context;
  if (!isObject(marker) || typeof marker.kind !== "string") return undefined;
  return marker as unknown as ContextMarker;
};

export const markerMetadata = (marker: ContextMarker): JsonObject => ({
  agentRuntime: { context: JSON.parse(JSON.stringify(marker)) as JsonValue },
});

/** Small, synchronous content fingerprint used to match stored input reductions. */
export const fingerprint = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}:${text.length}`;
};

/**
 * The transcript as the model should see it: superseded items removed,
 * rewritten items substituted, visible markers placed at their anchors, and
 * invisible markers omitted.
 */
export const compactedView = (
  transcript: readonly TranscriptItem[],
): TranscriptItem[] => {
  const superseded = new Set<string>();
  const rewrites = new Map<string, ContentPart[]>();
  const anchored = new Map<string, TranscriptItem[]>();
  const present = new Set(transcript.map((item) => item.id));
  for (const item of transcript) {
    const marker = contextMarker(item);
    if (!marker) continue;
    for (const id of marker.replaces ?? []) superseded.add(id);
    for (const [id, content] of Object.entries(marker.rewrites ?? {}))
      rewrites.set(id, content);
    if (marker.anchor && item.role && present.has(marker.anchor)) {
      const list = anchored.get(marker.anchor) ?? [];
      list.push(item);
      anchored.set(marker.anchor, list);
    }
  }
  const view: TranscriptItem[] = [];
  const emit = (item: TranscriptItem): void => {
    if (superseded.has(item.id)) return;
    const content = rewrites.get(item.id);
    view.push(content ? { ...item, content } : item);
  };
  for (const item of transcript) {
    for (const marker of anchored.get(item.id) ?? []) emit(marker);
    const marker = contextMarker(item);
    if (marker) {
      const isAnchored =
        marker.anchor != null &&
        item.role != null &&
        present.has(marker.anchor);
      if (item.role && !isAnchored) emit(item);
      continue;
    }
    emit(item);
  }
  return view;
};

export interface TranscriptRound {
  kind: "tool" | "marker";
  items: TranscriptItem[];
}

/**
 * Group a view into rounds: one model response plus the tool results that
 * answer it, or a single visible marker. Rounds are compacted whole, so a
 * tool call and its result are never separated.
 */
export const deriveRounds = (
  view: readonly TranscriptItem[],
): TranscriptRound[] => {
  const rounds: TranscriptRound[] = [];
  let previous: TranscriptItem | undefined;
  for (const item of view) {
    if (contextMarker(item)) {
      rounds.push({ kind: "marker", items: [item] });
    } else if (
      item.role === "assistant" &&
      (previous == null ||
        previous.type === "tool-result" ||
        previous.role === "tool" ||
        contextMarker(previous) != null)
    ) {
      rounds.push({ kind: "tool", items: [item] });
    } else if (rounds.length === 0 || rounds.at(-1)!.kind === "marker") {
      rounds.push({ kind: "tool", items: [item] });
    } else {
      rounds.at(-1)!.items.push(item);
    }
    previous = item;
  }
  return rounds;
};

/** Split rounds into a compactable prefix and the retained newest tool rounds. */
export const splitRetained = (
  rounds: readonly TranscriptRound[],
  retainToolRounds: number,
): { prefix: TranscriptRound[]; retained: TranscriptRound[] } => {
  if (retainToolRounds <= 0) return { prefix: [...rounds], retained: [] };
  let seen = 0;
  let cut = rounds.length;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (rounds[index]!.kind !== "tool") continue;
    seen += 1;
    cut = index;
    if (seen >= retainToolRounds) break;
  }
  return { prefix: rounds.slice(0, cut), retained: rounds.slice(cut) };
};

/** Tool rounds after the most recent marker that summarized or removed rounds. */
export const toolRoundsSinceCompaction = (
  rounds: readonly TranscriptRound[],
): number => {
  let count = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]!;
    if (round.kind === "marker") {
      const marker = contextMarker(round.items[0]!);
      if (marker?.kind === "summary" || (marker?.replaces?.length ?? 0) > 0)
        break;
      continue;
    }
    count += 1;
  }
  return count;
};

const partText = (part: ContentPart): string => {
  switch (part.type) {
    case "text":
      return part.text;
    case "reasoning":
      return "";
    case "json":
      return JSON.stringify(part.value);
    case "image":
      return "[image]";
    case "file":
      return `[file${part.name ? ` ${part.name}` : ""}]`;
    case "tool-call":
      return `Called tool ${part.call.name} with ${JSON.stringify(part.call.input)}`;
    case "tool-result": {
      const { result } = part;
      const artifacts = result.artifacts?.length
        ? ` (artifacts: ${result.artifacts.map((artifact) => artifact.name).join(", ")})`
        : "";
      return result.error
        ? `Tool ${result.name} failed (${result.error.code}): ${result.error.message}`
        : `Tool ${result.name} returned${artifacts}: ${
            typeof result.output === "string"
              ? result.output
              : JSON.stringify(result.output ?? null)
          }`;
    }
  }
};

/** A plain-text rendering of transcript items for a summarizer. */
export const renderItemsAsText = (items: readonly TranscriptItem[]): string =>
  items
    .map((item) => {
      const marker = contextMarker(item);
      const speaker = marker
        ? marker.kind === "summary"
          ? "Earlier summary"
          : "Runtime note"
        : item.role === "assistant"
          ? "Assistant"
          : item.role === "tool"
            ? "Tool"
            : item.role === "user"
              ? "User"
              : "System";
      const text = item.content.map(partText).filter(Boolean).join("\n");
      return text ? `${speaker}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

/** Latest stored reduction for each opening-prompt slot. */
export const inputReductions = (
  transcript: readonly TranscriptItem[],
): Map<string, InputSlotReduction> => {
  const reductions = new Map<string, InputSlotReduction>();
  for (const item of transcript) {
    const marker = contextMarker(item);
    if (marker?.kind !== "input") continue;
    for (const slot of marker.slots ?? [])
      reductions.set(`${slot.location}#${slot.index}`, slot);
  }
  return reductions;
};

/** Latest stored reduction of the inserted conversation history. */
export const historyReduction = (
  transcript: readonly TranscriptItem[],
): HistoryReduction | undefined => {
  let latest: HistoryReduction | undefined;
  for (const item of transcript) {
    const marker = contextMarker(item);
    if (marker?.kind === "input" && marker.history) latest = marker.history;
  }
  return latest;
};

export const nextMarkerSequence = (
  transcript: readonly TranscriptItem[],
): number =>
  transcript.reduce(
    (highest, item) => Math.max(highest, contextMarker(item)?.sequence ?? 0),
    0,
  ) + 1;

/** Summarizing compactions recorded in this step's transcript. */
export const summaryCompactions = (
  transcript: readonly TranscriptItem[],
): number =>
  transcript.filter((item) => {
    const marker = contextMarker(item);
    return marker?.kind === "summary";
  }).length;

/** Model messages for view items; runtime marker metadata stays internal. */
export const viewMessages = (
  items: readonly TranscriptItem[],
): ModelMessage[] =>
  items.flatMap((item) => {
    if (!item.role) return [];
    const marker = contextMarker(item);
    return [
      {
        role: item.role,
        content: item.content,
        ...(item.metadata && !marker ? { metadata: item.metadata } : {}),
        ...(item.providerOptions
          ? { providerOptions: item.providerOptions }
          : {}),
      } satisfies ModelMessage,
    ];
  });
