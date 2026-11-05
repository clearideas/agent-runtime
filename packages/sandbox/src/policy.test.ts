import type {
  ResolvedWorkspace,
  WorkspaceStore,
} from "@clearideas/agent-runtime-core";
import { describe, expect, it } from "vitest";

import {
  SandboxPolicyError,
  admitCommand,
  describeWorkspaceTools,
  resolveRunSandboxLimits,
  resolveRunSandboxPolicy,
  type AdmissionContext,
} from "./policy.js";

const store = (mode: "read" | "read_write"): WorkspaceStore => ({
  mode,
  limits: { maxFiles: 100, maxFileBytes: 64 },
  entries: async () => [],
  read: async () => new Uint8Array(),
});

const workspace = (
  mode: "read" | "read_write",
  tools?: string[],
): ResolvedWorkspace => ({
  binding: { ref: "repo", alias: "code", ...(tools ? { tools } : {}) },
  alias: "code",
  mode,
  store: store(mode),
});

const policy = resolveRunSandboxPolicy({
  commands: {
    extract_text: {
      argv: ["pdftotext", "-layout", "{file}", "-"],
      inputs: ["**/*.pdf"],
    },
    wc: { argv: ["wc", "-l", "{mount}"], modes: ["read_write"] },
    pytest: {
      program: "pytest",
      args: { maxCount: 3, denyPatterns: ["^-p$"], allowPatterns: ["^tests"] },
    },
    other: { program: "x", workspaces: ["other"] },
  },
  shell: { enabled: true, modes: ["read_write"] },
  limits: { maxArgBytes: 32, maxArgs: 8 },
});

const context = (
  current: ResolvedWorkspace | undefined,
  current_policy = policy,
): AdmissionContext => ({
  policy: current_policy,
  ...(current ? { workspace: current } : {}),
  commandId: "cmd-1-1",
  helperCommand: ["python3", "/workspace/bin/agent-fs"],
  codeProfile: (language) =>
    language === "python"
      ? { extension: "py", argv: (source) => ["python3", source] }
      : undefined,
});

const admit = (
  kind: "builtin" | "command" | "shell" | "code",
  name: string,
  args: Record<string, unknown>,
  current: ResolvedWorkspace | undefined = workspace("read_write"),
) =>
  admitCommand(
    {
      stepId: "s",
      kind,
      name,
      alias: current?.alias,
      arguments: args as never,
    },
    context(current),
  );

const rejects = (run: () => unknown, code: string, message?: RegExp): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect((error as SandboxPolicyError).code).toBe(code);
    if (message) expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected rejection");
};

describe("run sandbox policy", () => {
  it("applies defaults and rejects invalid limits and command entries", () => {
    expect(resolveRunSandboxLimits()).toMatchObject({
      commandTimeoutMs: 60_000,
      maxCommandsPerRun: 200,
      maxTotalSandboxSeconds: 900,
      maxArgs: 64,
    });
    expect(() => resolveRunSandboxLimits({ maxArgs: 0 })).toThrow(/positive/u);
    expect(() =>
      resolveRunSandboxLimits({ commandTimeoutMs: 10, maxCommandTimeoutMs: 5 }),
    ).toThrow(/cannot exceed/u);
    expect(() =>
      resolveRunSandboxPolicy({ commands: { read_file: { program: "x" } } }),
    ).toThrow(/reserved/u);
    expect(() =>
      resolveRunSandboxPolicy({ commands: { Bad: { program: "x" } } }),
    ).toThrow(/invalid/u);
    expect(() =>
      resolveRunSandboxPolicy({
        commands: { both: { program: "x", argv: ["y"] } },
      }),
    ).toThrow(/exactly one/u);
    expect(() =>
      resolveRunSandboxPolicy({ commands: { ph: { argv: ["x", "{nope}"] } } }),
    ).toThrow(/unknown placeholder/u);
    expect(() =>
      resolveRunSandboxPolicy({
        commands: { bad: { program: "x", args: { denyPatterns: ["("] } } },
      }),
    ).toThrow(/regular expression/u);
    expect(() =>
      resolveRunSandboxPolicy({ shell: { enabled: true, program: [] } }),
    ).toThrow(/requires a program/u);
  });

  it("describes tools by mode, host policy, and agent narrowing", () => {
    expect(
      describeWorkspaceTools(workspace("read"), policy).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "list_files",
      "read_file",
      "search_files",
      "extract_text",
      "pytest",
    ]);
    expect(
      describeWorkspaceTools(workspace("read_write"), policy).map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "list_files",
      "read_file",
      "search_files",
      "write_file",
      "delete_file",
      "extract_text",
      "wc",
      "pytest",
      "shell",
    ]);
    expect(
      describeWorkspaceTools(
        workspace("read_write", ["read_file", "shell", "unknown"]),
        policy,
      ).map((tool) => tool.name),
    ).toEqual(["read_file", "shell"]);
    const tools = describeWorkspaceTools(workspace("read_write"), policy);
    expect(
      tools.find((tool) => tool.name === "extract_text")?.inputSchema,
    ).toMatchObject({
      required: ["file"],
    });
    expect(
      tools.find((tool) => tool.name === "pytest")?.inputSchema,
    ).toMatchObject({
      properties: { args: { maxItems: 3 } },
    });
    expect(
      tools.find((tool) => tool.name === "write_file")?.metadata,
    ).toMatchObject({
      kind: "builtin",
      destructive: true,
    });
  });

  it("builds helper argv for built-in operations and validates their arguments", () => {
    expect(
      admit("builtin", "list_files", { glob: "**/*.md", limit: 5 }).argv,
    ).toEqual([
      "python3",
      "/workspace/bin/agent-fs",
      "list",
      "--mount",
      "/workspace/mounts/code",
      "--writable",
      "--max-files",
      "100",
      "--max-bytes",
      "64",
      "--glob",
      "**/*.md",
      "--limit",
      "5",
    ]);
    expect(
      admit("builtin", "read_file", { path: "a.md" }, workspace("read")).argv,
    ).toEqual(
      expect.arrayContaining([
        "read",
        "--path",
        "a.md",
        "--artifact-dir",
        "/workspace/output/cmd-1-1",
      ]),
    );
    expect(
      admit("builtin", "read_file", { path: "a.md" }, workspace("read")).argv,
    ).not.toContain("--writable");
    const write = admit("builtin", "write_file", {
      path: "n.md",
      content: "hi",
    });
    expect(write.stagedFiles).toEqual([
      {
        path: "/workspace/staging/cmd-1-1/content",
        content: "hi",
        mode: 0o400,
      },
    ]);
    expect(write.argv).toEqual(
      expect.arrayContaining([
        "write",
        "--source",
        "/workspace/staging/cmd-1-1/content",
      ]),
    );
    expect(write.cwd).toBe("/workspace/mounts/code");
    expect(write.expectsJson).toBe(true);

    rejects(
      () => admit("builtin", "read_file", { path: "../x" }),
      "workspace_path_invalid",
    );
    rejects(
      () => admit("builtin", "read_file", { path: ".env" }),
      "workspace_path_invalid",
    );
    rejects(
      () => admit("builtin", "read_file", {}),
      "sandbox_command_failed",
      /required/u,
    );
    rejects(
      () => admit("builtin", "read_file", { path: "a", extra: 1 }),
      "sandbox_command_failed",
      /Unexpected/u,
    );
    rejects(
      () => admit("builtin", "read_file", { path: "a", lineCount: 5000 }),
      "workspace_limit_exceeded",
    );
    rejects(
      () => admit("builtin", "search_files", { query: "" }),
      "sandbox_command_failed",
    );
    rejects(
      () => admit("builtin", "search_files", { query: "a\u0000b" }),
      "sandbox_command_failed",
      /control/u,
    );
    rejects(
      () =>
        admit("builtin", "write_file", { path: "n", content: "x".repeat(65) }),
      "workspace_limit_exceeded",
    );
    rejects(
      () =>
        admit(
          "builtin",
          "write_file",
          { path: "n", content: "x" },
          workspace("read"),
        ),
      "tool_not_allowed",
    );
    rejects(
      () =>
        admit(
          "builtin",
          "delete_file",
          { path: "n" },
          workspace("read_write", ["read_file"]),
        ),
      "tool_not_allowed",
    );
    rejects(() => admit("builtin", "nope", {}), "tool_not_allowed");
    rejects(
      () =>
        admitCommand(
          {
            stepId: "s",
            kind: "builtin",
            name: "read_file",
            arguments: { path: "a" },
          },
          context(undefined),
        ),
      "tool_not_allowed",
      /no bound workspace/u,
    );
  });

  it("substitutes placeholders, enforces input globs, and validates program arguments", () => {
    expect(
      admit("command", "extract_text", { file: "docs/a.pdf" }).argv,
    ).toEqual([
      "pdftotext",
      "-layout",
      "/workspace/mounts/code/docs/a.pdf",
      "-",
    ]);
    rejects(
      () => admit("command", "extract_text", { file: "docs/a.txt" }),
      "workspace_path_invalid",
      /inputs/u,
    );
    rejects(
      () => admit("command", "extract_text", { file: "../a.pdf" }),
      "workspace_path_invalid",
    );
    rejects(
      () => admit("command", "extract_text", { file: "a.pdf", args: [] }),
      "sandbox_command_failed",
    );
    expect(admit("command", "wc", {}).argv).toEqual([
      "wc",
      "-l",
      "/workspace/mounts/code",
    ]);
    rejects(
      () => admit("command", "wc", {}, workspace("read")),
      "tool_not_allowed",
    );
    rejects(() => admit("command", "other", {}), "tool_not_allowed");

    const pytest = admit("command", "pytest", { args: ["tests/unit", "-q"] });
    expect(pytest).toMatchObject({
      kind: "command",
      policyEntry: "pytest",
      argv: ["pytest", "tests/unit", "-q"],
      expectsJson: false,
    });
    rejects(
      () => admit("command", "pytest", { args: ["tests", "-p", "x"] }),
      "tool_not_allowed",
      /not permitted/u,
    );
    rejects(
      () => admit("command", "pytest", { args: ["-q"] }),
      "tool_not_allowed",
      /allowlist/u,
    );
    rejects(
      () => admit("command", "pytest", { args: ["tests", "a", "b", "c"] }),
      "workspace_limit_exceeded",
    );
    rejects(
      () => admit("command", "pytest", { args: ["tests", "x".repeat(33)] }),
      "workspace_limit_exceeded",
    );
    rejects(
      () => admit("command", "pytest", { args: "tests" }),
      "sandbox_command_failed",
    );
    rejects(
      () => admit("command", "pytest", { args: [""] }),
      "sandbox_command_failed",
    );
  });

  it("admits shell only when enabled for the mode and builds code-step commands", () => {
    expect(admit("shell", "shell", { command: "ls -la" })).toMatchObject({
      kind: "shell",
      argv: ["/bin/sh", "-c", "ls -la"],
      cwd: "/workspace/mounts/code",
      policyEntry: "shell",
    });
    rejects(
      () => admit("shell", "shell", { command: "ls" }, workspace("read")),
      "tool_not_allowed",
    );
    rejects(
      () => admit("shell", "shell", { command: "x".repeat(33) }),
      "workspace_limit_exceeded",
    );
    rejects(
      () =>
        admit(
          "shell",
          "shell",
          { command: "ls" },
          workspace("read_write", ["read_file"]),
        ),
      "tool_not_allowed",
    );

    const code = admitCommand(
      {
        stepId: "tests",
        kind: "code",
        name: "tests",
        arguments: {
          language: "python",
          code: "print(1)",
          variables: { a: 1 },
          timeoutMs: 5_000,
        },
      },
      context(undefined),
    );
    expect(code).toMatchObject({
      kind: "code",
      argv: ["python3", "/workspace/steps/cmd-1-1/main.py"],
      cwd: "/workspace/steps/cmd-1-1",
      timeoutMs: 5_000,
      expectsJson: false,
    });
    expect(code.stagedFiles.map((file) => file.path)).toEqual([
      "/workspace/steps/cmd-1-1/main.py",
      "/workspace/steps/cmd-1-1/variables.json",
    ]);
    rejects(
      () =>
        admitCommand(
          {
            stepId: "s",
            kind: "code",
            name: "s",
            arguments: { language: "ruby", code: "" },
          },
          context(undefined),
        ),
      "tool_not_allowed",
      /profile/u,
    );
    expect(
      admitCommand(
        {
          stepId: "s",
          kind: "code",
          name: "s",
          arguments: { language: "python", code: "", timeoutMs: 10_000_000 },
        },
        context(undefined),
      ).timeoutMs,
    ).toBe(900_000);
  });
});
