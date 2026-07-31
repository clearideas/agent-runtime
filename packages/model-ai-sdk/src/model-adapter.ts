import type {
  ContentPart,
  JsonObject,
  JsonValue,
  ModelUsage,
  ToolCall,
  ToolResult,
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
  type SystemModelMessage,
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
  system?: string | SystemModelMessage | SystemModelMessage[];
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
  providerExecuted?: boolean;
}

export interface AiSdkGenerateResult {
  text: string;
  reasoningText?: string;
  toolCalls: readonly AiSdkToolCall[];
  finishReason?: string;
  totalUsage?: AiSdkUsage;
  providerMetadata?: unknown;
  responseMessages?: readonly AiSdkModelMessage[];
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
  responseMessages?:
    PromiseLike<readonly AiSdkModelMessage[]> | readonly AiSdkModelMessage[];
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

const combinedProviderOptions = (
  message: ModelMessage,
): JsonObject | undefined => {
  const combined: JsonObject = {};
  for (const part of message.content) {
    if (part.providerOptions) Object.assign(combined, part.providerOptions);
  }
  if (message.providerOptions) Object.assign(combined, message.providerOptions);
  return Object.keys(combined).length > 0 ? combined : undefined;
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
            ...(typeof part.providerExecuted === "boolean"
              ? { providerExecuted: part.providerExecuted }
              : {}),
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
    const responseMessages =
      result.responseMessages == null
        ? undefined
        : await result.responseMessages;
    const completed = this.#buildModelResult({
      request,
      text,
      reasoning,
      toolCalls,
      finishReason,
      usage,
      providerMetadata,
      structuredOutput,
      responseMessages,
    });
    yield { type: "completed", result: completed };
  }

  #toCallOptions(request: ModelRequest): AiSdkCallOptions {
    const systemMessages = request.messages
      .filter((message) => message.role === "system")
      .map((message) => {
        const providerOptions = combinedProviderOptions(message);
        return {
          role: "system" as const,
          content: partsAsText(message.content),
          ...(providerOptions
            ? { providerOptions: providerOptions as never }
            : {}),
        };
      })
      .filter((message) => message.content.length > 0);
    const hasSystemProviderOptions = systemMessages.some(
      (message) => message.providerOptions != null,
    );
    const system =
      systemMessages.length === 0
        ? undefined
        : hasSystemProviderOptions
          ? systemMessages
          : systemMessages.map((message) => message.content).join("\n\n");
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
      responseMessages: result.responseMessages,
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
    responseMessages?: readonly AiSdkModelMessage[] | undefined;
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

    const transcript =
      input.responseMessages == null || input.responseMessages.length === 0
        ? [
            {
              id: this.#generateTranscriptId(),
              type: "message" as const,
              role: "assistant" as const,
              content,
              createdAt: this.#now().toISOString(),
              model: input.request.model,
            },
          ]
        : input.responseMessages.flatMap((message) => {
            const item = fromAiSdkResponseMessage(
              message,
              this.#generateTranscriptId(),
              this.#now().toISOString(),
              input.request.model,
            );
            return item == null ? [] : [item];
          });
    const mappedUsage = toModelUsage(input.usage);
    const usageItem = [...transcript]
      .reverse()
      .find((item) => item.role === "assistant");
    if (mappedUsage != null && usageItem != null) usageItem.usage = mappedUsage;

    const modelResult: ModelResult = {
      output:
        input.structuredOutput === undefined
          ? input.text
          : toJsonValue(input.structuredOutput),
      transcript,
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

const contentProviderOptions = (
  part: ModelMessage["content"][number],
): { providerOptions: never } | Record<string, never> =>
  part.providerOptions
    ? { providerOptions: part.providerOptions as never }
    : {};

const messageProviderOptions = (
  message: ModelMessage,
): { providerOptions: never } | Record<string, never> =>
  message.providerOptions
    ? { providerOptions: message.providerOptions as never }
    : {};

const mediaSource = (
  part: Extract<ModelMessage["content"][number], { type: "image" | "file" }>,
): string | URL => {
  if (part.data != null) return part.data;
  const uri = part.url ?? part.artifact?.uri;
  if (uri != null) return new URL(uri);
  throw new Error(`${part.type} content requires resolvable data or a URL`);
};

const mediaType = (
  part: Extract<ModelMessage["content"][number], { type: "image" | "file" }>,
): string => {
  const value = part.mediaType ?? part.artifact?.mediaType;
  if (value == null) {
    throw new Error(`${part.type} content requires a media type`);
  }
  return value;
};

type AiSdkToolResultPart = Extract<
  ToolContent[number],
  { type: "tool-result" }
>;

const toAiSdkToolResultPart = (
  part: Extract<ModelMessage["content"][number], { type: "tool-result" }>,
): AiSdkToolResultPart => {
  const result = part.result;
  let output: AiSdkToolResultPart["output"];
  if (result.artifacts != null && result.artifacts.length > 0) {
    const value: Array<Record<string, unknown>> = [];
    if (result.output !== undefined) {
      value.push({
        type: "text",
        text:
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output),
      });
    }
    for (const artifact of result.artifacts) {
      if (artifact.uri == null) {
        throw new Error(
          `Historical tool artifact ${artifact.id} requires a URI`,
        );
      }
      value.push({
        type: "file",
        data: new URL(artifact.uri),
        mediaType: artifact.mediaType,
        filename: artifact.name,
      });
    }
    output = { type: "content", value } as AiSdkToolResultPart["output"];
  } else {
    output =
      result.error == null
        ? { type: "json", value: result.output ?? null }
        : {
            type: "json",
            value: {
              error: {
                code: result.error.code,
                message: result.error.message,
              },
            },
          };
  }
  return {
    type: "tool-result",
    toolCallId: result.callId,
    toolName: result.name,
    output,
    ...contentProviderOptions(part),
  };
};

function toAiSdkMessage(message: ModelMessage): AiSdkModelMessage {
  if (message.role === "system") {
    throw new Error("System messages must be mapped as model instructions");
  }
  if (message.role === "tool") {
    const content: ToolContent = message.content.map((part) => {
      if (part.type !== "tool-result") {
        throw new Error(`Tool messages cannot contain ${part.type} content`);
      }
      return toAiSdkToolResultPart(part);
    });
    return { role: "tool", content, ...messageProviderOptions(message) };
  }
  if (message.role === "assistant") {
    const content: Exclude<AssistantContent, string> = [];
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          content.push({
            type: "text",
            text: part.text,
            ...contentProviderOptions(part),
          });
          break;
        case "reasoning":
          content.push({
            type: "reasoning",
            text: part.text ?? "",
            ...contentProviderOptions(part),
          });
          break;
        case "json":
          content.push({
            type: "text",
            text: JSON.stringify(part.value),
            ...contentProviderOptions(part),
          });
          break;
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: part.call.id,
            toolName: part.call.name,
            input: part.call.input,
            ...(part.call.providerExecuted != null
              ? { providerExecuted: part.call.providerExecuted }
              : {}),
            ...contentProviderOptions(part),
          });
          break;
        case "tool-result":
          content.push(toAiSdkToolResultPart(part));
          break;
        case "image":
        case "file":
          content.push({
            type: "file",
            data: mediaSource(part),
            mediaType: mediaType(part),
            ...(part.type === "file" && (part.name ?? part.artifact?.name)
              ? { filename: (part.name ?? part.artifact?.name)! }
              : {}),
            ...contentProviderOptions(part),
          });
          break;
        default:
          throw new Error(`Unsupported assistant content`);
      }
    }
    return {
      role: "assistant",
      content,
      ...messageProviderOptions(message),
    };
  }

  const content: Exclude<UserContent, string> = [];
  for (const part of message.content) {
    switch (part.type) {
      case "text":
        content.push({
          type: "text",
          text: part.text,
          ...contentProviderOptions(part),
        });
        break;
      case "json":
        content.push({
          type: "text",
          text: JSON.stringify(part.value),
          ...contentProviderOptions(part),
        });
        break;
      case "image":
        content.push({
          type: "image",
          image: mediaSource(part),
          ...((part.mediaType ?? part.artifact?.mediaType)
            ? { mediaType: (part.mediaType ?? part.artifact?.mediaType)! }
            : {}),
          ...contentProviderOptions(part),
        });
        break;
      case "file":
        content.push({
          type: "file",
          data: mediaSource(part),
          mediaType: mediaType(part),
          ...((part.name ?? part.artifact?.name)
            ? { filename: (part.name ?? part.artifact?.name)! }
            : {}),
          ...contentProviderOptions(part),
        });
        break;
      default:
        throw new Error(`User messages cannot contain ${part.type} content`);
    }
  }
  return { role: "user", content, ...messageProviderOptions(message) };
}

const fromAiSdkProviderOptions = (value: unknown): JsonObject | undefined =>
  toJsonObject(value);

const fromAiSdkPartOptions = (
  part: Record<string, unknown>,
): Pick<ContentPart, "providerOptions"> =>
  part.providerOptions == null
    ? {}
    : {
        providerOptions: fromAiSdkProviderOptions(part.providerOptions) ?? {
          value: toJsonValue(part.providerOptions),
        },
      };

const bytesAsBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
};

const fromAiSdkFile = (
  part: Record<string, unknown>,
): Extract<ContentPart, { type: "file" }> => {
  const data = part.data;
  const source: Pick<
    Extract<ContentPart, { type: "file" }>,
    "data" | "url"
  > = data instanceof URL
    ? { url: data.href }
    : typeof data === "string"
      ? { data }
      : data instanceof Uint8Array
        ? { data: bytesAsBase64(data) }
        : typeof data === "object" &&
            data != null &&
            "type" in data &&
            data.type === "url" &&
            "url" in data
          ? {
              url: data.url instanceof URL ? data.url.href : String(data.url),
            }
          : (() => {
              throw new Error(
                "AI SDK returned file content that cannot be durably replayed",
              );
            })();
  const mediaType =
    typeof part.mediaType === "string" ? part.mediaType : undefined;
  if (mediaType == null) {
    throw new Error("AI SDK returned file content without a media type");
  }
  return {
    type: "file",
    ...source,
    mediaType,
    ...(typeof part.filename === "string" ? { name: part.filename } : {}),
    ...fromAiSdkPartOptions(part),
  };
};

const fromAiSdkToolOutput = (
  output: unknown,
): Pick<ToolResult, "output" | "error"> => {
  if (typeof output !== "object" || output == null) {
    return { output: toJsonValue(output) };
  }
  const record = output as Record<string, unknown>;
  switch (record.type) {
    case "text":
    case "json":
      return { output: toJsonValue(record.value) };
    case "error-text":
    case "error-json":
      return {
        error: {
          code: "tool_error",
          message:
            typeof record.value === "string"
              ? record.value
              : JSON.stringify(record.value),
        },
      };
    case "execution-denied":
      return {
        error: {
          code: "tool_execution_denied",
          message:
            typeof record.reason === "string"
              ? record.reason
              : "Tool execution was denied.",
        },
      };
    default:
      return { output: toJsonValue(output) };
  }
};

const fromAiSdkToolResult = (
  part: Record<string, unknown>,
): Extract<ContentPart, { type: "tool-result" }> => {
  if (
    typeof part.toolCallId !== "string" ||
    typeof part.toolName !== "string"
  ) {
    throw new Error("AI SDK returned an invalid tool result");
  }
  return {
    type: "tool-result",
    result: {
      callId: part.toolCallId,
      name: part.toolName,
      ...fromAiSdkToolOutput(part.output),
    },
    ...fromAiSdkPartOptions(part),
  };
};

function fromAiSdkResponseMessage(
  message: AiSdkModelMessage,
  id: string,
  createdAt: string,
  model: string,
): TranscriptItem | undefined {
  if (message.role !== "assistant" && message.role !== "tool") return undefined;
  const rawContent =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const content: ContentPart[] = rawContent.map((rawPart) => {
    const part = rawPart as unknown as Record<string, unknown>;
    switch (part.type) {
      case "text":
        return {
          type: "text",
          text: typeof part.text === "string" ? part.text : "",
          ...fromAiSdkPartOptions(part),
        };
      case "reasoning":
        return {
          type: "reasoning",
          ...(typeof part.text === "string" ? { text: part.text } : {}),
          ...fromAiSdkPartOptions(part),
        };
      case "tool-call":
        if (
          typeof part.toolCallId !== "string" ||
          typeof part.toolName !== "string"
        ) {
          throw new Error("AI SDK returned an invalid tool call");
        }
        return {
          type: "tool-call",
          call: {
            id: part.toolCallId,
            name: part.toolName,
            input: toJsonObject(part.input) ?? {
              value: toJsonValue(part.input),
            },
            ...(typeof part.providerExecuted === "boolean"
              ? { providerExecuted: part.providerExecuted }
              : {}),
          },
          ...fromAiSdkPartOptions(part),
        };
      case "tool-result":
        return fromAiSdkToolResult(part);
      case "file":
        return fromAiSdkFile(part);
      default:
        throw new Error(
          `AI SDK returned unsupported replay content: ${String(part.type)}`,
        );
    }
  });
  const providerOptions = fromAiSdkProviderOptions(message.providerOptions);
  return {
    id,
    type: message.role === "tool" ? "tool-result" : "message",
    role: message.role,
    content,
    createdAt,
    model,
    ...(providerOptions ? { providerOptions } : {}),
  };
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
    ...(call.providerExecuted != null
      ? { providerExecuted: call.providerExecuted }
      : {}),
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
