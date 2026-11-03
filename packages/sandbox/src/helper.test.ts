import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundledHelperPath } from "./run-sandbox.js";

/** The helper and the host-process test provider run POSIX commands; skip elsewhere. */
const hasPython =
  process.platform !== "win32" &&
  spawnSync("python3", ["--version"]).status === 0;

interface HelperResult {
  exitCode: number;
  document: Record<string, unknown>;
}

const helper = (args: string[]): HelperResult => {
  const result = spawnSync("python3", [bundledHelperPath(), ...args], {
    encoding: "utf8",
  });
  return {
    exitCode: result.status ?? -1,
    document: JSON.parse(result.stdout.trim() || "{}") as Record<
      string,
      unknown
    >,
  };
};

describe.skipIf(!hasPython)(
  "agent-fs helper protocol",
  { timeout: 60_000 },
  () => {
    let mount: string;
    let outside: string;

    beforeEach(async () => {
      mount = await mkdtemp(path.join(tmpdir(), "agent-runtime-helper-"));
      outside = await mkdtemp(
        path.join(tmpdir(), "agent-runtime-helper-outside-"),
      );
      await mkdir(path.join(mount, "src", "nested"), { recursive: true });
      await writeFile(
        path.join(mount, "README.md"),
        "# Title\r\nhello World\nlast",
      );
      await writeFile(path.join(mount, "src", "app.py"), "print('hello')\n");
      await writeFile(
        path.join(mount, "src", "nested", "deep.txt"),
        "x\n".repeat(10),
      );
      await writeFile(
        path.join(mount, "image.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]),
      );
      await writeFile(path.join(mount, ".env"), "SECRET=1\n");
      await writeFile(path.join(mount, "bad name.txt"), "spaces\n");
      await writeFile(path.join(outside, "secret.txt"), "outside\n");
      await symlink(
        path.join(outside, "secret.txt"),
        path.join(mount, "link.txt"),
      );
      await symlink(outside, path.join(mount, "linkdir"));
    });

    afterEach(async () => {
      await rm(mount, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });

    it("reports its protocol version and rejects invalid usage", () => {
      expect(helper(["version"])).toEqual({
        exitCode: 0,
        document: { protocolVersion: 1, version: expect.any(String) },
      });
      expect(helper(["bogus"]).exitCode).toBe(2);
      expect(helper(["list", "--mount", mount, "--limit", "0"]).exitCode).toBe(
        2,
      );
      expect(
        helper(["list", "--mount", path.join(mount, "missing")]).exitCode,
      ).toBe(2);
    });

    it("lists visible files deterministically with globs and limits", () => {
      const listed = helper(["list", "--mount", mount]);
      expect(listed.exitCode).toBe(0);
      expect(
        (listed.document.files as Array<{ path: string }>).map(
          (file) => file.path,
        ),
      ).toEqual([
        "README.md",
        "image.png",
        "src/app.py",
        "src/nested/deep.txt",
      ]);
      expect(
        helper(["list", "--mount", mount, "--glob", "**/*.py"]).document,
      ).toMatchObject({
        files: [{ path: "src/app.py", mediaType: "text/x-python", size: 15 }],
        truncated: false,
      });
      expect(
        helper(["list", "--mount", mount, "--limit", "1"]).document,
      ).toMatchObject({
        truncated: true,
      });
      expect(
        helper(["list", "--mount", mount, "--path", "src/nested"]).document,
      ).toMatchObject({
        files: [{ path: "src/nested/deep.txt" }],
      });
      expect(helper(["list", "--mount", mount, "--path", "../"]).exitCode).toBe(
        3,
      );
      expect(
        helper(["list", "--mount", mount, "--max-scan", "2"]).exitCode,
      ).toBe(4);
    });

    it("reads text windows, normalizes line endings, and copies binaries for artifacts", () => {
      expect(
        helper(["read", "--mount", mount, "--path", "README.md"]).document,
      ).toMatchObject({
        encoding: "utf-8",
        content: "# Title\nhello World\nlast",
        totalLines: 3,
        lineCount: 3,
        truncated: false,
      });
      expect(
        helper([
          "read",
          "--mount",
          mount,
          "--path",
          "README.md",
          "--start-line",
          "2",
          "--line-count",
          "1",
        ]).document,
      ).toMatchObject({
        content: "hello World",
        startLine: 2,
        lineCount: 1,
        truncated: true,
      });
      const artifactDirectory = path.join(outside, "artifacts");
      expect(
        helper([
          "read",
          "--mount",
          mount,
          "--path",
          "image.png",
          "--artifact-dir",
          artifactDirectory,
        ]).document,
      ).toMatchObject({
        encoding: "binary",
        mediaType: "image/png",
        size: 6,
        artifactFile: "image.png",
      });
      expect(
        helper([
          "read",
          "--mount",
          mount,
          "--path",
          "README.md",
          "--max-bytes",
          "4",
        ]).exitCode,
      ).toBe(4);
      for (const invalid of [
        ".env",
        "bad name.txt",
        "link.txt",
        "linkdir/secret.txt",
        "../secret",
        "src",
        "missing",
      ]) {
        expect(
          helper(["read", "--mount", mount, "--path", invalid]).exitCode,
          invalid,
        ).toBe(3);
      }
    });

    it("searches literally with case folding and bounds", () => {
      expect(
        helper(["search", "--mount", mount, "--query", "hello"]).document,
      ).toMatchObject({
        matches: [
          { path: "README.md", line: 2, text: "hello World" },
          { path: "src/app.py", line: 1, text: "print('hello')" },
        ],
        truncated: false,
      });
      expect(
        helper([
          "search",
          "--mount",
          mount,
          "--query",
          "hello",
          "--case-sensitive",
          "--glob",
          "**/*.md",
        ]).document,
      ).toMatchObject({ matches: [{ path: "README.md", line: 2 }] });
      expect(
        helper(["search", "--mount", mount, "--query", "x", "--limit", "2"])
          .document,
      ).toMatchObject({
        truncated: true,
      });
      expect(
        helper(["search", "--mount", mount, "--query", "a.*b"]).document,
      ).toMatchObject({
        matches: [],
      });
    });

    it("writes atomically only on writable mounts and snapshots with hashes", async () => {
      const source = path.join(outside, "content");
      await writeFile(source, "new content");
      expect(
        helper([
          "write",
          "--mount",
          mount,
          "--path",
          "docs/new.txt",
          "--source",
          source,
        ]).exitCode,
      ).toBe(5);
      expect(
        helper([
          "write",
          "--mount",
          mount,
          "--writable",
          "--path",
          "docs/new.txt",
          "--source",
          source,
        ]).document,
      ).toMatchObject({ path: "docs/new.txt", size: 11 });
      expect(await readFile(path.join(mount, "docs", "new.txt"), "utf8")).toBe(
        "new content",
      );
      await writeFile(source, Buffer.from("binary").toString("base64"));
      expect(
        helper([
          "write",
          "--mount",
          mount,
          "--writable",
          "--path",
          "docs/bin.dat",
          "--source",
          source,
          "--encoding",
          "base64",
        ]).document,
      ).toMatchObject({ size: 6 });
      expect(
        helper([
          "write",
          "--mount",
          mount,
          "--writable",
          "--path",
          "link.txt",
          "--source",
          source,
        ]).exitCode,
      ).toBe(3);
      expect(
        helper([
          "write",
          "--mount",
          mount,
          "--writable",
          "--path",
          "docs/new.txt",
          "--source",
          source,
          "--max-bytes",
          "2",
        ]).exitCode,
      ).toBe(4);
      expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe(
        "outside\n",
      );
      expect(
        helper(["delete", "--mount", mount, "--path", "docs/new.txt"]).exitCode,
      ).toBe(5);
      expect(
        helper([
          "delete",
          "--mount",
          mount,
          "--writable",
          "--path",
          "docs/new.txt",
        ]).document,
      ).toMatchObject({
        deleted: true,
      });
      const snapshot = helper([
        "snapshot",
        "--mount",
        mount,
        "--max-bytes",
        "10",
      ]);
      expect(snapshot.exitCode).toBe(0);
      const files = snapshot.document.files as Array<{
        path: string;
        sha256?: string;
      }>;
      expect(files.map((file) => file.path)).toEqual([
        "README.md",
        "docs/bin.dat",
        "image.png",
        "src/app.py",
        "src/nested/deep.txt",
      ]);
      expect(files.find((file) => file.path === "image.png")?.sha256).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      expect(
        files.find((file) => file.path === "README.md")?.sha256,
      ).toBeUndefined();
      expect(snapshot.document.ignored).toEqual(
        expect.arrayContaining([
          { path: ".env", reason: "path" },
          { path: "bad name.txt", reason: "path" },
          { path: "link.txt", reason: "symlink" },
          { path: "linkdir", reason: "symlink" },
        ]),
      );
    });
  },
);
