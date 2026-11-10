// Runs the walkthrough in README.md: serve this directory's configuration
// with the scripted model, chat through chat.mjs, and stop with SIGINT.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../packages/cli/dist/bin.js");
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/gu, "");

test("the serving walkthrough works end to end", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-runtime-serving-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(here, directory, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.data`),
  });
  const env = {
    ...process.env,
    AGENT_RUNTIME_API_KEY: "walkthrough-key",
    AGENT_MESSAGES_KEY: `hex:${"5a".repeat(32)}`,
  };
  delete env.OPENAI_API_KEY;

  // 3. Start the server: the discovered configuration, the scripted model.
  const server = spawn(
    process.execPath,
    [cli, "serve", "--runtime-module", "scripted-model.mjs", "--port", "0"],
    { cwd: directory, env },
  );
  let serverLog = "";
  server.stderr.setEncoding("utf8");
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(serverLog)), 20_000);
    server.stderr.on("data", (chunk) => {
      serverLog += chunk;
      const match = /listening on (http:\/\/[^\s]+)\/v1/u.exec(serverLog);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.on("exit", () => reject(new Error(serverLog)));
  });
  t.after(() => server.kill("SIGKILL"));
  assert.match(serverLog, /agent-runtime\.server\.yaml/u);

  // 4. Chat from the terminal, as the README shows.
  const chat = spawn(process.execPath, ["chat.mjs"], {
    cwd: directory,
    env: { ...env, AGENT_RUNTIME_BASE_URL: `${url}/v1` },
  });
  chat.stdin.end(
    "How do I share a folder?\nWhat is the weather?\nThanks!\n/quit\n",
  );
  let output = "";
  chat.stdout.setEncoding("utf8");
  chat.stdout.on("data", (chunk) => (output += chunk));
  assert.equal(await new Promise((resolve) => chat.on("exit", resolve)), 0);
  output = plain(output);
  assert.match(output, /Models: support-chat, topic-brief/u);
  assert.match(
    output,
    /Step: Screen the request\nStep: Answer\nagent \(turn 1\) › \(scripted\) You asked: "How do I share a folder\?"/u,
  );
  assert.match(
    output,
    /Step: Redirect\nagent \(turn 2\) › \(scripted\) I can only help/u,
  );
  assert.match(output, /agent \(turn 3\) › .*I can see 4 earlier message/u);

  // Every later turn continued from the runtime's own history.
  const ledger = serverLog
    .split("\n")
    .filter((line) => line.includes('"path":"/v1/chat/completions"'))
    .map((line) => JSON.parse(line).ledger);
  assert.deepEqual(ledger, ["first-turn", "hit", "hit"]);

  // Ctrl+C finishes active runs and exits cleanly.
  server.kill("SIGINT");
  assert.equal(await new Promise((resolve) => server.on("exit", resolve)), 0);
  assert.match(serverLog, /Shutting down/u);
});
