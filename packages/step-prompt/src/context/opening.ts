/**
 * The step's opening prompt as templates with variable slots. Messages are
 * rendered from the templates, so replacing a slot's text (a reduction)
 * changes only that variable's interpolation.
 */
import type {
  PromptStep,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import type { ModelMessage } from "@clearideas/agent-runtime-core/ports";

import {
  type CompiledTemplate,
  compileTemplate,
  renderTemplate,
  renderTemplateOutline,
} from "./template.js";

export interface OpeningPrompt {
  templates: CompiledTemplate[];
  /** Renders messages from the current slot texts. */
  render(): ModelMessage[];
  /** The task as written, with `{{ path }}` placeholders instead of values. */
  outline(): string;
}

export const buildOpeningPrompt = (
  step: PromptStep,
  variables: Readonly<VariableState>,
): OpeningPrompt => {
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
      render: () =>
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
      outline: () =>
        step
          .messages!.flatMap((message, messageIndex) =>
            message.content.flatMap((part, partIndex) => {
              if (message.role !== "user" || part.type !== "text") return [];
              const template = byLocation.get(
                `messages.${messageIndex}.content.${partIndex}`,
              );
              return template ? [renderTemplateOutline(template)] : [];
            }),
          )
          .join("\n"),
    };
  }

  const system = step.systemPrompt
    ? compileTemplate("systemPrompt", step.systemPrompt, variables)
    : undefined;
  const prompt = compileTemplate("prompt", step.prompt ?? "", variables);
  return {
    templates: [...(system ? [system] : []), prompt],
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
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: renderTemplate(prompt) }],
      },
    ],
    outline: () => renderTemplateOutline(prompt),
  };
};
