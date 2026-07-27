import type {
  JsonValue,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import type { ConditionEvaluator } from "@clearideas/agent-runtime-core";
import Jexl from "jexl";

const getNestedValue = (
  state: Readonly<VariableState>,
  path: string,
): JsonValue | undefined => {
  let current: unknown = state;
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

const stringifyConditionValue = (value: JsonValue | undefined): string => {
  if (typeof value !== "string") {
    if (value === undefined) return "undefined";
    return String(value);
  }
  const trimmed = value.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    const numberValue = Number(trimmed);
    if (Number.isFinite(numberValue)) return String(numberValue);
  }
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^null$/i.test(trimmed)) return "null";
  return JSON.stringify(trimmed);
};

/** Resolves legacy `{{ variable.path }}` operands before JEXL evaluation. */
export const resolveConditionExpression = (
  expression: string,
  variables: Readonly<VariableState>,
): string =>
  expression.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) =>
    stringifyConditionValue(getNestedValue(variables, rawPath.trim())),
  );

export class JexlConditionEvaluator implements ConditionEvaluator {
  async evaluate(
    expression: string,
    variables: Readonly<VariableState>,
  ): Promise<boolean> {
    if (expression.trim() === "") return true;
    const resolved = resolveConditionExpression(expression, variables);
    return Boolean(await Jexl.eval(resolved, variables));
  }
}
