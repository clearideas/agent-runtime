import type {
  JsonValue,
  VariableState,
} from "@clearideas/agent-runtime-contracts";

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

const stringifyTemplateValue = (value: JsonValue | undefined): string => {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

export const compilePromptTemplate = (
  template: string,
  variables: Readonly<VariableState>,
): string =>
  template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) =>
    stringifyTemplateValue(getNestedValue(variables, rawPath.trim())),
  );
