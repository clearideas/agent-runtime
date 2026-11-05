export type SandboxNetworkPolicy = "none" | "restricted";

export interface SandboxResourceLimits {
  timeoutMs: number;
  memoryMb?: number;
  cpuCount?: number;
  processLimit?: number;
  maximumOutputBytes?: number;
  maximumOutputFiles?: number;
  /** Size of the /workspace filesystem for providers that allocate one. */
  workspaceTmpfsMb?: number;
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
  if (limits.workspaceTmpfsMb != null) {
    positiveSafeInteger(
      limits.workspaceTmpfsMb,
      "Sandbox workspaceTmpfsMb",
      1_048_576,
    );
  }
};

/** A host directory bound read-only into the sandbox at creation. */
export interface SandboxAttachment {
  /** Absolute host directory. */
  source: string;
  /** Normalized target beneath /workspace. */
  target: string;
}

export interface SandboxSpec {
  image: string;
  workingDirectory: string;
  network: SandboxNetworkPolicy;
  limits: SandboxResourceLimits;
  /** Honored only by providers whose capabilities declare readOnlyAttachments. */
  attachments?: SandboxAttachment[];
  /** Provider-visible labels, e.g. the owning run id for host cleanup. */
  metadata?: Record<string, string | number | boolean>;
}

export interface SandboxProviderCapabilities {
  /** The provider can bind host directories read-only from SandboxSpec.attachments. */
  readOnlyAttachments?: boolean;
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
  readonly capabilities?: SandboxProviderCapabilities;
  /** Check that a specification could be created without creating it. */
  validate?(
    spec: SandboxSpec,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
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
