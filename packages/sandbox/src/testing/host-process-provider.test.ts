import { describe, expect, it } from "vitest";

import { SANDBOX_WORKSPACES_FILE } from "../policy.js";
import { HostProcessTestProvider } from "./host-process-provider.js";

describe("HostProcessTestProvider workspace index", () => {
  it.each([false, true])(
    "relocates only index paths (bytes: %s)",
    async (bytes) => {
      const provider = new HostProcessTestProvider();
      const handle = await provider.create({
        image: "test",
        workingDirectory: "/workspace",
        network: "none",
        limits: { timeoutMs: 1000 },
      });
      const index = {
        version: 1,
        mounts: {
          code: {
            path: "/workspace/mounts/code",
            mode: "read",
            attached: false,
          },
          notes: {
            path: "/workspace/mounts/notes",
            mode: "read_write",
            fileCount: 0,
          },
        },
        output: "/workspace/output",
      };
      const original = JSON.stringify(index);
      try {
        await provider.putFiles(handle, [
          {
            path: SANDBOX_WORKSPACES_FILE,
            content: bytes ? new TextEncoder().encode(original) : original,
            mode: 0o400,
          },
          { path: "/workspace/mounts/code/workspaces.json", content: original },
        ]);
        const actual = JSON.parse(
          new TextDecoder().decode(
            await provider.readFile(handle, SANDBOX_WORKSPACES_FILE),
          ),
        );
        expect(actual).toEqual({
          ...index,
          mounts: {
            code: {
              ...index.mounts.code,
              path: provider.translate(handle, index.mounts.code.path),
            },
            notes: {
              ...index.mounts.notes,
              path: provider.translate(handle, index.mounts.notes.path),
            },
          },
          output: provider.translate(handle, index.output),
        });
        expect(
          new TextDecoder().decode(
            await provider.readFile(
              handle,
              "/workspace/mounts/code/workspaces.json",
            ),
          ),
        ).toBe(original);
      } finally {
        await provider.terminate(handle);
      }
    },
  );
});
