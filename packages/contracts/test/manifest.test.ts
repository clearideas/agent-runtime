import { describe, expect, it } from "vitest";

import {
  parseAgentManifest,
  parseAgentRunManifest,
  parseRunCheckpoint,
  safeParseAgentManifest,
  safeParseAgentRunManifest,
} from "../src/index.js";

describe("agent manifest contracts", () => {
  it("accepts complete rich prompt histories while preserving legacy prompts", () => {
    const legacy = safeParseAgentManifest({
      schemaVersion: "1.0",
      steps: [
        {
          id: "legacy",
          type: "prompt",
          systemPrompt: "Be concise.",
          prompt: "Answer.",
        },
      ],
    });
    expect(legacy.success).toBe(true);

    const parsed = parseAgentManifest({
      schemaVersion: "1.0",
      steps: [
        {
          id: "continued-chat",
          type: "prompt",
          messages: [
            {
              role: "system",
              content: [{ type: "text", text: "Review {{topic}}." }],
              metadata: { source: "agent" },
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Inspect this image." },
                {
                  type: "image",
                  url: "https://example.test/diagram.png",
                  mediaType: "image/png",
                  providerOptions: { openai: { detail: "high" } },
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  call: {
                    id: "call-1",
                    name: "lookup",
                    input: { id: 1 },
                    metadata: { imported: true },
                  },
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  result: {
                    callId: "call-1",
                    name: "lookup",
                    output: { found: true },
                    metadata: { latencyMs: 10 },
                  },
                },
              ],
            },
            {
              role: "user",
              content: [{ type: "text", text: "Give the final answer." }],
            },
          ],
        },
      ],
    });

    const step = parsed.steps[0];
    expect(step?.type).toBe("prompt");
    if (step?.type === "prompt") {
      expect(step.messages).toHaveLength(5);
      expect(step.messages?.[1]?.content[1]).toMatchObject({
        type: "image",
        mediaType: "image/png",
      });
    }
  });

  it("rejects ambiguous histories, invalid media, and unpaired tool results", () => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        steps: [
          {
            id: "ambiguous",
            type: "prompt",
            prompt: "Legacy",
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "History" }],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        steps: [
          {
            id: "invalid-media",
            type: "prompt",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    url: "https://example.test/image.png",
                    data: "also-inline",
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        steps: [
          {
            id: "orphan-result",
            type: "prompt",
            messages: [
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    result: {
                      callId: "missing",
                      name: "lookup",
                      output: null,
                    },
                  },
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts explicit variables, conditional collection loops, and goal loops", () => {
    const manifest = parseAgentManifest({
      schemaVersion: "1.0",
      name: "Review documents",
      variables: [
        {
          key: "documents",
          type: "array",
          value: [
            { id: "one", enabled: true },
            { id: "two", enabled: false },
          ],
        },
        { key: "targetScore", type: "number", value: 90 },
      ],
      steps: [
        {
          id: "review-documents",
          type: "loop",
          loop: {
            source: "documents",
            itemVariable: "document",
            condition: "document.enabled == true",
            outputMode: "array",
          },
          steps: [
            {
              id: "review-document",
              type: "prompt",
              prompt: "Review {{document.id}}",
            },
          ],
        },
        {
          id: "improve-draft",
          type: "loop",
          loop: {
            maxIterations: 5,
            goal: "{{score}} >= {{targetScore}}",
            resultVariable: "draft",
            outputMode: "final",
          },
          steps: [
            { id: "revise", type: "prompt", prompt: "Improve {{draft}}" },
          ],
        },
      ],
    });

    expect(
      manifest.variables?.find((variable) => variable.key === "targetScore")
        ?.value,
    ).toBe(90);
    expect(manifest.steps.map((step) => step.type)).toEqual(["loop", "loop"]);
  });

  it("requires an exact supported schema version", () => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "2.0",
        steps: [],
      }).success,
    ).toBe(false);
  });

  it("accepts model profiles and connection bindings while rejecting alias collisions", () => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        model: { ref: "quality" },
        connections: [
          { ref: "documents", alias: "docs", mode: "read", tools: ["search"] },
        ],
        steps: [
          {
            id: "answer",
            type: "prompt",
            prompt: "Answer",
            tools: ["docs__search"],
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        connections: [
          { ref: "documents", alias: "docs" },
          { ref: "other-documents", alias: "docs" },
        ],
        steps: [],
      }).success,
    ).toBe(false);
  });

  it("requires a sub-run manifest or reference", () => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        steps: [{ id: "child", type: "sub-run" }],
      }).success,
    ).toBe(false);
  });

  it("rejects ambiguous sibling ids and agent variables", () => {
    const result = safeParseAgentManifest({
      schemaVersion: "1.0",
      variables: [
        { key: "subject", type: "string" },
        { key: "Subject", type: "string" },
      ],
      steps: [
        { id: "same", type: "prompt", prompt: "First" },
        { id: "same", type: "prompt", prompt: "Second" },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "Duplicate sibling step id: same",
        "Duplicate agent variable: Subject",
      ]),
    );
  });

  it("rejects the discontinued finalOutputSteps manifest field", () => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        steps: [{ id: "answer", type: "prompt", prompt: "Answer." }],
        finalOutputSteps: ["answer"],
      }).success,
    ).toBe(false);
  });

  it("rejects dotted variable keys and defaults that do not match their declared type", () => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        variables: [
          { key: "release.name", type: "string", value: "AgentRuntime 1.0" },
        ],
        steps: [],
      }).success,
    ).toBe(false);

    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        variables: [{ key: "maxWords", type: "number", value: "180" }],
        steps: [],
      }).success,
    ).toBe(false);
  });

  it("allows the same child id under different loop parents", () => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        steps: [
          {
            id: "first-loop",
            type: "loop",
            loop: { maxIterations: 1 },
            steps: [{ id: "child", type: "prompt", prompt: "First child" }],
          },
          {
            id: "second-loop",
            type: "loop",
            loop: { maxIterations: 1 },
            steps: [{ id: "child", type: "prompt", prompt: "Second child" }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    "__proto__",
    "safe.__proto__.polluted",
    "constructor.prototype.polluted",
  ])("rejects prototype-sensitive variable path %s", (outputVariable) => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        steps: [
          { id: "unsafe", type: "prompt", prompt: "Unsafe", outputVariable },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects dotted output variable keys", () => {
    expect(
      safeParseAgentManifest({
        schemaVersion: "1.0",
        steps: [
          {
            id: "draft",
            type: "prompt",
            prompt: "Draft.",
            outputVariable: "brief.draft",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("agent run manifest contracts", () => {
  it("parses an agent reference and runtime variable overrides", () => {
    expect(
      parseAgentRunManifest({
        schemaVersion: "1.0",
        agent: { ref: "release-brief" },
        runId: "release-brief-42",
        variables: [{ key: "audience", value: "partners" }],
        execution: { mode: "parallel", maxConcurrency: 4 },
      }),
    ).toEqual({
      schemaVersion: "1.0",
      agent: { ref: "release-brief" },
      runId: "release-brief-42",
      variables: [{ key: "audience", value: "partners" }],
      execution: { mode: "parallel", maxConcurrency: 4 },
    });
  });

  it("validates agent run execution options", () => {
    expect(
      safeParseAgentRunManifest({
        schemaVersion: "1.0",
        agent: { ref: "release-brief" },
        execution: { mode: "sequential" },
      }).success,
    ).toBe(true);
    expect(
      safeParseAgentRunManifest({
        schemaVersion: "1.0",
        agent: { ref: "release-brief" },
        execution: { mode: "parallel", maxConcurrency: 0 },
      }).success,
    ).toBe(false);
    expect(
      safeParseAgentRunManifest({
        schemaVersion: "1.0",
        agent: { ref: "release-brief" },
        execution: { mode: "graph" },
      }).success,
    ).toBe(false);
  });

  it("requires an agent reference and rejects agent-definition fields", () => {
    expect(
      safeParseAgentRunManifest({
        schemaVersion: "1.0",
        variables: [{ key: "audience", value: "partners" }],
        steps: [],
      }).success,
    ).toBe(false);
  });
});

describe("runner checkpoint contracts", () => {
  const checkpoint = {
    id: "checkpoint-1",
    runId: "run-1",
    sequence: 1,
    attempt: 1,
    manifestHash: "sha256:test",
    contractVersion: "1.0",
    runtimeVersion: "0.1.0",
    cursor: { stepIndex: 0 },
    state: {},
    stepResults: [],
    transcript: [],
    artifacts: [],
    createdAt: "2026-07-22T12:00:00.000Z",
  };

  it("parses a versioned checkpoint with active-step accumulators", () => {
    expect(
      parseRunCheckpoint({
        ...checkpoint,
        activeStepTranscript: [],
        activeStepArtifacts: [],
      }),
    ).toMatchObject(checkpoint);
  });

  it.each([
    { ...checkpoint, sequence: 0 },
    { ...checkpoint, createdAt: "not-a-timestamp" },
    { ...checkpoint, unexpected: true },
  ])("rejects a malformed or ambiguous checkpoint", (value) => {
    expect(() => parseRunCheckpoint(value)).toThrow();
  });
});
