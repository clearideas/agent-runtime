import type {
  ContentPart,
  JsonObject,
  JsonValue,
  ModelUsage,
  ToolCall,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import type {
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResult,
  AgentTool,
} from "@clearideas/agent-runtime-core/ports";
import {
  type AssistantContent,
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage as AiSdkModelMessage,
  Output,
  streamText,
  tool,
  type ToolContent,
  type ToolSet,
  type UserContent,
} from "ai";

export type ModelResolver = (model: string) => LanguageModel;
export type ProviderModelFactory = (modelId: string) => LanguageModel;

export interface ProviderRegistryOptions {
  defaultProvider?: string;
}

export interface ParsedModelKey {
  provider: string;
  modelId: string;
}

export const parseModelKey = (
  value: string,
  defaultProvider?: string,
): ParsedModelKey => {
  const normalized = value.trim();
  const separator = normalized.indexOf("/");
  if (separator > 0 && separator < normalized.length - 1) {
    return {
      provider: normalized.slice(0, separator),
      modelId: normalized.slice(separator + 1),
    };
  }
  if (defaultProvider && normalized) {
    return { provider: defaultProvider, modelId: normalized };
  }
  throw new Error(
    `Model "${value}" must use provider/model format or configure a default provider`,
  );
};

/** Creates a resolver from any set of AI SDK-compatible provider factories. */
export const createProviderRegistryModelResolver =
  (
    providers: Readonly<Record<string, ProviderModelFactory>>,
    options: ProviderRegistryOptions = {},
  ): ModelResolver =>
  (model) => {
    const parsed = parseModelKey(model, options.defaultProvider);
    const provider = providers[parsed.provider];
    if (!provider) {
      throw new Error(
        `No AI SDK provider factory is registered for "${parsed.provider}"`,
      );
    }
    return provider(parsed.modelId);
  };

export interface AiSdkCallOptions {
  model: LanguageModel;
  system?: string;
  messages: AiSdkModelMessage[];
  tools?: ToolSet;
  output?: unknown;
  providerOptions?: JsonObject;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface AiSdkUsage {
  inputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokens?: number;
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
  totalTokens?: number;
  raw?: unknown;
}

export interface AiSdkToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface AiSdkGenerateResult {
  text: string;
  reasoningText?: string;
  toolCalls: readonly AiSdkToolCall[];
  finishReason?: string;
  totalUsage?: AiSdkUsage;
  providerMetadata?: unknown;
  output?: unknown;
}

export interface AiSdkStreamPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  finishReason?: string;
  usage?: AiSdkUsage;
  totalUsage?: AiSdkUsage;
  providerMetadata?: unknown;
  reason?: string;
  error?: unknown;
  [key: string]: unknown;
}

export interface AiSdkStreamResult {
  fullStream: AsyncIterable<AiSdkStreamPart>;
  output?: PromiseLike<unknown> | unknown;
}

export type GenerateTextFunction = (
  options: AiSdkCallOptions,
) => Promise<AiSdkGenerateResult>;

export type StreamTextFunction = (
  options: AiSdkCallOptions,
) => AiSdkStreamResult;

export interface AiSdkModelAdapterOptions {
  resolveModel: ModelResolver;
  generateText?: GenerateTextFunction;
  streamText?: StreamTextFunction;
  now?: () => Date;
  generateTranscriptId?: () => string;
}

const defaultGenerateText: GenerateTextFunction = async (options) => {
  const result = await generateText(
    options as Parameters<typeof generateText>[0],
  );
  return result as unknown as AiSdkGenerateResult;
};

const defaultStreamText: StreamTextFunction = (options) => {
  const result = streamText(options as Parameters<typeof streamText>[0]);
  return result as unknown as AiSdkStreamResult;
};

/**
 * Keeps AI SDK provider and message types behind the neutral ModelAdapter port.
 * Tool definitions are advertised without execute functions; Agent Runtime owns
 * ordered tool execution through ToolAdapter.
 */
export class AiSdkModelAdapter implements ModelAdapter {
  readonly #resolveModel: ModelResolver;
  readonly #generateText: GenerateTextFunction;
  readonly #streamText: StreamTextFunction;
  readonly #now: () => Date;
  readonly #generateTranscriptId: () => string;

  constructor(options: AiSdkModelAdapterOptions) {
    this.#resolveModel = options.resolveModel;
    this.#generateText = options.generateText ?? defaultGenerateText;
    this.#streamText = options.streamText ?? defaultStreamText;
    this.#now = options.now ?? (() => new Date());
    this.#generateTranscriptId =
      options.generateTranscriptId ?? (() => globalThis.crypto.randomUUID());
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    const result = await this.#generateText(this.#toCallOptions(request));
    return this.#toModelResult(request, result);
  }

  async *stream(
    request: ModelRequest,
  ): AsyncIterable<
    | { type: "text-delta"; delta: string }
    | { type: "reasoning-delta"; delta: string }
    | { type: "tool-call"; call: ToolCall }
    | { type: "completed"; result: ModelResult }
  > {
    const result = this.#streamText(this.#toCallOptions(request));
    let text = "";
    let reasoning = "";
    let finishReason: string | undefined;
    let usage: AiSdkUsage | undefined;
    let providerMetadata: unknown;
    const toolCalls: ToolCall[] = [];

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          if (typeof part.text !== "string") break;
          text += part.text;
          yield { type: "text-delta", delta: part.text };
          break;
        case "reasoning-delta":
          if (typeof part.text !== "string") break;
          reasoning += part.text;
          yield { type: "reasoning-delta", delta: part.text };
          break;
        case "tool-call": {
          if (
            typeof part.toolCallId !== "string" ||
            typeof part.toolName !== "string"
          )
            break;
          const call = toToolCall({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          toolCalls.push(call);
          yield { type: "tool-call", call };
          break;
        }
        case "finish-step":
          finishReason =
            typeof part.finishReason === "string"
              ? part.finishReason
              : finishReason;
          usage = part.usage ?? usage;
          providerMetadata = part.providerMetadata ?? providerMetadata;
          break;
        case "finish":
          finishReason =
            typeof part.finishReason === "string"
              ? part.finishReason
              : finishReason;
          usage = part.totalUsage ?? usage;
          break;
        case "abort":
          throw new Error(
            typeof part.reason !== "string"
              ? "Model stream aborted."
              : `Model stream aborted: ${part.reason}`,
          );
        case "error":
          throw normalizeError(part.error);
        default:
          break;
      }
    }

    const structuredOutput =
      request.outputSchema == null ? undefined : await result.output;
    const completed = this.#buildModelResult({
      request,
      text,
      reasoning,
      toolCalls,
      finishReason,
      usage,
      providerMetadata,
      structuredOutput,
    });
    yield { type: "completed", result: completed };
  }

  #toCallOptions(request: ModelRequest): AiSdkCallOptions {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => partsAsText(message.content))
      .filter(Boolean)
      .join("\n\n");
    const options: AiSdkCallOptions = {
      model: this.#resolveModel(request.model),
      ...(system ? { system } : {}),
      messages: request.messages
        .filter((message) => message.role !== "system")
        .map(toAiSdkMessage),
    };
    if (request.tools != null && request.tools.length > 0) {
      options.tools = toAiSdkTools(request.tools);
    }
    if (request.outputSchema != null) {
      options.output = Output.object({
        schema: jsonSchema(request.outputSchema as never),
      });
    }
    if (request.providerOptions != null) {
      options.providerOptions = request.providerOptions;
    }
    const maxOutputTokens = (
      request as ModelRequest & { maxOutputTokens?: number }
    ).maxOutputTokens;
    if (maxOutputTokens != null) {
      options.maxOutputTokens = maxOutputTokens;
    }
    if (request.signal != null) {
      options.abortSignal = request.signal;
    }
    return options;
  }

  #toModelResult(
    request: ModelRequest,
    result: AiSdkGenerateResult,
  ): ModelResult {
    return this.#buildModelResult({
      request,
      text: result.text,
      reasoning: result.reasoningText ?? "",
      toolCalls: result.toolCalls.map(toToolCall),
      finishReason: result.finishReason,
      usage: result.totalUsage,
      providerMetadata: result.providerMetadata,
      structuredOutput:
        request.outputSchema == null ? undefined : result.output,
    });
  }

  #buildModelResult(input: {
    request: ModelRequest;
    text: string;
    reasoning: string;
    toolCalls: ToolCall[];
    finishReason?: string | undefined;
    usage?: AiSdkUsage | undefined;
    providerMetadata?: unknown;
    structuredOutput?: unknown;
  }): ModelResult {
    const content: ContentPart[] = [];
    if (input.reasoning.length > 0) {
      content.push({ type: "reasoning", text: input.reasoning });
    }
    if (input.text.length > 0) {
      content.push({ type: "text", text: input.text });
    }
    content.push(
      ...input.toolCalls.map((call) => ({ type: "tool-call" as const, call })),
    );

    const transcriptItem: TranscriptItem = {
      id: this.#generateTranscriptId(),
      type: "message",
      role: "assistant",
      content,
      createdAt: this.#now().toISOString(),
      model: input.request.model,
    };
    const mappedUsage = toModelUsage(input.usage);
    if (mappedUsage != null) transcriptItem.usage = mappedUsage;

    const modelResult: ModelResult = {
      output:
        input.structuredOutput === undefined
          ? input.text
          : toJsonValue(input.structuredOutput),
      transcript: [transcriptItem],
      toolCalls: input.toolCalls,
    };
    if (input.finishReason != null) {
      modelResult.finishReason = input.finishReason;
    }
    const metadata = toJsonObject(input.providerMetadata);
    if (metadata != null) modelResult.providerMetadata = metadata;
    return modelResult;
  }
}

function toAiSdkTools(tools: AgentTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((toolDefinition) => [
      toolDefinition.name,
      tool({
        ...(toolDefinition.description == null
          ? {}
          : { description: toolDefinition.description }),
        inputSchema: jsonSchema(toolDefinition.inputSchema as never),
        ...(toolDefinition.metadata == null
          ? {}
          : { metadata: toolDefinition.metadata as never }),
      }),
    ]),
  );
}

function toAiSdkMessage(message: ModelMessage): AiSdkModelMessage {
  if (message.role === "tool") {
    const content: ToolContent = [];
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const output =
        part.result.error == null
          ? { type: "json" as const, value: part.result.output ?? null }
          : {
              type: "json" as const,
              value: {
                error: {
                  code: part.result.error.code,
                  message: part.result.error.message,
                },
              },
            };
      content.push({
        type: "tool-result",
        toolCallId: part.result.callId,
        toolName: part.result.name,
        output,
      });
    }
    return { role: "tool", content };
  }
  if (message.role === "assistant") {
    const content: Exclude<AssistantContent, string> = [];
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          content.push({ type: "text", text: part.text });
          break;
        case "reasoning":
          if (part.text != null) {
            content.push({ type: "reasoning", text: part.text });
          }
          break;
        case "json":
          content.push({ type: "text", text: JSON.stringify(part.value) });
          break;
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: part.call.id,
            toolName: part.call.name,
            input: part.call.input,
          });
          break;
        default:
          break;
      }
    }
    return { role: "assistant", content };
  }

  const content: Exclude<UserContent, string> = [];
  for (const part of message.content) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "json":
        content.push({ type: "text", text: JSON.stringify(part.value) });
        break;
      case "image": {
        const url = part.url ?? part.artifact?.uri;
        if (url != null) content.push({ type: "image", image: new URL(url) });
        break;
      }
      case "file": {
        const uri = part.artifact.uri;
        if (uri != null) {
          content.push({
            type: "file",
            data: new URL(uri),
            mediaType: part.artifact.mediaType,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return { role: "user", content };
}

function partsAsText(parts: ModelMessage["content"]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "json") return JSON.stringify(part.value);
      if (part.type === "reasoning") return part.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toToolCall(call: AiSdkToolCall): ToolCall {
  return {
    id: call.toolCallId,
    name: call.toolName,
    input: toJsonObject(call.input) ?? { value: toJsonValue(call.input) },
  };
}

function toModelUsage(usage: AiSdkUsage | undefined): ModelUsage | undefined {
  if (usage == null) return undefined;
  const mapped: ModelUsage = {};
  if (usage.inputTokens != null) mapped.inputTokens = usage.inputTokens;
  if (usage.outputTokens != null) mapped.outputTokens = usage.outputTokens;
  if (usage.outputTokenDetails?.reasoningTokens != null) {
    mapped.reasoningTokens = usage.outputTokenDetails.reasoningTokens;
  }
  if (usage.inputTokenDetails?.cacheReadTokens != null) {
    mapped.cachedInputTokens = usage.inputTokenDetails.cacheReadTokens;
  }
  if (usage.inputTokenDetails?.cacheWriteTokens != null) {
    mapped.cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens;
  }
  if (usage.totalTokens != null) mapped.totalTokens = usage.totalTokens;
  const raw = toJsonObject(usage.raw);
  if (raw != null) mapped.metadata = raw;
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

function toJsonObject(value: unknown): JsonObject | undefined {
  const converted = toJsonValue(value);
  return converted != null &&
    typeof converted === "object" &&
    !Array.isArray(converted)
    ? converted
    : undefined;
}

function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item, seen));
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      entry === undefined ? [] : [[key, toJsonValue(entry, seen)]],
    ),
  );
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}
