export type SandboxNetworkPolicy = "none" | "restricted";

export interface SandboxResourceLimits {
  timeoutMs: number;
  memoryMb?: number;
  cpuCount?: number;
  processLimit?: number;
  maximumOutputBytes?: number;
  maximumOutputFiles?: number;
}

const positiveSafeInteger = (
  value: number,
  label: string,
  maximum: number,
): void => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${label} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
};

/** Validates provider-bound limits before untrusted code reaches a sandbox. */
export const assertSandboxResourceLimits = (
  limits: SandboxResourceLimits,
): void => {
  positiveSafeInteger(limits.timeoutMs, "Sandbox timeoutMs", 86_400_000);
  if (limits.memoryMb != null) {
    positiveSafeInteger(limits.memoryMb, "Sandbox memoryMb", 262_144);
  }
  if (
    limits.cpuCount != null &&
    (!Number.isFinite(limits.cpuCount) ||
      limits.cpuCount <= 0 ||
      limits.cpuCount > 1_024)
  ) {
    throw new Error("Sandbox cpuCount must be finite and between 0 and 1024.");
  }
  if (limits.processLimit != null) {
    positiveSafeInteger(limits.processLimit, "Sandbox processLimit", 1_048_576);
  }
  if (limits.maximumOutputBytes != null) {
    positiveSafeInteger(
      limits.maximumOutputBytes,
      "Sandbox maximumOutputBytes",
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (limits.maximumOutputFiles != null) {
    positiveSafeInteger(
      limits.maximumOutputFiles,
      "Sandbox maximumOutputFiles",
      1_000_000,
    );
  }
};

export interface SandboxSpec {
  image: string;
  workingDirectory: string;
  network: SandboxNetworkPolicy;
  limits: SandboxResourceLimits;
  metadata?: Record<string, string | number | boolean>;
}

export interface SandboxHandle {
  id: string;
  provider: string;
  createdAt: string;
  providerData?: Record<string, string | number | boolean>;
}

export interface SandboxInputFile {
  path: string;
  content: Uint8Array | string;
  mode?: number;
}

export interface SandboxCommand {
  command: string;
  args?: string[];
  cwd?: string;
  environment?: Record<string, string>;
  timeoutMs?: number;
}

export type SandboxProcessEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number; signal?: string };

export interface SandboxFileInfo {
  path: string;
  size?: number;
}

export interface SandboxProvider {
  readonly name: string;
  create(
    spec: SandboxSpec,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxHandle>;
  putFiles(
    handle: SandboxHandle,
    files: SandboxInputFile[],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  execute(
    handle: SandboxHandle,
    command: SandboxCommand,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<SandboxProcessEvent>;
  listFiles(
    handle: SandboxHandle,
    directory: string,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxFileInfo[]>;
  readFile(
    handle: SandboxHandle,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array>;
  terminate(handle: SandboxHandle): Promise<void>;
}

const SAFE_WORKSPACE_PATH = /^\/workspace(?:\/[A-Za-z0-9._-]+)*$/u;

export const assertSandboxPath = (value: string): string => {
  if (
    !SAFE_WORKSPACE_PATH.test(value) ||
    value.includes("/../") ||
    value.endsWith("/..")
  ) {
    throw new Error(
      `Sandbox path must be normalized beneath /workspace: ${value}`,
    );
  }
  return value;
};
