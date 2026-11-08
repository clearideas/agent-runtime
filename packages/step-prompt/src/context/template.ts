/**
 * Prompt templates compiled into literal text and variable slots. Sizing the
 * slots separately lets an oversized opening prompt be reduced one
 * interpolated variable at a time while the template's own text is kept.
 */
import type {
  JsonValue,
  VariableState,
} from "@clearideas/agent-runtime-contracts";

const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

const getNestedValue = (
  variables: Readonly<VariableState>,
  path: string,
): JsonValue | undefined => {
  let current: unknown = variables;
  for (const segment of path.split(".")) {
    if (
      current == null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    const lowerSegment = segment.toLowerCase();
    const key = Object.keys(record).find(
      (candidate) => candidate.toLowerCase() === lowerSegment,
    );
    if (!key) return undefined;
    current = record[key];
  }
  return current as JsonValue | undefined;
};

/** Same stringification as compilePromptTemplate. */
export const templateValueText = (value: JsonValue | undefined): string => {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

export interface TemplateSlot {
  /** Variable path exactly as written in the template, trimmed. */
  path: string;
  value: JsonValue | undefined;
  /** Interpolated text before any reduction. */
  originalText: string;
  /** Interpolated text, possibly replaced by a reduction. */
  text: string;
}

export type TemplateSegment = { literal: string } | { slot: TemplateSlot };

export interface CompiledTemplate {
  /** Where the template lives: systemPrompt, prompt, or messages.<m>.content.<p>. */
  location: string;
  segments: TemplateSegment[];
}

export const compileTemplate = (
  location: string,
  template: string,
  variables: Readonly<VariableState>,
): CompiledTemplate => {
  const segments: TemplateSegment[] = [];
  let cursor = 0;
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor)
      segments.push({ literal: template.slice(cursor, index) });
    const path = (match[1] ?? "").trim();
    const value = getNestedValue(variables, path);
    const text = templateValueText(value);
    segments.push({ slot: { path, value, originalText: text, text } });
    cursor = index + match[0].length;
  }
  if (cursor < template.length)
    segments.push({ literal: template.slice(cursor) });
  return { location, segments };
};

export const renderTemplate = (template: CompiledTemplate): string =>
  template.segments
    .map((segment) =>
      "literal" in segment ? segment.literal : segment.slot.text,
    )
    .join("");

/** The template text with each slot shown as its `{{ path }}` placeholder. */
export const renderTemplateOutline = (template: CompiledTemplate): string =>
  template.segments
    .map((segment) =>
      "literal" in segment ? segment.literal : `{{ ${segment.slot.path} }}`,
    )
    .join("");

export const templateSlots = (
  templates: readonly CompiledTemplate[],
): Array<{ template: CompiledTemplate; index: number; slot: TemplateSlot }> =>
  templates.flatMap((template) =>
    template.segments.flatMap((segment, index) =>
      "slot" in segment ? [{ template, index, slot: segment.slot }] : [],
    ),
  );
