/**
 * The step's opening prompt as templates with variable slots. Messages are
 * rendered from the templates, so replacing a slot's text (a reduction)
 * changes only that variable's interpolation. Conversation history inserted
 * by the step's `history` setting is literal: it is never a template.
 */
import type {
  ConversationMessage,
  PromptStep,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import { mediaPlaceholder } from "@clearideas/agent-runtime-core";
import type { ModelMessage } from "@clearideas/agent-runtime-core/ports";

import {
  type CompiledTemplate,
  compileTemplate,
  renderTemplate,
  renderTemplateOutline,
} from "./template.js";

/** Conversation turns inserted into the opening prompt. */
export interface OpeningHistory {
  /** The step's selection, as model messages. Never templated. */
  messages: ModelMessage[];
  /** Each message's turn number, for summarizer material; undefined for a marker. */
  turns: Array<number | undefined>;
  /** Oldest messages replaced by a step-level reduction. */
  dropped: number;
  /** The summary or note that stands for the dropped messages. */
  replacement?: string;
}

export interface OpeningPrompt {
  templates: CompiledTemplate[];
  /** Inserted conversation turns, when the step sets `history`. */
  history?: OpeningHistory;
  /** Renders messages from the current slot texts. */
  render(): ModelMessage[];
  /** The task as written, with `{{ path }}` placeholders instead of values. */
  outline(): string;
}

const CONVERSATION_TASK = "Continue the conversation.";

/**
 * Media a model can receive inline from a conversation. Providers accept
 * images and PDFs; other files (a Word document, a spreadsheet, a file of
 * unknown type) are rejected by the provider, so they reach the model as a
 * placeholder naming the file, and tools or code in the run sandbox read
 * their content.
 */
const modelReadable = (
  part: Extract<
    ConversationMessage["content"][number],
    { type: "image" | "file" }
  >,
): boolean => {
  if (part.type === "image") return true;
  const mediaType = part.mediaType ?? part.artifact?.mediaType;
  return (
    mediaType != null &&
    (mediaType.startsWith("image/") || mediaType === "application/pdf")
  );
};

/** Inserted history as model messages; runtime marker metadata stays internal. */
export const historyModelMessages = (
  messages: readonly ConversationMessage[],
): ModelMessage[] =>
  messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) =>
      (part.type === "image" || part.type === "file") && !modelReadable(part)
        ? { type: "text" as const, text: mediaPlaceholder(part) }
        : structuredClone(part),
    ),
  }));

const renderHistory = (history: OpeningHistory | undefined): ModelMessage[] =>
  history
    ? [
        ...(history.replacement
          ? [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: history.replacement }],
              },
            ]
          : []),
        ...history.messages.slice(history.dropped),
      ]
    : [];

/** Place inserted history after the leading system messages. */
const withHistory = (
  rendered: ModelMessage[],
  history: OpeningHistory | undefined,
): ModelMessage[] => {
  if (!history) return rendered;
  const firstNonSystem = rendered.findIndex(
    (message) => message.role !== "system",
  );
  const at = firstNonSystem < 0 ? rendered.length : firstNonSystem;
  return [
    ...rendered.slice(0, at),
    ...renderHistory(history),
    ...rendered.slice(at),
  ];
};

export const buildOpeningPrompt = (
  step: PromptStep,
  variables: Readonly<VariableState>,
  insertedHistory?: readonly ConversationMessage[],
  turns: ReadonlyArray<number | undefined> = [],
): OpeningPrompt => {
  const history: OpeningHistory | undefined = insertedHistory
    ? {
        messages: historyModelMessages(insertedHistory),
        turns: insertedHistory.map((_, index) => turns[index]),
        dropped: 0,
      }
    : undefined;
  if (step.messages) {
    const byLocation = new Map<string, CompiledTemplate>();
    step.messages.forEach((message, messageIndex) =>
      message.content.forEach((part, partIndex) => {
        if (part.type !== "text") return;
        const location = `messages.${messageIndex}.content.${partIndex}`;
        byLocation.set(
          location,
          compileTemplate(location, part.text, variables),
        );
      }),
    );
    return {
      templates: [...byLocation.values()],
      ...(history ? { history } : {}),
      render: () =>
        withHistory(
          step.messages!.map((message, messageIndex) => ({
            ...message,
            content: message.content.map((part, partIndex) => {
              if (part.type !== "text") return part;
              const template = byLocation.get(
                `messages.${messageIndex}.content.${partIndex}`,
              )!;
              return { ...part, text: renderTemplate(template) };
            }),
          })),
          history,
        ),
      outline: () => {
        const outline = step
          .messages!.flatMap((message, messageIndex) =>
            message.content.flatMap((part, partIndex) => {
              if (message.role !== "user" || part.type !== "text") return [];
              const template = byLocation.get(
                `messages.${messageIndex}.content.${partIndex}`,
              );
              return template ? [renderTemplateOutline(template)] : [];
            }),
          )
          .join("\n");
        return outline || (history ? CONVERSATION_TASK : "");
      },
    };
  }

  const system = step.systemPrompt
    ? compileTemplate("systemPrompt", step.systemPrompt, variables)
    : undefined;
  // A step that inserts history may have no prompt of its own.
  const prompt =
    step.prompt !== undefined || !history
      ? compileTemplate("prompt", step.prompt ?? "", variables)
      : undefined;
  return {
    templates: [...(system ? [system] : []), ...(prompt ? [prompt] : [])],
    ...(history ? { history } : {}),
    render: () => [
      ...(system
        ? [
            {
              role: "system" as const,
              content: [
                { type: "text" as const, text: renderTemplate(system) },
              ],
            },
          ]
        : []),
      ...renderHistory(history),
      ...(prompt
        ? [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: renderTemplate(prompt) },
              ],
            },
          ]
        : []),
    ],
    outline: () =>
      prompt
        ? renderTemplateOutline(prompt)
        : system
          ? renderTemplateOutline(system)
          : CONVERSATION_TASK,
  };
};
