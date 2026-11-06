/**
 * The unisolated fallback must work when `python3` is a shim that needs HOME
 * (pyenv, asdf) or the macOS developer-tools stub: the base test provider
 * runs commands with only PATH set.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { eventsOf, resultOf, runDemo, startShowcase } from "./helpers.ts";

const realPython =
  spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
  }).stdout?.trim() ?? "";

test(
  "runs Repo Mechanic when python3 is a shim that requires HOME",
  {
    skip:
      process.platform === "win32" || !realPython
        ? "needs a POSIX shell and python3"
        : false,
  },
  async (context) => {
    const shims = await mkdtemp(path.join(tmpdir(), "showcase-shim-"));
    const shim = path.join(shims, "python3");
    await writeFile(
      shim,
      `#!/bin/sh\nif [ -z "$HOME" ]; then echo "shim: HOME is not set" >&2; exit 1; fi\nexec "${realPython}" "$@"\n`,
    );
    await chmod(shim, 0o755);
    process.env.PATH = `${shims}${path.delimiter}${process.env.PATH}`;

    const { baseURL } = await startShowcase(context, { sandbox: "unisolated" });
    const messages = await runDemo(baseURL, "repo-mechanic");
    const result = resultOf(messages);
    assert.equal(JSON.parse(result.state.verification).passed, true);
    assert.equal(
      messages.some((message) => message.kind === "tool-io" && message.error),
      false,
    );
    assert.equal(eventsOf(messages, "run.completed").length, 1);
  },
);
