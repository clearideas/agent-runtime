import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  assertSandboxResourceLimits,
  assertSandboxPath,
  type SandboxCommand,
  type SandboxFileInfo,
  type SandboxHandle,
  type SandboxInputFile,
  type SandboxProcessEvent,
  type SandboxProvider,
  type SandboxSpec,
} from "./contracts.js";

export interface DockerSandboxProviderOptions {
  binary?: string;
  allowedImages: string[];
  now?: () => Date;
}

const collect = async (
  binary: string,
  args: string[],
  input?: Uint8Array | string,
  signal?: AbortSignal,
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> => {
  const child = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    signal,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const maximumCollectedBytes = 32 * 1024 * 1024;
  let collectedBytes = 0;
  let overflow = false;
  const append = (target: Buffer[], chunk: unknown): void => {
    if (overflow) return;
    const buffer = Buffer.from(chunk as Uint8Array);
    collectedBytes += buffer.byteLength;
    if (collectedBytes > maximumCollectedBytes) {
      overflow = true;
      child.kill("SIGKILL");
      return;
    }
    target.push(buffer);
  };
  child.stdout.on("data", (chunk) => append(stdout, chunk));
  child.stderr.on("data", (chunk) => append(stderr, chunk));
  if (input == null) child.stdin.end();
  else child.stdin.end(input);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (overflow)
    throw new Error(
      `Docker command output exceeded ${maximumCollectedBytes} bytes.`,
    );
  return {
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    exitCode,
  };
};

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";
  readonly #binary: string;
  readonly #allowedImages: ReadonlySet<string>;
  readonly #now: () => Date;

  constructor(options: DockerSandboxProviderOptions) {
    if (options.allowedImages.length === 0)
      throw new Error("Docker sandbox requires allowedImages.");
    this.#binary = options.binary ?? "docker";
    this.#allowedImages = new Set(options.allowedImages);
    this.#now = options.now ?? (() => new Date());
  }

  async create(
    spec: SandboxSpec,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxHandle> {
    if (!this.#allowedImages.has(spec.image))
      throw new Error(`Docker image is not allowed: ${spec.image}`);
    if (spec.network !== "none")
      throw new Error("Docker reference sandbox only permits network: none.");
    assertSandboxPath(spec.workingDirectory);
    assertSandboxResourceLimits(spec.limits);
    const name = `agent-runtime-${randomUUID()}`;
    const args = [
      "create",
      "--name",
      name,
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65532:65532",
      "--read-only",
      "--tmpfs",
      "/workspace:rw,noexec,nosuid,nodev,size=256m,uid=65532,gid=65532,mode=0700",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700",
      "--workdir",
      spec.workingDirectory,
      "--memory",
      `${spec.limits.memoryMb ?? 512}m`,
      "--cpus",
      String(spec.limits.cpuCount ?? 1),
      "--pids-limit",
      String(spec.limits.processLimit ?? 64),
      spec.image,
      "sleep",
      "infinity",
    ];
    const created = await collect(
      this.#binary,
      args,
      undefined,
      options?.signal,
    );
    if (created.exitCode !== 0)
      throw new Error(
        `docker create failed: ${created.stderr.toString("utf8").trim()}`,
      );
    const containerId = created.stdout.toString("utf8").trim();
    if (!/^[a-f0-9]{12,64}$/u.test(containerId)) {
      throw new Error("docker create returned an invalid container ID.");
    }
    const started = await collect(
      this.#binary,
      ["start", containerId],
      undefined,
      options?.signal,
    );
    if (started.exitCode !== 0) {
      await collect(this.#binary, ["rm", "-f", containerId]).catch(
        () => undefined,
      );
      throw new Error(
        `docker start failed: ${started.stderr.toString("utf8").trim()}`,
      );
    }
    return {
      id: name,
      provider: this.name,
      createdAt: this.#now().toISOString(),
      providerData: { containerId },
    };
  }

  async putFiles(
    handle: SandboxHandle,
    files: SandboxInputFile[],
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const containerId = this.#containerId(handle);
    for (const file of files) {
      const target = assertSandboxPath(file.path);
      const parent = target.slice(0, target.lastIndexOf("/")) || "/workspace";
      const mode = file.mode ?? 0o600;
      if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
        throw new Error(`Invalid sandbox file mode: ${String(file.mode)}`);
      }
      const command = `mkdir -p '${parent}' && cat > '${target}' && chmod ${mode.toString(8)} '${target}'`;
      const result = await collect(
        this.#binary,
        ["exec", "-i", containerId, "sh", "-c", command],
        file.content,
        options?.signal,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `docker file staging failed: ${result.stderr.toString("utf8").trim()}`,
        );
    }
  }

  async *execute(
    handle: SandboxHandle,
    command: SandboxCommand,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<SandboxProcessEvent> {
    const containerId = this.#containerId(handle);
    const args = ["exec", "-i"];
    if (command.cwd) args.push("--workdir", assertSandboxPath(command.cwd));
    for (const [name, value] of Object.entries(command.environment ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
        throw new Error(`Invalid environment name: ${name}`);
      args.push("--env", `${name}=${value}`);
    }
    args.push(containerId, command.command, ...(command.args ?? []));
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
        append({ type: "stderr", data: error.message });
      });
      child.once("exit", (code, signal) => {
        append({
          type: "exit",
          exitCode: code ?? 1,
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
    const normalized = assertSandboxPath(directory);
    const result = await collect(
      this.#binary,
      [
        "exec",
        this.#containerId(handle),
        "find",
        normalized,
        "-type",
        "f",
        "-print",
      ],
      undefined,
      options?.signal,
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .toString("utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((file) => ({ path: assertSandboxPath(file) }));
  }

  async readFile(
    handle: SandboxHandle,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array> {
    const result = await collect(
      this.#binary,
      ["exec", this.#containerId(handle), "cat", assertSandboxPath(path)],
      undefined,
      options?.signal,
    );
    if (result.exitCode !== 0)
      throw new Error(
        `docker read failed: ${result.stderr.toString("utf8").trim()}`,
      );
    return result.stdout;
  }

  async terminate(handle: SandboxHandle): Promise<void> {
    const result = await collect(this.#binary, [
      "rm",
      "-f",
      this.#containerId(handle),
    ]);
    if (
      result.exitCode !== 0 &&
      !result.stderr.toString("utf8").includes("No such container")
    ) {
      throw new Error(
        `docker cleanup failed: ${result.stderr.toString("utf8").trim()}`,
      );
    }
  }

  #containerId(handle: SandboxHandle): string {
    if (
      handle.provider !== this.name ||
      typeof handle.providerData?.containerId !== "string"
    ) {
      throw new Error(
        "Sandbox handle does not belong to DockerSandboxProvider.",
      );
    }
    return handle.providerData.containerId;
  }
}
