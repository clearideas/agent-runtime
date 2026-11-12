import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createShowcaseApp } from "../server.ts";
import { parseOrigin } from "../lib/hosting.ts";
import { startShowcase } from "./helpers.ts";

test("readiness exposes a boot ID, permits only declared parents, and creates no session", async (context) => {
  const { baseURL } = await startShowcase(context, {
    sessions: true,
    frameAncestors: ["https://docs.example.com"],
  });
  const health = await fetch(`${baseURL}/healthz`, {
    headers: { origin: "https://docs.example.com" },
  });
  assert.equal(
    health.headers.get("access-control-allow-origin"),
    "https://docs.example.com",
  );
  assert.equal(health.headers.get("set-cookie"), null);
  const body = await health.json();
  assert.match(body.instanceId, /^[a-f0-9-]{36}$/u);
  assert.ok(Number.isFinite(Date.parse(body.startedAt)));
  const other = await fetch(`${baseURL}/healthz`, {
    headers: { origin: "https://other.example.com" },
  });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  assert.equal((await other.json()).instanceId, body.instanceId);
  const api = await fetch(`${baseURL}/api/demos`, {
    headers: { origin: "https://docs.example.com" },
  });
  assert.equal(
    api.headers.get("access-control-allow-origin"),
    null,
    "CORS is limited to readiness",
  );
});

test("an HTTPS public origin is distinct from the internal callback URL and embedding origins", async (context) => {
  const { baseURL } = await startShowcase(context, {
    publicOrigin: "https://showcase.example.com",
    frameAncestors: ["https://docs.example.com"],
    sessions: true,
  });
  const page = await fetch(baseURL);
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /frame-ancestors https:\/\/docs\.example\.com$/u,
  );
  const cookie = page.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly.*SameSite=None; Secure; Partitioned/u);
  for (const [origin, expected] of [
    ["https://showcase.example.com", 200],
    ["https://docs.example.com", 403],
    [baseURL, 403],
  ] as const) {
    const response = await fetch(`${baseURL}/api/demos/repo-mechanic/reset`, {
      method: "POST",
      headers: { origin, cookie: cookie.split(";")[0]! },
    });
    assert.equal(response.status, expected);
  }
});

test("visitor workspaces and resets are isolated and a tampered cookie cannot select a session", async (context) => {
  const { baseURL, dataDirectory } = await startShowcase(context, {
    sessions: true,
  });
  const visit = async () =>
    (await fetch(baseURL)).headers.get("set-cookie")!.split(";")[0]!;
  const alice = await visit();
  const bob = await visit();
  assert.notEqual(alice, bob);
  const state = async (cookie: string) => {
    const response = await fetch(`${baseURL}/api/demos/repo-mechanic/state`, {
      headers: { cookie },
    });
    return JSON.stringify(await response.json());
  };
  await state(alice);
  await state(bob);
  const aliceId = alice.split("=")[1]!.split(".")[0]!;
  const aliceRoot = path.join(
    dataDirectory,
    "sessions",
    aliceId,
    "repo-mechanic",
    "invoice-service",
  );
  // Simulate a synced-back agent edit; HTTP reads and reset must use the
  // session's workspace even when the same demo is open in another browser.
  const target = path.join(aliceRoot, "src", "invoice.py");
  const original = await readFile(target, "utf8");
  await writeFile(target, `${original}\n# Alice's private revision\n`);
  assert.match(await state(alice), /Alice's private revision/u);
  assert.doesNotMatch(await state(bob), /Alice's private revision/u);
  await fetch(`${baseURL}/api/demos/repo-mechanic/reset`, {
    method: "POST",
    headers: { cookie: bob },
  });
  assert.match(await state(alice), /Alice's private revision/u);
  const forged = `showcase_session=${aliceId}.${"0".repeat(64)}`;
  assert.doesNotMatch(await state(forged), /Alice's private revision/u);
});

test("explicit hosting configuration fails closed without isolation and rejects invalid origins", async () => {
  await assert.rejects(
    createShowcaseApp({ sandbox: "unisolated", requireIsolation: true }),
    /isolated sandbox is required/u,
  );
  for (const origin of [
    "https://example.com/path",
    "https://user:password@example.com",
    "javascript:alert(1)",
    "https://example.com?x=1",
  ])
    assert.throws(() => parseOrigin(origin));
});
