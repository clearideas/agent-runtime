import { describe, expect, it } from "vitest";

import { applyStatePatch, setVariableAtPath } from "./state.js";

describe("runner variable paths", () => {
  it("applies dotted set and unset paths consistently", () => {
    const state = applyStatePatch(
      { client: { name: "Old", retained: true } },
      {
        set: { "client.name": "New", "client.score": 9 },
        unset: ["client.retained"],
      },
    );

    expect(state).toEqual({ client: { name: "New", score: 9 } });
  });

  it.each([
    "__proto__",
    "safe.__proto__.polluted",
    "constructor.prototype.polluted",
  ])("rejects prototype-sensitive path %s", (path) => {
    const state = {};
    expect(() => setVariableAtPath(state, path, true)).toThrow(
      "Unsafe variable path",
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
