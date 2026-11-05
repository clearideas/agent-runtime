import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertSandboxPath,
  assertSandboxResourceLimits,
  type SandboxCommand,
  type SandboxFileInfo,
  type SandboxHandle,
  type SandboxInputFile,
  type SandboxProcessEvent,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SandboxSpec,
} from "./contracts.js";

export interface BubblewrapSandboxProviderOptions {
  /** bubblewrap binary. Defaults to "bwrap" on PATH. */
  binary?: string;
  /** util-linux prlimit binary used for resource limits. Defaults to "prlimit". */
  prlimitBinary?: string;
  /**
   * Host directories bound read-only into every sandbox. Defaults to the
   * system directories needed to run installed software: /usr, /bin, /sbin,
   * /lib*, and the dynamic-loader configuration under /etc.
   */
  binds?: string[];
  /** Host directory that holds each sandbox's working directory. Defaults to the OS temporary directory. */
  stateDirectory?: string;
  /** Environment variables set inside every sandbox in addition to command environment. */
  environment?: Record<string, string>;
  now?: () => Date;
}

export const DEFAULT_BUBBLEWRAP_BINDS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc/alternatives",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
];

const SANDBOX_ROOT = "/workspace";
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

interface SandboxState {
  hostRoot: string;
  hostWorkspace: string;
  spec: SandboxSpec;
  limitsEnforced: boolean;
}

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const collect = async (
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(signal ? { signal } : {}),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    exitCode,
  };
};

/**
 * A local sandbox provider built on bubblewrap (bwrap): separate user, PID,
 * IPC, UTS, cgroup, and network namespaces, read-only binds of host system
 * directories, a private /workspace backed by a host directory the provider
 * owns, and prlimit-enforced memory, CPU, process, and file-size limits.
 * Requires Linux with unprivileged user namespaces. It runs without a
 * container daemon and is the reference provider for local development and
 * continuous integration.
 */
export class BubblewrapSandboxProvider implements SandboxProvider {
  readonly name = "bubblewrap";
  readonly capabilities: SandboxProviderCapabilities = {
    readOnlyAttachments: true,
  };
  readonly #binary: string;
  readonly #prlimit: string;
  readonly #binds: readonly string[];
  readonly #stateDirectory: string;
  readonly #environment: Record<string, string>;
  readonly #now: () => Date;
  readonly #sandboxes = new Map<string, SandboxState>();
  #bindArguments: string[] | undefined;
  #prlimitAvailable: boolean | undefined;
  #probe: Promise<void> | undefined;

  constructor(options: BubblewrapSandboxProviderOptions = {}) {
    this.#binary = options.binary ?? "bwrap";
    this.#prlimit = options.prlimitBinary ?? "prlimit";
    this.#binds = options.binds ?? DEFAULT_BUBBLEWRAP_BINDS;
    this.#stateDirectory = path.resolve(options.stateDirectory ?? tmpdir());
    this.#environment = options.environment ?? {};
    this.#now = options.now ?? (() => new Date());
    for (const [name] of Object.entries(this.#environment)) {
      if (!ENVIRONMENT_NAME.test(name))
        throw new Error(`Invalid environment name: ${name}`);
    }
  }

  /** Resolve bind arguments once; symbolic links (for example /bin → usr/bin) are recreated as links. */
  async #bindArgumentList(): Promise<string[]> {
    if (this.#bindArguments) return this.#bindArguments;
    const args: string[] = [];
    for (const bind of this.#binds) {
      if (!path.isAbsolute(bind))
        throw new Error(`Bind must be absolute: ${bind}`);
      const stats = await lstat(bind).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (!stats) continue;
      if (stats.isSymbolicLink()) {
        args.push("--symlink", await readlink(bind), bind);
      } else {
        args.push("--ro-bind", bind, bind);
      }
    }
    this.#bindArguments = args;
    return args;
  }

  /** Confirm bubblewrap can create an isolated sandbox on this host. */
  async probe(options?: { signal?: AbortSignal }): Promise<void> {
    if (!this.#probe) {
      this.#probe = (async () => {
        const binds = await this.#bindArgumentList();
        const result = await collect(
          this.#binary,
          [
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--clearenv",
            ...binds,
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            SANDBOX_ROOT,
            "--",
            "/bin/true",
          ],
          options?.signal,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `bubblewrap is unavailable (exit ${result.exitCode}): ${result.stderr.trim() || "install bubblewrap and enable unprivileged user namespaces"}`,
          );
        }
        const prlimit = await collect(this.#prlimit, ["--version"]);
        this.#prlimitAvailable = prlimit.exitCode === 0;
      })();
      this.#probe.catch(() => {
        this.#probe = undefined;
      });
    }
    await this.#probe;
  }

  /** True when prlimit is available and resource limits are enforced. */
  get limitsEnforced(): boolean | undefined {
    return this.#prlimitAvailable;
  }

  async validate(
    spec: SandboxSpec,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    if (spec.network !== "none")
      throw new Error("Bubblewrap sandbox only permits network: none.");
    assertSandboxPath(spec.workingDirectory);
    assertSandboxResourceLimits(spec.limits);
    for (const attachment of spec.attachments ?? []) {
      assertSandboxPath(attachment.target);
      if (!path.isAbsolute(attachment.source))
        throw new Error(
          `Attachment source must be absolute: ${attachment.source}`,
        );
    }
    await this.probe(options);
  }

  async create(
    spec: SandboxSpec,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxHandle> {
    await this.validate(spec, options);
    await mkdir(this.#stateDirectory, { recursive: true });
    const hostRoot = await mkdtemp(
      path.join(this.#stateDirectory, "agent-runtime-bwrap-"),
    );
    const hostWorkspace = path.join(hostRoot, "workspace");
    await mkdir(hostWorkspace, { mode: 0o700 });
    const id = `bwrap-${randomUUID()}`;
    this.#sandboxes.set(id, {
      hostRoot,
      hostWorkspace,
      spec,
      limitsEnforced: this.#prlimitAvailable === true,
    });
    return {
      id,
      provider: this.name,
      createdAt: this.#now().toISOString(),
      providerData: {
        hostRoot,
        limitsEnforced: this.#prlimitAvailable === true,
        ...(spec.metadata ?? {}),
      },
    };
  }

  async putFiles(
    handle: SandboxHandle,
    files: SandboxInputFile[],
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const state = this.#state(handle);
    for (const file of files) {
      options?.signal?.throwIfAborted();
      const mode = file.mode ?? 0o600;
      if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
        throw new Error(`Invalid sandbox file mode: ${String(file.mode)}`);
      }
      const target = await this.#hostPath(state, file.path, { forWrite: true });
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      let descriptor: Awaited<ReturnType<typeof open>> | undefined;
      try {
        descriptor = await open(temporary, "wx", 0o600);
        await descriptor.writeFile(file.content);
        await descriptor.close();
        descriptor = undefined;
        await chmod(temporary, mode);
        await rename(temporary, target);
      } catch (error) {
        await descriptor?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }
  }

  async *execute(
    handle: SandboxHandle,
    command: SandboxCommand,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<SandboxProcessEvent> {
    const state = this.#state(handle);
    const binds = await this.#bindArgumentList();
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      ...binds,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      state.hostWorkspace,
      SANDBOX_ROOT,
    ];
    for (const attachment of state.spec.attachments ?? []) {
      args.push(
        "--ro-bind",
        attachment.source,
        assertSandboxPath(attachment.target),
      );
    }
    args.push(
      "--chdir",
      assertSandboxPath(command.cwd ?? state.spec.workingDirectory),
    );
    const environment: Record<string, string> = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      LANG: "C.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
      ...this.#environment,
      ...(command.environment ?? {}),
    };
    for (const [name, value] of Object.entries(environment)) {
      if (!ENVIRONMENT_NAME.test(name))
        throw new Error(`Invalid environment name: ${name}`);
      args.push("--setenv", name, value);
    }
    args.push("--");
    if (state.limitsEnforced) {
      const limits = state.spec.limits;
      const timeoutSeconds = Math.max(
        1,
        Math.ceil((command.timeoutMs ?? limits.timeoutMs) / 1_000),
      );
      args.push(
        this.#prlimit,
        `--as=${(limits.memoryMb ?? 1_024) * 1_048_576}`,
        `--cpu=${timeoutSeconds}`,
        `--nproc=${limits.processLimit ?? 128}`,
        `--fsize=${(limits.workspaceTmpfsMb ?? 1_024) * 1_048_576}`,
        "--",
      );
    }
    args.push(command.command, ...(command.args ?? []));

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = command.timeoutMs
      ? setTimeout(
          () => controller.abort(new Error("Sandbox command timed out.")),
          command.timeoutMs,
        )
      : undefined;
    try {
      const child = spawn(this.#binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
        killSignal: "SIGKILL",
      });
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
        if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") return;
        append({ type: "stderr", data: error.message });
      });
      child.once("exit", (code, signal) => {
        append({
          type: "exit",
          exitCode: code ?? (signal ? 137 : 1),
          ...(signal ? { signal } : {}),
        });
        ended = true;
        wake?.();
      });
      while (!ended || events.length > 0) {
        const event = events.shift();
        if (event) yield event;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listFiles(
    handle: SandboxHandle,
    directory: string,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxFileInfo[]> {
    const state = this.#state(handle);
    const normalized = assertSandboxPath(directory);
    const root = await this.#hostPath(state, normalized, {
      forWrite: false,
    }).catch(() => undefined);
    if (!root) return [];
    const files: SandboxFileInfo[] = [];
    const pending = [normalized];
    while (pending.length > 0) {
      options?.signal?.throwIfAborted();
      const current = pending.shift()!;
      const hostCurrent = this.#translate(state, current);
      let entries: Dirent[];
      try {
        entries = await readdir(hostCurrent, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : 1));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const sandboxPath = `${current}/${entry.name}`;
        if (
          !/^[A-Za-z0-9._-]+$/u.test(entry.name) ||
          entry.name === "." ||
          entry.name === ".."
        )
          continue;
        if (entry.isDirectory()) {
          pending.push(sandboxPath);
        } else if (entry.isFile()) {
          const stats = await lstat(path.join(hostCurrent, entry.name));
          if (stats.isFile())
            files.push({ path: sandboxPath, size: stats.size });
        }
      }
    }
    return files;
  }

  async readFile(
    handle: SandboxHandle,
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array> {
    options?.signal?.throwIfAborted();
    const state = this.#state(handle);
    const target = await this.#hostPath(state, filePath, { forWrite: false });
    const stats = await lstat(target);
    if (!stats.isFile())
      throw new Error(`Sandbox path is not a regular file: ${filePath}`);
    return readFile(target);
  }

  async terminate(handle: SandboxHandle): Promise<void> {
    const state = this.#sandboxes.get(handle.id);
    this.#sandboxes.delete(handle.id);
    const hostRoot =
      state?.hostRoot ??
      (typeof handle.providerData?.hostRoot === "string"
        ? handle.providerData.hostRoot
        : undefined);
    if (!hostRoot) return;
    if (
      hostRoot !== this.#stateDirectory &&
      hostRoot.startsWith(`${this.#stateDirectory}${path.sep}`)
    ) {
      await rm(hostRoot, { recursive: true, force: true });
    }
  }

  #state(handle: SandboxHandle): SandboxState {
    const state = this.#sandboxes.get(handle.id);
    if (handle.provider !== this.name || !state) {
      throw new Error(
        "Sandbox handle does not belong to this BubblewrapSandboxProvider.",
      );
    }
    return state;
  }

  #translate(state: SandboxState, sandboxPath: string): string {
    const normalized = assertSandboxPath(sandboxPath);
    if (normalized === SANDBOX_ROOT) return state.hostWorkspace;
    return path.join(
      state.hostWorkspace,
      ...normalized.slice(SANDBOX_ROOT.length + 1).split("/"),
    );
  }

  /**
   * Map a sandbox path to the host directory, refusing any symbolic link
   * component so software inside the sandbox cannot redirect host-side reads
   * or writes outside the sandbox's own directory.
   */
  async #hostPath(
    state: SandboxState,
    sandboxPath: string,
    options: { forWrite: boolean },
  ): Promise<string> {
    const target = this.#translate(state, sandboxPath);
    let current = state.hostWorkspace;
    const relative = path.relative(state.hostWorkspace, target);
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      const stats = await lstat(current).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (!stats) {
        if (options.forWrite) return target;
        throw new Error(`Sandbox path does not exist: ${sandboxPath}`);
      }
      if (stats.isSymbolicLink()) {
        throw new Error(`Sandbox path crosses a symbolic link: ${sandboxPath}`);
      }
    }
    return target;
  }
}
