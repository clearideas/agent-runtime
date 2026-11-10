/**
 * Chat request → run input. Conversation manifests receive the chat as
 * conversation messages; variable manifests receive operator-mapped
 * variables. Nothing else from a request reaches a run.
 */
import type {
  AgentVariableOverride,
  ConversationContentPart,
  ConversationMessage,
  JsonValue,
} from "@clearideas/agent-runtime-contracts";
import type { ArtifactStore } from "@clearideas/agent-runtime-core";

import type { InputMapping } from "./config.js";
import { invalidRequest } from "./errors.js";
import type { MediaIngestor } from "./media.js";
import type {
  ChatCompletionRequest,
  ChatMessage,
  OpenAiContentPart,
} from "./openai.js";

export interface ConvertedChat {
  /** Text of the client's system and developer messages. */
  instructions: string;
  /** User and assistant messages, in order, with media as artifact references. */
  messages: ConversationMessage[];
}

export interface ConvertOptions {
  /** Conversation mode accepts media; variable mode accepts text only. */
  allowMedia: boolean;
  /** `ignore` drops client tool messages and tool calls; `reject` refuses them. */
  clientTools: "ignore" | "reject";
  media: MediaIngestor;
  scope: string;
  artifacts: ArtifactStore;
}

const textOf = (
  content: ChatMessage["content"],
  role: string,
  index: number,
): string => {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text" && "text" in part) return String(part.text);
      if (part.type === "refusal" && "refusal" in part)
        return String(part.refusal);
      throw invalidRequest(
        `messages[${index}]: ${role} messages may contain only text.`,
        "messages",
      );
    })
    .join("\n");
};

const convertPart = async (
  part: OpenAiContentPart,
  index: number,
  options: ConvertOptions,
): Promise<ConversationContentPart> => {
  if (part.type === "text" && "text" in part)
    return { type: "text", text: String(part.text) };
  if (part.type === "refusal" && "refusal" in part)
    return { type: "text", text: String(part.refusal) };
  if (part.type === "image_url" || part.type === "file") {
    if (!options.allowMedia)
      throw invalidRequest(
        `messages[${index}]: this model accepts text only.`,
        "messages",
      );
    if (part.type === "image_url" && "image_url" in part) {
      const imageUrl = part.image_url as { url: string };
      return options.media.part({
        kind: "image",
        source: imageUrl.url,
        scope: options.scope,
        artifacts: options.artifacts,
      });
    }
    const file = (
      part as {
        file?: { file_data?: string; file_id?: string; filename?: string };
      }
    ).file;
    if (file?.file_id || !file?.file_data) {
      throw invalidRequest(
        `messages[${index}]: file references (file_id) are not supported; send file_data.`,
        "messages",
      );
    }
    return options.media.part({
      kind: "file",
      source: file.file_data,
      ...(file.filename ? { name: file.filename } : {}),
      scope: options.scope,
      artifacts: options.artifacts,
    });
  }
  throw invalidRequest(
    `messages[${index}]: content parts of type ${JSON.stringify(part.type)} are not supported.`,
    "messages",
  );
};

/**
 * Convert chat messages. Client system and developer messages become
 * `instructions`; tool messages and tool calls are dropped or refused, per
 * the `clientTools` policy; audio and file ids are refused; an assistant
 * message with no text is omitted. The request must end with a user message.
 */
export const convertChatMessages = async (
  messages: readonly ChatMessage[],
  options: ConvertOptions,
): Promise<ConvertedChat> => {
  const instructions: string[] = [];
  const converted: ConversationMessage[] = [];
  for (const [index, message] of messages.entries()) {
    switch (message.role) {
      case "system":
      case "developer":
        instructions.push(textOf(message.content, message.role, index));
        break;
      case "tool":
      case "function":
        if (options.clientTools === "ignore") break;
        throw invalidRequest(
          `messages[${index}]: ${message.role} messages are not supported; the served agent's tools are configured by the host.`,
          "messages",
        );
      case "assistant": {
        if (
          options.clientTools === "reject" &&
          ((message.tool_calls?.length ?? 0) > 0 || message.function_call)
        )
          throw invalidRequest(
            `messages[${index}]: assistant tool calls are not supported.`,
            "messages",
          );
        const text = textOf(message.content, message.role, index);
        const refusal = message.refusal ?? "";
        const reply = text || refusal;
        if (reply) {
          converted.push({
            role: "assistant",
            content: [{ type: "text", text: reply }],
          });
        }
        break;
      }
      case "user": {
        const content: ConversationContentPart[] =
          typeof message.content === "string" || message.content == null
            ? [{ type: "text", text: message.content ?? "" }]
            : await Promise.all(
                message.content.map((part) =>
                  convertPart(part, index, options),
                ),
              );
        converted.push({
          role: "user",
          content: content.length > 0 ? content : [{ type: "text", text: "" }],
        });
        break;
      }
    }
  }
  if (converted.at(-1)?.role !== "user") {
    throw invalidRequest(
      "The last message must be a user message.",
      "messages",
    );
  }
  return {
    instructions: instructions.filter(Boolean).join("\n\n"),
    messages: converted,
  };
};

/** Messages up to and including the last assistant message, and the new turn after it. */
export const splitNewTurn = (
  messages: readonly ConversationMessage[],
): { prefix: ConversationMessage[]; newTurn: ConversationMessage[] } => {
  let index = messages.length;
  while (index > 0 && messages[index - 1]!.role === "user") index -= 1;
  return {
    prefix: messages.slice(0, index),
    newTurn: messages.slice(index),
  };
};

const messageText = (message: ConversationMessage): string =>
  message.content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "json"
          ? JSON.stringify(part.value)
          : `[${part.type}]`,
    )
    .join("\n");

/**
 * Variable overrides for operator-mapped inputs. Values are validated by the
 * runtime against the manifest's declarations before a run is created.
 */
export const mapInputVariables = (input: {
  mappings: readonly InputMapping[];
  chat: ConvertedChat;
  request: ChatCompletionRequest;
}): AgentVariableOverride[] => {
  const { chat, request } = input;
  let lastUserIndex = chat.messages.length - 1;
  while (lastUserIndex >= 0 && chat.messages[lastUserIndex]!.role !== "user")
    lastUserIndex -= 1;
  const lastUser =
    lastUserIndex >= 0 ? messageText(chat.messages[lastUserIndex]!) : "";
  let parsedJson: Record<string, JsonValue> | undefined;
  const json = (): Record<string, JsonValue> => {
    if (parsedJson) return parsedJson;
    let value: unknown;
    try {
      value = JSON.parse(lastUser);
    } catch {
      throw invalidRequest(
        "This model expects the last user message to be a JSON object.",
        "messages",
      );
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      throw invalidRequest(
        "This model expects the last user message to be a JSON object.",
        "messages",
      );
    }
    parsedJson = value as Record<string, JsonValue>;
    return parsedJson;
  };
  const overrides: AgentVariableOverride[] = [];
  for (const mapping of input.mappings) {
    let value: JsonValue | undefined;
    switch (mapping.source) {
      case "last-user":
        value = lastUser;
        break;
      case "system":
        value = chat.instructions;
        break;
      case "transcript": {
        const earlier = chat.messages.slice(0, Math.max(lastUserIndex, 0));
        const window =
          mapping.maxMessages != null
            ? earlier.slice(-mapping.maxMessages)
            : earlier;
        value = window
          .map((message) => `${message.role}: ${messageText(message)}`)
          .join("\n\n");
        break;
      }
      case "json":
        value = json()[mapping.key];
        break;
      case "client": {
        const supplied = request.variables?.[mapping.key];
        value = supplied === undefined ? undefined : (supplied as JsonValue);
        break;
      }
    }
    if (value !== undefined) overrides.push({ key: mapping.variable, value });
  }
  return overrides;
};
