#!/usr/bin/env node
/**
 * npm run test:python
 *
 * Runs the showcase's HTTP tests against the Python server (server.py on the
 * Python Agent Runtime) instead of server.ts, and the cross-runtime parity
 * tests (test/parity.python.ts) that run every demo on both and compare them.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const showcase = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const project = path.resolve(showcase, "..", "..", "python");
const python = path.join(
  project,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
if (!existsSync(python)) {
  console.log("Creating the Python environment (uv sync in python/)");
  const sync = spawnSync("uv", ["sync", "--all-extras"], {
    cwd: project,
    stdio: "inherit",
  });
  if (sync.status !== 0) {
    console.error(
      "\n✗ The Python environment is missing. Install uv (https://docs.astral.sh/uv/), or run `make test` at the repository root.\n",
    );
    process.exit(1);
  }
}
const result = spawnSync(
  process.execPath,
  [
    "--test",
    ...process.argv.slice(2),
    "test/*.test.ts",
    // Every demo on both servers, compared (not part of `npm test`).
    "test/parity.python.ts",
  ],
  {
    cwd: showcase,
    stdio: "inherit",
    env: { ...process.env, SHOWCASE_RUNTIME: "python" },
  },
);
process.exit(result.status ?? 1);
