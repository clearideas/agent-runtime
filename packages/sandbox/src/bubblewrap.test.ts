import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ArtifactRef,
  RunEvent,
} from "@clearideas/agent-runtime-contracts";
import type {
  ArtifactInput,
  ArtifactStore,
  ResolvedWorkspace,
  RunSandboxOpenRequest,
} from "@clearideas/agent-runtime-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BubblewrapSandboxProvider,
  DEFAULT_BUBBLEWRAP_BINDS,
} from "./bubblewrap.js";
import type { SandboxProcessEvent, SandboxSpec } from "./contracts.js";
import { ProviderRunSandbox } from "./run-sandbox.js";

/** Bubblewrap needs Linux with unprivileged user namespaces; skip elsewhere. */
const bubblewrapAvailable = (() => {
  if (process.platform !== "linux") return false;
  const binds = DEFAULT_BUBBLEWRAP_BINDS.flatMap((bind) =>
    spawnSync("test", ["-e", bind]).status === 0
      ? ["--ro-bind", bind, bind]
      : [],
  );
  const probe = spawnSync("bwrap", [
    "--unshare-all",
    "--die-with-parent",
    ...binds,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/workspace",
    "--",
    "/bin/true",
  ]);
  return probe.status === 0 && spawnSync("python3", ["--version"]).status === 0;
})();

const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  image: "host",
  workingDirectory: "/workspace",
  network: "none",
  limits: {
    timeoutMs: 10_000,
    memoryMb: 512,
    processLimit: 64,
    workspaceTmpfsMb: 64,
  },
  ...overrides,
});

const collect = async (
  events: AsyncIterable<SandboxProcessEvent>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  for await (const event of events) {
    if (event.type === "stdout") stdout += event.data;
    else if (event.type === "stderr") stderr += event.data;
    else exitCode = event.exitCode;
  }
  return { stdout, stderr, exitCode };
};

describe.skipIf(!bubblewrapAvailable)(
  "BubblewrapSandboxProvider",
  { timeout: 60_000 },
  () => {
    let state: string;
    let attached: string;

    beforeEach(async () => {
      state = await mkdtemp(path.join(tmpdir(), "agent-runtime-bwrap-state-"));
      attached = await mkdtemp(
        path.join(tmpdir(), "agent-runtime-bwrap-attach-"),
      );
      await writeFile(path.join(attached, "readme.txt"), "attached\n");
    });

    afterEach(async () => {
      await rm(state, { recursive: true, force: true });
      await rm(attached, { recursive: true, force: true });
    });

    it("isolates processes, filesystem, and network, and cleans up its state directory", async () => {
      const provider = new BubblewrapSandboxProvider({ stateDirectory: state });
      await provider.validate(spec());
      const handle = await provider.create(spec());
      await provider.putFiles(handle, [
        { path: "/workspace/hello.txt", content: "hi", mode: 0o400 },
      ]);
      const run = (command: string) =>
        collect(
          provider.execute(handle, {
            command: "/bin/sh",
            args: ["-c", command],
            cwd: "/workspace",
            environment: { AGENT_TEST: "1" },
            timeoutMs: 5_000,
          }),
        );
      expect(await run("cat /workspace/hello.txt")).toMatchObject({
        stdout: "hi",
        exitCode: 0,
      });
      expect((await run("echo $AGENT_TEST $HOME")).stdout.trim()).toBe(
        "1 /tmp",
      );
      expect(
        (
          await run(
            "cat /proc/1/comm 2>/dev/null | head -c 20; echo; ls / | wc -l",
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (await run("ls /workspace/../ | grep -c workspace")).stdout.trim(),
      ).toBe("1");
      expect((await run(`ls ${state}`)).exitCode).not.toBe(0);
      const network = await run(
        "python3 -c \"import socket; s=socket.socket(); s.settimeout(2); s.connect(('1.1.1.1',80))\"",
      );
      expect(network.exitCode).not.toBe(0);
      // Even when the host runs as root, the command has no capabilities, so
      // file modes bind it like any other user.
      expect(
        (await run("grep '^CapEff:' /proc/self/status")).stdout.trim(),
      ).toBe("CapEff:\t0000000000000000");
      expect((await run("echo nope > /workspace/hello.txt")).exitCode).not.toBe(
        0,
      );
      expect(
        (
          await run("echo new > /workspace/new.txt && cat /workspace/new.txt")
        ).stdout.trim(),
      ).toBe("new");
      expect(await provider.listFiles(handle, "/workspace")).toEqual([
        { path: "/workspace/hello.txt", size: 2 },
        { path: "/workspace/new.txt", size: 4 },
      ]);
      expect(
        new TextDecoder().decode(
          await provider.readFile(handle, "/workspace/new.txt"),
        ),
      ).toBe("new\n");
      await run("ln -s /etc /workspace/escape");
      await expect(
        provider.readFile(handle, "/workspace/escape/passwd"),
      ).rejects.toThrow(/symbolic link/u);
      expect(
        (await provider.listFiles(handle, "/workspace")).map(
          (file) => file.path,
        ),
      ).not.toContain("/workspace/escape/passwd");
      const timed = await collect(
        provider.execute(handle, {
          command: "/bin/sh",
          args: ["-c", "sleep 5"],
          cwd: "/workspace",
          timeoutMs: 300,
        }),
      );
      expect(timed.exitCode).not.toBe(0);
      await provider.terminate(handle);
      expect(await readdir(state)).toEqual([]);
      await expect(
        provider.readFile(handle, "/workspace/new.txt"),
      ).rejects.toThrow(/does not belong/u);
    });

    it("binds read-only attachments and enforces prlimit resource limits when available", async () => {
      const provider = new BubblewrapSandboxProvider({ stateDirectory: state });
      const handle = await provider.create(
        spec({
          attachments: [{ source: attached, target: "/workspace/mounts/docs" }],
        }),
      );
      const run = (command: string, timeoutMs = 5_000) =>
        collect(
          provider.execute(handle, {
            command: "/bin/sh",
            args: ["-c", command],
            cwd: "/workspace",
            timeoutMs,
          }),
        );
      expect((await run("cat /workspace/mounts/docs/readme.txt")).stdout).toBe(
        "attached\n",
      );
      expect(
        (await run("echo x > /workspace/mounts/docs/evil.txt")).exitCode,
      ).not.toBe(0);
      expect(await readdir(attached)).toEqual(["readme.txt"]);
      if (provider.limitsEnforced) {
        const memory = await run(
          "python3 -c \"b = bytearray(800 * 1024 * 1024); print('allocated')\"",
        );
        expect(memory.stdout).not.toContain("allocated");
      }
      await provider.terminate(handle);
    });

    it.each([false, true])(
      "exposes raw directory entries only after explicit attachment opt-in (auto: %s)",
      async (auto) => {
        await mkdir(path.join(attached, ".git"));
        await writeFile(path.join(attached, ".env"), "PRIVATE=hidden");
        await writeFile(
          path.join(attached, ".git", "config"),
          "private config",
        );
        await writeFile(path.join(attached, "bad name.txt"), "unaddressable");
        const { LocalDirectoryWorkspace } =
          await import("@clearideas/agent-runtime-store-local");
        const sandbox = new ProviderRunSandbox({
          provider: new BubblewrapSandboxProvider({ stateDirectory: state }),
          image: "host",
        });
        const request: RunSandboxOpenRequest = {
          runId: "visibility",
          attempt: 1,
          workspaces: [
            {
              binding: { ref: "repo" },
              alias: "code",
              mode: "read",
              store: new LocalDirectoryWorkspace({
                root: attached,
                ...(auto ? { attach: "auto" as const } : {}),
              }),
            },
          ],
          emit: async (type) => ({
            id: type,
            runId: "visibility",
            sequence: 1,
            timestamp: "",
            type,
          }),
        };
        await sandbox.validate(request);
        const session = await sandbox.open(request);
        try {
          const result = await session.execute({
            stepId: "probe",
            kind: "code",
            name: "probe",
            arguments: {
              language: "python",
              variables: {},
              code: [
                "import json, os",
                "root = json.load(open(os.environ['AGENT_WORKSPACES_FILE']))['mounts']['code']['path']",
                "print(json.dumps({'visible': open(root + '/readme.txt').read(), 'other': [os.path.exists(root + '/' + name) for name in ['.env', '.git/config', 'bad name.txt']]}))",
              ].join("\n"),
            },
          });
          expect(JSON.parse(String(result.output))).toEqual({
            visible: "attached\n",
            other: [auto, auto, auto],
          });
        } finally {
          await session.close("completed");
        }
      },
    );

    it("normalizes Windows tool paths and syncs canonical report paths to the host", async () => {
      const { LocalDirectoryWorkspace } =
        await import("@clearideas/agent-runtime-store-local");
      const sandbox = new ProviderRunSandbox({
        provider: new BubblewrapSandboxProvider({ stateDirectory: state }),
        image: "host",
      });
      const request: RunSandboxOpenRequest = {
        runId: "paths",
        attempt: 1,
        workspaces: [
          {
            binding: { ref: "reports" },
            alias: "notes",
            mode: "read_write",
            store: new LocalDirectoryWorkspace({
              root: attached,
              mode: "read_write",
            }),
          },
        ],
        emit: async (type) => ({
          id: type,
          runId: "paths",
          sequence: 1,
          timestamp: "",
          type,
        }),
      };
      await sandbox.validate(request);
      const session = await sandbox.open(request);
      try {
        const list = await session.execute({
          stepId: "list",
          kind: "builtin",
          name: "list_files",
          alias: "notes",
          arguments: { path: "." },
        });
        expect(list.output).toMatchObject({
          files: [expect.objectContaining({ path: "readme.txt" })],
        });
        await session.execute({
          stepId: "write",
          kind: "builtin",
          name: "write_file",
          alias: "notes",
          arguments: {
            path: ".\\reports\\Q3-draft.md",
            content: "published\n",
          },
        });
        expect(
          await readFile(path.join(attached, "reports", "Q3-draft.md"), "utf8"),
        ).toBe("published\n");
        const read = await session.execute({
          stepId: "read",
          kind: "builtin",
          name: "read_file",
          alias: "notes",
          arguments: { path: "/reports//./Q3-draft.md/" },
        });
        expect(read.output).toMatchObject({ content: "published" });
        await expect(
          session.execute({
            stepId: "unsafe",
            kind: "builtin",
            name: "read_file",
            alias: "notes",
            arguments: { path: ".\\..\\outside.md" },
          }),
        ).rejects.toMatchObject({ code: "workspace_path_invalid" });
      } finally {
        await session.close("completed");
      }
    });

    it("runs the complete run sandbox with the bundled helper", async () => {
      const provider = new BubblewrapSandboxProvider({ stateDirectory: state });
      const repo = await mkdtemp(
        path.join(tmpdir(), "agent-runtime-bwrap-repo-"),
      );
      const notes = await mkdtemp(
        path.join(tmpdir(), "agent-runtime-bwrap-notes-"),
      );
      try {
        await writeFile(path.join(repo, "README.md"), "# Repo\nhello world\n");
        const { LocalDirectoryWorkspace } =
          await import("@clearideas/agent-runtime-store-local");
        const workspaces: ResolvedWorkspace[] = [
          {
            binding: { ref: "repo", alias: "code", mode: "read" },
            alias: "code",
            mode: "read",
            store: new LocalDirectoryWorkspace({ root: repo, attach: "auto" }),
          },
          {
            binding: { ref: "notes" },
            alias: "notes",
            mode: "read_write",
            store: new LocalDirectoryWorkspace({
              root: notes,
              mode: "read_write",
            }),
          },
        ];
        const artifacts: ArtifactInput[] = [];
        const artifactStore: ArtifactStore = {
          put: async (input) => {
            artifacts.push(input);
            return {
              id: `a${artifacts.length}`,
              name: input.name,
              mediaType: input.mediaType,
            } as ArtifactRef;
          },
          get: async () => {
            throw new Error("unused");
          },
        };
        const runSandbox = new ProviderRunSandbox({
          provider,
          image: "host",
          commands: {
            wc: { argv: ["wc", "-l", "{file}"], inputs: ["**/*.md"] },
          },
          shell: { enabled: true },
        });
        const events: RunEvent[] = [];
        const request: RunSandboxOpenRequest = {
          runId: "run-bwrap",
          attempt: 1,
          workspaces,
          artifacts: artifactStore,
          emit: async (type, data) => {
            const event = {
              id: String(events.length),
              runId: "run-bwrap",
              sequence: events.length + 1,
              timestamp: "",
              type,
              ...(data ? { data } : {}),
            } as RunEvent;
            events.push(event);
            return event;
          },
        };
        await runSandbox.validate(request);
        const session = await runSandbox.open(request);
        expect(events[0]?.data).toMatchObject({
          provider: "bubblewrap",
          mounts: [
            { alias: "code", attached: true },
            { alias: "notes", attached: false, fileCount: 0 },
          ],
        });
        const search = await session.execute({
          stepId: "s",
          kind: "builtin",
          name: "search_files",
          alias: "code",
          arguments: { query: "hello" },
        });
        expect(search.output).toEqual({
          matches: [{ path: "README.md", line: 2, text: "hello world" }],
          truncated: false,
        });
        const wc = await session.execute({
          stepId: "s",
          kind: "command",
          name: "wc",
          alias: "code",
          arguments: { file: "README.md" },
        });
        expect(wc.output).toMatchObject({
          exitCode: 0,
          stdout: "2 /workspace/mounts/code/README.md\n",
        });
        const shell = await session.execute({
          stepId: "s",
          kind: "shell",
          name: "shell",
          alias: "notes",
          arguments: {
            command:
              "echo '# Notes' > review.md; echo nope > /workspace/mounts/code/hack.md; cp /workspace/mounts/code/README.md $AGENT_OUTPUT_DIRECTORY/copy.md; echo ok",
          },
        });
        expect(shell.output).toMatchObject({
          exitCode: 0,
          stdout: "ok\n",
          artifacts: ["a1"],
        });
        expect(shell.record.filesChanged).toEqual([
          expect.objectContaining({
            alias: "notes",
            path: "review.md",
            action: "created",
          }),
        ]);
        expect(await readFile(path.join(notes, "review.md"), "utf8")).toBe(
          "# Notes\n",
        );
        expect(await readdir(repo)).toEqual(["README.md"]);
        const code = await session.execute({
          stepId: "compute",
          kind: "code",
          name: "compute",
          arguments: {
            language: "python",
            code: "import json,os; print(open(json.load(open(os.environ['AGENT_WORKSPACES_FILE']))['mounts']['code']['path'] + '/README.md').read().splitlines()[0])",
            variables: {},
          },
        });
        expect(code.output).toBe("# Repo\n");
        await session.close("completed");
        expect(events.at(-1)?.type).toBe("sandbox.closed");
        expect(await readdir(state)).toEqual([]);
      } finally {
        await rm(repo, { recursive: true, force: true });
        await rm(notes, { recursive: true, force: true });
      }
    });
  },
);

describe("BubblewrapSandboxProvider validation", () => {
  it("rejects network access, bad attachments, and foreign handles without running bwrap", async () => {
    const provider = new BubblewrapSandboxProvider({
      binary: "/nonexistent/bwrap",
    });
    await expect(
      provider.validate(spec({ network: "restricted" })),
    ).rejects.toThrow(/network/u);
    await expect(
      provider.validate(
        spec({ attachments: [{ source: "relative", target: "/workspace/x" }] }),
      ),
    ).rejects.toThrow(/absolute/u);
    await expect(provider.validate(spec())).rejects.toThrow(
      /bubblewrap is unavailable/u,
    );
    await expect(
      provider.putFiles({ id: "other", provider: "docker", createdAt: "" }, [
        { path: "/workspace/x", content: "" },
      ]),
    ).rejects.toThrow(/does not belong/u);
    expect(
      () => new BubblewrapSandboxProvider({ environment: { "bad name": "x" } }),
    ).toThrow(/Invalid environment name/u);
  });
});
