import type { TranscriptItem } from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  isContextOverflowError,
  isInvalidOutputError,
  isRetryableModelError,
} from "./context/errors.js";
import { jsonBytes, jsonTextBytes, TokenEstimator } from "./context/measure.js";
import {
  clipToolResultPart,
  pruneJson,
  pruneText,
  stubToolResultPart,
} from "./context/prune.js";
import { ChunkedSummarizer, splitIntoChunks } from "./context/summarize.js";
import {
  compileTemplate,
  renderTemplate,
  renderTemplateOutline,
} from "./context/template.js";
import {
  compactedView,
  deriveRounds,
  markerMetadata,
  splitRetained,
  toolRoundsSinceCompaction,
} from "./context/transcript.js";

const at = "2026-07-22T00:00:00.000Z";
const assistantCall = (id: string, name = "lookup"): TranscriptItem => ({
  id,
  type: "message",
  role: "assistant",
  content: [{ type: "tool-call", call: { id: `call-${id}`, name, input: {} } }],
  createdAt: at,
});
const toolResult = (
  id: string,
  callId: string,
  output = "x",
): TranscriptItem => ({
  id,
  type: "tool-result",
  role: "tool",
  content: [
    { type: "tool-result", result: { callId, name: "lookup", output } },
  ],
  createdAt: at,
});

describe("pruning", () => {
  it("keeps the beginning and end of text within the byte budget", () => {
    const text = `BEGIN ${"a".repeat(10_000)} END`;
    const pruned = pruneText(text, 1_000, "doc");
    expect(jsonTextBytes(pruned)).toBeLessThanOrEqual(1_000);
    expect(pruned.startsWith("BEGIN")).toBe(true);
    expect(pruned.endsWith("END")).toBe(true);
    expect(pruned).toContain("omitted");
    expect(pruned).toContain("of doc");
    expect(pruneText("short", 1_000)).toBe("short");
  });

  it("never splits multi-byte characters", () => {
    const pruned = pruneText("😀".repeat(2_000), 500);
    expect(jsonTextBytes(pruned)).toBeLessThanOrEqual(500);
    expect(pruned).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("keeps JSON valid by clipping the largest strings and arrays first", () => {
    const value = {
      title: "Report",
      rows: Array.from({ length: 500 }, (_, index) => ({ index, note: "n" })),
      body: "b".repeat(20_000),
    };
    const pruned = pruneJson(value, 4_000);
    expect(jsonBytes(JSON.parse(pruned))).toBeLessThanOrEqual(4_000);
    const parsed = JSON.parse(pruned) as typeof value;
    expect(parsed.title).toBe("Report");
    expect(parsed.rows.length).toBeLessThan(500);
  });

  it("stubs and clips tool results without losing the call pairing", () => {
    const part = {
      type: "tool-result" as const,
      result: {
        callId: "call-1",
        name: "read",
        output: "z".repeat(5_000),
        artifacts: [{ id: "a", name: "chart.png", mediaType: "image/png" }],
      },
    };
    const stub = stubToolResultPart(part);
    expect(stub.result).toMatchObject({
      callId: "call-1",
      name: "read",
      output: { agentRuntime: "omitted", omittedArtifacts: ["chart.png"] },
    });
    expect(jsonBytes(stub)).toBeLessThan(1_000);
    const clipped = clipToolResultPart(part, 1_000);
    expect(clipped.result.callId).toBe("call-1");
    expect(clipped.result.artifacts).toBeUndefined();
    expect(jsonBytes(clipped)).toBeLessThan(1_600);
  });
});

describe("templates", () => {
  it("compiles literal text and variable slots case-insensitively", () => {
    const template = compileTemplate(
      "prompt",
      "Review {{ Doc.Body }} for {{ audience }}.",
      { doc: { body: "the contract" }, audience: "legal" },
    );
    expect(renderTemplate(template)).toBe("Review the contract for legal.");
    expect(renderTemplateOutline(template)).toBe(
      "Review {{ Doc.Body }} for {{ audience }}.",
    );
    const slot = template.segments.find((segment) => "slot" in segment);
    expect(slot).toMatchObject({
      slot: { path: "Doc.Body", value: "the contract", text: "the contract" },
    });
  });
});

describe("transcript view", () => {
  const transcript: TranscriptItem[] = [
    assistantCall("a1"),
    toolResult("t1", "call-a1", "first"),
    assistantCall("a2"),
    toolResult("t2", "call-a2", "second"),
    assistantCall("a3"),
    toolResult("t3", "call-a3", "third"),
  ];

  it("derives whole rounds and retains the newest", () => {
    const rounds = deriveRounds(transcript);
    expect(rounds.map((round) => round.items.map((item) => item.id))).toEqual([
      ["a1", "t1"],
      ["a2", "t2"],
      ["a3", "t3"],
    ]);
    const { prefix, retained } = splitRetained(rounds, 2);
    expect(prefix).toHaveLength(1);
    expect(retained).toHaveLength(2);
    expect(splitRetained(rounds, 0).retained).toHaveLength(0);
    expect(toolRoundsSinceCompaction(rounds)).toBe(3);
  });

  it("hides superseded items, places summaries at their anchor, and substitutes rewrites", () => {
    const summary: TranscriptItem = {
      id: "s1",
      type: "message",
      role: "user",
      content: [{ type: "text", text: "summary" }],
      createdAt: at,
      metadata: markerMetadata({
        kind: "summary",
        sequence: 1,
        strategy: "summarize",
        reason: "input-size",
        replaces: ["a1", "t1"],
        anchor: "a2",
      }),
    };
    const rewrite: TranscriptItem = {
      id: "r1",
      type: "message",
      content: [],
      createdAt: at,
      metadata: markerMetadata({
        kind: "rewrite",
        sequence: 2,
        strategy: "prune",
        reason: "tool-result-size",
        rewrites: {
          t3: [
            {
              type: "tool-result",
              result: { callId: "call-a3", name: "lookup", output: "short" },
            },
          ],
        },
      }),
    };
    const view = compactedView([...transcript, summary, rewrite]);
    expect(view.map((item) => item.id)).toEqual(["s1", "a2", "t2", "a3", "t3"]);
    expect(view.at(-1)?.content[0]).toMatchObject({
      result: { output: "short" },
    });
    const rounds = deriveRounds(view);
    expect(rounds[0]?.kind).toBe("marker");
    expect(toolRoundsSinceCompaction(rounds)).toBe(2);
  });
});

describe("chunked summarizer", () => {
  it("splits oversized material, condenses each part, then combines", async () => {
    const calls: string[] = [];
    const summarizer = new ChunkedSummarizer({
      call: async ({ user }) => {
        calls.push(user);
        return `summary ${calls.length}`;
      },
      chunkBytes: 2_000,
      maxCalls: 20,
      variables: {},
    });
    const text = Array.from(
      { length: 10 },
      (_, index) => `Section ${index}: ${"word ".repeat(150)}`,
    ).join("\n\n");
    const summary = await summarizer.summarize({
      text,
      targetBytes: 600,
      kind: "input",
      label: "the variable doc",
      task: "Answer the question.",
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toContain("(part 1 of");
    expect(calls[0]).toContain("Answer the question.");
    expect(summary).toContain("summary");
    for (const call of calls) {
      expect(call.length).toBeLessThan(2_000 + 1_000);
    }
  });

  it("stops at its call limit and rejects empty summaries", async () => {
    const limited = new ChunkedSummarizer({
      call: async () => "ok",
      chunkBytes: 1_000,
      maxCalls: 2,
      variables: {},
    });
    await expect(
      limited.summarize({
        text: "x ".repeat(5_000),
        targetBytes: 300,
        kind: "input",
        label: "doc",
        task: "",
      }),
    ).rejects.toThrow("summarizer calls");
    const empty = new ChunkedSummarizer({
      call: async () => "  ",
      chunkBytes: 10_000,
      maxCalls: 5,
      variables: {},
    });
    await expect(
      empty.summarize({
        text: "hello",
        targetBytes: 300,
        kind: "input",
        label: "doc",
        task: "",
      }),
    ).rejects.toThrow("returned nothing");
  });

  it("templates custom prompts with step variables and the context namespace", async () => {
    let seen: { system: string; user: string } | undefined;
    const summarizer = new ChunkedSummarizer({
      call: async (input) => {
        seen = input;
        return "done";
      },
      chunkBytes: 10_000,
      maxCalls: 5,
      systemPrompt: "Notes for {{ topic }}.",
      prompt:
        "Summarize {{ context.label }} in {{ context.targetWords }} words.",
      variables: { topic: "pricing" },
    });
    await summarizer.summarize({
      text: "material",
      targetBytes: 600,
      kind: "transcript",
      label: "3 rounds",
      task: "t",
    });
    expect(seen?.system).toBe("Notes for pricing.");
    expect(seen?.user).toContain("Summarize 3 rounds in 100 words.");
    expect(seen?.user).toContain("<material>\nmaterial\n</material>");
  });

  it("splits at paragraph and line boundaries before bytes", () => {
    const chunks = splitIntoChunks(
      `${"a".repeat(900)}\n\n${"b".repeat(900)}`,
      1_000,
    );
    expect(chunks).toHaveLength(2);
    expect(splitIntoChunks("c".repeat(2_500), 1_000).length).toBe(3);
  });
});

describe("error classification", () => {
  const apiError = (statusCode: number, message: string, extra = {}) =>
    Object.assign(new Error(message), { statusCode, ...extra });

  it("recognizes provider context overflows but not rate limits", () => {
    expect(
      isContextOverflowError(
        apiError(
          400,
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
        ),
      ),
    ).toBe(true);
    expect(
      isContextOverflowError(
        apiError(400, "prompt is too long: 210000 tokens > 200000 maximum"),
      ),
    ).toBe(true);
    expect(
      isContextOverflowError(
        apiError(
          400,
          "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
        ),
      ),
    ).toBe(true);
    expect(
      isContextOverflowError(
        apiError(429, "Request too large for gpt-x on tokens per min (TPM)"),
      ),
    ).toBe(false);
    const wrapped = Object.assign(new Error("Failed after 3 attempts"), {
      lastError: apiError(413, "Request too large"),
    });
    expect(isContextOverflowError(wrapped)).toBe(true);
  });

  it("retries transient failures only", () => {
    expect(isRetryableModelError(apiError(429, "rate limited"))).toBe(true);
    expect(isRetryableModelError(apiError(503, "unavailable"))).toBe(true);
    expect(
      isRetryableModelError(
        Object.assign(new Error("x"), { isRetryable: true }),
      ),
    ).toBe(true);
    expect(isRetryableModelError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableModelError(apiError(401, "bad key"))).toBe(false);
    expect(isRetryableModelError(new Error("boom"))).toBe(false);
    expect(
      isRetryableModelError(apiError(400, "maximum context length exceeded")),
    ).toBe(false);
  });

  it("recognizes invalid structured output", () => {
    const error = Object.assign(new Error("No object generated"), {
      name: "AI_NoObjectGeneratedError",
    });
    expect(isInvalidOutputError(error)).toBe(true);
    expect(isInvalidOutputError(new Error("other"))).toBe(false);
  });
});

describe("token estimates", () => {
  it("calibrates bytes per token from reported usage", () => {
    const estimator = new TokenEstimator();
    expect(estimator.tokens(4_000)).toBe(1_000);
    estimator.observe(6_000, 1_000);
    expect(estimator.calibrated).toBe(true);
    expect(estimator.tokens(6_000)).toBe(1_000);
    expect(estimator.bytes(100)).toBe(600);
    estimator.observe(100, 0);
    expect(estimator.bytesPerToken).toBe(6);
  });
});
