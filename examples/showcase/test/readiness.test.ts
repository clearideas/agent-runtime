import assert from "node:assert/strict";
import test from "node:test";
import { showcaseUrl, waitForShowcase } from "../launcher/readiness.js";

test("the launcher tolerates a cold-start 503, stops after readiness, and sends no credentials", async () => {
  let calls = 0;
  const result = await waitForShowcase("https://showcase.example.com/", {
    retryMs: 1,
    fetcher: async (input, options) => {
      assert.equal(input, "https://showcase.example.com/healthz");
      assert.equal(options?.credentials, "omit");
      assert.equal(options?.cache, "no-store");
      calls++;
      return calls === 1
        ? new Response("Starting", { status: 503 })
        : Response.json({ status: "ready", instanceId: "boot-1" });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.health.instanceId, "boot-1");
});

test("the launcher cancels readiness and does not retry authentication errors", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Navigation cancelled"));
  await assert.rejects(
    waitForShowcase("https://example.com", { signal: controller.signal }),
    /Navigation cancelled/u,
  );
  let calls = 0;
  await assert.rejects(
    waitForShowcase("https://example.com", {
      fetcher: async () => {
        calls++;
        return new Response("Unauthorized", { status: 401 });
      },
    }),
    /HTTP 401/u,
  );
  assert.equal(calls, 1);
  assert.throws(() => showcaseUrl("https://secret:token@example.com"));
});
