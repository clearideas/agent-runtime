import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserAnalytics } from "../lib/browser-analytics.ts";
import { startShowcase } from "./helpers.ts";

test("self-hosted analytics is off unless both public settings are configured", () => {
  assert.deepEqual(resolveBrowserAnalytics(undefined, {}), { enabled: false });
  assert.deepEqual(
    resolveBrowserAnalytics(false, { SHOWCASE_ANALYTICS_SITE_KEY: "demo" }),
    { enabled: false },
  );
  assert.throws(() =>
    resolveBrowserAnalytics(undefined, { SHOWCASE_ANALYTICS_SITE_KEY: "demo" }),
  );
  for (const apiBaseUrl of [
    "javascript:alert(1)",
    "https://user:secret@collector.example",
    "https://collector.example?token=secret",
  ]) {
    assert.throws(() =>
      resolveBrowserAnalytics({ apiBaseUrl, siteKey: "demo" }),
    );
  }
});

test("serves configured client assets and allows only the collector origin through CSP", async (context) => {
  const { baseURL } = await startShowcase(context, {
    analytics: {
      apiBaseUrl: "https://collector.example/api/",
      siteKey: "runtime-demo",
    },
  });
  const config = await (await fetch(baseURL + "/api/browser-analytics")).json();
  assert.deepEqual(config, {
    enabled: true,
    apiBaseUrl: "https://collector.example/api",
    siteKey: "runtime-demo",
  });
  const page = await fetch(baseURL);
  assert.match(
    page.headers.get("content-security-policy")!,
    /connect-src 'self' https:\/\/collector\.example;/,
  );
  assert.doesNotMatch(
    page.headers.get("content-security-policy")!,
    /unsafe-inline|https:\/\/collector\.example\/api/,
  );
  for (const path of [
    "/assets/lib/analytics.js",
    "/vendor/consent-analytics.js",
    "/vendor/consent-analytics.css",
  ]) {
    assert.equal((await fetch(baseURL + path)).status, 200, path);
  }
});

test("does not advertise a collector or relax CSP when analytics is disabled", async (context) => {
  const { baseURL } = await startShowcase(context, { analytics: false });
  assert.deepEqual(
    await (await fetch(baseURL + "/api/browser-analytics")).json(),
    { enabled: false },
  );
  assert.match(
    (await fetch(baseURL)).headers.get("content-security-policy")!,
    /connect-src 'self';/,
  );
});
