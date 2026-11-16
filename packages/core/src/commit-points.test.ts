import type {
  AgentManifest,
  WorkspaceChange,
} from "@clearideas/agent-runtime-contracts";
import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  RunSuspendedError,
  mergeWorkspaceChanges,
  type StepExecutionContext,
  type StepExecutionResult,
} from "./agent-runtime.js";
import type {
  RunSandboxProvider,
  WorkspaceCommitPoint,
  WorkspaceStore,
} from "./ports/index.js";
import { CollectingEventSink, MemoryRunStore } from "./testing/index.js";

/** A sandbox whose commands report the file changes named in their arguments. */
const fakeSandbox = (): RunSandboxProvider => ({
  tools: async () => [],
  validate: async () => undefined,
  open: async () => {
    let pending: WorkspaceChange[] = [];
    return {
      id: "sb",
      execute: async (request) => {
        pending = mergeWorkspaceChanges(
          pending,
          (request.arguments.changes as unknown as WorkspaceChange[]) ?? [],
        );
        return { record: {} as never, stdout: "", stderr: "" };
      },
      budget: () => ({ commandsUsed: 0, sandboxSecondsUsed: 0 }),
      takeChanges: () => {
        const taken = pending.length
          ? { notes: { changes: pending, notPersisted: [] } }
          : {};
        pending = [];
        return taken;
      },
      close: async () => undefined,
    };
  },
});

const store = (
  mode: "read" | "read_write",
  commits: WorkspaceCommitPoint[] = [],
): WorkspaceStore => ({
  mode,
  entries: async () => [],
  read: async () => new Uint8Array(),
  ...(mode === "read_write"
    ? {
        write: async (path) => ({ path, size: 0 }),
        delete: async () => undefined,
        commit: async (point) => {
          commits.push(structuredClone(point));
          return { token: `snapshot-${commits.length}` };
        },
      }
    : { version: async () => "library-v7" }),
});

const change = (path: string, action: WorkspaceChange["action"]) => ({
  path,
  action,
});

const manifest = (steps: string[]): AgentManifest => ({
  schemaVersion: "1.0",
  workspaces: [
    { ref: "notes", mode: "read_write" },
    { ref: "library", mode: "read" },
  ],
  steps: steps.map((id) => ({ id, type: "prompt" as const, prompt: id })),
});

const runtime = (
  execute: (
    context: StepExecutionContext,
  ) => Promise<StepExecutionResult> | StepExecutionResult,
  commits: WorkspaceCommitPoint[],
  runStore = new MemoryRunStore(),
  events = new CollectingEventSink(),
) =>
  new AgentRuntime({
    runStore,
    eventSinks: [events],
    runSandbox: fakeSandbox(),
    workspaces: {
      resolveWorkspace: async (binding) =>
        binding.ref === "notes" ? store("read_write", commits) : store("read"),
    },
    stepExecutors: [{ type: "prompt", execute }],
  });

const command = async (
  context: StepExecutionContext,
  changes: WorkspaceChange[],
) => {
  const session = await context.runSandbox!();
  await session.execute({
    stepId: context.step.id,
    kind: "shell",
    name: "shell",
    alias: "notes",
    arguments: { changes: changes as never },
  });
};

describe("step commit points", () => {
  it("commits each changed read-write workspace when a step completes and records its token", async () => {
    const commits: WorkspaceCommitPoint[] = [];
    const runStore = new MemoryRunStore();
    const events = new CollectingEventSink();
    await runtime(
      async (context) => {
        if (context.step.id === "write")
          await command(context, [
            change("a.md", "created"),
            change("b.md", "modified"),
          ]);
        return { output: context.step.id };
      },
      commits,
      runStore,
      events,
    ).run({ runId: "commit", manifest: manifest(["write", "think"]) });

    expect(commits).toEqual([
      expect.objectContaining({
        runId: "commit",
        attempt: 1,
        alias: "notes",
        stepPath: "write",
        executionKey: "write",
        changes: [change("a.md", "created"), change("b.md", "modified")],
        notPersisted: [],
      }),
    ]);
    const checkpoints = runStore.checkpoints.get("commit")!;
    const boundary = checkpoints.find(
      (checkpoint) => checkpoint.boundary?.stepPath === "write",
    )!;
    expect(boundary.sequence).toBe(commits[0]!.checkpointSequence);
    expect(boundary.workspaces).toEqual({
      notes: {
        token: "snapshot-1",
        stepPath: "write",
        sequence: boundary.sequence,
      },
    });
    // The token is carried forward; "think" changed nothing and is not committed.
    expect(checkpoints.at(-1)).toMatchObject({
      boundary: { stepPath: "think", stepIndex: 1 },
      workspaces: { notes: { token: "snapshot-1" } },
      inputs: { library: { token: "library-v7" } },
    });
    expect(
      events.events.find((event) => event.type === "workspace.committed")?.data,
    ).toMatchObject({
      alias: "notes",
      stepPath: "write",
      created: 1,
      modified: 1,
      deleted: 0,
      token: "snapshot-1",
    });
  });

  it("offers changes from every attempt of a step at its commit point", async () => {
    const commits: WorkspaceCommitPoint[] = [];
    const runStore = new MemoryRunStore();
    let attempt = 0;
    const execute = async (context: StepExecutionContext) => {
      attempt += 1;
      if (attempt === 1) {
        await command(context, [
          change("draft.md", "created"),
          change("old.md", "deleted"),
        ]);
        await context.checkpoint?.({
          state: { ...context.variables },
          continuation: { type: "half" },
        });
        throw new RunSuspendedError("paused");
      }
      await command(context, [change("draft.md", "modified")]);
      return { output: "done" };
    };
    await expect(
      runtime(execute, commits, runStore).run({
        runId: "pending",
        manifest: manifest(["write"]),
      }),
    ).rejects.toMatchObject({ reason: "paused" });
    expect(
      (await runStore.loadLatestCheckpoint("pending"))?.workspaces?.notes
        ?.pending,
    ).toEqual([change("draft.md", "created"), change("old.md", "deleted")]);
    await runtime(execute, commits, runStore).run({
      runId: "pending",
      resume: true,
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      attempt: 2,
      changes: [change("draft.md", "created"), change("old.md", "deleted")],
    });
  });

  it("commits a nested step boundary a parent reports", async () => {
    const commits: WorkspaceCommitPoint[] = [];
    await runtime(async (context) => {
      await command(context, [change("row-1.md", "created")]);
      await context.checkpoint?.({
        state: { ...context.variables },
        boundary: { stepPath: "each/row", executionKey: "each[0]/row" },
      });
      return { output: "ok" };
    }, commits).run({ manifest: manifest(["each"]) });
    expect(commits.map((point) => point.executionKey)).toEqual(["each[0]/row"]);
  });
});
