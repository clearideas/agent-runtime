import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ArtifactRef,
  JsonObject,
  JsonValue,
  SandboxCommandRecord,
  ToolCall,
} from "@clearideas/agent-runtime-contracts";
import type {
  AgentTool,
  ArtifactStore,
  ResolvedWorkspace,
  RunSandboxCommandRequest,
  RunSandboxCommandResult,
  RunSandboxOpenRequest,
  RunSandboxProvider,
  RunSandboxSession,
  SandboxBudgetState,
} from "@clearideas/agent-runtime-core";
import { isSafeWorkspacePath } from "@clearideas/agent-runtime-core";

import {
  assertSandboxPath,
  assertSandboxResourceLimits,
  type SandboxAttachment,
  type SandboxCommand,
  type SandboxHandle,
  type SandboxInputFile,
  type SandboxProvider,
  type SandboxSpec,
} from "./contracts.js";
import {
  DEFAULT_HELPER_COMMAND,
  SANDBOX_HELPER_PATH,
  SANDBOX_MOUNT_DIRECTORY,
  SANDBOX_OUTPUT_DIRECTORY,
  SANDBOX_WORKSPACES_FILE,
  SandboxPolicyError,
  admitCommand,
  describeWorkspaceTools,
  resolveRunSandboxPolicy,
  type AdmittedCommand,
  type RunSandboxCommandEntry,
  type RunSandboxLimitOverrides,
  type RunSandboxPolicy,
  type RunSandboxShellPolicy,
} from "./policy.js";
import type { SandboxRuntimeProfile } from "./provider-adapter.js";

const HELPER_PROTOCOL_VERSION = 1;
const STAGING_BATCH_BYTES = 4 * 1024 * 1024;
const MAXIMUM_HELPER_OUTPUT_BYTES = 1_048_576;
const CLOSE_SYNC_TIMEOUT_MS = 30_000;
const OUTPUT_PLACEHOLDER = ".agent-runtime-output";

export interface RunSandboxHelperOptions {
  /** Argv used to invoke the helper inside the sandbox. */
  command?: string[];
  /** Host path of a replacement helper; defaults to the bundled script. */
  source?: string;
}

export interface RunSandboxHostHooks {
  authorizeSandbox?(input: {
    runId: string;
    attempt: number;
    image: string;
    /** Attached (bound read-only) mounts are not enumerated and omit fileCount. */
    mounts: Array<{
      alias: string;
      mode: string;
      fileCount?: number;
      attached: boolean;
    }>;
  }): void | Promise<void>;
  authorizeCommand?(
    input: {
      record: Pick<
        SandboxCommandRecord,
        "kind" | "name" | "policyEntry" | "argv" | "cwd" | "alias" | "workspace"
      >;
      toolCall?: ToolCall;
    },
    context: { runId: string; stepId: string; attempt: number },
  ): void | Promise<void>;
}

export interface ProviderRunSandboxOptions extends RunSandboxHostHooks {
  provider: SandboxProvider;
  /** Image (or provider-specific environment name) for the run sandbox. */
  image: string;
  helper?: RunSandboxHelperOptions;
  commands?: Record<string, RunSandboxCommandEntry> | undefined;
  shell?: Partial<RunSandboxShellPolicy> | undefined;
  limits?: RunSandboxLimitOverrides | undefined;
  /** Runtime profiles for code steps executed in the run sandbox. */
  profiles?: SandboxRuntimeProfile[];
  /** Environment variable names a code step may forward. */
  allowedEnvironment?: string[];
  /** Disable provider-native read-only attachments. */
  attach?: "auto" | "never";
  now?: () => Date;
}

const defaultProfiles: SandboxRuntimeProfile[] = [
  {
    language: "python",
    image: "python:3.12-slim",
    extension: "py",
    command: "python3",
    args: (sourcePath) => [sourcePath],
  },
];

export const bundledHelperPath = (): string =>
  fileURLToPath(new URL("../assets/agent-fs.py", import.meta.url));

interface MountState {
  workspace: ResolvedWorkspace;
  directory: string;
  attached: boolean;
  fileCount: number;
  bytes: number;
  /** path → { size, sha256 } for read-write mounts. */
  baseline: Map<string, { size: number; sha256?: string }>;
}

const sha256 = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const appendBounded = (
  chunks: string[],
  state: { bytes: number; truncated: boolean },
  chunk: string,
  maximum: number,
): void => {
  const bytes = Buffer.byteLength(chunk);
  if (state.truncated) return;
  if (state.bytes + bytes > maximum) {
    const remaining = Math.max(0, maximum - state.bytes);
    chunks.push(Buffer.from(chunk).subarray(0, remaining).toString("utf8"));
    state.bytes = maximum;
    state.truncated = true;
    return;
  }
  chunks.push(chunk);
  state.bytes += bytes;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  value != null && typeof value === "object" && !Array.isArray(value);

class RunSandboxExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunSandboxExecutionError";
    this.code = code;
  }
}

/**
 * Opens one provider-backed sandbox per run attempt, stages bound
 * workspaces, executes every workspace command under the host policy, syncs
 * read-write mounts back to their stores after each command, and reports
 * everything through run events and command records.
 */
export class ProviderRunSandbox implements RunSandboxProvider {
  readonly #options: ProviderRunSandboxOptions;
  readonly #policy: RunSandboxPolicy;
  readonly #helperCommand: readonly string[];
  readonly #helperSource: string;
  readonly #profiles: Map<string, SandboxRuntimeProfile>;
  readonly #now: () => Date;

  constructor(options: ProviderRunSandboxOptions) {
    if (!options.image.trim())
      throw new Error("Run sandbox requires an image.");
    this.#options = options;
    this.#policy = resolveRunSandboxPolicy({
      ...(options.commands ? { commands: options.commands } : {}),
      ...(options.shell ? { shell: options.shell } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
    });
    this.#helperCommand = options.helper?.command ?? DEFAULT_HELPER_COMMAND;
    if (this.#helperCommand.length === 0)
      throw new Error("Run sandbox helper command cannot be empty.");
    this.#helperSource = options.helper?.source ?? bundledHelperPath();
    this.#profiles = new Map(
      (options.profiles ?? defaultProfiles).map((profile) => [
        profile.language,
        profile,
      ]),
    );
    this.#now = options.now ?? (() => new Date());
  }

  get policy(): RunSandboxPolicy {
    return this.#policy;
  }

  async tools(workspace: ResolvedWorkspace): Promise<AgentTool[]> {
    return describeWorkspaceTools(workspace, this.#policy);
  }

  async validate(
    request: Omit<RunSandboxOpenRequest, "emit" | "artifacts">,
  ): Promise<void> {
    await readFile(this.#helperSource).catch((error: unknown) => {
      throw new Error(
        `Run sandbox helper is not readable at ${this.#helperSource}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const spec = this.#spec(request.runId, []);
    assertSandboxResourceLimits(spec.limits);
    await this.#options.provider.validate?.(
      spec,
      request.signal ? { signal: request.signal } : undefined,
    );
    let total = 0;
    for (const workspace of request.workspaces) {
      if (this.#canAttach(workspace)) continue;
      const entries = await workspace.store.entries(
        request.signal ? { signal: request.signal } : undefined,
      );
      const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      this.#assertStagingLimits(workspace, entries.length, bytes);
      total += bytes;
    }
    if (total > this.#policy.limits.maxTotalStagedBytes) {
      throw new Error(
        `Bound workspaces total ${total} bytes, exceeding the ${this.#policy.limits.maxTotalStagedBytes}-byte sandbox staging limit.`,
      );
    }
  }

  async open(request: RunSandboxOpenRequest): Promise<RunSandboxSession> {
    const mounts: MountState[] = [];
    const attachments: SandboxAttachment[] = [];
    const aliases = new Set<string>();
    for (const workspace of request.workspaces) {
      if (aliases.has(workspace.alias))
        throw new Error(`Duplicate workspace alias: ${workspace.alias}`);
      aliases.add(workspace.alias);
      const directory = assertSandboxPath(
        `${SANDBOX_MOUNT_DIRECTORY}/${workspace.alias}`,
      );
      const attached = this.#canAttach(workspace);
      if (attached) {
        attachments.push({
          source: workspace.store.attachable!.root,
          target: directory,
        });
      }
      mounts.push({
        workspace,
        directory,
        attached,
        fileCount: 0,
        bytes: 0,
        baseline: new Map(),
      });
    }
    const spec = this.#spec(request.runId, attachments);
    const handle = await this.#options.provider.create(
      spec,
      request.signal ? { signal: request.signal } : undefined,
    );
    const session = new ProviderRunSandboxSession({
      handle,
      provider: this.#options.provider,
      policy: this.#policy,
      helperCommand: this.#helperCommand,
      profiles: this.#profiles,
      allowedEnvironment: new Set(this.#options.allowedEnvironment ?? []),
      hooks: this.#options,
      request,
      mounts,
      image: spec.image,
      now: this.#now,
    });
    try {
      await session.stage(await readFile(this.#helperSource));
      await this.#options.authorizeSandbox?.({
        runId: request.runId,
        attempt: request.attempt,
        image: spec.image,
        mounts: mounts.map((mount) => ({
          alias: mount.workspace.alias,
          mode: mount.workspace.mode,
          ...(mount.attached ? {} : { fileCount: mount.fileCount }),
          attached: mount.attached,
        })),
      });
      await request.emit("sandbox.opened", {
        sandboxId: handle.id,
        image: spec.image,
        provider: this.#options.provider.name,
        mounts: mounts.map((mount) => ({
          alias: mount.workspace.alias,
          mode: mount.workspace.mode,
          ...(mount.attached
            ? {}
            : { fileCount: mount.fileCount, bytes: mount.bytes }),
          attached: mount.attached,
        })),
        helper: { command: [...this.#helperCommand] },
      });
    } catch (error) {
      await this.#options.provider.terminate(handle).catch(() => undefined);
      throw error;
    }
    return session;
  }

  #canAttach(workspace: ResolvedWorkspace): boolean {
    return (
      (this.#options.attach ?? "auto") === "auto" &&
      workspace.mode === "read" &&
      workspace.store.attachable != null &&
      this.#options.provider.capabilities?.readOnlyAttachments === true
    );
  }

  #assertStagingLimits(
    workspace: ResolvedWorkspace,
    fileCount: number,
    bytes: number,
  ): void {
    const limits = workspace.store.limits ?? {};
    if (limits.maxFiles != null && fileCount > limits.maxFiles) {
      throw new Error(
        `Workspace ${workspace.alias} has ${fileCount} files, exceeding its ${limits.maxFiles}-file limit.`,
      );
    }
    if (limits.maxTotalBytes != null && bytes > limits.maxTotalBytes) {
      throw new Error(
        `Workspace ${workspace.alias} has ${bytes} bytes, exceeding its ${limits.maxTotalBytes}-byte limit.`,
      );
    }
  }

  #spec(runId: string, attachments: SandboxAttachment[]): SandboxSpec {
    const limits = this.#policy.limits;
    return {
      image: this.#options.image,
      workingDirectory: "/workspace",
      network: "none",
      limits: {
        timeoutMs: limits.maxTotalSandboxSeconds * 1_000 + 60_000,
        memoryMb: limits.memoryMb,
        cpuCount: limits.cpuCount,
        processLimit: limits.processLimit,
        workspaceTmpfsMb: limits.workspaceTmpfsMb,
        maximumOutputBytes: limits.maxOutputBytes,
        maximumOutputFiles: limits.maxOutputFiles,
      },
      ...(attachments.length > 0 ? { attachments } : {}),
      metadata: {
        "agent-runtime.run": runId,
        "agent-runtime.kind": "run-sandbox",
      },
    };
  }
}

interface SessionInput {
  handle: SandboxHandle;
  provider: SandboxProvider;
  policy: RunSandboxPolicy;
  helperCommand: readonly string[];
  profiles: Map<string, SandboxRuntimeProfile>;
  allowedEnvironment: Set<string>;
  hooks: RunSandboxHostHooks;
  request: RunSandboxOpenRequest;
  mounts: MountState[];
  image: string;
  now: () => Date;
}

class ProviderRunSandboxSession implements RunSandboxSession {
  readonly id: string;
  readonly #input: SessionInput;
  readonly #mounts: Map<string, MountState>;
  #commandsUsed: number;
  #sandboxSecondsUsed: number;
  #sequence = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(input: SessionInput) {
    this.id = input.handle.id;
    this.#input = input;
    this.#mounts = new Map(
      input.mounts.map((mount) => [mount.workspace.alias, mount]),
    );
    this.#commandsUsed = input.request.budget?.commandsUsed ?? 0;
    this.#sandboxSecondsUsed = input.request.budget?.sandboxSecondsUsed ?? 0;
  }

  budget(): SandboxBudgetState {
    return {
      commandsUsed: this.#commandsUsed,
      sandboxSecondsUsed: this.#sandboxSecondsUsed,
    };
  }

  /** Stage the helper, every non-attached mount, and the mount index. */
  async stage(helperSource: Uint8Array): Promise<void> {
    const { provider, handle, request } = this.#input;
    const signal = request.signal;
    await provider.putFiles(
      handle,
      [{ path: SANDBOX_HELPER_PATH, content: helperSource, mode: 0o500 }],
      signal ? { signal } : undefined,
    );
    let stagedBytes = 0;
    for (const mount of this.#mounts.values()) {
      if (mount.attached) continue;
      const { workspace } = mount;
      const entries = await workspace.store.entries(
        signal ? { signal } : undefined,
      );
      const limits = workspace.store.limits ?? {};
      const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      if (limits.maxFiles != null && entries.length > limits.maxFiles) {
        throw new Error(
          `Workspace ${workspace.alias} has ${entries.length} files, exceeding its ${limits.maxFiles}-file limit.`,
        );
      }
      if (limits.maxTotalBytes != null && totalBytes > limits.maxTotalBytes) {
        throw new Error(
          `Workspace ${workspace.alias} has ${totalBytes} bytes, exceeding its ${limits.maxTotalBytes}-byte limit.`,
        );
      }
      const mode = workspace.mode === "read_write" ? 0o600 : 0o400;
      let batch: SandboxInputFile[] = [];
      let batchBytes = 0;
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        await provider.putFiles(handle, batch, signal ? { signal } : undefined);
        batch = [];
        batchBytes = 0;
      };
      for (const entry of entries) {
        if (!isSafeWorkspacePath(entry.path)) continue;
        const data = await workspace.store.read(
          entry.path,
          signal ? { signal } : undefined,
        );
        stagedBytes += data.byteLength;
        if (stagedBytes > this.#input.policy.limits.maxTotalStagedBytes) {
          throw new Error(
            `Bound workspaces exceed the ${this.#input.policy.limits.maxTotalStagedBytes}-byte sandbox staging limit.`,
          );
        }
        batch.push({
          path: assertSandboxPath(`${mount.directory}/${entry.path}`),
          content: data,
          mode,
        });
        batchBytes += data.byteLength;
        mount.fileCount += 1;
        mount.bytes += data.byteLength;
        if (workspace.mode === "read_write") {
          mount.baseline.set(entry.path, {
            size: data.byteLength,
            sha256: sha256(data),
          });
        }
        if (batchBytes >= STAGING_BATCH_BYTES) await flush();
      }
      await flush();
      if (entries.length === 0) {
        // Guarantee the mount directory exists even for empty workspaces.
        await provider.putFiles(
          handle,
          [
            {
              path: `${mount.directory}/.agent-runtime-mount`,
              content: "",
              mode: 0o400,
            },
          ],
          signal ? { signal } : undefined,
        );
      }
    }
    const index = {
      version: 1,
      mounts: Object.fromEntries(
        [...this.#mounts.values()].map((mount) => [
          mount.workspace.alias,
          {
            path: mount.directory,
            mode: mount.workspace.mode,
            ...(mount.attached ? {} : { fileCount: mount.fileCount }),
            attached: mount.attached,
          },
        ]),
      ),
      output: SANDBOX_OUTPUT_DIRECTORY,
    };
    await provider.putFiles(
      handle,
      [
        {
          path: SANDBOX_WORKSPACES_FILE,
          content: JSON.stringify(index),
          mode: 0o400,
        },
      ],
      signal ? { signal } : undefined,
    );
  }

  execute(request: RunSandboxCommandRequest): Promise<RunSandboxCommandResult> {
    const run = this.#queue.then(() => this.#execute(request));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(
    reason: "completed" | "failed" | "cancelled" | "suspended",
  ): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    const { provider, handle, request } = this.#input;
    let filesChanged = 0;
    let ignored = 0;
    let syncError: unknown;
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Final workspace sync timed out.")),
        CLOSE_SYNC_TIMEOUT_MS,
      );
      timer.unref?.();
      try {
        for (const mount of this.#mounts.values()) {
          if (mount.workspace.mode !== "read_write") continue;
          const changes = await this.#syncBack(mount, controller.signal);
          filesChanged += changes.filesChanged.length;
          ignored += changes.ignoredPaths.length;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      syncError = error;
    } finally {
      await provider.terminate(handle);
      await request.emit("sandbox.closed", {
        sandboxId: handle.id,
        reason,
        commandsUsed: this.#commandsUsed,
        sandboxSecondsUsed: this.#sandboxSecondsUsed,
        finalSync: { filesChanged, ignored },
        ...(syncError
          ? {
              syncError:
                syncError instanceof Error
                  ? syncError.message
                  : String(syncError),
            }
          : {}),
      });
    }
    if (syncError) throw syncError;
  }

  async #execute(
    request: RunSandboxCommandRequest,
  ): Promise<RunSandboxCommandResult> {
    if (this.#closed)
      throw new RunSandboxExecutionError(
        "sandbox_unavailable",
        "The run sandbox is closed.",
      );
    const { policy, provider, handle, hooks, now } = this.#input;
    const runRequest = this.#input.request;
    const mount = request.alias ? this.#mounts.get(request.alias) : undefined;
    if (request.kind !== "code" && !mount) {
      throw new SandboxPolicyError(
        "tool_not_allowed",
        `Workspace "${request.alias ?? ""}" is not bound to this run.`,
      );
    }
    const commandId = `cmd-${runRequest.attempt}-${this.#sequence + 1}`;
    const admitted = admitCommand(request, {
      policy,
      ...(mount ? { workspace: mount.workspace } : {}),
      commandId,
      helperCommand: this.#helperCommand(),
      codeProfile: (language) => {
        const profile = this.#input.profiles.get(language);
        return profile
          ? {
              extension: profile.extension,
              argv: (sourcePath) => [
                profile.command,
                ...profile.args(sourcePath),
              ],
            }
          : undefined;
      },
    });
    if (this.#commandsUsed >= policy.limits.maxCommandsPerRun) {
      throw new RunSandboxExecutionError(
        "sandbox_budget_exhausted",
        `The run has used its ${policy.limits.maxCommandsPerRun}-command sandbox budget.`,
      );
    }
    if (this.#sandboxSecondsUsed >= policy.limits.maxTotalSandboxSeconds) {
      throw new RunSandboxExecutionError(
        "sandbox_budget_exhausted",
        `The run has used its ${policy.limits.maxTotalSandboxSeconds}-second sandbox budget.`,
      );
    }
    this.#sequence += 1;
    const partialRecord = {
      kind: admitted.kind,
      name: admitted.name,
      ...(admitted.policyEntry ? { policyEntry: admitted.policyEntry } : {}),
      argv: [...admitted.argv],
      cwd: admitted.cwd,
      ...(mount
        ? {
            alias: mount.workspace.alias,
            workspace: mount.workspace.binding.ref,
          }
        : {}),
    };
    try {
      await hooks.authorizeCommand?.(
        {
          record: partialRecord,
          ...(request.toolCallId
            ? {
                toolCall: {
                  id: request.toolCallId,
                  name: request.name,
                  input: request.arguments,
                },
              }
            : {}),
        },
        {
          runId: runRequest.runId,
          stepId: request.stepId,
          attempt: runRequest.attempt,
        },
      );
    } catch (error) {
      throw new RunSandboxExecutionError(
        "tool_not_authorized",
        error instanceof Error ? error.message : String(error),
      );
    }
    await runRequest.emit(
      "sandbox.command.started",
      {
        commandId,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        kind: admitted.kind,
        name: admitted.name,
        ...(admitted.policyEntry ? { policyEntry: admitted.policyEntry } : {}),
        ...(mount
          ? {
              alias: mount.workspace.alias,
              workspace: mount.workspace.binding.ref,
            }
          : {}),
        argv: [...admitted.argv],
        cwd: admitted.cwd,
        timeoutMs: admitted.timeoutMs,
      },
      request.stepId,
    );
    const startedAt = now();
    this.#commandsUsed += 1;
    const signal = request.signal ?? runRequest.signal;
    // Guarantee the per-command output directory exists for every provider.
    await provider.putFiles(
      handle,
      [
        ...admitted.stagedFiles,
        {
          path: `${admitted.outputDirectory}/${OUTPUT_PLACEHOLDER}`,
          content: "",
          mode: 0o400,
        },
      ],
      signal ? { signal } : undefined,
    );
    const environment = this.#environment(admitted, request);
    const command: SandboxCommand = {
      command: admitted.argv[0]!,
      args: admitted.argv.slice(1),
      cwd: admitted.cwd,
      environment,
      timeoutMs: admitted.timeoutMs,
    };
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    let exitCode = -1;
    let timedOut = false;
    let exitSignal: string | undefined;
    try {
      for await (const event of provider.execute(
        handle,
        command,
        signal ? { signal } : undefined,
      )) {
        if (event.type === "stdout") {
          appendBounded(
            stdoutChunks,
            stdoutState,
            event.data,
            policy.limits.maxStdoutBytes,
          );
        } else if (event.type === "stderr") {
          appendBounded(
            stderrChunks,
            stderrState,
            event.data,
            policy.limits.maxStderrBytes,
          );
        } else {
          exitCode = event.exitCode;
          exitSignal = event.signal;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      exitCode = -1;
      appendBounded(
        stderrChunks,
        stderrState,
        error instanceof Error ? error.message : String(error),
        policy.limits.maxStderrBytes,
      );
    }
    const completedAt = now();
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    this.#sandboxSecondsUsed += durationMs / 1_000;
    if (
      durationMs >= admitted.timeoutMs &&
      (exitCode !== 0 || exitSignal === "SIGKILL" || exitSignal === "SIGTERM")
    ) {
      timedOut = true;
    }
    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    const artifacts = await this.#collectArtifacts(
      admitted.outputDirectory,
      signal,
    );
    const filesChanged: SandboxCommandRecord["filesChanged"] = [];
    const ignoredPaths: SandboxCommandRecord["ignoredPaths"] = [];
    for (const candidate of this.#mounts.values()) {
      if (candidate.workspace.mode !== "read_write") continue;
      const changes = await this.#syncBack(candidate, signal);
      filesChanged.push(...changes.filesChanged);
      ignoredPaths.push(...changes.ignoredPaths);
    }

    const record: SandboxCommandRecord = {
      id: commandId,
      runId: runRequest.runId,
      attempt: runRequest.attempt,
      stepId: request.stepId,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      ...partialRecord,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      exitCode,
      timedOut,
      stdoutBytes: stdoutState.bytes,
      stderrBytes: stderrState.bytes,
      stdoutTruncated: stdoutState.truncated,
      stderrTruncated: stderrState.truncated,
      filesChanged,
      ...(artifacts.length > 0
        ? { artifacts: artifacts.map((artifact) => artifact.id) }
        : {}),
      ignoredPaths,
      budget: {
        commandsUsed: this.#commandsUsed,
        commandsLimit: policy.limits.maxCommandsPerRun,
        sandboxSecondsUsed: this.#sandboxSecondsUsed,
        sandboxSecondsLimit: policy.limits.maxTotalSandboxSeconds,
      },
    };
    await runRequest.emit(
      "sandbox.command.completed",
      JSON.parse(JSON.stringify(record)) as JsonObject,
      request.stepId,
    );

    if (timedOut) {
      throw new RunSandboxExecutionError(
        "sandbox_command_timeout",
        `Sandbox command ${admitted.name} timed out after ${admitted.timeoutMs}ms.`,
      );
    }

    let output: JsonValue | undefined;
    if (admitted.expectsJson) {
      output = this.#parseHelperOutput(stdout, exitCode, stderr, artifacts);
    } else if (admitted.kind === "code") {
      output = stdout.length > 0 ? stdout : undefined;
    } else {
      output = {
        exitCode,
        stdout,
        stderr,
        truncated: stdoutState.truncated || stderrState.truncated,
        ...(artifacts.length > 0
          ? { artifacts: artifacts.map((artifact) => artifact.id) }
          : {}),
      };
    }
    return {
      record,
      ...(output !== undefined ? { output } : {}),
      stdout,
      stderr,
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  }

  #helperCommand(): readonly string[] {
    return this.#input.helperCommand;
  }

  #environment(
    admitted: AdmittedCommand,
    request: RunSandboxCommandRequest,
  ): Record<string, string> {
    const environment: Record<string, string> = {
      AGENT_WORKSPACES_FILE: SANDBOX_WORKSPACES_FILE,
      AGENT_OUTPUT_DIRECTORY: admitted.outputDirectory,
      AGENT_COMMAND_ID: admitted.outputDirectory.split("/").at(-1)!,
    };
    if (admitted.kind === "code") {
      environment.AGENT_VARIABLES_FILE = `${admitted.cwd}/variables.json`;
      const requested = request.arguments.environment;
      if (isJsonObject(requested)) {
        for (const [name, value] of Object.entries(requested)) {
          if (
            this.#input.allowedEnvironment.has(name) &&
            typeof value === "string"
          ) {
            environment[name] = value;
          }
        }
      }
    }
    return environment;
  }

  async #collectArtifacts(
    directory: string,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactRef[]> {
    const { provider, handle, policy } = this.#input;
    const artifacts = this.#input.request.artifacts;
    const files = (
      await provider
        .listFiles(handle, directory, signal ? { signal } : undefined)
        .catch(() => [])
    ).filter((file) => !file.path.endsWith(`/${OUTPUT_PLACEHOLDER}`));
    if (files.length === 0 || !artifacts) return [];
    if (files.length > policy.limits.maxOutputFiles) {
      throw new RunSandboxExecutionError(
        "workspace_limit_exceeded",
        `Command produced ${files.length} output files, exceeding ${policy.limits.maxOutputFiles}.`,
      );
    }
    const refs: ArtifactRef[] = [];
    let total = 0;
    for (const file of files) {
      const outputPath = assertSandboxPath(file.path);
      if (!outputPath.startsWith(`${directory}/`)) continue;
      if (outputPath.endsWith(`/${OUTPUT_PLACEHOLDER}`)) continue;
      const data = await provider.readFile(
        handle,
        outputPath,
        signal ? { signal } : undefined,
      );
      total += data.byteLength;
      if (total > policy.limits.maxOutputBytes) {
        throw new RunSandboxExecutionError(
          "workspace_limit_exceeded",
          `Command output exceeded ${policy.limits.maxOutputBytes} bytes.`,
        );
      }
      const relative = outputPath.slice(directory.length + 1);
      refs.push(
        await artifacts.put({
          name: relative,
          mediaType: mediaTypeFor(relative),
          data,
          metadata: {
            sandboxProvider: provider.name,
            commandId: directory.split("/").at(-1)!,
            sha256: sha256(data),
          },
        }),
      );
    }
    return refs;
  }

  #parseHelperOutput(
    stdout: string,
    exitCode: number,
    stderr: string,
    artifacts: ArtifactRef[],
  ): JsonValue {
    if (Buffer.byteLength(stdout) > MAXIMUM_HELPER_OUTPUT_BYTES) {
      throw new RunSandboxExecutionError(
        "workspace_limit_exceeded",
        "Helper output exceeded the 1 MiB limit.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim() || "null");
    } catch {
      throw new RunSandboxExecutionError(
        "sandbox_command_failed",
        `Workspace helper returned invalid output (exit ${exitCode}): ${stderr.slice(0, 512)}`,
      );
    }
    if (
      !isJsonObject(parsed) ||
      parsed.protocolVersion !== HELPER_PROTOCOL_VERSION
    ) {
      throw new RunSandboxExecutionError(
        "sandbox_command_failed",
        `Workspace helper protocol mismatch (exit ${exitCode}).`,
      );
    }
    const { protocolVersion: _version, ...document } = parsed;
    if (isJsonObject(document.error)) {
      const code = String(document.error.code ?? "");
      const message = String(
        document.error.message ?? "Workspace helper error.",
      );
      const mapped =
        code === "path_invalid"
          ? "workspace_path_invalid"
          : code === "limit_exceeded"
            ? "workspace_limit_exceeded"
            : code === "read_only"
              ? "tool_not_allowed"
              : "sandbox_command_failed";
      throw new RunSandboxExecutionError(mapped, message);
    }
    if (exitCode !== 0) {
      throw new RunSandboxExecutionError(
        "sandbox_command_failed",
        `Workspace helper exited with ${exitCode}: ${stderr.slice(0, 512)}`,
      );
    }
    if (document.encoding === "binary") {
      const { artifactFile: _file, ...rest } = document;
      const artifact = artifacts.find((candidate) => candidate.name === _file);
      return {
        ...rest,
        ...(artifact
          ? { artifactId: artifact.id }
          : { note: "binary content requires an artifact store" }),
      };
    }
    return document;
  }

  async #syncBack(
    mount: MountState,
    signal: AbortSignal | undefined,
  ): Promise<{
    filesChanged: SandboxCommandRecord["filesChanged"];
    ignoredPaths: SandboxCommandRecord["ignoredPaths"];
  }> {
    const { provider, handle } = this.#input;
    const { workspace } = mount;
    const alias = workspace.alias;
    const filesChanged: SandboxCommandRecord["filesChanged"] = [];
    const ignoredPaths: SandboxCommandRecord["ignoredPaths"] = [];
    const maxFileBytes = workspace.store.limits?.maxFileBytes ?? 1_048_576;
    const snapshot = await this.#snapshot(mount, signal);
    for (const item of snapshot.ignored) {
      ignoredPaths.push({ alias, path: item.path, reason: item.reason });
    }
    const seen = new Set<string>();
    for (const file of snapshot.files) {
      seen.add(file.path);
      const previous = mount.baseline.get(file.path);
      if (file.sha256 == null || file.size > maxFileBytes) {
        if (!previous || previous.sha256 !== undefined) {
          ignoredPaths.push({ alias, path: file.path, reason: "size" });
        }
        continue;
      }
      if (previous && previous.sha256 === file.sha256) continue;
      const data = await provider.readFile(
        handle,
        assertSandboxPath(`${mount.directory}/${file.path}`),
        signal ? { signal } : undefined,
      );
      if (data.byteLength > maxFileBytes) {
        ignoredPaths.push({ alias, path: file.path, reason: "size" });
        continue;
      }
      try {
        await workspace.store.write!(
          file.path,
          data,
          signal ? { signal } : undefined,
        );
        mount.baseline.set(file.path, {
          size: data.byteLength,
          sha256: sha256(data),
        });
        filesChanged.push({
          alias,
          path: file.path,
          action: previous ? "modified" : "created",
          size: data.byteLength,
          sha256: file.sha256,
        });
      } catch (error) {
        ignoredPaths.push({
          alias,
          path: file.path,
          reason: `store: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    for (const previousPath of [...mount.baseline.keys()]) {
      if (seen.has(previousPath)) continue;
      try {
        await workspace.store.delete!(
          previousPath,
          signal ? { signal } : undefined,
        );
        mount.baseline.delete(previousPath);
        filesChanged.push({ alias, path: previousPath, action: "deleted" });
      } catch (error) {
        ignoredPaths.push({
          alias,
          path: previousPath,
          reason: `store: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { filesChanged, ignoredPaths };
  }

  async #snapshot(
    mount: MountState,
    signal: AbortSignal | undefined,
  ): Promise<{
    files: Array<{ path: string; size: number; sha256?: string }>;
    ignored: Array<{ path: string; reason: string }>;
  }> {
    const { provider, handle, policy } = this.#input;
    const limits = mount.workspace.store.limits ?? {};
    const argv = [
      ...this.#helperCommand(),
      "snapshot",
      "--mount",
      mount.directory,
      "--max-files",
      String(limits.maxFiles ?? 5_000),
      "--max-bytes",
      String(limits.maxFileBytes ?? 1_048_576),
    ];
    const chunks: string[] = [];
    const state = { bytes: 0, truncated: false };
    let exitCode = -1;
    for await (const event of provider.execute(
      handle,
      {
        command: argv[0]!,
        args: argv.slice(1),
        cwd: "/workspace",
        environment: {},
        timeoutMs: policy.limits.maxCommandTimeoutMs,
      },
      signal ? { signal } : undefined,
    )) {
      if (event.type === "stdout") {
        appendBounded(
          chunks,
          state,
          event.data,
          8 * MAXIMUM_HELPER_OUTPUT_BYTES,
        );
      } else if (event.type === "exit") {
        exitCode = event.exitCode;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunks.join("").trim() || "null");
    } catch {
      parsed = undefined;
    }
    if (
      exitCode !== 0 ||
      !isJsonObject(parsed) ||
      !Array.isArray(parsed.files)
    ) {
      throw new Error(
        `Workspace snapshot of ${mount.workspace.alias} failed (exit ${exitCode}).`,
      );
    }
    const files = (parsed.files as JsonValue[]).flatMap((item) => {
      if (
        !isJsonObject(item) ||
        typeof item.path !== "string" ||
        !isSafeWorkspacePath(item.path)
      )
        return [];
      return [
        {
          path: item.path,
          size: typeof item.size === "number" ? item.size : 0,
          ...(typeof item.sha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(item.sha256)
            ? { sha256: item.sha256 }
            : {}),
        },
      ];
    });
    const ignored = Array.isArray(parsed.ignored)
      ? (parsed.ignored as JsonValue[]).flatMap((item) =>
          isJsonObject(item) && typeof item.path === "string"
            ? [
                {
                  path: String(item.path).slice(0, 1024),
                  reason: String(item.reason ?? "path"),
                },
              ]
            : [],
        )
      : [];
    return { files, ignored };
  }
}

const mediaTypeFor = (filename: string): string => {
  const extension = path.posix.extname(filename).toLowerCase();
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
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".html": "text/html",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }[extension] ?? "application/octet-stream"
  );
};

export { RunSandboxExecutionError };
