import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertSandboxPath,
  type SandboxCommand,
  type SandboxFileInfo,
  type SandboxHandle,
  type SandboxInputFile,
  type SandboxProcessEvent,
  type SandboxProvider,
  type SandboxSpec,
} from "../contracts.js";
import { SANDBOX_WORKSPACES_FILE } from "../policy.js";

/**
 * TEST-ONLY provider that runs commands as ordinary host processes inside a
 * temporary directory, rewriting `/workspace` paths in arguments and
 * environment and the runtime-owned workspace index to that directory.
 * It provides no isolation whatsoever and
 * exists so the run sandbox can be exercised end to end (including the real
 * helper script) on hosts without bubblewrap or Docker. It is deliberately not
 * exported from the package entry point.
 */
export class HostProcessTestProvider implements SandboxProvider {
  readonly name = "host-process-test";
  readonly capabilities = { readOnlyAttachments: false };
  readonly roots = new Map<string, string>();
  readonly commands: SandboxCommand[] = [];
  readonly specs: SandboxSpec[] = [];
  terminated: string[] = [];

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.specs.push(spec);
    const root = await mkdtemp(path.join(tmpdir(), "agent-runtime-hostproc-"));
    const id = `host-${randomUUID()}`;
    this.roots.set(id, root);
    return {
      id,
      provider: this.name,
      createdAt: new Date().toISOString(),
      providerData: { root },
    };
  }

  translate(handle: SandboxHandle, sandboxPath: string): string {
    const root = this.roots.get(handle.id);
    if (!root) throw new Error("Unknown sandbox handle.");
    const normalized = assertSandboxPath(sandboxPath);
    return path.join(
      root,
      ...normalized.slice("/workspace".length).split("/").filter(Boolean),
    );
  }

  async putFiles(
    handle: SandboxHandle,
    files: SandboxInputFile[],
  ): Promise<void> {
    for (const file of files) {
      const target = this.translate(handle, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const existing = await lstat(target).catch(() => undefined);
      if (existing) await chmod(target, 0o600);
      let content = file.content;
      // This runtime-owned index must describe the same host paths as argv
      // and environment. Never rewrite workspace files or arbitrary JSON.
      if (file.path === SANDBOX_WORKSPACES_FILE) {
        const index = JSON.parse(
          typeof content === "string"
            ? content
            : new TextDecoder().decode(content),
        ) as { mounts: Record<string, { path: string }>; output: string };
        for (const mount of Object.values(index.mounts)) {
          mount.path = this.translate(handle, mount.path);
        }
        index.output = this.translate(handle, index.output);
        content = JSON.stringify(index);
      }
      await writeFile(target, content);
      await chmod(target, file.mode ?? 0o600);
    }
  }

  async *execute(
    handle: SandboxHandle,
    command: SandboxCommand,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<SandboxProcessEvent> {
    this.commands.push(command);
    const root = this.roots.get(handle.id)!;
    const rewrite = (value: string): string =>
      value.replace(/\/workspace(?=\/|$)/gu, root);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = command.timeoutMs
      ? setTimeout(
          () => controller.abort(new Error("timed out")),
          command.timeoutMs,
        )
      : undefined;
    try {
      const child = spawn(
        rewrite(command.command),
        (command.args ?? []).map(rewrite),
        {
          cwd: rewrite(command.cwd ?? "/workspace"),
          env: {
            PATH: process.env.PATH ?? "",
            ...Object.fromEntries(
              Object.entries(command.environment ?? {}).map(([key, value]) => [
                key,
                rewrite(value),
              ]),
            ),
          },
          stdio: ["ignore", "pipe", "pipe"],
          signal: controller.signal,
          killSignal: "SIGKILL",
        },
      );
      const events: SandboxProcessEvent[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const append = (event: SandboxProcessEvent): void => {
        events.push(event);
        wake?.();
        wake = undefined;
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (data) => append({ type: "stdout", data }));
      child.stderr.on("data", (data) => append({ type: "stderr", data }));
      child.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ABORT_ERR")
          append({ type: "stderr", data: error.message });
      });
      child.once("exit", (code, signal) => {
        append({
          type: "exit",
          exitCode: code ?? 137,
          ...(signal ? { signal } : {}),
        });
        ended = true;
        wake?.();
      });
      while (!ended || events.length > 0) {
        const event = events.shift();
        if (event) yield event;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listFiles(
    handle: SandboxHandle,
    directory: string,
  ): Promise<SandboxFileInfo[]> {
    const files: SandboxFileInfo[] = [];
    const pending = [assertSandboxPath(directory)];
    while (pending.length > 0) {
      const current = pending.shift()!;
      let entries: Dirent[];
      try {
        entries = await readdir(this.translate(handle, current), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.isSymbolicLink()) continue;
        const sandboxPath = `${current}/${entry.name}`;
        if (entry.isDirectory()) pending.push(sandboxPath);
        else if (entry.isFile()) {
          const stats = await lstat(this.translate(handle, sandboxPath));
          files.push({ path: sandboxPath, size: stats.size });
        }
      }
    }
    return files;
  }

  async readFile(handle: SandboxHandle, filePath: string): Promise<Uint8Array> {
    return readFile(this.translate(handle, filePath));
  }

  async terminate(handle: SandboxHandle): Promise<void> {
    this.terminated.push(handle.id);
    const root = this.roots.get(handle.id);
    this.roots.delete(handle.id);
    if (root) await rm(root, { recursive: true, force: true });
  }
}
