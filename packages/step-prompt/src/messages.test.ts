import type {
  AgentManifest,
  ConversationMessage,
  JsonObject,
  PromptStep,
  RunEvent,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import {
  RunSuspendedError,
  selectHistory,
  withMessagesView,
  type MessageHistoryCompactionRequest,
  type StepExecutionContext,
  type StepHistoryContext,
} from "@clearideas/agent-runtime-core";
import type {
  ModelAdapter,
  ModelRequest,
} from "@clearideas/agent-runtime-core/ports";
import { describe, expect, it } from "vitest";

import { PromptMessageHistoryCompactor, PromptStepExecutor } from "./index.js";

const at = "2026-07-22T00:00:00.000Z";
const user = (text: string): ConversationMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): ConversationMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const reply = (text: string) => ({
  output: text,
  transcript: [
    {
      id: `assistant-${text.length}-${Math.random()}`,
      type: "message" as const,
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      createdAt: at,
    },
  ],
});

const recordingModel = (
  requests: ModelRequest[],
  answer: (request: ModelRequest) => string = () => "done",
): ModelAdapter => ({
  generate: async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined }));
    return reply(answer(request));
  },
});

const historyContext = (
  messages: ConversationMessage[],
  setting: PromptStep["history"],
): StepHistoryContext => {
  const selection = selectHistory(messages, setting);
  return {
    messages: selection.messages,
    places: selection.places,
    turn: selection.currentTurn,
    explicit: selection.explicit,
    insert: selection.insert,
    media: selection.media,
    sign: async () => undefined,
  };
};

const run = async (
  step: PromptStep,
  history: ConversationMessage[],
  options: {
    model: ModelAdapter;
    manifest?: Partial<AgentManifest>;
    variables?: Record<string, unknown>;
    events?: RunEvent[];
    resume?: StepExecutionContext["resume"];
    checkpoints?: TranscriptItem[][];
    policies?: StepExecutionContext["policies"];
    artifacts?: StepExecutionContext["artifacts"];
  },
) => {
  const manifest: AgentManifest = {
    schemaVersion: "1.0",
    model: { provider: "openai", model: "gpt-test" },
    messages: {},
    steps: [step],
    ...options.manifest,
  };
  const selection = selectHistory(history, step.history);
  let sequence = 0;
  return new PromptStepExecutor().execute({
    runId: "run-1",
    manifest,
    step,
    stepIndex: 0,
    variables: withMessagesView(
      manifest,
      (options.variables ?? {}) as never,
      selection,
    ),
    history: historyContext(history, step.history),
    model: options.model,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.policies ? { policies: options.policies } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    checkpoint: async (input) => {
      options.checkpoints?.push(structuredClone(input.transcript ?? []));
    },
    emit: async (type, data) => {
      const event = {
        id: `event-${++sequence}`,
        runId: "run-1",
        sequence,
        timestamp: at,
        type,
        ...(data ? { data } : {}),
      } as RunEvent;
      options.events?.push(event);
      return event;
    },
  });
};

const texts = (request: ModelRequest): string[] =>
  request.messages.map(
    (message) =>
      `${message.role}: ${message.content
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join(" ")}`,
  );

describe("conversation history in prompt steps", () => {
  const history = [
    user("My name is {{ secret }}"),
    assistant("Hello."),
    user("What is my order status?"),
  ];

  it("inserts the selection between the system prompt and the step prompt, literally", async () => {
    const requests: ModelRequest[] = [];
    await run(
      {
        id: "answer",
        type: "prompt",
        systemPrompt: "Support for {{ product }}.",
        history: "all",
        prompt: "Answer {{ messages.lastUser.text }} briefly.",
      },
      history,
      {
        model: recordingModel(requests),
        variables: { product: "Widgets", secret: "S3CRET" },
      },
    );
    expect(texts(requests[0]!)).toEqual([
      "system: Support for Widgets.",
      "user: My name is {{ secret }}",
      "assistant: Hello.",
      "user: What is my order status?",
      "user: Answer What is my order status? briefly.",
    ]);
    expect(JSON.stringify(requests[0])).not.toContain("S3CRET");
  });

  it("lets a step be a system prompt plus the conversation", async () => {
    const requests: ModelRequest[] = [];
    await run(
      {
        id: "answer",
        type: "prompt",
        systemPrompt: "Answer.",
        history: { last: 1 },
      },
      history,
      { model: recordingModel(requests) },
    );
    expect(texts(requests[0]!)).toEqual([
      "system: Answer.",
      "user: What is my order status?",
    ]);
  });

  it("inserts after the leading system messages of step messages", async () => {
    const requests: ModelRequest[] = [];
    await run(
      {
        id: "answer",
        type: "prompt",
        history: { last: 2 },
        messages: [
          { role: "system", content: [{ type: "text", text: "Be brief." }] },
          { role: "user", content: [{ type: "text", text: "Now answer." }] },
        ],
      },
      history,
      { model: recordingModel(requests) },
    );
    expect(texts(requests[0]!)).toEqual([
      "system: Be brief.",
      "assistant: Hello.",
      "user: What is my order status?",
      "user: Now answer.",
    ]);
  });

  it("does not insert turns when insert is false or history is omitted", async () => {
    const requests: ModelRequest[] = [];
    await run(
      {
        id: "check",
        type: "prompt",
        history: { last: 2, insert: false },
        prompt: "Check: {{ messages.text }}",
      },
      history,
      { model: recordingModel(requests) },
    );
    expect(texts(requests[0]!)).toEqual([
      "user: Check: assistant (turn 1): Hello.\n\nuser (turn 2): What is my order status?",
    ]);
  });

  it("resolves artifact media in inserted turns through the artifact store", async () => {
    const requests: ModelRequest[] = [];
    await run(
      { id: "answer", type: "prompt", history: "all", systemPrompt: "Look." },
      [
        {
          role: "user",
          content: [
            { type: "text", text: "This chart" },
            {
              type: "image",
              artifact: {
                id: "chart",
                name: "chart.png",
                mediaType: "image/png",
                sha256: "a".repeat(64),
              },
            },
          ],
        },
      ],
      {
        model: recordingModel(requests),
        artifacts: {
          put: async () => {
            throw new Error("not used");
          },
          get: async (ref) => ({ ref, data: new TextEncoder().encode("png") }),
        },
      },
    );
    expect(requests[0]!.messages[1]!.content[1]).toMatchObject({
      type: "image",
      data: btoa("png"),
      mediaType: "image/png",
    });
  });

  it("sends only images and PDFs to the model; other files become placeholders", async () => {
    const requests: ModelRequest[] = [];
    const artifact = (name: string, mediaType: string) => ({
      id: name,
      name,
      mediaType,
      sha256: "a".repeat(64),
    });
    await run(
      { id: "answer", type: "prompt", history: "all", systemPrompt: "Look." },
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Edit these." },
            {
              type: "file",
              artifact: artifact(
                "report.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              ),
            },
            {
              type: "file",
              artifact: artifact("brief.pdf", "application/pdf"),
            },
            { type: "image", artifact: artifact("chart.png", "image/png") },
            { type: "image", url: "https://example.test/photo" },
          ],
        },
      ],
      {
        model: recordingModel(requests),
        artifacts: {
          put: async () => {
            throw new Error("not used");
          },
          get: async (ref) => ({
            ref,
            data: new TextEncoder().encode("bytes"),
          }),
        },
      },
    );
    const parts = requests[0]!.messages[1]!.content;
    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "text",
      "file",
      "image",
      "image",
    ]);
    expect(parts[1]).toEqual({
      type: "text",
      text: "[file: report.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]",
    });
  });

  it("counts inserted turns toward maxMessagesPerPrompt", async () => {
    await expect(
      run(
        { id: "answer", type: "prompt", history: "all", prompt: "Go." },
        history,
        {
          model: recordingModel([]),
          manifest: { limits: { maxMessagesPerPrompt: 3 } },
          policies: { context: { strategy: "fail" } },
        },
      ),
    ).rejects.toThrow(/4 messages, exceeding the 3-message input limit/u);
  });
});

describe("the step-level history safety net", () => {
  const long = (label: string) => `${label} ${"detail ".repeat(150)}`;
  const history = [
    user(long("first")),
    assistant(long("second")),
    user(long("third")),
    assistant(long("fourth")),
    user("Newest question?"),
  ];

  it("prunes the oldest inserted messages with a note and keeps the newest", async () => {
    const requests: ModelRequest[] = [];
    const events: RunEvent[] = [];
    const result = await run(
      { id: "answer", type: "prompt", history: "all", systemPrompt: "Answer." },
      history,
      {
        model: recordingModel(requests),
        manifest: { limits: { maxInputBytes: 3_000 } },
        events,
      },
    );
    const sent = texts(requests[0]!);
    expect(sent[0]).toBe("system: Answer.");
    expect(sent[1]).toMatch(
      /^user: \[Agent Runtime removed \d earlier messages of this conversation to fit this step's context window\.\]$/u,
    );
    expect(sent.at(-1)).toBe("user: Newest question?");
    expect(
      events.find((event) => event.type === "context.reduced")!.data,
    ).toMatchObject({ scope: "messages", strategy: "prune" });
    expect(
      result.transcript!.some(
        (item) =>
          (item.metadata?.agentRuntime as JsonObject | undefined)?.context !=
          null,
      ),
    ).toBe(true);
  });

  it("summarizes the oldest inserted messages and resumes without summarizing again", async () => {
    const requests: ModelRequest[] = [];
    const model = recordingModel(requests, (request) =>
      request.messages[0]!.content.some(
        (part) =>
          part.type === "text" && part.text.includes("condense material"),
      )
        ? "They discussed first and second."
        : "Answer.",
    );
    const checkpoints: TranscriptItem[][] = [];
    const step: PromptStep = {
      id: "answer",
      type: "prompt",
      history: "all",
      systemPrompt: "Answer.",
    };
    const options = {
      model,
      manifest: { limits: { maxInputBytes: 3_000 } },
      policies: { context: { strategy: "summarize" as const } },
      checkpoints,
    };
    await run(step, history, options);
    const summarizerRequest = requests.find((request) =>
      JSON.stringify(request).includes("labeled with its turn number"),
    );
    expect(summarizerRequest).toBeDefined();
    const main = requests.at(-1)!;
    expect(texts(main)[1]).toContain(
      "[Summary of earlier messages in this conversation",
    );
    expect(texts(main)[1]).toContain("They discussed first and second.");

    const resumedRequests: ModelRequest[] = [];
    await run(step, history, {
      ...options,
      model: recordingModel(resumedRequests),
      // Interrupted after the reduction was recorded, before the main request.
      resume: {
        cursor: { stepIndex: 0 },
        transcript: checkpoints.findLast(
          (transcript) =>
            transcript.some((item) =>
              JSON.stringify(item.metadata ?? {}).includes('"history"'),
            ) && !transcript.some((item) => item.role === "assistant"),
        )!,
      },
    });
    expect(resumedRequests).toHaveLength(1);
    expect(resumedRequests[0]!.messages).toEqual(main.messages);
  });
});

describe("PromptMessageHistoryCompactor", () => {
  const manifest: AgentManifest = {
    schemaVersion: "1.0",
    model: { provider: "openai", model: "gpt-test" },
    messages: { maxMessages: 4 },
    steps: [],
  };

  const request = (
    overrides: Partial<MessageHistoryCompactionRequest> = {},
  ): MessageHistoryCompactionRequest & {
    saved: Array<{ journal: JsonObject; transcript: TranscriptItem[] }>;
    events: Array<{ type: string; data?: JsonObject }>;
  } => {
    const saved: Array<{ journal: JsonObject; transcript: TranscriptItem[] }> =
      [];
    const events: Array<{ type: string; data?: JsonObject }> = [];
    return {
      runId: "run-1",
      manifest,
      text: "user: a\n\nassistant: b",
      label: "2 earlier messages",
      task: "Customer support",
      segmentBytes: 5_000,
      maxTargetBytes: 2_000,
      policies: {},
      checkpoint: async (input) => {
        saved.push(structuredClone(input));
      },
      emit: async (type, data) => {
        events.push({ type, ...(data ? { data } : {}) });
        return {} as RunEvent;
      },
      saved,
      events,
      ...overrides,
    };
  };

  it("summarizes with the messages instruction and records usage", async () => {
    const requests: ModelRequest[] = [];
    const model: ModelAdapter = {
      generate: async (modelRequest) => {
        requests.push(structuredClone({ ...modelRequest, signal: undefined }));
        return {
          ...reply("They agreed on a refund."),
          transcript: [
            {
              ...reply("x").transcript[0]!,
              usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
            },
          ],
        };
      },
    };
    const input = request({ model });
    const result = await new PromptMessageHistoryCompactor().summarize(input);
    expect(result.text).toBe("They agreed on a refund.");
    expect(result.summarizerCalls).toBe(1);
    expect(result.transcript[0]!.usage).toMatchObject({ totalTokens: 30 });
    const user = requests[0]!.messages[1]!.content[0];
    expect(user).toMatchObject({ type: "text" });
    expect((user as { text: string }).text).toContain(
      "The material above is 2 earlier messages, between a user and an assistant about: Customer support",
    );
    expect(input.events.map((event) => event.type)).toEqual([
      "model.started",
      "model.completed",
      "model.usage",
    ]);
    expect(input.events[0]!.data).toMatchObject({ purpose: "summarize" });
    expect(input.saved.at(-1)!.journal).toMatchObject({
      calls: [{ text: "They agreed on a refund." }],
    });
  });

  it("replays a journal without calling the model again", async () => {
    let calls = 0;
    const model: ModelAdapter = {
      generate: async () => {
        calls += 1;
        return reply("Summary.");
      },
    };
    const first = request({ model });
    await new PromptMessageHistoryCompactor().summarize(first);
    const second = await new PromptMessageHistoryCompactor().summarize(
      request({ model, journal: first.saved.at(-1)!.journal }),
    );
    expect(second.text).toBe("Summary.");
    expect(calls).toBe(1);
  });

  it("lets a host summarizer see kind messages and report usage", async () => {
    const seen: unknown[] = [];
    const input = request({
      summarizer: {
        summarize: async (summarizeRequest) => {
          seen.push(summarizeRequest);
          return { text: "Host summary.", usage: { totalTokens: 7 } };
        },
      },
    });
    const result = await new PromptMessageHistoryCompactor().summarize(input);
    expect(result.text).toBe("Host summary.");
    expect(seen[0]).toMatchObject({
      runId: "run-1",
      kind: "messages",
      label: "2 earlier messages",
      task: "Customer support",
    });
    expect(seen[0]).toMatchObject({ stepId: "" });
    expect(result.transcript[0]!.usage).toEqual({ totalTokens: 7 });
  });

  it("suspends before a call when the token budget is exhausted", async () => {
    await expect(
      new PromptMessageHistoryCompactor().summarize(
        request({
          model: recordingModel([]),
          tokenBudget: {
            maxTotalTokens: 10,
            consumedTokens: 10,
            consume: () => ({ maxTotalTokens: 10, consumedTokens: 10 }),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RunSuspendedError);
  });

  it("rejects truncated summaries", async () => {
    await expect(
      new PromptMessageHistoryCompactor().summarize(
        request({
          model: {
            generate: async () => ({
              ...reply("partial"),
              finishReason: "length",
            }),
          },
        }),
      ),
    ).rejects.toThrow(/truncated/u);
  });
});
