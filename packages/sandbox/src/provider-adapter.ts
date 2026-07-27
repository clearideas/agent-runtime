import { createHash } from "node:crypto";
import path from "node:path";

import type { ArtifactRef } from "@clearideas/agent-runtime-contracts";
import type {
  ArtifactStore,
  SandboxAdapter,
  SandboxRequest,
  SandboxResult,
} from "@clearideas/agent-runtime-core";

import {
  assertSandboxResourceLimits,
  assertSandboxPath,
  type SandboxCommand,
  type SandboxProvider,
  type SandboxSpec,
} from "./contracts.js";

export interface SandboxRuntimeProfile {
  language: string;
  image: string;
  extension: string;
  command: string;
  args(sourcePath: string): string[];
}

export interface ProviderSandboxAdapterOptions {
  provider: SandboxProvider;
  artifacts?: ArtifactStore;
  profiles?: SandboxRuntimeProfile[];
  allowedEnvironment?: string[];
  maximumStdoutBytes?: number;
  maximumStderrBytes?: number;
  maximumOutputBytes?: number;
  maximumOutputFiles?: number;
  memoryMb?: number;
  cpuCount?: number;
  processLimit?: number;
}

const defaultProfiles: SandboxRuntimeProfile[] = [
  {
    language: "python",
    image: "python:3.12-slim",
    extension: "py",
    command: "python",
    args: (sourcePath) => [sourcePath],
  },
];

const appendBounded = (
  current: string,
  chunk: string,
  maximumBytes: number,
): string => {
  const combined = `${current}${chunk}`;
  if (Buffer.byteLength(combined) > maximumBytes) {
    throw new Error(`Sandbox output exceeded ${maximumBytes} bytes.`);
  }
  return combined;
};

const mediaType = (filename: string): string => {
  const extension = path.extname(filename).toLowerCase();
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".csv": "text/csv",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }[extension] ?? "application/octet-stream"
  );
};

export class ProviderSandboxAdapter implements SandboxAdapter {
  readonly #options: ProviderSandboxAdapterOptions;
  readonly #profiles: Map<string, SandboxRuntimeProfile>;

  constructor(options: ProviderSandboxAdapterOptions) {
    this.#options = options;
    this.#profiles = new Map(
      (options.profiles ?? defaultProfiles).map((profile) => [
        profile.language,
        profile,
      ]),
    );
  }

  async execute(
    request: SandboxRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxResult> {
    const profile = this.#profiles.get(request.language);
    if (!profile)
      throw new Error(`No sandbox runtime profile for ${request.language}.`);
    const maximumOutputBytes =
      this.#options.maximumOutputBytes ?? 25 * 1024 * 1024;
    const maximumOutputFiles = this.#options.maximumOutputFiles ?? 20;
    const timeoutMs = request.timeoutMs ?? 60_000;
    const spec: SandboxSpec = {
      image: profile.image,
      workingDirectory: "/workspace",
      network: "none",
      limits: {
        timeoutMs,
        memoryMb: this.#options.memoryMb ?? 512,
        cpuCount: this.#options.cpuCount ?? 1,
        processLimit: this.#options.processLimit ?? 64,
        maximumOutputBytes,
        maximumOutputFiles,
      },
    };
    assertSandboxResourceLimits(spec.limits);
    const handle = await this.#options.provider.create(spec, options);
    try {
      const sourcePath = `/workspace/main.${profile.extension}`;
      await this.#options.provider.putFiles(
        handle,
        [
          { path: sourcePath, content: request.code, mode: 0o600 },
          {
            path: "/workspace/variables.json",
            content: JSON.stringify(request.variables),
            mode: 0o600,
          },
        ],
        options,
      );
      const allowed = new Set(this.#options.allowedEnvironment ?? []);
      const environment = Object.fromEntries(
        Object.entries(request.environment ?? {}).filter(([name]) =>
          allowed.has(name),
        ),
      );
      environment.AGENT_VARIABLES_FILE = "/workspace/variables.json";
      environment.AGENT_OUTPUT_DIRECTORY = "/workspace/output";
      const command: SandboxCommand = {
        command: profile.command,
        args: profile.args(sourcePath),
        cwd: "/workspace",
        environment,
        timeoutMs,
      };
      let stdout = "";
      let stderr = "";
      let exitCode: number | undefined;
      for await (const event of this.#options.provider.execute(
        handle,
        command,
        options,
      )) {
        if (event.type === "stdout") {
          stdout = appendBounded(
            stdout,
            event.data,
            this.#options.maximumStdoutBytes ?? 1_048_576,
          );
        } else if (event.type === "stderr") {
          stderr = appendBounded(
            stderr,
            event.data,
            this.#options.maximumStderrBytes ?? 1_048_576,
          );
        } else {
          exitCode = event.exitCode;
        }
      }
      if (exitCode == null)
        throw new Error("Sandbox process ended without an exit event.");
      const files = await this.#options.provider.listFiles(
        handle,
        "/workspace/output",
        options,
      );
      if (files.length > maximumOutputFiles) {
        throw new Error(
          `Sandbox produced ${files.length} files, exceeding ${maximumOutputFiles}.`,
        );
      }
      const artifacts: ArtifactRef[] = [];
      let aggregateBytes = 0;
      for (const file of files) {
        const outputPath = assertSandboxPath(file.path);
        if (!outputPath.startsWith("/workspace/output/")) {
          throw new Error(
            `Sandbox output escaped /workspace/output: ${outputPath}`,
          );
        }
        const content = await this.#options.provider.readFile(
          handle,
          file.path,
          options,
        );
        aggregateBytes += content.byteLength;
        if (aggregateBytes > maximumOutputBytes) {
          throw new Error(
            `Sandbox artifacts exceeded ${maximumOutputBytes} bytes.`,
          );
        }
        if (this.#options.artifacts) {
          const filename = path.posix.basename(file.path);
          artifacts.push(
            await this.#options.artifacts.put({
              name: filename,
              mediaType: mediaType(filename),
              data: content,
              metadata: {
                sandboxProvider: this.#options.provider.name,
                sha256: createHash("sha256").update(content).digest("hex"),
              },
            }),
          );
        }
      }
      return {
        exitCode,
        stdout,
        stderr,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    } finally {
      await this.#options.provider.terminate(handle);
    }
  }
}
