/**
 * Long Investigation: turns the host's `model-input` measurements and Agent
 * Runtime's `context.reduced` events into view state for the context-window
 * chart. DOM-free, so the same module runs in Node tests.
 */

/** Message kinds, bottom to top of a stacked bar. */
export const SEGMENT_KINDS = [
  { kind: "system", label: "System prompt" },
  { kind: "opening", label: "Opening prompt" },
  { kind: "summary", label: "Summary" },
  { kind: "note", label: "Runtime note" },
  { kind: "call", label: "Model tool call" },
  { kind: "result", label: "Tool result" },
  { kind: "stub", label: "Stubbed result" },
  { kind: "clipped", label: "Clipped result" },
];

/** Kilobytes as the manifest states limits (40000 bytes is "40 KB"). */
export const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** One sentence per reduction, for the log and the agent's activity line. */
export const describeReduction = (data = {}) => {
  const sizes =
    data.bytesBefore != null && data.bytesAfter != null
      ? ` · ${kb(data.bytesBefore)} → ${kb(data.bytesAfter)}`
      : "";
  if (data.scope === "input") {
    const verb = data.strategy === "summarize" ? "Summarized" : "Clipped";
    return `${verb} the ${data.variable ?? "variable"} variable in the opening prompt${sizes}`;
  }
  if (data.scope === "tool-result") {
    if (data.toolName)
      return `Shortened a large ${data.toolName} result${sizes}`;
    return `Clipped ${plural(data.clippedResults ?? 1, "recent tool result")}${sizes}`;
  }
  if (data.summarizedRounds != null)
    return `Summarized ${plural(data.summarizedRounds, "older round")} into one summary${sizes}`;
  if (data.stubbedResults != null)
    return `Replaced ${plural(data.stubbedResults, "older tool output")} with stubs${sizes}`;
  if (data.removedRounds != null)
    return `Removed older rounds (${data.removedRounds} removed so far)${sizes}`;
  return `Reduced the input${sizes}`;
};

/**
 * @typedef {{ kind: string, bytes: number, label: string }} Segment
 * @typedef {Record<string, any> & { text: string, beforeRequest: number }} Reduction
 * @typedef {{
 *   index: number,
 *   stepId: string,
 *   bytes: number,
 *   segments: Segment[],
 *   reductions: Reduction[],
 *   summarizerCalls: number,
 * }} RequestView
 * @typedef {{
 *   limit: number | null,
 *   requests: RequestView[],
 *   reductions: Reduction[],
 *   summaries: Array<Record<string, any>>,
 *   summarizerCalls: number,
 *   pendingReductions: Reduction[],
 *   pendingSummaries: number,
 *   peak: number,
 *   bytesKeptOut: number,
 *   failure: { bytes: number, limit: number } | null,
 * }} ContextState
 */

/**
 * @param {number | null} [limit] the step's `limits.maxInputBytes`
 * @returns {ContextState}
 */
export const createContextState = (limit = null) => ({
  limit,
  requests: [],
  reductions: [],
  summaries: [],
  summarizerCalls: 0,
  pendingReductions: [],
  pendingSummaries: 0,
  peak: 0,
  bytesKeptOut: 0,
  failure: null,
});

/**
 * Apply one stream message. Returns effects for the page to render:
 * `request`, `summarizer`, `reduction`, or `failure`.
 */
export const applyContextMessage = (state, message) => {
  if (message.kind === "model-input") {
    if (message.limit != null) state.limit = message.limit;
    if (message.purpose === "summarize") {
      state.summarizerCalls += 1;
      state.pendingSummaries += 1;
      return [{ type: "summarizer", bytes: message.bytes }];
    }
    const request = {
      index: state.requests.length + 1,
      stepId: message.stepId,
      bytes: message.bytes,
      segments: message.segments ?? [],
      reductions: state.pendingReductions,
      summarizerCalls: state.pendingSummaries,
    };
    state.pendingReductions = [];
    state.pendingSummaries = 0;
    state.requests.push(request);
    state.peak = Math.max(state.peak, message.bytes);
    return [{ type: "request", request }];
  }
  if (message.kind === "summarizer") {
    const summary = {
      stepId: message.stepId,
      kind: message.summaryKind,
      label: message.label,
      inputBytes: message.inputBytes,
      targetBytes: message.targetBytes,
      outputBytes: message.outputBytes,
      beforeRequest: state.requests.length + 1,
      text: `Summarizer condensed ${message.label} (${message.summaryKind}): ${kb(message.inputBytes)} → ${kb(message.outputBytes)}, asked for ${kb(message.targetBytes)}`,
    };
    state.summaries.push(summary);
    return [{ type: "summary", summary }];
  }
  if (message.kind === "event" && message.event?.type === "context.reduced") {
    const data = message.event.data ?? {};
    const reduction = {
      ...data,
      stepId: message.event.stepId,
      beforeRequest: state.requests.length + 1,
      text: describeReduction(data),
    };
    state.reductions.push(reduction);
    state.pendingReductions.push(reduction);
    if (data.bytesBefore != null && data.bytesAfter != null)
      state.bytesKeptOut += Math.max(0, data.bytesBefore - data.bytesAfter);
    return [{ type: "reduction", reduction }];
  }
  if (message.kind === "error") {
    const match =
      /input is (\d+) bytes, exceeding the (\d+)-byte input limit/u.exec(
        message.error?.message ?? "",
      );
    if (match) {
      state.failure = { bytes: Number(match[1]), limit: Number(match[2]) };
      return [{ type: "failure", failure: state.failure }];
    }
  }
  return [];
};

/** Segments grouped by kind for a compact legend or summary. */
export const bytesByKind = (segments) => {
  const totals = new Map();
  for (const segment of segments)
    totals.set(segment.kind, (totals.get(segment.kind) ?? 0) + segment.bytes);
  return totals;
};
