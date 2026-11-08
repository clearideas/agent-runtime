/**
 * npm run doctor [-- --live]
 *
 * Checks this machine for the showcase and proves the setup works by running
 * demos end to end in the real sandbox. With --live it also makes three
 * small calls to your model provider to confirm the key, tool calls, and
 * structured output (this uses a few hundred tokens).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pullDockerImage } from "./lib/environment.ts";
import { checkLiveModel } from "./lib/live-check.ts";
import { createShowcaseApp } from "./server.ts";

const windows = process.platform === "win32";
let failed = false;
const ok = (text: string) => console.log(`  ✓ ${text}`);
const warn = (text: string) => console.log(`  ! ${text}`);
const fail = (text: string, fix?: string) => {
  failed = true;
  console.log(`  ✗ ${text}`);
  if (fix) console.log(`    Fix: ${fix}`);
};

interface Message {
  kind: string;
  [key: string]: any;
}
const events = (messages: Message[], type: string) =>
  messages
    .filter((m) => m.kind === "event" && m.event.type === type)
    .map((m) => m.event);
const post = async (url: string, body: unknown): Promise<Message[]> =>
  (
    await (
      await fetch(url, { method: "POST", body: JSON.stringify(body) })
    ).text()
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);

console.log("\nAgent Runtime showcase doctor\n");

// ─── Node.js ─────────────────────────────────────────────────────────────────
console.log("Node.js");
const major = Number(process.versions.node.split(".")[0]);
if (major >= 24) ok(`Node.js ${process.versions.node}`);
else
  fail(
    `Node.js ${process.versions.node} is too old`,
    "install Node.js 24 or newer from https://nodejs.org",
  );

// ─── Sandbox ─────────────────────────────────────────────────────────────────
console.log("\nSandbox");
const dataDirectory = await mkdtemp(path.join(tmpdir(), "showcase-doctor-"));
const app = await createShowcaseApp({
  host: "127.0.0.1",
  port: 0,
  dataDirectory,
});
const { sandbox, live } = app.environment;
for (const note of sandbox.notes) warn(note);
if (sandbox.isolated) ok(`${sandbox.kind} is available and isolated`);
else if (sandbox.kind === "unisolated")
  fail(
    "no isolated sandbox; only the unisolated demo fallback is available",
    windows
      ? "install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/), start it, use Linux containers, then run this again"
      : "start Docker, or on Linux install bubblewrap (sudo apt-get install bubblewrap)",
  );
else
  fail(
    "no sandbox is available",
    "install and start Docker Desktop, then run this again",
  );

if (sandbox.kind === "docker") {
  if (sandbox.imagePresent) ok(`image ${sandbox.image} is present`);
  else {
    console.log(`    Pulling ${sandbox.image} (first run only)…`);
    if (pullDockerImage(sandbox.image!)) ok(`pulled ${sandbox.image}`);
    else
      fail(
        `could not pull ${sandbox.image}`,
        `check your connection, then run: docker pull ${sandbox.image}`,
      );
  }
}

// ─── End-to-end runs in the sandbox ──────────────────────────────────────────
if (sandbox.kind !== "none") {
  console.log(`\nDemos in the ${sandbox.kind} sandbox (scripted model)`);
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}/api/demos`;
  try {
    const repo = await post(`${base}/repo-mechanic/runs`, { pace: 0 });
    const error = repo.find((m) => m.kind === "error");
    const result = repo.find((m) => m.kind === "result")?.result;
    const commands = events(repo, "sandbox.command.completed").length;
    const provider = events(repo, "sandbox.opened")[0]?.data.provider;
    if (error)
      fail(
        `Repo Mechanic failed: ${error.error.message}`,
        "the terminal output above shows the sandbox's error",
      );
    else if (JSON.parse(result.state.verification).passed)
      ok(
        `Repo Mechanic: ${commands} commands ran in ${provider}; the fix synced back and the tests pass`,
      );
    else fail("Repo Mechanic ran, but the tests did not pass afterwards");

    const first = await post(`${base}/durable-runs/runs`, { pace: 0 });
    const runId = first.find((m) => m.kind === "accepted")?.runId;
    const resumed = runId
      ? await post(`${base}/durable-runs/runs/${runId}/resume`, {
          pace: 0,
          options: { decision: "approve", reviewer: "doctor" },
        })
      : [];
    const report = resumed.find((m) => m.kind === "result")?.result;
    if (report && events(resumed, "sandbox.opened").length === 1)
      ok(
        "Durable Runs: paused for approval, then resumed with a fresh sandbox and published",
      );
    else
      fail(
        `Durable Runs did not complete: ${first.concat(resumed).find((m) => m.kind === "error")?.error.message ?? "no result"}`,
      );

    const attack = await post(`${base}/guardrails/runs`, { pace: 0 });
    const reached = attack.filter((m) => m.kind === "canary").at(-1)?.hit;
    if (attack.some((m) => m.kind === "error"))
      fail(
        `Guardrails failed: ${attack.find((m) => m.kind === "error")!.error.message}`,
      );
    else if (reached === false)
      ok("Guardrails: the sandbox blocked a script's network access");
    else
      warn(
        "Guardrails: a script reached the network (expected without an isolated sandbox)",
      );

    // Long Investigation needs context management, which is newer than the
    // published 0.6.3 runtime; an older runtime is reported, not a failure.
    const catalog = (await (await fetch(base)).json()) as Array<{
      id: string;
      status: string;
      unavailable?: string;
    }>;
    const investigation = catalog.find(
      (entry) => entry.id === "long-investigation",
    );
    if (investigation?.status === "unavailable") {
      warn(`Long Investigation is unavailable: ${investigation.unavailable}`);
    } else {
      const run = await post(`${base}/long-investigation/runs`, {
        pace: 0,
        options: { strategy: "prune" },
      });
      const findings = run.find((m) => m.kind === "result")?.result?.state
        ?.findings;
      const reductions = events(run, "context.reduced").length;
      if (findings?.filesRead === 16)
        ok(
          `Long Investigation: read all 16 logs inside the 40 KB input limit (${reductions} context reductions)`,
        );
      else
        fail(
          `Long Investigation did not complete: ${run.find((m) => m.kind === "error")?.error.message ?? "no result"}`,
        );
    }
  } catch (error) {
    fail(
      `the demos could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
await app.close();
await rm(dataDirectory, { recursive: true, force: true });

// ─── Live model ──────────────────────────────────────────────────────────────
console.log("\nLive model");
const setKey = windows
  ? `$env:OPENAI_API_KEY = "sk-…"`
  : `export OPENAI_API_KEY="sk-…"`;
if (!live.available) {
  warn(live.reason);
  console.log(
    `    Live mode is optional. To use OpenAI: ${setKey}, then restart.`,
  );
  console.log(
    `    Another provider: set SHOWCASE_PROVIDER (anthropic, google, xai, groq, cohere), SHOWCASE_MODEL, and that provider's key.`,
  );
} else if (!process.argv.includes("--live")) {
  ok(`configured for ${live.provider}/${live.model}`);
  console.log(
    "    Run `npm run doctor -- --live` to make three small real calls and confirm the key and model.",
  );
} else {
  const check = await checkLiveModel({
    provider: live.provider,
    model: live.model,
  });
  if (check.error) {
    fail(
      `the ${live.provider}/${live.model} call failed: ${check.error.slice(0, 300)}`,
      /401|auth|api key/iu.test(check.error)
        ? "check the API key"
        : /model/iu.test(check.error)
          ? "set SHOWCASE_MODEL to a model your account can use"
          : "check your network and provider settings",
    );
  } else {
    for (const line of check.lines)
      if (line.ok) ok(`${live.provider}/${live.model} ${line.text}`);
      else
        fail(
          `${live.provider}/${live.model} ${line.text}`,
          "the demos need tool calls and structured output; try another SHOWCASE_MODEL",
        );
    if (check.totalTokens) console.log(`    (${check.totalTokens} tokens)`);
  }
}

console.log(
  failed
    ? "\nSome checks failed. Fix them and run `npm run doctor` again.\n"
    : "\nAll set. Start the showcase with `npm start`.\n",
);
process.exit(failed ? 1 : 0);
