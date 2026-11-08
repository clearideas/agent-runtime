import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renameWithRetry, withFileRetry } from "./file-retry.js";
import { FileRunStore } from "./run-store.file.js";

const failing = (codes: string[], value = "done") => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    operation: async () => {
      const code = codes[calls];
      calls += 1;
      if (code)
        throw Object.assign(new Error(`${code}: operation not permitted`), {
          code,
        });
      return value;
    },
  };
};

describe("withFileRetry", () => {
  it("retries transient Windows sharing errors, then succeeds", async () => {
    const delays: number[] = [];
    const attempt = failing(["EPERM", "EBUSY", "EACCES"]);
    await expect(
      withFileRetry(attempt.operation, {
        platform: "win32",
        sleep: async (delay) => {
          delays.push(delay);
        },
      }),
    ).resolves.toBe("done");
    expect(attempt.calls).toBe(4);
    expect(delays).toEqual([10, 20, 40]);
  });

  it("does not retry the same codes on other platforms", async () => {
    const attempt = failing(["EPERM"]);
    await expect(
      withFileRetry(attempt.operation, { platform: "linux" }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(attempt.calls).toBe(1);
  });

  it("does not retry other errors, and gives up after its time budget", async () => {
    const missing = failing(["ENOENT"]);
    await expect(
      withFileRetry(missing.operation, { platform: "win32" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(missing.calls).toBe(1);

    const locked = failing(Array.from({ length: 100 }, () => "EPERM"));
    await expect(
      withFileRetry(locked.operation, {
        platform: "win32",
        maxWaitMs: 500,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    // 10 + 20 + 40 + 80 + 160 + 250 = 560 ms of backoff, then the last error.
    expect(locked.calls).toBe(7);
  });

  it("replaces a file atomically", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "file-retry-"));
    try {
      const target = path.join(directory, "checkpoint.json");
      const temporary = path.join(directory, ".checkpoint.json.tmp");
      await writeFile(target, "old");
      await writeFile(temporary, "new");
      await renameWithRetry(temporary, target);
      await expect(readFile(target, "utf8")).resolves.toBe("new");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("FileRunStore on Windows with a file briefly locked", () => {
  it("saves checkpoints while another process holds checkpoint.json open", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "file-store-locked-"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const originalRename = fs.promises.rename;
    let refused = 0;
    // Like OneDrive or an antivirus scanner: the first attempts to replace an
    // existing checkpoint fail with EPERM, as they do on Windows.
    fs.promises.rename = (async (from, to) => {
      if (String(to).endsWith("checkpoint.json") && refused < 3) {
        refused += 1;
        throw Object.assign(
          new Error("EPERM: operation not permitted, rename"),
          {
            code: "EPERM",
          },
        );
      }
      return originalRename(from, to);
    }) as typeof fs.promises.rename;
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const store = new FileRunStore(directory);
      await store.createRun({
        runId: "run-locked",
        manifest: { schemaVersion: "1.0", steps: [] },
        status: "running",
        state: {},
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
      });
      for (const sequence of [1, 2]) {
        await store.saveCheckpoint({
          id: `checkpoint-${sequence}`,
          runId: "run-locked",
          sequence,
          manifestHash: "hash",
          contractVersion: "1.0",
          runtimeVersion: "0.1.0",
          cursor: { stepIndex: 0 },
          state: { sequence },
          stepResults: [],
          transcript: [],
          artifacts: [],
          createdAt: "2026-07-22T00:00:00.000Z",
        });
      }
      expect(refused).toBe(3);
      expect((await store.loadLatestCheckpoint("run-locked"))?.sequence).toBe(
        2,
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
      fs.promises.rename = originalRename;
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
