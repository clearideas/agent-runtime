import assert from "node:assert/strict";
import test from "node:test";

import {
  applySandboxChoice,
  assertModeAllowed,
  type ShowcaseEnvironment,
} from "../lib/environment.ts";
import { parseAgentRuntimeConfig } from "@clearideas/agent-runtime";
import { runDemo, startShowcase } from "./helpers.ts";

test("serves the gallery, demo pages, and vendor assets under a strict CSP", async (context) => {
  const { baseURL } = await startShowcase(context);
  for (const page of [
    "/",
    "/demos/repo-mechanic",
    "/assets/showcase.css",
    "/vendor/marked.js",
  ]) {
    const response = await fetch(`${baseURL}${page}`);
    assert.equal(response.status, 200, page);
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /default-src 'self'; script-src 'self'/u,
    );
  }
  const html = await (await fetch(`${baseURL}/demos/repo-mechanic`)).text();
  assert.doesNotMatch(
    html,
    /https?:\/\/(?!www\.w3\.org)/u,
    "no external resources",
  );
  assert.equal((await fetch(`${baseURL}/assets/../server.ts`)).status, 404);
});

test("lists all five demos and describes the ready ones", async (context) => {
  const { baseURL } = await startShowcase(context);
  const catalog = await (await fetch(`${baseURL}/api/demos`)).json();
  assert.deepEqual(
    catalog.map((entry: { id: string }) => entry.id),
    [
      "repo-mechanic",
      "durable-runs",
      "guardrails",
      "document-library",
      "orchestration",
    ],
  );
  const demo = await (await fetch(`${baseURL}/api/demos/repo-mechanic`)).json();
  assert.equal(demo.manifest.id, "repo-mechanic");
  assert.equal(demo.workspace.name, "invoice-service");
  assert.deepEqual(demo.sandbox.commands, ["run_tests"]);
});

test("serves only declared source files", async (context) => {
  const { baseURL } = await startShowcase(context);
  const host = await fetch(
    `${baseURL}/api/demos/repo-mechanic/source?path=demos/repo-mechanic/host.ts`,
  );
  assert.equal(host.status, 200);
  assert.match((await host.json()).text, /composeRuntime/u);
  const denied = await fetch(
    `${baseURL}/api/demos/repo-mechanic/source?path=server.ts`,
  );
  assert.equal(denied.status, 404);
});

test("live mode is refused without an isolated sandbox and a provider key", async (context) => {
  const { baseURL } = await startShowcase(context, { sandbox: "unisolated" });
  const messages = await runDemo(baseURL, "repo-mechanic", { mode: "live" });
  const error = messages.find((message) => message.kind === "error");
  assert.match(error?.error.message ?? "", /isolated sandbox/u);
});

const environment = (
  kind: ShowcaseEnvironment["sandbox"]["kind"],
  live = true,
): ShowcaseEnvironment => ({
  sandbox: {
    kind,
    isolated: kind === "bubblewrap" || kind === "docker",
    detail: "",
    notes: [],
  },
  python: "Python 3",
  live: {
    available: live,
    reason: live ? "openai/gpt-6-luna" : "Set OPENAI_API_KEY",
    provider: "openai",
    model: "gpt-6-luna",
  },
  loopback: true,
});

test("mode policy and sandbox substitution", () => {
  assert.throws(
    () => assertModeAllowed(environment("none"), "scripted"),
    /No sandbox/u,
  );
  assert.throws(
    () => assertModeAllowed(environment("bubblewrap", false), "live"),
    /OPENAI_API_KEY/u,
  );
  assert.doesNotThrow(() =>
    assertModeAllowed(environment("unisolated", false), "scripted"),
  );

  const config = parseAgentRuntimeConfig({
    version: "1.0",
    sandbox: { driver: "bubblewrap", commands: { t: { argv: ["true"] } } },
  });
  const docker = applySandboxChoice(config, {
    kind: "docker",
    isolated: true,
    image: "python:3.12-slim",
    detail: "",
    notes: [],
  });
  assert.equal(docker.config.sandbox?.driver, "docker");
  assert.equal(docker.config.sandbox?.image, "python:3.12-slim");
  assert.deepEqual(Object.keys(docker.config.sandbox?.commands ?? {}), ["t"]);
  const fallback = applySandboxChoice(config, {
    kind: "unisolated",
    isolated: false,
    detail: "",
    notes: [],
  });
  assert.equal(fallback.config.sandbox?.driver, "host");
  assert.ok(fallback.sandboxProvider);
});

test("rejects cross-origin browser mutations while allowing this showcase and local clients", async (context) => {
  const { baseURL } = await startShowcase(context);
  for (const origin of ["https://untrusted.example", "null"]) {
    const response = await fetch(`${baseURL}/api/demos/repo-mechanic/reset`, {
      method: "POST",
      headers: { origin, "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(response.status, 403, origin);
  }
  for (const origin of [undefined, baseURL]) {
    const response = await fetch(`${baseURL}/api/demos/repo-mechanic/reset`, {
      method: "POST",
      headers: {
        ...(origin ? { origin } : {}),
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
  }
});
