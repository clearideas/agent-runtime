import type {
  AgentManifest,
  AgentStep,
} from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  RunSuspendedError,
  resolveAgentWorkspaces,
} from "./agent-runtime.js";
import {
  assertWorkspacePath,
  isSafeWorkspacePath,
  restrictWorkspace,
  type ResolvedWorkspace,
  type RunSandboxOpenRequest,
  type RunSandboxProvider,
  type RunSandboxSession,
  type WorkspaceProvider,
  type WorkspaceStore,
} from "./ports/index.js";
import { CollectingEventSink, MemoryRunStore } from "./testing/index.js";

const store = (mode: "read" | "read_write"): WorkspaceStore => ({
  mode,
  limits: { maxFileBytes: 10 },
  entries: async () => [],
  read: async () => new Uint8Array(),
  write: async (path) => ({ path, size: 0 }),
  delete: async () => undefined,
});

const provider = (
  stores: Record<string, WorkspaceStore>,
): WorkspaceProvider => ({
  resolveWorkspace: async (binding) => stores[binding.ref],
});

class FakeRunSandbox implements RunSandboxProvider {
  readonly opened: RunSandboxOpenRequest[] = [];
  readonly closed: string[] = [];
  readonly validated: string[] = [];
  commands = 0;
  failValidate = false;
  failClose = false;

  async tools(): Promise<never[]> {
    return [];
  }

  async validate(request: { runId: string }): Promise<void> {
    this.validated.push(request.runId);
    if (this.failValidate) throw new Error("image not allowed");
  }

  async open(request: RunSandboxOpenRequest): Promise<RunSandboxSession> {
    this.opened.push(request);
    this.commands = request.budget?.commandsUsed ?? 0;
    await request.emit("sandbox.opened", { sandboxId: "sb-1" });
    return {
      id: "sb-1",
      execute: async (command) => {
        this.commands += 1;
        await request.emit(
          "sandbox.command.completed",
          { name: command.name },
          command.stepId,
        );
        return {
          record: {} as never,
          stdout: "",
          stderr: "",
          output: { ran: command.name },
        };
      },
      budget: () => ({
        commandsUsed: this.commands,
        sandboxSecondsUsed: this.commands * 0.5,
      }),
      close: async (reason) => {
        this.closed.push(reason);
        if (this.failClose) throw new Error("sync failed");
      },
    };
  }
}

describe("workspace paths", () => {
  it("accepts relative POSIX paths with safe segments only", () => {
    expect(isSafeWorkspacePath("src/index.ts")).toBe(true);
    expect(isSafeWorkspacePath("README.md")).toBe(true);
    for (const unsafe of [
      "",
      "/etc/passwd",
      "../secret",
      "src/../../x",
      "src/./x",
      ".git/config",
      "a//b",
      "a/",
      "with space.txt",
      "ünïcode.txt",
      "a\\b",
      "x".repeat(1025),
      Array.from({ length: 65 }, () => "a").join("/"),
    ]) {
      expect(isSafeWorkspacePath(unsafe), unsafe).toBe(false);
    }
    expect(() => assertWorkspacePath("../x")).toThrow(/safe segments/u);
  });
});

describe("resolveAgentWorkspaces", () => {
  it("narrows privileges, skips optional unknowns, and rejects elevation", async () => {
    const manifest: AgentManifest = {
      schemaVersion: "1.0",
      workspaces: [
        { ref: "code", alias: "src", mode: "read" },
        { ref: "docs" },
        { ref: "scratch", required: false },
      ],
      steps: [],
    };
    const resolved = await resolveAgentWorkspaces(
      manifest,
      provider({ code: store("read_write"), docs: store("read_write") }),
    );
    expect(resolved.map((item) => [item.alias, item.mode])).toEqual([
      ["src", "read"],
      ["docs", "read_write"],
    ]);
    expect(resolved[0]?.store.write).toBeUndefined();
    expect(resolved[0]?.store.limits).toEqual({ maxFileBytes: 10 });
    expect(resolved[1]?.store.write).toBeTypeOf("function");

    const single = (
      binding: NonNullable<AgentManifest["workspaces"]>[number],
    ): AgentManifest => ({
      schemaVersion: "1.0",
      workspaces: [binding],
      steps: [],
    });
    await expect(
      resolveAgentWorkspaces(single({ ref: "docs" }), undefined),
    ).rejects.toThrow(/requires a WorkspaceProvider/u);
    await expect(
      resolveAgentWorkspaces(single({ ref: "missing" }), provider({})),
    ).rejects.toThrow(/Unknown workspace "missing"/u);
    await expect(
      resolveAgentWorkspaces(
        single({ ref: "docs", mode: "read_write" }),
        provider({ docs: store("read") }),
      ),
    ).rejects.toThrow(/cannot be elevated/u);
    expect(() => restrictWorkspace(store("read"), "read_write")).toThrow(
      /cannot be elevated/u,
    );
  });
});

describe("AgentRuntime run sandbox lifecycle", () => {
  const manifest = (steps: AgentStep[]): AgentManifest => ({
    schemaVersion: "1.0",
    workspaces: [{ ref: "docs", mode: "read" }],
    steps,
  });

  const runtime = (
    sandbox: FakeRunSandbox,
    executor: (
      context: Parameters<
        ConstructorParameters<
          typeof AgentRuntime
        >[0]["stepExecutors"] extends Iterable<infer T>
          ? T extends { execute: infer E }
            ? E
            : never
          : never
      >[0],
    ) => Promise<unknown>,
    runStore = new MemoryRunStore(),
    events = new CollectingEventSink(),
  ) =>
    new AgentRuntime({
      runStore,
      eventSinks: [events],
      workspaces: provider({ docs: store("read_write") }),
      runSandbox: sandbox,
      stepExecutors: [
        {
          type: "prompt",
          execute: (context) => executor(context) as never,
        },
      ],
    });

  it("validates before creating the run, opens lazily, records budget, and closes on completion", async () => {
    const sandbox = new FakeRunSandbox();
    const runStore = new MemoryRunStore();
    const events = new CollectingEventSink();
    const seen: ResolvedWorkspace[][] = [];
    const runner = runtime(
      sandbox,
      async (context) => {
        seen.push([...(context.workspaces ?? [])]);
        const session = await context.runSandbox!();
        await session.execute({
          stepId: context.step.id,
          kind: "builtin",
          name: "list_files",
          arguments: {},
        });
        await context.checkpoint?.({ state: { ...context.variables } });
        return { output: "done" };
      },
      runStore,
      events,
    );
    await runner.run({
      runId: "run-1",
      manifest: manifest([{ id: "first", type: "prompt", prompt: "x" }]),
    });
    expect(sandbox.validated).toEqual(["run-1"]);
    expect(sandbox.opened).toHaveLength(1);
    expect(sandbox.opened[0]?.workspaces[0]).toMatchObject({
      alias: "docs",
      mode: "read",
    });
    expect(sandbox.closed).toEqual(["completed"]);
    expect(seen[0]?.[0]?.store.write).toBeUndefined();
    const types = events.events.map((event) => event.type);
    expect(types.indexOf("workspace.bound")).toBeGreaterThan(
      types.indexOf("run.started"),
    );
    expect(types).toContain("sandbox.opened");
    expect(types).toContain("sandbox.command.completed");
    expect(
      events.events.find((event) => event.type === "workspace.bound")?.data,
    ).toMatchObject({ workspace: "docs", alias: "docs", mode: "read" });
    const checkpoints = runStore.checkpoints.get("run-1") ?? [];
    expect(checkpoints.at(-1)?.metadata).toEqual({
      sandboxBudget: { commandsUsed: 1, sandboxSecondsUsed: 0.5 },
    });
  });

  it("does not open a sandbox for runs that never use it and fails validation before createRun", async () => {
    const sandbox = new FakeRunSandbox();
    const runStore = new MemoryRunStore();
    const runner = runtime(sandbox, async () => ({ output: "ok" }), runStore);
    await runner.run({
      runId: "run-2",
      manifest: manifest([{ id: "first", type: "prompt", prompt: "x" }]),
    });
    expect(sandbox.opened).toHaveLength(0);
    expect(sandbox.closed).toEqual([]);

    sandbox.failValidate = true;
    await expect(
      runner.run({
        runId: "run-3",
        manifest: manifest([{ id: "first", type: "prompt", prompt: "x" }]),
      }),
    ).rejects.toThrow(/image not allowed/u);
    expect(runStore.runs.has("run-3")).toBe(false);
  });

  it("requires a RunSandboxProvider when workspaces or run-sandbox code steps are declared", async () => {
    const runner = new AgentRuntime({
      runStore: new MemoryRunStore(),
      workspaces: provider({ docs: store("read") }),
      stepExecutors: [{ type: "prompt", execute: async () => ({}) }],
    });
    await expect(
      runner.run({
        runId: "run-4",
        manifest: manifest([{ id: "first", type: "prompt", prompt: "x" }]),
      }),
    ).rejects.toThrow(/require a RunSandboxProvider/u);
    await expect(
      runner.run({
        runId: "run-5",
        manifest: {
          schemaVersion: "1.0",
          steps: [
            {
              id: "c",
              type: "code",
              language: "python",
              code: "",
              sandbox: "run",
            },
          ],
        },
      }),
    ).rejects.toThrow(/require a RunSandboxProvider/u);
  });

  it("closes with failed, cancelled, and suspended reasons and restores budget on resume", async () => {
    const sandbox = new FakeRunSandbox();
    const runStore = new MemoryRunStore();
    let behaviour: "fail" | "suspend" | "cancel" | "ok" = "fail";
    const controller = new AbortController();
    const runner = runtime(
      sandbox,
      async (context) => {
        const session = await context.runSandbox!();
        await session.execute({
          stepId: context.step.id,
          kind: "shell",
          name: "shell",
          arguments: {},
        });
        if (behaviour === "fail") throw new Error("boom");
        if (behaviour === "cancel") {
          controller.abort();
          throw new Error("aborted");
        }
        if (behaviour === "suspend") {
          await context.checkpoint?.({ state: { ...context.variables } });
          throw new RunSuspendedError("approval");
        }
        return { output: "ok" };
      },
      runStore,
    );
    const steps: AgentStep[] = [{ id: "first", type: "prompt", prompt: "x" }];
    await expect(
      runner.run({ runId: "f", manifest: manifest(steps) }),
    ).rejects.toThrow(/boom/u);
    behaviour = "cancel";
    await expect(
      runner.run({
        runId: "c",
        manifest: manifest(steps),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    behaviour = "suspend";
    await expect(
      runner.run({ runId: "s", manifest: manifest(steps) }),
    ).rejects.toThrow(/suspended/u);
    expect(sandbox.closed).toEqual(["failed", "cancelled", "suspended"]);
    expect((await runStore.loadLatestCheckpoint("s"))?.metadata).toEqual({
      sandboxBudget: { commandsUsed: 1, sandboxSecondsUsed: 0.5 },
    });

    behaviour = "ok";
    await runner.run({ runId: "s", resume: true });
    expect(sandbox.opened.at(-1)?.budget).toEqual({
      commandsUsed: 1,
      sandboxSecondsUsed: 0.5,
    });
    expect(sandbox.opened.at(-1)?.attempt).toBe(2);
    expect(sandbox.closed.at(-1)).toBe("completed");
    expect((await runStore.loadLatestCheckpoint("s"))?.metadata).toEqual({
      sandboxBudget: { commandsUsed: 2, sandboxSecondsUsed: 1 },
    });
  });

  it("fails the run when the final sync-back cannot complete", async () => {
    const sandbox = new FakeRunSandbox();
    sandbox.failClose = true;
    const runStore = new MemoryRunStore();
    const runner = runtime(
      sandbox,
      async (context) => {
        await context.runSandbox!();
        return { output: "ok" };
      },
      runStore,
    );
    await expect(
      runner.run({
        runId: "run-6",
        manifest: manifest([{ id: "first", type: "prompt", prompt: "x" }]),
      }),
    ).rejects.toThrow(/sync failed/u);
    expect((await runStore.loadRun("run-6"))?.status).toBe("failed");
    expect(sandbox.closed).toEqual(["completed"]);
  });
});
