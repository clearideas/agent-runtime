import { spawnSync } from "node:child_process";

import type {
  ArtifactRef,
  JsonObject,
  RunEvent,
} from "@clearideas/agent-runtime-contracts";
import type {
  ArtifactInput,
  ArtifactStore,
  ResolvedWorkspace,
  RunSandboxOpenRequest,
  WorkspaceEntry,
  WorkspaceStore,
} from "@clearideas/agent-runtime-core";
import { describe, expect, it } from "vitest";

import { ProviderRunSandbox, RunSandboxExecutionError } from "./run-sandbox.js";
import { HostProcessTestProvider } from "./testing/host-process-provider.js";

/** The helper and the host-process test provider run POSIX commands; skip elsewhere. */
const hasPython =
  process.platform !== "win32" &&
  spawnSync("python3", ["--version"]).status === 0;

/** Minimal in-memory store with the same contract as the local stores. */
class MemoryStore implements WorkspaceStore {
  readonly files = new Map<string, Uint8Array>();
  readonly limits = {
    maxFiles: 50,
    maxFileBytes: 4096,
    maxTotalBytes: 1_000_000,
  };
  readonly writes: string[] = [];
  readonly deletes: string[] = [];
  failWrites = false;

  constructor(
    readonly mode: "read" | "read_write",
    initial: Record<string, string> = {},
  ) {
    for (const [key, value] of Object.entries(initial)) {
      this.files.set(key, new TextEncoder().encode(value));
    }
  }

  async entries(): Promise<WorkspaceEntry[]> {
    return [...this.files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, data]) => ({ path, size: data.byteLength }));
  }

  async read(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`missing ${path}`);
    return data;
  }

  async write(path: string, data: Uint8Array): Promise<WorkspaceEntry> {
    if (this.failWrites) throw new Error("store rejected");
    this.writes.push(path);
    this.files.set(path, new Uint8Array(data));
    return { path, size: data.byteLength };
  }

  async delete(path: string): Promise<void> {
    this.deletes.push(path);
    this.files.delete(path);
  }

  text(path: string): string | undefined {
    const data = this.files.get(path);
    return data ? new TextDecoder().decode(data) : undefined;
  }
}

class MemoryArtifacts implements ArtifactStore {
  readonly items: ArtifactInput[] = [];

  async put(input: ArtifactInput): Promise<ArtifactRef> {
    this.items.push(input);
    return {
      id: `artifact-${this.items.length}`,
      name: input.name,
      mediaType: input.mediaType,
    };
  }

  async get(): Promise<never> {
    throw new Error("not used");
  }
}

const resolved = (
  alias: string,
  store: WorkspaceStore,
  tools?: string[],
): ResolvedWorkspace => ({
  binding: { ref: `${alias}-ref`, alias, ...(tools ? { tools } : {}) },
  alias,
  mode: store.mode,
  store,
});

const open = async (
  runSandbox: ProviderRunSandbox,
  workspaces: ResolvedWorkspace[],
  extra: Partial<RunSandboxOpenRequest> = {},
) => {
  const events: RunEvent[] = [];
  let sequence = 0;
  const request: RunSandboxOpenRequest = {
    runId: "run-1",
    attempt: 1,
    workspaces,
    emit: async (type, data, stepId) => {
      sequence += 1;
      const event: RunEvent = {
        id: `event-${sequence}`,
        runId: "run-1",
        sequence,
        timestamp: new Date().toISOString(),
        type,
        ...(stepId ? { stepId } : {}),
        ...(data ? { data } : {}),
      };
      events.push(event);
      return event;
    },
    ...extra,
  };
  await runSandbox.validate(request);
  const session = await runSandbox.open(request);
  return { session, events };
};

describe.skipIf(!hasPython)("ProviderRunSandbox", { timeout: 60_000 }, () => {
  it("stages mounts, serves built-in operations through the helper, syncs writes back, and reports", async () => {
    const provider = new HostProcessTestProvider();
    const artifacts = new MemoryArtifacts();
    const code = new MemoryStore("read", {
      "README.md": "# Title\nhello world\n",
      "src/app.py": "print('x')\n",
      "logo.png": "\u0089PNG\u0000\u0001",
    });
    const notes = new MemoryStore("read_write", { "old.md": "old\n" });
    const authorized: string[] = [];
    const runSandbox = new ProviderRunSandbox({
      provider,
      image: "test",
      limits: { maxCommandsPerRun: 20 },
      authorizeCommand: ({ record }) => {
        authorized.push(record.name);
      },
    });
    const { session, events } = await open(
      runSandbox,
      [resolved("code", code), resolved("notes", notes)],
      { artifacts },
    );
    expect(events.map((event) => event.type)).toEqual(["sandbox.opened"]);
    expect(events[0]?.data).toMatchObject({
      provider: "host-process-test",
      mounts: [
        { alias: "code", mode: "read", fileCount: 3, attached: false },
        { alias: "notes", mode: "read_write", fileCount: 1, attached: false },
      ],
    });

    const list = await session.execute({
      stepId: "survey",
      toolCallId: "call-1",
      kind: "builtin",
      name: "list_files",
      alias: "code",
      arguments: { glob: "**/*.py" },
    });
    expect(list.output).toEqual({
      files: [
        expect.objectContaining({
          path: "src/app.py",
          mediaType: "text/x-python",
          size: 11,
        }),
      ],
      truncated: false,
    });
    expect(list.record).toMatchObject({
      id: "cmd-1-1",
      kind: "builtin",
      name: "list_files",
      alias: "code",
      workspace: "code-ref",
      toolCallId: "call-1",
      exitCode: 0,
      timedOut: false,
      filesChanged: [],
      budget: { commandsUsed: 1, commandsLimit: 20 },
    });
    expect(list.record.argv[2]).toBe("list");
    expect(authorized).toEqual(["list_files"]);

    const read = await session.execute({
      stepId: "survey",
      kind: "builtin",
      name: "read_file",
      alias: "code",
      arguments: { path: "README.md", startLine: 2 },
    });
    expect(read.output).toMatchObject({
      content: "hello world",
      startLine: 2,
      totalLines: 2,
      encoding: "utf-8",
    });

    const search = await session.execute({
      stepId: "survey",
      kind: "builtin",
      name: "search_files",
      alias: "code",
      arguments: { query: "HELLO" },
    });
    expect(search.output).toEqual({
      matches: [{ path: "README.md", line: 2, text: "hello world" }],
      truncated: false,
    });

    const binary = await session.execute({
      stepId: "survey",
      kind: "builtin",
      name: "read_file",
      alias: "code",
      arguments: { path: "logo.png" },
    });
    expect(binary.output).toEqual({
      path: "logo.png",
      size: 7,
      mediaType: "image/png",
      encoding: "binary",
      artifactId: "artifact-1",
    });
    expect(binary.artifacts).toEqual([
      { id: "artifact-1", name: "logo.png", mediaType: "image/png" },
    ]);
    expect(artifacts.items[0]?.metadata).toMatchObject({
      commandId: "cmd-1-4",
    });

    const write = await session.execute({
      stepId: "draft",
      kind: "builtin",
      name: "write_file",
      alias: "notes",
      arguments: { path: "draft/review.md", content: "# Review\n" },
    });
    expect(write.output).toMatchObject({ path: "draft/review.md", size: 9 });
    expect(write.record.filesChanged).toEqual([
      expect.objectContaining({
        alias: "notes",
        path: "draft/review.md",
        action: "created",
        size: 9,
      }),
    ]);
    expect(notes.text("draft/review.md")).toBe("# Review\n");

    const remove = await session.execute({
      stepId: "draft",
      kind: "builtin",
      name: "delete_file",
      alias: "notes",
      arguments: { path: "old.md" },
    });
    expect(remove.output).toEqual({ path: "old.md", deleted: true });
    expect(remove.record.filesChanged).toEqual([
      { alias: "notes", path: "old.md", action: "deleted" },
    ]);
    expect(notes.files.has("old.md")).toBe(false);

    await session.close("completed");
    expect(provider.terminated).toHaveLength(1);
    const types = events.map((event) => event.type);
    expect(
      types.filter((type) => type === "sandbox.command.started"),
    ).toHaveLength(6);
    expect(
      types.filter((type) => type === "sandbox.command.completed"),
    ).toHaveLength(6);
    expect(types.at(-1)).toBe("sandbox.closed");
    expect(events.at(-1)?.data).toMatchObject({
      reason: "completed",
      commandsUsed: 6,
      finalSync: { filesChanged: 0, ignored: 0 },
    });
    const started = events.find(
      (event) => event.type === "sandbox.command.started",
    );
    expect(started?.stepId).toBe("survey");
    expect(started?.data).toMatchObject({
      commandId: "cmd-1-1",
      argv: expect.any(Array),
    });
    expect(session.budget().commandsUsed).toBe(6);
  });

  it("maps helper and policy failures to tool error codes and never syncs read-only mounts", async () => {
    const provider = new HostProcessTestProvider();
    const code = new MemoryStore("read", { "a.md": "x\n" });
    const runSandbox = new ProviderRunSandbox({
      provider,
      image: "test",
      shell: { enabled: true },
    });
    const { session } = await open(runSandbox, [resolved("code", code)]);
    const fails = async (
      request: Parameters<typeof session.execute>[0],
      code: string,
    ) => {
      try {
        await session.execute(request);
      } catch (error) {
        expect((error as RunSandboxExecutionError).code, String(error)).toBe(
          code,
        );
        return error as Error;
      }
      throw new Error(`expected ${code}`);
    };
    await fails(
      {
        stepId: "s",
        kind: "builtin",
        name: "read_file",
        alias: "code",
        arguments: { path: "missing.md" },
      },
      "workspace_path_invalid",
    );
    await fails(
      {
        stepId: "s",
        kind: "builtin",
        name: "read_file",
        alias: "code",
        arguments: { path: "../x" },
      },
      "workspace_path_invalid",
    );
    await fails(
      {
        stepId: "s",
        kind: "builtin",
        name: "write_file",
        alias: "code",
        arguments: { path: "a.md", content: "y" },
      },
      "tool_not_allowed",
    );
    await fails(
      {
        stepId: "s",
        kind: "builtin",
        name: "list_files",
        alias: "other",
        arguments: {},
      },
      "tool_not_allowed",
    );
    const shell = await session.execute({
      stepId: "s",
      kind: "shell",
      name: "shell",
      alias: "code",
      arguments: {
        command: "echo hacked > a.md; echo extra > extra.md; echo done",
      },
    });
    expect(shell.output).toMatchObject({ exitCode: 0, stdout: "done\n" });
    expect(shell.record.filesChanged).toEqual([]);
    expect(code.text("a.md")).toBe("x\n");
    expect(code.writes).toEqual([]);
    await session.close("failed");
  });

  it("enforces timeouts, output ceilings, budgets, and authorization", async () => {
    const provider = new HostProcessTestProvider();
    const notes = new MemoryStore("read_write");
    const runSandbox = new ProviderRunSandbox({
      provider,
      image: "test",
      shell: { enabled: true, timeoutMs: 500 },
      limits: { maxStdoutBytes: 16, maxCommandsPerRun: 3 },
      authorizeCommand: ({ record }) => {
        if (record.argv.some((arg) => arg.includes("forbidden")))
          throw new Error("denied by host");
      },
    });
    const { session, events } = await open(runSandbox, [
      resolved("notes", notes),
    ]);
    await expect(
      session.execute({
        stepId: "s",
        kind: "shell",
        name: "shell",
        alias: "notes",
        arguments: { command: "echo forbidden" },
      }),
    ).rejects.toMatchObject({
      code: "tool_not_authorized",
      message: "denied by host",
    });
    expect(
      events.some((event) => event.type === "sandbox.command.started"),
    ).toBe(false);

    const big = await session.execute({
      stepId: "s",
      kind: "shell",
      name: "shell",
      alias: "notes",
      arguments: { command: "printf '%s' 0123456789abcdef0123456789" },
    });
    expect(big.output).toMatchObject({
      stdout: "0123456789abcdef",
      truncated: true,
    });
    expect(big.record).toMatchObject({
      stdoutBytes: 16,
      stdoutTruncated: true,
    });

    await expect(
      session.execute({
        stepId: "s",
        kind: "shell",
        name: "shell",
        alias: "notes",
        arguments: { command: "sleep 5" },
      }),
    ).rejects.toMatchObject({ code: "sandbox_command_timeout" });
    const completed = events.filter(
      (event) => event.type === "sandbox.command.completed",
    );
    expect(completed.at(-1)?.data).toMatchObject({
      timedOut: true,
      name: "shell",
    });

    await session.execute({
      stepId: "s",
      kind: "shell",
      name: "shell",
      alias: "notes",
      arguments: { command: "true" },
    });
    await expect(
      session.execute({
        stepId: "s",
        kind: "shell",
        name: "shell",
        alias: "notes",
        arguments: { command: "true" },
      }),
    ).rejects.toMatchObject({ code: "sandbox_budget_exhausted" });
    await session.close("cancelled");
  });

  it("runs code steps in the run sandbox with variables, outputs, and mounts", async () => {
    const provider = new HostProcessTestProvider();
    const artifacts = new MemoryArtifacts();
    const code = new MemoryStore("read", { "data.txt": "42\n" });
    const runSandbox = new ProviderRunSandbox({
      provider,
      image: "test",
      allowedEnvironment: ["SAFE"],
    });
    const { session } = await open(runSandbox, [resolved("code", code)], {
      artifacts,
    });
    const result = await session.execute({
      stepId: "compute",
      kind: "code",
      name: "compute",
      arguments: {
        language: "python",
        code: [
          "import json, os",
          "mounts = json.load(open(os.environ['AGENT_WORKSPACES_FILE']))['mounts']",
          "assert mounts['code']['path'] == '/workspace/mounts/code'",
          "# The test provider relocates /workspace; real providers use the index path directly.",
          "root = os.path.dirname(os.environ['AGENT_WORKSPACES_FILE'])",
          "value = open(root + '/mounts/code/data.txt').read().strip()",
          "variables = json.load(open(os.environ['AGENT_VARIABLES_FILE']))",
          "print(json.dumps({'value': int(value) * variables['factor'], 'safe': os.environ.get('SAFE'), 'secret': os.environ.get('SECRET')}))",
          "open(os.environ['AGENT_OUTPUT_DIRECTORY'] + '/report.txt', 'w').write('done')",
        ].join("\n"),
        variables: { factor: 2 },
        environment: { SAFE: "yes", SECRET: "no" },
      },
    });
    expect(result.stderr, result.stderr).toBe("");
    expect(JSON.parse(String(result.output))).toEqual({
      value: 84,
      safe: "yes",
      secret: null,
    });
    expect(result.record).toMatchObject({
      kind: "code",
      name: "compute",
      exitCode: 0,
    });
    expect(result.artifacts).toEqual([
      { id: "artifact-1", name: "report.txt", mediaType: "text/plain" },
    ]);
    await session.close("completed");
  });

  it("reports files the store rejects and resumes budgets", async () => {
    const provider = new HostProcessTestProvider();
    const notes = new MemoryStore("read_write");
    notes.failWrites = true;
    const runSandbox = new ProviderRunSandbox({
      provider,
      image: "test",
      shell: { enabled: true },
    });
    const { session } = await open(runSandbox, [resolved("notes", notes)], {
      budget: { commandsUsed: 5, sandboxSecondsUsed: 1.5 },
      attempt: 2,
    });
    const result = await session.execute({
      stepId: "s",
      kind: "shell",
      name: "shell",
      alias: "notes",
      arguments: {
        command: "echo hi > new.md; mkdir -p d; echo x > 'd/bad name.md'",
      },
    });
    expect(result.record.id).toBe("cmd-2-1");
    expect(result.record.budget.commandsUsed).toBe(6);
    expect(result.record.filesChanged).toEqual([]);
    expect(result.record.ignoredPaths).toEqual(
      expect.arrayContaining([
        { alias: "notes", path: "d/bad name.md", reason: "path" },
        expect.objectContaining({
          alias: "notes",
          path: "new.md",
          reason: expect.stringContaining("store rejected"),
        }),
      ]),
    );
    await session.close("suspended");
  });

  it("fails validation for oversized workspaces and unreadable helpers before opening", async () => {
    const provider = new HostProcessTestProvider();
    const big = new MemoryStore("read", { "a.txt": "x".repeat(100) });
    const runSandbox = new ProviderRunSandbox({
      provider,
      image: "test",
      limits: { maxTotalStagedBytes: 50 },
    });
    await expect(
      runSandbox.validate({
        runId: "r",
        attempt: 1,
        workspaces: [resolved("big", big)],
      }),
    ).rejects.toThrow(/staging limit/u);
    await expect(
      new ProviderRunSandbox({
        provider,
        image: "test",
        helper: { source: "/nonexistent/agent-fs.py" },
      }).validate({ runId: "r", attempt: 1, workspaces: [] }),
    ).rejects.toThrow(/helper is not readable/u);
    expect(provider.specs).toHaveLength(0);
  });

  it("describes tools per binding without opening a sandbox", async () => {
    const runSandbox = new ProviderRunSandbox({
      provider: new HostProcessTestProvider(),
      image: "test",
      commands: { lint: { program: "eslint" } },
    });
    expect(
      (
        await runSandbox.tools(
          resolved("code", new MemoryStore("read"), ["read_file", "lint"]),
        )
      ).map((tool) => tool.name),
    ).toEqual(["read_file", "lint"]);
    expect(runSandbox.policy.limits.maxCommandsPerRun).toBe(200);
    const spec: JsonObject = { ok: true };
    expect(spec.ok).toBe(true);
  });
});
