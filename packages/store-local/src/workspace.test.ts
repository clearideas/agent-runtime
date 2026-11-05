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

import { compileGlob } from "./workspace-common.js";
import { LocalDirectoryWorkspace } from "./workspace.directory.js";
import { MemoryWorkspace } from "./workspace.memory.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("compileGlob", () => {
  it("matches segments, globstars, and single characters deterministically", () => {
    expect(compileGlob("**/*.md").test("README.md")).toBe(true);
    expect(compileGlob("**/*.md").test("docs/guide/intro.md")).toBe(true);
    expect(compileGlob("*.md").test("docs/intro.md")).toBe(false);
    expect(compileGlob("src/**").test("src/a/b.ts")).toBe(true);
    expect(compileGlob("src/**").test("lib/a.ts")).toBe(false);
    expect(compileGlob("**/node_modules/**").test("a/node_modules/")).toBe(
      true,
    );
    expect(compileGlob("file?.txt").test("file1.txt")).toBe(true);
    expect(compileGlob("file?.txt").test("file/.txt")).toBe(false);
    expect(compileGlob("a.b").test("aXb")).toBe(false);
    expect(() => compileGlob("  ")).toThrow(/Invalid workspace glob/u);
  });
});

describe("LocalDirectoryWorkspace", () => {
  let root: string;
  let outside: string;
  // Creating symbolic links needs privileges on Windows; skip those cases when it fails.
  let symlinksSupported = true;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "agent-runtime-workspace-"));
    outside = await mkdtemp(path.join(tmpdir(), "agent-runtime-outside-"));
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Title\nhello world\n");
    await writeFile(
      path.join(root, "src", "index.ts"),
      "export const x = 1;\n",
    );
    await writeFile(path.join(root, "src", "nested", "util.ts"), "util\n");
    await writeFile(
      path.join(root, "node_modules", "dep", "index.js"),
      "dep\n",
    );
    await writeFile(path.join(root, ".git", "config"), "secret\n");
    await writeFile(path.join(root, ".env"), "SECRET=1\n");
    await writeFile(path.join(root, "with space.txt"), "hidden by path rule\n");
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    symlinksSupported = await symlink(
      path.join(outside, "secret.txt"),
      path.join(root, "link.txt"),
    ).then(
      async () => {
        await symlink(outside, path.join(root, "linked-dir"));
        return true;
      },
      () => false,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("enumerates and reads Python package paths beginning with underscores", async () => {
    await mkdir(path.join(root, "_package"));
    await writeFile(path.join(root, "_package", "__init__.py"), "value = 42\n");
    const workspace = new LocalDirectoryWorkspace({ root });
    expect(await workspace.entries()).toContainEqual(
      expect.objectContaining({ path: "_package/__init__.py" }),
    );
    expect(
      new TextDecoder().decode(await workspace.read("_package/__init__.py")),
    ).toBe("value = 42\n");
    const memory = new MemoryWorkspace({ mode: "read_write" });
    await memory.write("_package/__init__.py", text("value = 42\n"));
    expect(await memory.entries()).toContainEqual(
      expect.objectContaining({ path: "_package/__init__.py" }),
    );
  });

  it("enumerates only safe, visible regular files and advertises limits", async () => {
    const workspace = new LocalDirectoryWorkspace({
      root,
      exclude: ["**/node_modules/**"],
      maxFileBytes: 2048,
    });
    const entries = await workspace.entries();
    expect(entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "src/index.ts",
      "src/nested/util.ts",
    ]);
    expect(entries[0]).toMatchObject({ size: 20 });
    expect(entries[0]?.modifiedAt).toMatch(/^\d{4}-/u);
    expect(workspace.limits).toEqual({
      maxFiles: 5000,
      maxFileBytes: 2048,
      maxTotalBytes: 100 * 1_048_576,
    });
    expect(workspace.attachable).toBeUndefined();
    expect(new LocalDirectoryWorkspace({ root }).attachable).toEqual({
      kind: "local-directory",
      root,
    });
    await expect(
      new LocalDirectoryWorkspace({ root, maxFiles: 2 }).entries(),
    ).rejects.toThrow(/more than 2 visible files/u);
    await expect(
      new LocalDirectoryWorkspace({
        root: path.join(root, "missing"),
      }).entries(),
    ).resolves.toEqual([]);
  });

  it("applies include allowlists to enumeration and reads", async () => {
    const workspace = new LocalDirectoryWorkspace({
      root,
      include: ["**/*.md"],
    });
    expect((await workspace.entries()).map((entry) => entry.path)).toEqual([
      "README.md",
    ]);
    await expect(workspace.read("src/index.ts")).rejects.toThrow(
      /not available/u,
    );
    expect(new TextDecoder().decode(await workspace.read("README.md"))).toBe(
      "# Title\nhello world\n",
    );
  });

  it("refuses traversal, hidden entries, symbolic links, and oversized files", async () => {
    const workspace = new LocalDirectoryWorkspace({ root, maxFileBytes: 16 });
    await expect(workspace.read("../outside/secret.txt")).rejects.toThrow(
      /safe segments/u,
    );
    await expect(workspace.read(".env")).rejects.toThrow(/safe segments/u);
    await expect(workspace.read(".git/config")).rejects.toThrow(
      /safe segments/u,
    );
    if (symlinksSupported) {
      await expect(workspace.read("link.txt")).rejects.toThrow(
        /symbolic link/u,
      );
      await expect(workspace.read("linked-dir/secret.txt")).rejects.toThrow(
        /symbolic link/u,
      );
    }
    await expect(workspace.read("src")).rejects.toThrow(/not available/u);
    await expect(workspace.read("README.md")).rejects.toThrow(
      /exceeding the 16-byte limit/u,
    );
    expect(
      new TextDecoder().decode(await workspace.read("src/nested/util.ts")),
    ).toBe("util\n");
  });

  it("rejects writes in read mode and confines writes in read_write mode", async () => {
    const readOnly = new LocalDirectoryWorkspace({ root });
    expect(readOnly.write).toBeTypeOf("function");
    await expect(readOnly.write("new.txt", text("x"))).rejects.toThrow(
      /read-only/u,
    );
    await expect(readOnly.delete("README.md")).rejects.toThrow(/read-only/u);

    const workspace = new LocalDirectoryWorkspace({
      root,
      mode: "read_write",
      maxFileBytes: 32,
      exclude: ["protected/**"],
    });
    const written = await workspace.write("docs/new/file.md", text("# New\n"));
    expect(written).toMatchObject({ path: "docs/new/file.md", size: 6 });
    expect(
      await readFile(path.join(root, "docs", "new", "file.md"), "utf8"),
    ).toBe("# New\n");
    await expect(
      workspace.write("docs/new/file.md", text("updated")),
    ).resolves.toMatchObject({ size: 7 });
    await expect(workspace.write("../escape.txt", text("x"))).rejects.toThrow(
      /safe segments/u,
    );
    await expect(workspace.write("protected/x.txt", text("x"))).rejects.toThrow(
      /not available/u,
    );
    if (symlinksSupported) {
      await expect(
        workspace.write("linked-dir/new.txt", text("x")),
      ).rejects.toThrow(/symbolic link/u);
      await expect(workspace.write("link.txt", text("x"))).rejects.toThrow(
        /symbolic link/u,
      );
    }
    await expect(workspace.write("src", text("x"))).rejects.toThrow(
      /not a regular file/u,
    );
    await expect(
      workspace.write("big.txt", text("x".repeat(33))),
    ).rejects.toThrow(/exceeding the 32-byte limit/u);
    await workspace.delete("docs/new/file.md");
    await expect(workspace.read("docs/new/file.md")).rejects.toThrow(
      /not available/u,
    );
    if (symlinksSupported) {
      await expect(workspace.delete("link.txt")).rejects.toThrow(
        /symbolic link/u,
      );
    }
    await expect(
      readFile(path.join(outside, "secret.txt"), "utf8"),
    ).resolves.toBe("outside\n");
  });
});

describe("MemoryWorkspace", () => {
  it("behaves like a bounded workspace over in-memory files", async () => {
    const workspace = new MemoryWorkspace({
      mode: "read_write",
      files: {
        "README.md": "# Memory\nhello\n",
        "src/index.ts": "const a = 1;\n",
        "assets/logo.png": new Uint8Array([0x89, 0x50, 0, 1]),
      },
      exclude: ["assets/**"],
      maxFiles: 4,
      maxFileBytes: 64,
    });
    expect((await workspace.entries()).map((entry) => entry.path)).toEqual([
      "README.md",
      "src/index.ts",
    ]);
    await expect(workspace.read("assets/logo.png")).rejects.toThrow(
      /not available/u,
    );
    await workspace.write("notes.txt", text("note"));
    expect(workspace.paths).toContain("notes.txt");
    expect(workspace.text("notes.txt")).toBe("note");
    await expect(workspace.write("extra.txt", text("x"))).rejects.toThrow(
      /more than 4 files/u,
    );
    await expect(
      workspace.write("notes.txt", text("y".repeat(65))),
    ).rejects.toThrow(/exceeding the 64-byte limit/u);
    await workspace.delete("notes.txt");
    await expect(workspace.delete("notes.txt")).rejects.toThrow(
      /not available/u,
    );
    await expect(
      new MemoryWorkspace({ files: { "a.txt": "x" } }).write(
        "a.txt",
        text("y"),
      ),
    ).rejects.toThrow(/read-only/u);
    expect(() => new MemoryWorkspace({ files: { "../a.txt": "x" } })).toThrow(
      /safe segments/u,
    );
  });
});
