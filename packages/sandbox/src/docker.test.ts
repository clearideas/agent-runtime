import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DockerSandboxProvider } from "./docker.js";
import type { SandboxSpec } from "./contracts.js";

const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  image: "python:3.12-slim",
  workingDirectory: "/workspace",
  network: "none",
  limits: {
    timeoutMs: 60_000,
    memoryMb: 1024,
    cpuCount: 2,
    processLimit: 128,
    workspaceTmpfsMb: 512,
  },
  ...overrides,
});

describe("DockerSandboxProvider", () => {
  let directory: string;
  let binary: string;
  let log: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(tmpdir(), "agent-runtime-docker-stub-"),
    );
    binary = path.join(directory, "docker");
    log = path.join(directory, "calls.log");
    await writeFile(
      binary,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$1" in\n  create) echo 0123456789abcdef ;;\n  exec) cat >/dev/null; exit 0 ;;\nesac\nexit 0\n`,
    );
    await chmod(binary, 0o755);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("validates images, attachments, and labels without invoking docker", async () => {
    const provider = new DockerSandboxProvider({
      binary,
      allowedImages: ["python:3.12-slim"],
    });
    expect(provider.capabilities).toEqual({ readOnlyAttachments: true });
    await expect(
      provider.validate(spec({ image: "evil:latest" })),
    ).rejects.toThrow(/not allowed/u);
    await expect(
      provider.validate(spec({ network: "restricted" })),
    ).rejects.toThrow(/network/u);
    await expect(
      provider.validate(
        spec({
          attachments: [
            { source: "relative/dir", target: "/workspace/mounts/x" },
          ],
        }),
      ),
    ).rejects.toThrow(/absolute path/u);
    await expect(
      provider.validate(
        spec({
          attachments: [{ source: "/srv/a:b", target: "/workspace/mounts/x" }],
        }),
      ),
    ).rejects.toThrow(/colons/u);
    await expect(
      provider.validate(
        spec({ attachments: [{ source: "/srv/a", target: "/etc" }] }),
      ),
    ).rejects.toThrow(/beneath \/workspace/u);
    await expect(
      provider.validate(spec({ metadata: { "bad key": "x" } })),
    ).rejects.toThrow(/label/u);
    await expect(
      provider.validate(spec({ metadata: { "agent-runtime.run": "run;rm" } })),
    ).rejects.toThrow(/label/u);
    await expect(readFile(log, "utf8")).rejects.toThrow();
  });

  // The stub binary is a POSIX shell script; on Windows the provider would spawn docker.exe.
  it.skipIf(process.platform === "win32")(
    "creates containers with attachments, tmpfs sizing, and labels",
    async () => {
      const provider = new DockerSandboxProvider({
        binary,
        allowedImages: ["python:3.12-slim"],
      });
      const handle = await provider.create(
        spec({
          attachments: [
            { source: "/srv/docs", target: "/workspace/mounts/docs" },
          ],
          metadata: { "agent-runtime.run": "run_1" },
        }),
      );
      expect(handle.providerData?.containerId).toBe("0123456789abcdef");
      const calls = (await readFile(log, "utf8")).trim().split("\n");
      expect(calls[0]).toContain(
        "--tmpfs /workspace:rw,noexec,nosuid,nodev,size=512m",
      );
      expect(calls[0]).toContain(
        "--volume /srv/docs:/workspace/mounts/docs:ro",
      );
      expect(calls[0]).toContain("--label agent-runtime.run=run_1");
      expect(calls[0]).toContain("--memory 1024m --cpus 2 --pids-limit 128");
      expect(calls[0]).toContain("--network none");
      expect(calls[1]).toBe("start 0123456789abcdef");
      await provider.terminate(handle);
      expect((await readFile(log, "utf8")).trim().split("\n").at(-1)).toBe(
        "rm -f 0123456789abcdef",
      );
    },
  );
});
