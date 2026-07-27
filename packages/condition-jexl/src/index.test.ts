import { describe, expect, it } from "vitest";

import { JexlConditionEvaluator, resolveConditionExpression } from "./index.js";

describe("JexlConditionEvaluator", () => {
  it("evaluates direct JEXL expressions against variables", async () => {
    const evaluator = new JexlConditionEvaluator();
    await expect(
      evaluator.evaluate("count >= 2 && enabled", { count: 2, enabled: true }),
    ).resolves.toBe(true);
  });

  it("supports case-insensitive nested handlebars operands", async () => {
    const evaluator = new JexlConditionEvaluator();
    const variables = { Result: { Status: "ready" }, attempts: "3" };
    expect(
      resolveConditionExpression(
        '{{ result.status }} == "ready" && {{ attempts }} >= 2',
        variables,
      ),
    ).toBe('"ready" == "ready" && 3 >= 2');
    await expect(
      evaluator.evaluate(
        '{{ result.status }} == "ready" && {{ attempts }} >= 2',
        variables,
      ),
    ).resolves.toBe(true);
  });

  it("returns true for a blank condition", async () => {
    await expect(new JexlConditionEvaluator().evaluate("  ", {})).resolves.toBe(
      true,
    );
  });
});
