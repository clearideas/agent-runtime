import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunSandboxOpenRequest } from "@clearideas/agent-runtime-core";
import { resolveAgentWorkspaces } from "@clearideas/agent-runtime-core";
import { LocalDirectoryWorkspace } from "@clearideas/agent-runtime-store-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SandboxHandle, SandboxInputFile } from "./contracts.js";
import { ProviderRunSandbox } from "./run-sandbox.js";
import { HostProcessTestProvider } from "./testing/host-process-provider.js";

class AttachmentCapableTestProvider extends HostProcessTestProvider {
  override readonly capabilities = { readOnlyAttachments: true };
  readonly staged: string[] = [];

  override async putFiles(
    handle: SandboxHandle,
    files: SandboxInputFile[],
  ): Promise<void> {
    this.staged.push(...files.map((file) => file.path));
    await super.putFiles(handle, files);
  }
}

describe("workspace staging defaults", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "agent-runtime-staging-"));
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".env"), "PRIVATE=hidden");
    await writeFile(path.join(root, ".git", "config"), "private git config");
    await writeFile(path.join(root, "bad name.txt"), "not addressable");
    await writeFile(path.join(root, "visible.txt"), "visible");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    "stages default stores even after narrowing to read (narrowed: %s)",
    async (narrowed) => {
      const provider = new AttachmentCapableTestProvider();
      const store = new LocalDirectoryWorkspace({
        root,
        mode: narrowed ? "read_write" : "read",
      });
      const workspaces = await resolveAgentWorkspaces(
        {
          schemaVersion: "1.0",
          steps: [],
          workspaces: [{ ref: "repo", alias: "code", mode: "read" }],
        },
        { resolveWorkspace: async () => store },
      );
      const request: RunSandboxOpenRequest = {
        runId: "r",
        attempt: 1,
        workspaces,
        emit: async (type) => ({
          id: type,
          runId: "r",
          sequence: 1,
          timestamp: "",
          type,
        }),
      };
      const sandbox = new ProviderRunSandbox({ provider, image: "test" });
      await sandbox.validate(request);
      const session = await sandbox.open(request);
      try {
        expect(provider.specs[0]?.attachments).toBeUndefined();
        expect(
          provider.staged.filter((file) =>
            file.startsWith("/workspace/mounts/code/"),
          ),
        ).toEqual(["/workspace/mounts/code/visible.txt"]);
      } finally {
        await session.close("completed");
      }
    },
  );

  it.each([false, true])(
    "honors explicit auto while filtered stores remain staged (filtered: %s)",
    async (filtered) => {
      const provider = new AttachmentCapableTestProvider();
      const store = new LocalDirectoryWorkspace({
        root,
        attach: "auto",
        ...(filtered ? { include: ["*.txt"] } : {}),
      });
      const sandbox = new ProviderRunSandbox({ provider, image: "test" });
      const session = await sandbox.open({
        runId: "r",
        attempt: 1,
        workspaces: [
          { binding: { ref: "repo" }, alias: "code", mode: "read", store },
        ],
        emit: async (type) => ({
          id: type,
          runId: "r",
          sequence: 1,
          timestamp: "",
          type,
        }),
      });
      try {
        expect(provider.specs[0]?.attachments).toEqual(
          filtered
            ? undefined
            : [{ source: root, target: "/workspace/mounts/code" }],
        );
        expect(
          provider.staged.includes("/workspace/mounts/code/visible.txt"),
        ).toBe(filtered);
      } finally {
        await session.close("completed");
      }
    },
  );

  it("fails opening and cleans up when a visible file exceeds its per-file limit", async () => {
    const provider = new AttachmentCapableTestProvider();
    const store = new LocalDirectoryWorkspace({ root, maxFileBytes: 3 });
    const sandbox = new ProviderRunSandbox({ provider, image: "test" });
    await expect(
      sandbox.open({
        runId: "r",
        attempt: 1,
        workspaces: [
          { binding: { ref: "repo" }, alias: "code", mode: "read", store },
        ],
        emit: async (type) => ({
          id: type,
          runId: "r",
          sequence: 1,
          timestamp: "",
          type,
        }),
      }),
    ).rejects.toThrow(/visible.txt.*3-byte limit/u);
    expect(provider.terminated).toHaveLength(1);
    expect(provider.roots.size).toBe(0);
  });
});
