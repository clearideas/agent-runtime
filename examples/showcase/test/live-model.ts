/**
 * A stand-in for a real provider, for testing the showcase's Live path.
 *
 * Live mode runs each demo through Agent Runtime's AI SDK adapter instead of
 * the scripted adapter. That path has its own failure modes, such as
 * structured output combined with tool calls, so the tests exercise it with
 * no API key: this file builds an AI SDK `MockLanguageModelV4` and wraps it in
 * the real `AiSdkModelAdapter`. The mock reads the provider-level prompt the
 * AI SDK builds, turns it back into a `ScriptRequest`, asks the demo script
 * what to do, and streams the answer back as provider stream parts: narration
 * text, then either a tool call or the step's final output.
 */
import {
  AiSdkModelAdapter,
  type JsonValue,
  type ModelAdapter,
  type ToolResult,
} from "@clearideas/agent-runtime";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

import type { Script, ScriptRequest } from "../lib/scripted-model.ts";

type Part = Record<string, any>;
interface PromptMessage {
  role: string;
  content: string | Part[];
}

const partsOf = (message: PromptMessage): Part[] =>
  typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;

const texts = (messages: PromptMessage[]) =>
  messages
    .flatMap(partsOf)
    .flatMap((part) => (part.type === "text" ? [part.text as string] : []))
    .join("\n");

/** The step prompt: user messages before the model's first turn. */
const stepPrompt = (prompt: PromptMessage[]) => {
  const first = prompt.findIndex((message) => message.role === "assistant");
  return texts(
    (first < 0 ? prompt : prompt.slice(0, first)).filter(
      (message) => message.role === "user",
    ),
  );
};

const parseText = (text: string): JsonValue => {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
};

/** Rebuild the runtime's ToolResult from the AI SDK's tool-result part. */
const toolResultOf = (part: Part): ToolResult => {
  const base = { callId: part.toolCallId, name: part.toolName };
  const output = part.output as { type: string; value: any };
  if (output.type === "content") {
    const items = output.value as Part[];
    const text = items.find((item) => item.type === "text");
    return {
      ...base,
      ...(text ? { output: parseText(text.text) } : {}),
      artifacts: items
        .filter((item) => item.type !== "text")
        .map((item, index) => ({
          id: `${part.toolCallId}-artifact-${index}`,
          name: item.filename ?? `artifact-${index}`,
          mediaType: item.mediaType ?? "application/octet-stream",
        })),
    } as ToolResult;
  }
  const value = output.value;
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    value.error &&
    typeof value.error === "object" &&
    "code" in value.error
  ) {
    return { ...base, error: value.error } as ToolResult;
  }
  return { ...base, output: (value ?? null) as JsonValue } as ToolResult;
};

/** Size of a provider file part's data, however the AI SDK delivered it. */
const byteLength = (data: any): number => {
  const value =
    data?.type === "data" ? data.data : data?.type === "url" ? data.url : data;
  if (value instanceof Uint8Array) return value.byteLength;
  const text = String(value);
  const base64 = text.startsWith("data:")
    ? text.slice(text.indexOf(",") + 1)
    : text;
  return Buffer.from(base64, "base64").byteLength;
};

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

export interface LiveModelLog {
  /** Every provider call the mock answered, in order. */
  calls: Array<{
    structured: boolean;
    tools: string[];
    toolCall?: string;
    /** Media types and byte sizes of files the provider received. */
    files: Array<{ mediaType: string; bytes: number }>;
  }>;
}

/**
 * A ModelAdapter that goes through the real AI SDK adapter, answered by the
 * given demo script.
 */
export const liveModel = (
  script: Script,
  log: LiveModelLog = { calls: [] },
): ModelAdapter => {
  let sequence = 0;
  /** One provider turn as stream parts; doGenerate reuses it. */
  const answer = (options: any): Part[] => {
    {
      const prompt = options.prompt as PromptMessage[];
      const toolParts = prompt
        .filter((message) => message.role === "tool")
        .flatMap(partsOf)
        .filter((part) => part.type === "tool-result");
      const request: ScriptRequest = {
        system: texts(prompt.filter((message) => message.role === "system")),
        prompt: stepPrompt(prompt),
        tools: (options.tools ?? []).map((tool: Part) => tool.name as string),
        results: toolParts.map(toolResultOf),
        turn: prompt.filter(
          (message) =>
            message.role === "assistant" &&
            partsOf(message).some((part) => part.type === "tool-call"),
        ).length,
        structured: options.responseFormat?.type === "json",
      };
      const turn = script(request);
      sequence += 1;
      const id = `live-${sequence}`;
      const parts: Part[] = [{ type: "stream-start", warnings: [] }];
      const text = (value: string) => {
        parts.push(
          { type: "text-start", id },
          { type: "text-delta", id, delta: value },
          { type: "text-end", id },
        );
      };
      if ("call" in turn) {
        if (turn.say) text(turn.say);
        parts.push(
          {
            type: "tool-call",
            toolCallId: `call-${sequence}`,
            toolName: turn.call.name,
            input: JSON.stringify(turn.call.input),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: usage(100, 20),
          },
        );
      } else {
        // A provider's final answer is only the output: JSON for structured
        // steps, plain text otherwise.
        text(
          typeof turn.output === "string" && !request.structured
            ? turn.output
            : JSON.stringify(turn.output),
        );
        parts.push({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(100, 40),
        });
      }
      log.calls.push({
        structured: request.structured,
        tools: request.tools,
        files: toolParts
          .flatMap((part) =>
            part.output?.type === "content"
              ? (part.output.value as Part[]).filter(
                  (item) => item.type === "file",
                )
              : [],
          )
          .map((file) => ({
            mediaType: file.mediaType,
            bytes: byteLength(file.data),
          })),
        ...("call" in turn ? { toolCall: turn.call.name } : {}),
      });
      return parts;
    }
  };
  const model = new MockLanguageModelV4({
    doStream: async (options: any) => ({
      stream: convertArrayToReadableStream(answer(options) as never[]),
    }),
    // Non-streaming calls, such as a context summarizer's, get the same turn.
    doGenerate: async (options: any) => {
      const parts = answer(options);
      const finish = parts.find((part) => part.type === "finish")!;
      return {
        content: parts.flatMap((part) =>
          part.type === "text-delta"
            ? [{ type: "text", text: part.delta }]
            : part.type === "tool-call"
              ? [part]
              : [],
        ),
        finishReason: finish.finishReason,
        usage: finish.usage,
        warnings: [],
      } as never;
    },
  });
  return new AiSdkModelAdapter({ resolveModel: () => model as never });
};
