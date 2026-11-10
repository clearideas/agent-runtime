import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentManifest,
  ConversationMessage,
} from "@clearideas/agent-runtime-contracts";
import { JexlConditionEvaluator } from "@clearideas/agent-runtime-condition-jexl";
import { FileArtifactStore } from "@clearideas/agent-runtime-store-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdmissionController } from "./admission.js";
import { canStreamLive, conditionReads, planAnswer } from "./answer.js";
import { Authenticator } from "./auth.js";
import {
  convertChatMessages,
  mapInputVariables,
  splitNewTurn,
} from "./convert.js";
import { ServerError } from "./errors.js";
import { MemoryKeyValueStore, SqliteKeyValueStore } from "./kv.js";
import { ConversationLedger, ledgerKey } from "./ledger.js";
import { MediaIngestor, parseDataUrl } from "./media.js";
import { parseChatCompletionRequest } from "./openai.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const pngUrl = `data:image/png;base64,${PNG.toString("base64")}`;

describe("key-value stores", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-kv-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  for (const driver of ["memory", "sqlite"] as const) {
    it(`${driver}: expires entries and hands expired ones to takeExpired`, async () => {
      let now = 1_000;
      const clock = () => now;
      const store =
        driver === "memory"
          ? new MemoryKeyValueStore({ now: clock })
          : await SqliteKeyValueStore.open(path.join(directory, "kv.sqlite"), {
              now: clock,
            });
      await store.set("ns", "a", "1", 100);
      await store.set("ns", "b", "2", 500);
      await store.set("other", "a", "x", 100);
      expect(await store.get("ns", "a")).toBe("1");
      now += 200;
      expect(await store.get("ns", "a")).toBeUndefined();
      expect(await store.get("ns", "b")).toBe("2");
      // A still-present expired entry of another namespace is not taken.
      await store.set("ns", "c", "3", 50);
      now += 100;
      const taken = await store.takeExpired("ns", 10);
      expect(taken.map((entry) => entry.key).sort()).toEqual(
        driver === "memory" ? ["c"] : ["a", "c"],
      );
      expect(await store.takeExpired("ns", 10)).toEqual([]);
      await store.delete("ns", "b");
      expect(await store.get("ns", "b")).toBeUndefined();
      await store.close?.();
    });
  }

  it("memory: evicts the least recently used entries above its bound", async () => {
    const store = new MemoryKeyValueStore({ maxEntries: 2 });
    await store.set("ns", "a", "1", 10_000);
    await store.set("ns", "b", "2", 10_000);
    await store.get("ns", "a");
    await store.set("ns", "c", "3", 10_000);
    expect(await store.get("ns", "a")).toBe("1");
    expect(await store.get("ns", "b")).toBeUndefined();
    expect(await store.get("ns", "c")).toBe("3");
  });
});

describe("admission control", () => {
  it("limits runs globally and per principal, in order", async () => {
    const admission = new AdmissionController({
      maxConcurrentRuns: 2,
      maxQueuedRequests: 5,
      queueTimeoutMs: 5_000,
    });
    const first = await admission.acquire("a", 1, undefined);
    const order: string[] = [];
    const secondA = admission.acquire("a", 1).then((release) => {
      order.push("a2");
      return release;
    });
    const firstB = await admission.acquire("b", undefined);
    expect(admission.snapshot).toEqual({ active: 2, queued: 1 });
    const secondB = admission.acquire("b", undefined).then((release) => {
      order.push("b2");
      return release;
    });
    firstB();
    // b2 fits while a2 still waits for a's own limit.
    (await secondB)();
    expect(order).toEqual(["b2"]);
    first();
    (await secondA)();
    expect(order).toEqual(["b2", "a2"]);
    expect(admission.snapshot).toEqual({ active: 0, queued: 0 });
  });

  it("refuses beyond the queue, after the queue timeout, and on abort", async () => {
    const admission = new AdmissionController({
      maxConcurrentRuns: 1,
      maxQueuedRequests: 1,
      queueTimeoutMs: 50,
    });
    const held = await admission.acquire("a", undefined);
    const queued = admission.acquire("a", undefined);
    await expect(admission.acquire("a", undefined)).rejects.toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      retryAfter: 1,
    });
    await expect(queued).rejects.toMatchObject({ status: 429 });
    const controller = new AbortController();
    const aborted = admission.acquire("a", undefined, controller.signal);
    controller.abort(new Error("gone"));
    await expect(aborted).rejects.toThrow("gone");
    held();
    expect(admission.snapshot).toEqual({ active: 0, queued: 0 });
  });
});

describe("authentication", () => {
  const request = (authorization?: string) => ({
    method: "GET",
    path: "/v1/models",
    headers: authorization ? { authorization } : {},
  });

  it("accepts configured keys from the environment or as digests", async () => {
    const auth = new Authenticator({
      keys: [
        { id: "env-key", key: { env: "KEY_ONE" }, models: ["a"] },
        {
          id: "digest-key",
          key: {
            sha256: createHash("sha256").update("secret-two").digest("hex"),
          },
          models: "*",
          maxConcurrentRuns: 2,
        },
      ],
      environment: { KEY_ONE: "secret-one" },
      allowAnonymous: true,
    });
    expect(auth.anonymous).toBe(false);
    const one = await auth.authenticate(request("Bearer secret-one"));
    expect(one.id).toBe("env-key");
    expect(one.models).toEqual(new Set(["a"]));
    const two = await auth.authenticate(request("bearer secret-two"));
    expect(two).toMatchObject({
      id: "digest-key",
      models: "*",
      maxConcurrentRuns: 2,
    });
    await expect(
      auth.authenticate(request("Bearer wrong")),
    ).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
      message: "Incorrect API key provided.",
    });
    await expect(auth.authenticate(request())).rejects.toMatchObject({
      status: 401,
    });
  });

  it("fails fast when a key's environment variable is missing", () => {
    expect(
      () =>
        new Authenticator({
          keys: [{ id: "k", key: { env: "MISSING_KEY" }, models: "*" }],
          environment: {},
          allowAnonymous: false,
        }),
    ).toThrow(/MISSING_KEY, which is not set/u);
  });

  it("consults the host hook for credentials that are not API keys", async () => {
    const auth = new Authenticator({
      keys: [],
      hook: (input) =>
        input.headers.authorization === "Bearer jwt-token"
          ? { id: "user-7", models: ["a"], scope: "tenant:1/user:7" }
          : undefined,
      allowAnonymous: true,
    });
    expect(auth.anonymous).toBe(false);
    await expect(
      auth.authenticate(request("Bearer jwt-token")),
    ).resolves.toMatchObject({
      id: "user-7",
      scope: "tenant:1/user:7",
    });
    await expect(
      auth.authenticate(request("Bearer nope")),
    ).rejects.toBeInstanceOf(ServerError);
  });
});

describe("request validation", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };

  it("accepts and ignores unknown and sampling parameters", () => {
    expect(() =>
      parseChatCompletionRequest({
        ...base,
        temperature: 0.2,
        top_p: 1,
        seed: 3,
        some_vendor_field: { x: 1 },
        parallel_tool_calls: true,
        tool_choice: "auto",
      }),
    ).not.toThrow();
  });

  it.each([
    [{ tools: [{ type: "function", function: { name: "f" } }] }, "tools"],
    [{ functions: [{ name: "f" }] }, "functions"],
    [
      { tool_choice: { type: "function", function: { name: "f" } } },
      "tool_choice",
    ],
    [{ n: 2 }, "n"],
    [{ logprobs: true }, "logprobs"],
    [{ modalities: ["text", "audio"] }, "modalities"],
  ])("refuses %j", (extra, param) => {
    expect(() => parseChatCompletionRequest({ ...base, ...extra })).toThrow(
      expect.objectContaining({ status: 400, param }),
    );
  });

  it("ignores client tools when the policy is ignore", () => {
    const request = parseChatCompletionRequest(
      {
        ...base,
        tools: [{ type: "function", function: { name: "f" } }],
        tool_choice: { type: "function", function: { name: "f" } },
      },
      "ignore",
    );
    expect(request.tools).toHaveLength(1);
  });

  it("reports malformed bodies", () => {
    expect(() =>
      parseChatCompletionRequest({ model: "m", messages: [] }),
    ).toThrow(/messages/u);
  });
});

describe("message conversion", () => {
  let directory: string;
  let artifacts: FileArtifactStore;
  let media: MediaIngestor;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-convert-"));
    artifacts = new FileArtifactStore(directory);
    media = new MediaIngestor(new MemoryKeyValueStore(), {
      maxInlineBytes: 1024,
      urls: "allow",
      allowOrigins: ["https://images.example.com"],
      ttlMs: 60_000,
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const convert = (
    messages: unknown[],
    allowMedia = true,
    clientTools: "ignore" | "reject" = "reject",
  ) =>
    convertChatMessages(
      parseChatCompletionRequest({ model: "m", messages }, clientTools)
        .messages,
      { allowMedia, clientTools, media, scope: "key:a", artifacts },
    );

  it("turns system and developer messages into instructions", async () => {
    const converted = await convert([
      { role: "system", content: "Be terse." },
      { role: "developer", content: [{ type: "text", text: "Use French." }] },
      { role: "user", content: "Bonjour" },
    ]);
    expect(converted.instructions).toBe("Be terse.\n\nUse French.");
    expect(converted.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Bonjour" }] },
    ]);
  });

  it("converts text, refusals, images, and files", async () => {
    const converted = await convert([
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "image_url", image_url: { url: pngUrl } },
        ],
      },
      { role: "assistant", content: null, refusal: "I can't." },
      { role: "assistant", content: "" },
      {
        role: "user",
        content: [
          {
            type: "file",
            file: {
              filename: "a.pdf",
              file_data: `data:application/pdf;base64,${Buffer.from("%PDF").toString("base64")}`,
            },
          },
          {
            type: "image_url",
            image_url: { url: "https://images.example.com/x.png" },
          },
        ],
      },
    ]);
    expect(converted.messages).toHaveLength(3);
    expect(converted.messages[0]!.content[1]).toMatchObject({
      type: "image",
      artifact: {
        mediaType: "image/png",
        sha256: createHash("sha256").update(PNG).digest("hex"),
      },
    });
    expect(converted.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "I can't." }],
    });
    expect(converted.messages[2]!.content[0]).toMatchObject({
      type: "file",
      name: "a.pdf",
      artifact: { mediaType: "application/pdf" },
    });
    expect(converted.messages[2]!.content[1]).toEqual({
      type: "image",
      url: "https://images.example.com/x.png",
    });
  });

  it.each([
    [
      [
        { role: "tool", content: "x", tool_call_id: "1" },
        { role: "user", content: "u" },
      ],
      /tool messages are not supported/u,
    ],
    [
      [
        { role: "user", content: "u" },
        { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
        { role: "user", content: "u" },
      ],
      /tool calls are not supported/u,
    ],
    [
      [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }],
      /input_audio/u,
    ],
    [
      [
        {
          role: "user",
          content: [{ type: "file", file: { file_id: "file-1" } }],
        },
      ],
      /file_id/u,
    ],
    [
      [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://evil.example.com/x.png" },
            },
          ],
        },
      ],
      /Media URLs are not accepted/u,
    ],
    [
      [
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ],
      /last message must be a user message/u,
    ],
    [
      [
        {
          role: "system",
          content: [{ type: "image_url", image_url: { url: pngUrl } }],
        },
        { role: "user", content: "u" },
      ],
      /may contain only text/u,
    ],
  ])("refuses %#", async (messages, message) => {
    await expect(convert(messages)).rejects.toThrow(message);
  });

  it("drops client tool history when client tools are ignored", async () => {
    const converted = await convert(
      [
        { role: "user", content: "u" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: { name: "f", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "forged tool result", tool_call_id: "1" },
        { role: "user", content: "and?" },
      ],
      true,
      "ignore",
    );
    expect(converted.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "u" }] },
      { role: "assistant", content: [{ type: "text", text: "Let me check." }] },
      { role: "user", content: [{ type: "text", text: "and?" }] },
    ]);
  });

  it("accepts text only in variable mode", async () => {
    await expect(
      convert(
        [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: pngUrl } }],
          },
        ],
        false,
      ),
    ).rejects.toThrow(/accepts text only/u);
  });

  it("splits the new turn from the prefix", () => {
    const user = (text: string): ConversationMessage => ({
      role: "user",
      content: [{ type: "text", text }],
    });
    const assistant = (text: string): ConversationMessage => ({
      role: "assistant",
      content: [{ type: "text", text }],
    });
    expect(splitNewTurn([user("a")])).toEqual({
      prefix: [],
      newTurn: [user("a")],
    });
    expect(
      splitNewTurn([user("a"), assistant("b"), user("c"), user("d")]),
    ).toEqual({
      prefix: [user("a"), assistant("b")],
      newTurn: [user("c"), user("d")],
    });
  });

  it("maps variables from the request", async () => {
    const chat = await convert([
      { role: "system", content: "Formal." },
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: '{"topic":"checkpoints","depth":2}' },
    ]);
    const request = parseChatCompletionRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      variables: { tone: "warm", ignored: "x" },
    });
    expect(
      mapInputVariables({
        mappings: [
          { variable: "question", source: "last-user" },
          { variable: "history", source: "transcript" },
          { variable: "style", source: "system" },
          { variable: "topic", source: "json", key: "topic" },
          { variable: "depth", source: "json", key: "depth" },
          { variable: "tone", source: "client", key: "tone" },
          { variable: "absent", source: "client", key: "absent" },
        ],
        chat,
        request,
      }),
    ).toEqual([
      { key: "question", value: '{"topic":"checkpoints","depth":2}' },
      { key: "history", value: "user: first\n\nassistant: reply" },
      { key: "style", value: "Formal." },
      { key: "topic", value: "checkpoints" },
      { key: "depth", value: 2 },
      { key: "tone", value: "warm" },
    ]);
    expect(() =>
      mapInputVariables({
        mappings: [{ variable: "topic", source: "json", key: "topic" }],
        chat: { instructions: "", messages: chat.messages.slice(0, 1) },
        request,
      }),
    ).toThrow(/JSON object/u);
  });
});

describe("media ingestion", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-runtime-media-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("stores the same bytes once per scope and authorizes only minted references", async () => {
    let puts = 0;
    const files = new FileArtifactStore(directory);
    const artifacts = {
      put: async (input: Parameters<FileArtifactStore["put"]>[0]) => {
        puts += 1;
        return files.put(input);
      },
      get: files.get.bind(files),
    };
    const media = new MediaIngestor(new MemoryKeyValueStore(), {
      maxInlineBytes: 1024,
      urls: "reject",
      allowOrigins: [],
      ttlMs: 60_000,
    });
    const part = (scope: string) =>
      media.part({ kind: "image", source: pngUrl, scope, artifacts });
    const first = await part("key:a");
    const again = await part("key:a");
    const other = await part("key:b");
    expect(puts).toBe(2);
    expect(again).toEqual(first);
    const ref = (first as { artifact: { id: string } }).artifact;
    expect(await media.authorize(ref as never, "key:a")).toBe(true);
    expect(await media.authorize(ref as never, "key:b")).toBe(false);
    expect(
      await media.authorize(
        { ...(ref as object), id: "artifact_forged" } as never,
        "key:a",
      ),
    ).toBe(false);
    expect((other as { artifact: { id: string } }).artifact.id).not.toBe(
      ref.id,
    );
    await expect(
      media.part({
        kind: "image",
        source: "https://x.example.com/a.png",
        scope: "key:a",
        artifacts,
      }),
    ).rejects.toThrow(/not accepted/u);
    await expect(
      media.part({
        kind: "image",
        source: `data:image/png;base64,${Buffer.alloc(2048).toString("base64")}`,
        scope: "key:a",
        artifacts,
      }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      media.part({
        kind: "image",
        source: "data:text/plain;base64,aGk=",
        scope: "key:a",
        artifacts,
      }),
    ).rejects.toThrow(/image media type/u);
  });

  it("parses only base64 data URLs", () => {
    expect(parseDataUrl("https://example.com")).toBeUndefined();
    expect(parseDataUrl("data:image/png;base64,aGk=")).toMatchObject({
      mediaType: "image/png",
    });
    expect(() => parseDataUrl("data:text/plain,hi")).toThrow(/base64/u);
    expect(() => parseDataUrl("data:image/png;base64,*not*")).toThrow(
      /not valid base64/u,
    );
  });
});

describe("conversation ledger", () => {
  const text = (
    role: "user" | "assistant",
    value: string,
  ): ConversationMessage => ({
    role,
    content: [{ type: "text", text: value }],
  });

  it("matches the client-visible conversation, normalizing whitespace", () => {
    const key = (
      messages: ConversationMessage[],
      match: "exact" | "user-turns" = "exact",
    ) => ledgerKey({ scope: "key:a", model: "m", match, messages });
    const base = [text("user", "Hi"), text("assistant", "Hello there")];
    expect(key(base)).toBe(
      key([text("user", "Hi\r\n"), text("assistant", "Hello there  ")]),
    );
    expect(key(base)).not.toBe(
      key([text("user", "Hi"), text("assistant", "Hello there!")]),
    );
    expect(key(base, "user-turns")).toBe(
      key(
        [text("user", "Hi"), text("assistant", "Rewritten by the client")],
        "user-turns",
      ),
    );
    expect(key(base)).not.toBe(
      ledgerKey({ scope: "key:b", model: "m", match: "exact", messages: base }),
    );
    expect(key(base)).not.toBe(
      ledgerKey({
        scope: "key:a",
        model: "other",
        match: "exact",
        messages: base,
      }),
    );
  });

  it("records and finds entries by scope and model", async () => {
    const ledger = new ConversationLedger(new MemoryKeyValueStore(), {
      ttlMs: 60_000,
      match: "exact",
    });
    const messages = [text("user", "Hi"), text("assistant", "Hello")];
    await ledger.record({
      messages,
      entry: {
        history: messages,
        scope: "key:a",
        runId: "run_1",
        model: "m",
        manifestHash: "sha256:x",
        createdAt: new Date().toISOString(),
      },
    });
    expect(
      await ledger.lookup({ scope: "key:a", model: "m", messages }),
    ).toMatchObject({
      runId: "run_1",
    });
    expect(
      await ledger.lookup({ scope: "key:b", model: "m", messages }),
    ).toBeUndefined();
    expect(
      await ledger.lookup({
        scope: "key:a",
        model: "m",
        messages: [messages[0]!],
      }),
    ).toBeUndefined();
  });
});

describe("live streaming decisions", () => {
  const prompt = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: "prompt" as const,
    prompt: id,
    ...extra,
  });
  const manifest = (steps: unknown[]): AgentManifest =>
    ({ schemaVersion: "1.0", steps }) as AgentManifest;
  const decide = (
    target: AgentManifest,
    stepId: string,
    variables: Record<string, unknown>,
    options: {
      mode?: "auto" | "live" | "committed";
      completed?: string[];
    } = {},
  ) =>
    canStreamLive({
      manifest: target,
      plan: planAnswer(target),
      mode: options.mode ?? "auto",
      step: target.steps.find((step) => step.id === stepId)!,
      variables: variables as never,
      completedCandidates: new Set(options.completed ?? []),
      evaluator: new JexlConditionEvaluator(),
    });

  const branching = manifest([
    prompt("moderate", {
      outputVariable: "check",
      outputSchema: { type: "object" },
    }),
    prompt("answer", {
      when: "check.allowed == true",
      includeInFinalOutput: true,
    }),
    prompt("decline", {
      when: "check.allowed == false",
      includeInFinalOutput: true,
    }),
  ]);

  it("streams the branch that runs when later candidates are provably skipped", async () => {
    await expect(
      decide(branching, "answer", { check: { allowed: true } }),
    ).resolves.toBe(true);
    await expect(
      decide(branching, "decline", { check: { allowed: false } }),
    ).resolves.toBe(true);
    // Never the classifier, which is not a candidate.
    await expect(decide(branching, "moderate", {})).resolves.toBe(false);
  });

  it("commits when a later step could still change the reply", async () => {
    const checked = manifest([
      prompt("answer", {
        outputVariable: "answer",
        includeInFinalOutput: true,
      }),
      prompt("review", {
        outputVariable: "review",
        outputSchema: { type: "object" },
      }),
      prompt("blocked", {
        when: "review.allowed == false",
        includeInFinalOutput: true,
      }),
    ]);
    // `blocked` reads `review`, written after the answer: not provable.
    await expect(decide(checked, "answer", {})).resolves.toBe(false);
    const unconditional = manifest([
      prompt("a", { includeInFinalOutput: true }),
      prompt("b", { includeInFinalOutput: true }),
    ]);
    await expect(decide(unconditional, "a", {})).resolves.toBe(false);
    // b would join a's output.
    await expect(
      decide(unconditional, "b", {}, { completed: ["a"] }),
    ).resolves.toBe(false);
  });

  it("treats every later step as a candidate without includeInFinalOutput", async () => {
    const implicit = manifest([prompt("draft"), prompt("polish")]);
    await expect(decide(implicit, "draft", {})).resolves.toBe(false);
    await expect(decide(implicit, "polish", {})).resolves.toBe(true);
  });

  it("never streams structured, tool-using, or projected steps, and honors modes", async () => {
    const structured = manifest([
      prompt("a", {
        outputSchema: { type: "object" },
        includeInFinalOutput: true,
      }),
    ]);
    const tools = manifest([
      prompt("a", { tools: ["docs__search"], includeInFinalOutput: true }),
    ]);
    await expect(decide(structured, "a", {})).resolves.toBe(false);
    await expect(decide(tools, "a", {})).resolves.toBe(false);
    await expect(
      decide(
        branching,
        "answer",
        { check: { allowed: true } },
        { mode: "committed" },
      ),
    ).resolves.toBe(false);
    await expect(
      decide(
        branching,
        "answer",
        { check: { allowed: true } },
        { mode: "live" },
      ),
    ).resolves.toBe(true);
    const projected = {
      ...branching,
      extensions: { agentRuntime: { stateProjection: "step-output-state-v1" } },
    } as AgentManifest;
    await expect(
      decide(projected, "answer", { check: { allowed: true } }),
    ).resolves.toBe(false);
  });

  it("detects variable reads in conditions and templates", () => {
    expect(conditionReads("check.allowed == true", "check")).toBe(true);
    expect(conditionReads("recheck == true", "check")).toBe(false);
    expect(conditionReads("{{ check }} == 'x'", "check")).toBe(true);
    expect(conditionReads("messages.count > 2", "messages")).toBe(true);
  });
});
