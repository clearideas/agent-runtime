import type {
  JsonObject,
  JsonValue,
  WorkspaceMode,
} from "@clearideas/agent-runtime-contracts";
import type {
  AgentTool,
  ResolvedWorkspace,
  RunSandboxCommandRequest,
} from "@clearideas/agent-runtime-core";
import { isSafeWorkspacePath } from "@clearideas/agent-runtime-core";

import { assertSandboxPath, type SandboxInputFile } from "./contracts.js";

/** Built-in operations served by the runtime-shipped helper. */
export const BUILTIN_WORKSPACE_TOOLS = [
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "delete_file",
] as const;
export type BuiltinWorkspaceTool = (typeof BUILTIN_WORKSPACE_TOOLS)[number];
export const BUILTIN_READ_TOOLS: readonly BuiltinWorkspaceTool[] = [
  "list_files",
  "read_file",
  "search_files",
];
export const SHELL_TOOL_NAME = "shell";
export const SANDBOX_MOUNT_DIRECTORY = "/workspace/mounts";
export const SANDBOX_OUTPUT_DIRECTORY = "/workspace/output";
export const SANDBOX_STAGING_DIRECTORY = "/workspace/staging";
export const SANDBOX_STEPS_DIRECTORY = "/workspace/steps";
export const SANDBOX_HELPER_PATH = "/workspace/bin/agent-fs";
export const SANDBOX_WORKSPACES_FILE = "/workspace/workspaces.json";
export const DEFAULT_HELPER_COMMAND = ["python3", SANDBOX_HELPER_PATH];

const COMMAND_NAME = /^[a-z][a-z0-9_]*$/u;
const RESERVED_COMMAND_NAMES = new Set<string>([
  ...BUILTIN_WORKSPACE_TOOLS,
  SHELL_TOOL_NAME,
]);
const MAXIMUM_GLOB_LENGTH = 512;
const MAXIMUM_QUERY_LENGTH = 512;
const MAXIMUM_LINE_COUNT = 2_000;
const MAXIMUM_LIST_LIMIT = 5_000;
const MAXIMUM_SEARCH_LIMIT = 1_000;
const DEFAULT_LIST_LIMIT = 1_000;

export interface RunSandboxArgumentPolicy {
  /** Maximum argument count for program entries. Defaults to limits.maxArgs. */
  maxCount?: number | undefined;
  /** Regular expressions the first argument must match when present. */
  allowPatterns?: string[] | undefined;
  /** Regular expressions no argument may match. */
  denyPatterns?: string[] | undefined;
}

export interface RunSandboxCommandEntry {
  description?: string | undefined;
  /** Fixed argv; may contain {file}, {mount}, and {output}. */
  argv?: string[] | undefined;
  /** Program the model may pass arguments to. */
  program?: string | undefined;
  args?: RunSandboxArgumentPolicy | undefined;
  /** Globs the {file} argument must match. Defaults to every mount file. */
  inputs?: string[] | undefined;
  /** Workspace references the entry applies to. Defaults to all. */
  workspaces?: string[] | undefined;
  /** Effective binding modes the entry applies to. Defaults to both. */
  modes?: WorkspaceMode[] | undefined;
  timeoutMs?: number | undefined;
}

export interface RunSandboxShellPolicy {
  enabled: boolean;
  /** Interpreter argv; the command string is appended. */
  program?: string[] | undefined;
  timeoutMs?: number | undefined;
  modes?: WorkspaceMode[] | undefined;
}

export interface RunSandboxLimits {
  memoryMb: number;
  cpuCount: number;
  processLimit: number;
  workspaceTmpfsMb: number;
  commandTimeoutMs: number;
  maxCommandTimeoutMs: number;
  maxCommandsPerRun: number;
  maxTotalSandboxSeconds: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxArgs: number;
  maxArgBytes: number;
  maxTotalStagedBytes: number;
  maxOutputFiles: number;
  maxOutputBytes: number;
}

export const DEFAULT_RUN_SANDBOX_LIMITS: RunSandboxLimits = {
  memoryMb: 1_024,
  cpuCount: 1,
  processLimit: 128,
  workspaceTmpfsMb: 1_024,
  commandTimeoutMs: 60_000,
  maxCommandTimeoutMs: 900_000,
  maxCommandsPerRun: 200,
  maxTotalSandboxSeconds: 900,
  maxStdoutBytes: 1_048_576,
  maxStderrBytes: 262_144,
  maxArgs: 64,
  maxArgBytes: 4_096,
  maxTotalStagedBytes: 256 * 1_048_576,
  maxOutputFiles: 50,
  maxOutputBytes: 50 * 1_048_576,
};

export interface RunSandboxPolicy {
  commands: Record<string, RunSandboxCommandEntry>;
  shell: RunSandboxShellPolicy;
  limits: RunSandboxLimits;
}

export type RunSandboxLimitOverrides = {
  [Key in keyof RunSandboxLimits]?: number | undefined;
};

export const resolveRunSandboxLimits = (
  partial: RunSandboxLimitOverrides = {},
): RunSandboxLimits => {
  const limits = { ...DEFAULT_RUN_SANDBOX_LIMITS };
  for (const [key, value] of Object.entries(partial) as Array<
    [keyof RunSandboxLimits, number | undefined]
  >) {
    if (value == null) continue;
    if (key === "cpuCount") {
      if (!Number.isFinite(value) || value <= 0 || value > 1_024)
        throw new Error("Sandbox cpuCount must be between 0 and 1024.");
    } else if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Sandbox limit ${key} must be a positive safe integer.`);
    }
    limits[key] = value;
  }
  if (limits.commandTimeoutMs > limits.maxCommandTimeoutMs) {
    throw new Error(
      "Sandbox commandTimeoutMs cannot exceed maxCommandTimeoutMs.",
    );
  }
  return limits;
};

export const resolveRunSandboxPolicy = (input: {
  commands?: Record<string, RunSandboxCommandEntry> | undefined;
  shell?: Partial<RunSandboxShellPolicy> | undefined;
  limits?: RunSandboxLimitOverrides | undefined;
}): RunSandboxPolicy => {
  const policy: RunSandboxPolicy = {
    commands: { ...(input.commands ?? {}) },
    shell: {
      enabled: input.shell?.enabled ?? false,
      program: input.shell?.program ?? ["/bin/sh", "-c"],
      ...(input.shell?.timeoutMs ? { timeoutMs: input.shell.timeoutMs } : {}),
      ...(input.shell?.modes ? { modes: input.shell.modes } : {}),
    },
    limits: resolveRunSandboxLimits(input.limits),
  };
  validateRunSandboxPolicy(policy);
  return policy;
};

const compilePattern = (pattern: string, label: string): RegExp => {
  if (pattern.length > 512)
    throw new Error(`${label} pattern is too long: ${pattern}`);
  try {
    return new RegExp(pattern, "u");
  } catch {
    throw new Error(
      `${label} pattern is not a valid regular expression: ${pattern}`,
    );
  }
};

export const validateRunSandboxPolicy = (policy: RunSandboxPolicy): void => {
  for (const [name, entry] of Object.entries(policy.commands)) {
    if (!COMMAND_NAME.test(name))
      throw new Error(`Sandbox command name is invalid: ${name}`);
    if (RESERVED_COMMAND_NAMES.has(name))
      throw new Error(`Sandbox command name is reserved: ${name}`);
    if ((entry.argv == null) === (entry.program == null)) {
      throw new Error(
        `Sandbox command ${name} requires exactly one of argv or program.`,
      );
    }
    if (entry.argv) {
      if (entry.argv.length === 0)
        throw new Error(`Sandbox command ${name} argv cannot be empty.`);
      for (const element of entry.argv) {
        for (const placeholder of element.matchAll(/\{([^}]*)\}/gu)) {
          if (!["file", "mount", "output"].includes(placeholder[1] ?? "")) {
            throw new Error(
              `Sandbox command ${name} uses an unknown placeholder: {${placeholder[1]}}`,
            );
          }
        }
      }
      if (entry.args)
        throw new Error(
          `Sandbox command ${name} cannot combine argv and args.`,
        );
    }
    if (entry.program != null && entry.program.trim() === "")
      throw new Error(`Sandbox command ${name} program cannot be empty.`);
    for (const pattern of entry.args?.allowPatterns ?? [])
      compilePattern(pattern, `Sandbox command ${name} allow`);
    for (const pattern of entry.args?.denyPatterns ?? [])
      compilePattern(pattern, `Sandbox command ${name} deny`);
    if (
      entry.args?.maxCount != null &&
      (!Number.isSafeInteger(entry.args.maxCount) || entry.args.maxCount < 0)
    ) {
      throw new Error(
        `Sandbox command ${name} args.maxCount must be a non-negative integer.`,
      );
    }
    if (
      entry.timeoutMs != null &&
      (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0)
    ) {
      throw new Error(
        `Sandbox command ${name} timeoutMs must be a positive integer.`,
      );
    }
  }
  if (policy.shell.enabled && (policy.shell.program?.length ?? 0) === 0) {
    throw new Error("Sandbox shell requires a program.");
  }
};

export class SandboxPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SandboxPolicyError";
    this.code = code;
  }
}

const notAllowed = (message: string): SandboxPolicyError =>
  new SandboxPolicyError("tool_not_allowed", message);
const invalidPath = (message: string): SandboxPolicyError =>
  new SandboxPolicyError("workspace_path_invalid", message);
const limitExceeded = (message: string): SandboxPolicyError =>
  new SandboxPolicyError("workspace_limit_exceeded", message);
const invalidArguments = (message: string): SandboxPolicyError =>
  new SandboxPolicyError("sandbox_command_failed", message);

const entryApplies = (
  entry: RunSandboxCommandEntry,
  workspace: ResolvedWorkspace,
): boolean =>
  (entry.workspaces == null ||
    entry.workspaces.includes(workspace.binding.ref)) &&
  (entry.modes == null || entry.modes.includes(workspace.mode));

const shellApplies = (
  shell: RunSandboxShellPolicy,
  workspace: ResolvedWorkspace,
): boolean =>
  shell.enabled &&
  (shell.modes == null || shell.modes.includes(workspace.mode));

const pathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  description:
    "Path relative to the workspace root, such as docs/guide.md. Use forward slashes.",
};

const BUILTIN_SCHEMAS: Record<
  BuiltinWorkspaceTool,
  { description: string; inputSchema: JsonObject; readOnly: boolean }
> = {
  list_files: {
    description:
      "List files beneath a directory of the workspace. Supports an optional glob filter such as **/*.md and a result limit.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          ...pathSchema,
          minLength: 0,
          description:
            "Directory to list, relative to the workspace root, such as docs. Omit it to list the root.",
        },
        glob: { type: "string", minLength: 1, maxLength: MAXIMUM_GLOB_LENGTH },
        limit: { type: "integer", minimum: 1, maximum: MAXIMUM_LIST_LIMIT },
      },
    },
  },
  read_file: {
    description:
      "Read one file. Text files return UTF-8 content with an optional line window; binary files return metadata and an artifact reference.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: pathSchema,
        startLine: { type: "integer", minimum: 1 },
        lineCount: { type: "integer", minimum: 1, maximum: MAXIMUM_LINE_COUNT },
      },
    },
  },
  search_files: {
    description:
      "Find lines containing a literal text query across text files. Returns file paths, line numbers, and matching lines.",
    readOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MAXIMUM_QUERY_LENGTH,
        },
        glob: { type: "string", minLength: 1, maxLength: MAXIMUM_GLOB_LENGTH },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: MAXIMUM_SEARCH_LIMIT },
      },
    },
  },
  write_file: {
    description:
      "Create or replace one file. Content is UTF-8 text unless encoding is base64.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: pathSchema,
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
      },
    },
  },
  delete_file: {
    description: "Delete one file from the workspace.",
    readOnly: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: pathSchema },
    },
  },
};

/** Describe the bare (un-prefixed) tools a binding exposes after host policy. */
export const describeWorkspaceTools = (
  workspace: ResolvedWorkspace,
  policy: RunSandboxPolicy,
): AgentTool[] => {
  const tools: AgentTool[] = [];
  const permitted = new Set<string>(
    workspace.mode === "read" ? BUILTIN_READ_TOOLS : BUILTIN_WORKSPACE_TOOLS,
  );
  const agentAllowlist = workspace.binding.tools
    ? new Set(workspace.binding.tools)
    : undefined;
  const include = (name: string): boolean =>
    agentAllowlist == null || agentAllowlist.has(name);
  for (const name of BUILTIN_WORKSPACE_TOOLS) {
    if (!permitted.has(name) || !include(name)) continue;
    const schema = BUILTIN_SCHEMAS[name];
    tools.push({
      name,
      description: schema.description,
      inputSchema: structuredClone(schema.inputSchema),
      metadata: {
        kind: "builtin",
        readOnly: schema.readOnly,
        destructive: !schema.readOnly,
      },
    });
  }
  for (const [name, entry] of Object.entries(policy.commands)) {
    if (!entryApplies(entry, workspace) || !include(name)) continue;
    const usesFile = entry.argv?.some((element) => element.includes("{file}"));
    const inputSchema: JsonObject = entry.argv
      ? {
          type: "object",
          additionalProperties: false,
          ...(usesFile
            ? {
                required: ["file"],
                properties: {
                  file: {
                    ...pathSchema,
                    description: `Workspace file to process${entry.inputs ? ` (matching ${entry.inputs.join(", ")})` : ""}.`,
                  },
                },
              }
            : { properties: {} }),
        }
      : {
          type: "object",
          additionalProperties: false,
          properties: {
            args: {
              type: "array",
              items: { type: "string", maxLength: policy.limits.maxArgBytes },
              maxItems: entry.args?.maxCount ?? policy.limits.maxArgs,
              description: `Arguments passed to ${entry.program}.`,
            },
          },
        };
    tools.push({
      name,
      description:
        entry.description ??
        (entry.argv
          ? `Run ${entry.argv[0]} in the workspace.`
          : `Run ${entry.program} with arguments in the workspace.`),
      inputSchema,
      metadata: { kind: "command", readOnly: false, destructive: true },
    });
  }
  if (shellApplies(policy.shell, workspace) && include(SHELL_TOOL_NAME)) {
    tools.push({
      name: SHELL_TOOL_NAME,
      description:
        "Run a shell command in the workspace directory. Output is bounded; the sandbox has no network.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: {
            type: "string",
            minLength: 1,
            maxLength: policy.limits.maxArgBytes,
          },
        },
      },
      metadata: { kind: "shell", readOnly: false, destructive: true },
    });
  }
  return tools;
};

export interface AdmittedCommand {
  kind: RunSandboxCommandRequest["kind"];
  name: string;
  policyEntry?: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  /** Files to stage before execution (tool content, step code). */
  stagedFiles: SandboxInputFile[];
  /** Directory collected as artifacts after execution. */
  outputDirectory: string;
  /** Helper invocation flags that expect JSON output. */
  expectsJson: boolean;
}

export interface AdmissionContext {
  policy: RunSandboxPolicy;
  workspace?: ResolvedWorkspace;
  commandId: string;
  helperCommand: readonly string[];
  /** Runtime profile argv builder for code steps. */
  codeProfile?: (
    language: string,
  ) =>
    { extension: string; argv: (sourcePath: string) => string[] } | undefined;
}

const requireString = (
  value: JsonValue | undefined,
  label: string,
  maximum: number,
  required: boolean,
): string | undefined => {
  if (value === undefined) {
    if (required) throw invalidArguments(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== "string")
    throw invalidArguments(`${label} must be a string.`);
  if (required && value.length === 0)
    throw invalidArguments(`${label} cannot be empty.`);
  if (value.length > maximum)
    throw limitExceeded(`${label} exceeds ${maximum} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw invalidArguments(`${label} contains control characters.`);
  return value;
};

const requireInteger = (
  value: JsonValue | undefined,
  label: string,
  maximum: number,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw invalidArguments(`${label} must be a positive integer.`);
  if (Number(value) > maximum)
    throw limitExceeded(`${label} exceeds ${maximum}.`);
  return Number(value);
};

const requireBoolean = (
  value: JsonValue | undefined,
  label: string,
): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw invalidArguments(`${label} must be a boolean.`);
  return value;
};

/**
 * Accept the common spellings of a relative workspace path and return its
 * canonical form: Windows separators (`reports\q3.md`), a leading `./` or
 * `/`, repeated or trailing slashes, and `.` segments. `.` alone (or an empty
 * path) means the workspace root and normalizes to "". Nothing here can
 * change which file a path names: `..`, hidden segments, drive letters, and
 * other unsafe segments are left in place and rejected by the caller.
 */
const normalizeWorkspaceToolPath = (value: string): string =>
  value
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

const requirePath = (
  value: JsonValue | undefined,
  label: string,
  required = true,
) => {
  const text = requireString(value, label, 1024, required);
  if (text === undefined) return undefined;
  const normalized = normalizeWorkspaceToolPath(text);
  // An optional directory path may name the root; a file path may not.
  if (normalized === "" && !required) return undefined;
  if (!isSafeWorkspacePath(normalized))
    throw invalidPath(
      `${label} must be a path inside the workspace, such as docs/guide.md (got ${JSON.stringify(text)}). Segments must start with a letter, digit, or underscore and may contain letters, digits, ".", "_", and "-". Dot-prefixed segments and traversal are not allowed.`,
    );
  return normalized;
};

const rejectUnknownKeys = (
  input: JsonObject,
  allowed: readonly string[],
): void => {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key))
      throw invalidArguments(`Unexpected argument: ${key}`);
  }
};

const globMatches = (pattern: string, value: string): boolean => {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const slash = pattern[index + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        index += slash ? 3 : 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    index += 1;
  }
  return new RegExp(`^${source}$`, "u").test(value);
};

const mountDirectory = (alias: string): string =>
  assertSandboxPath(`${SANDBOX_MOUNT_DIRECTORY}/${alias}`);

const helperLimitFlags = (
  workspace: ResolvedWorkspace,
  writable: boolean,
): string[] => [
  ...(writable ? ["--writable"] : []),
  "--max-files",
  String(workspace.store.limits?.maxFiles ?? 5_000),
  "--max-bytes",
  String(workspace.store.limits?.maxFileBytes ?? 1_048_576),
];

const timeoutFor = (
  policy: RunSandboxPolicy,
  requested: number | undefined,
): number =>
  Math.min(
    requested ?? policy.limits.commandTimeoutMs,
    policy.limits.maxCommandTimeoutMs,
  );

/**
 * Decide whether a request may execute and, if so, the exact argv. Every
 * argument the model supplied is validated here before it reaches a process.
 */
export const admitCommand = (
  request: RunSandboxCommandRequest,
  context: AdmissionContext,
): AdmittedCommand => {
  const { policy } = context;
  const outputDirectory = assertSandboxPath(
    `${SANDBOX_OUTPUT_DIRECTORY}/${context.commandId}`,
  );
  const stagingDirectory = assertSandboxPath(
    `${SANDBOX_STAGING_DIRECTORY}/${context.commandId}`,
  );
  const input = request.arguments;

  if (request.kind === "code") {
    const language = requireString(input.language, "language", 64, true)!;
    const code = typeof input.code === "string" ? input.code : undefined;
    if (code === undefined) throw invalidArguments("code is required.");
    const profile = context.codeProfile?.(language);
    if (!profile)
      throw notAllowed(`No sandbox runtime profile for ${language}.`);
    const stepDirectory = assertSandboxPath(
      `${SANDBOX_STEPS_DIRECTORY}/${context.commandId}`,
    );
    const sourcePath = `${stepDirectory}/main.${profile.extension}`;
    const stagedFiles: SandboxInputFile[] = [
      { path: sourcePath, content: code, mode: 0o600 },
      {
        path: `${stepDirectory}/variables.json`,
        content: JSON.stringify(input.variables ?? {}),
        mode: 0o600,
      },
    ];
    return {
      kind: "code",
      name: request.name,
      argv: profile.argv(sourcePath),
      cwd: stepDirectory,
      timeoutMs: timeoutFor(
        policy,
        typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
      ),
      stagedFiles,
      outputDirectory,
      expectsJson: false,
    };
  }

  const workspace = context.workspace;
  if (!workspace) throw notAllowed("The command names no bound workspace.");
  const mount = mountDirectory(workspace.alias);
  const helper = [...context.helperCommand];

  if (request.kind === "builtin") {
    const name = request.name as BuiltinWorkspaceTool;
    if (!BUILTIN_WORKSPACE_TOOLS.includes(name))
      throw notAllowed(`Tool "${request.name}" is not available.`);
    const readOnly = BUILTIN_SCHEMAS[name].readOnly;
    if (!readOnly && workspace.mode !== "read_write")
      throw notAllowed(
        `Tool "${request.name}" requires a read_write workspace.`,
      );
    if (workspace.binding.tools && !workspace.binding.tools.includes(name))
      throw notAllowed(`Tool "${request.name}" is not available.`);
    const flags = helperLimitFlags(workspace, workspace.mode === "read_write");
    let argv: string[];
    const stagedFiles: SandboxInputFile[] = [];
    switch (name) {
      case "list_files": {
        rejectUnknownKeys(input, ["path", "glob", "limit"]);
        const path = requirePath(input.path, "path", false);
        const glob = requireString(
          input.glob,
          "glob",
          MAXIMUM_GLOB_LENGTH,
          false,
        );
        const limit = requireInteger(input.limit, "limit", MAXIMUM_LIST_LIMIT);
        argv = [
          ...helper,
          "list",
          "--mount",
          mount,
          ...flags,
          ...(path ? ["--path", path] : []),
          ...(glob ? ["--glob", glob] : []),
          "--limit",
          String(limit ?? DEFAULT_LIST_LIMIT),
        ];
        break;
      }
      case "read_file": {
        rejectUnknownKeys(input, ["path", "startLine", "lineCount"]);
        const path = requirePath(input.path, "path")!;
        const startLine = requireInteger(
          input.startLine,
          "startLine",
          Number.MAX_SAFE_INTEGER,
        );
        const lineCount = requireInteger(
          input.lineCount,
          "lineCount",
          MAXIMUM_LINE_COUNT,
        );
        argv = [
          ...helper,
          "read",
          "--mount",
          mount,
          ...flags,
          "--path",
          path,
          ...(startLine ? ["--start-line", String(startLine)] : []),
          ...(lineCount ? ["--line-count", String(lineCount)] : []),
          "--artifact-dir",
          outputDirectory,
        ];
        break;
      }
      case "search_files": {
        rejectUnknownKeys(input, ["query", "glob", "caseSensitive", "limit"]);
        const query = requireString(
          input.query,
          "query",
          MAXIMUM_QUERY_LENGTH,
          true,
        )!;
        const glob = requireString(
          input.glob,
          "glob",
          MAXIMUM_GLOB_LENGTH,
          false,
        );
        const caseSensitive = requireBoolean(
          input.caseSensitive,
          "caseSensitive",
        );
        const limit = requireInteger(
          input.limit,
          "limit",
          MAXIMUM_SEARCH_LIMIT,
        );
        argv = [
          ...helper,
          "search",
          "--mount",
          mount,
          ...flags,
          "--query",
          query,
          ...(glob ? ["--glob", glob] : []),
          ...(caseSensitive ? ["--case-sensitive"] : []),
          ...(limit ? ["--limit", String(limit)] : []),
        ];
        break;
      }
      case "write_file": {
        rejectUnknownKeys(input, ["path", "content", "encoding"]);
        const path = requirePath(input.path, "path")!;
        if (typeof input.content !== "string")
          throw invalidArguments("content must be a string.");
        const encoding =
          requireString(input.encoding, "encoding", 16, false) ?? "utf-8";
        if (encoding !== "utf-8" && encoding !== "base64")
          throw invalidArguments("encoding must be utf-8 or base64.");
        const maxBytes = workspace.store.limits?.maxFileBytes ?? 1_048_576;
        if (
          Buffer.byteLength(input.content) >
          maxBytes * (encoding === "base64" ? 2 : 1)
        ) {
          throw limitExceeded(`content exceeds the ${maxBytes}-byte limit.`);
        }
        const source = `${stagingDirectory}/content`;
        stagedFiles.push({ path: source, content: input.content, mode: 0o400 });
        argv = [
          ...helper,
          "write",
          "--mount",
          mount,
          ...flags,
          "--path",
          path,
          "--source",
          source,
          "--encoding",
          encoding,
        ];
        break;
      }
      case "delete_file": {
        rejectUnknownKeys(input, ["path"]);
        const path = requirePath(input.path, "path")!;
        argv = [
          ...helper,
          "delete",
          "--mount",
          mount,
          ...flags,
          "--path",
          path,
        ];
        break;
      }
    }
    return {
      kind: "builtin",
      name,
      argv,
      cwd: mount,
      timeoutMs: timeoutFor(policy, undefined),
      stagedFiles,
      outputDirectory,
      expectsJson: true,
    };
  }

  if (request.kind === "shell") {
    if (!shellApplies(policy.shell, workspace))
      throw notAllowed("Shell commands are not enabled for this workspace.");
    if (
      workspace.binding.tools &&
      !workspace.binding.tools.includes(SHELL_TOOL_NAME)
    )
      throw notAllowed(`Tool "${SHELL_TOOL_NAME}" is not available.`);
    rejectUnknownKeys(input, ["command"]);
    const command = requireString(
      input.command,
      "command",
      policy.limits.maxArgBytes,
      true,
    )!;
    return {
      kind: "shell",
      name: SHELL_TOOL_NAME,
      policyEntry: "shell",
      argv: [...(policy.shell.program ?? ["/bin/sh", "-c"]), command],
      cwd: mount,
      timeoutMs: timeoutFor(policy, policy.shell.timeoutMs),
      stagedFiles: [],
      outputDirectory,
      expectsJson: false,
    };
  }

  const entry = policy.commands[request.name];
  if (!entry || !entryApplies(entry, workspace))
    throw notAllowed(`Tool "${request.name}" is not available.`);
  if (
    workspace.binding.tools &&
    !workspace.binding.tools.includes(request.name)
  )
    throw notAllowed(`Tool "${request.name}" is not available.`);
  let argv: string[];
  if (entry.argv) {
    const usesFile = entry.argv.some((element) => element.includes("{file}"));
    rejectUnknownKeys(input, usesFile ? ["file"] : []);
    let file: string | undefined;
    if (usesFile) {
      file = requirePath(input.file, "file")!;
      if (
        entry.inputs &&
        !entry.inputs.some((glob) => globMatches(glob, file!))
      ) {
        throw invalidPath(
          `file does not match the inputs this command accepts: ${file}`,
        );
      }
    }
    argv = entry.argv.map((element) =>
      element
        .replaceAll("{mount}", mount)
        .replaceAll("{output}", outputDirectory)
        .replaceAll("{file}", file ? `${mount}/${file}` : ""),
    );
  } else {
    rejectUnknownKeys(input, ["args"]);
    const rawArgs = input.args ?? [];
    if (!Array.isArray(rawArgs))
      throw invalidArguments("args must be an array.");
    const maxCount = entry.args?.maxCount ?? policy.limits.maxArgs;
    if (rawArgs.length > maxCount)
      throw limitExceeded(`args exceeds ${maxCount} entries.`);
    const args = rawArgs.map((value, index) =>
      requireString(value, `args[${index}]`, policy.limits.maxArgBytes, false)!,
    );
    if (args.some((value) => value === undefined || value.length === 0))
      throw invalidArguments("args entries must be non-empty strings.");
    const deny = (entry.args?.denyPatterns ?? []).map((pattern) =>
      compilePattern(pattern, "deny"),
    );
    for (const value of args) {
      if (deny.some((pattern) => pattern.test(value)))
        throw notAllowed(`Argument is not permitted: ${value}`);
    }
    const allow = (entry.args?.allowPatterns ?? []).map((pattern) =>
      compilePattern(pattern, "allow"),
    );
    if (allow.length > 0) {
      const first = args[0];
      if (first === undefined || !allow.some((pattern) => pattern.test(first)))
        throw notAllowed(`The first argument must match the host allowlist.`);
    }
    argv = [entry.program!, ...args];
  }
  return {
    kind: "command",
    name: request.name,
    policyEntry: request.name,
    argv,
    cwd: mount,
    timeoutMs: timeoutFor(policy, entry.timeoutMs),
    stagedFiles: [],
    outputDirectory,
    expectsJson: false,
  };
};
