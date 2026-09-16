import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
const run = (name, args = [], env = process.env) =>
  execFileSync(
    process.execPath,
    [new URL(name, import.meta.url).pathname, ...args],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  );
test("prompt chain produces a structured final result", () => {
  assert.equal(
    JSON.parse(run("prompt-chain.mjs", ["--demo"])).title,
    "Durable checkpoints",
  );
});
test("tool agent recovers from a transient read failure", () => {
  assert.match(run("tool-agent.mjs", ["--demo"]), /Release found/);
});
test("approval resumes in a fresh process with the same persisted manifest", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-pattern-"));
  try {
    const env = { ...process.env, DEMO_STORE: directory };
    assert.match(run("approval.mjs", [], env), /Suspended/);
    assert.equal(
      JSON.parse(run("approval.mjs", ["--approve"], env)).approved,
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
