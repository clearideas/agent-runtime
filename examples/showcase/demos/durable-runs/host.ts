/**
 * Durable Runs — how a host pauses a run and resumes it later.
 *
 *   agent.yaml           drafts a report, waits for approval, then publishes
 *   runtime.config.yaml  a read-only data workspace and a read-write reports one
 *   this file            an ApprovalAdapter that pauses, and a resume endpoint
 *
 * A paused run is saved by the RunStore. Nothing stays in memory: resuming
 * builds a brand-new AgentRuntime, as it would after a server restart.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentRuntime,
  ApprovalStepExecutor,
  composeRuntime,
  FileAgentManifestSource,
  FileArtifactStore,
  FileRunStore,
  isRunSuspendedError,
  JexlConditionEvaluator,
  loadAgentRuntimeConfig,
  PromptStepExecutor,
  RunSuspendedError,
  type ApprovalAdapter,
  type JsonObject,
} from "@clearideas/agent-runtime";

import type {
  DemoContext,
  DemoRunRequest,
  ShowcaseDemo,
  ShowcaseMessage,
} from "../../lib/demo.ts";
import {
  applySandboxChoice,
  assertModeAllowed,
} from "../../lib/environment.ts";
import {
  mirrorTools,
  summarizeResult,
  toJson,
  visibilityOf,
  withModelOverrides,
} from "../../lib/host-kit.ts";
import { ScriptedModelAdapter } from "../../lib/scripted-model.ts";
import { describeWorkspace, seedWorkspace } from "../../lib/workspace-files.ts";
import { durableRunsScript } from "./script.ts";

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(demoDirectory, "fixture");
/** Small enough that the run pauses while drafting when the budget is on. */
export const TOKEN_BUDGET = 1_000;

const manifest = await new FileAgentManifestSource(
  demoDirectory,
  "agent.yaml",
).loadManifest();
const hostConfig = await loadAgentRuntimeConfig(
  path.join(demoDirectory, "runtime.config.yaml"),
);

const workspaces = [
  { alias: "data", name: "sales-data", folder: "sales-data" },
  { alias: "reports", name: "reports", folder: "reports" },
] as const;

// ─── Host state: what the browser needs to resume a paused run ───────────────

interface PendingRun {
  runId: string;
  reason: string;
  details: JsonObject;
  mode: DemoRunRequest["mode"];
}
interface Decision {
  approved: boolean;
  reviewer: string;
  respondedAt: string;
}

const files = (context: DemoContext) => ({
  root: (folder: string) => path.join(context.dataDirectory, folder),
  pending: path.join(context.dataDirectory, "pending.json"),
  decision: (runId: string, stepId: string) =>
    path.join(context.dataDirectory, "decisions", `${runId}.${stepId}.json`),
});

const readJsonFile = async <T>(file: string): Promise<T | undefined> =>
  JSON.parse(await readFile(file, "utf8").catch(() => "null")) ?? undefined;

const writeJsonFile = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
};

// ─── The runtime for one attempt ─────────────────────────────────────────────

const createRuntime = (
  context: DemoContext,
  mode: DemoRunRequest["mode"],
  pace: number,
  emit: (message: ShowcaseMessage) => void,
) => {
  const paths = files(context);
  const { config, sandboxProvider } = applySandboxChoice(
    withModelOverrides(hostConfig),
    context.environment.sandbox,
  );
  const composed = composeRuntime(
    manifest,
    config,
    {
      environment: {
        ...process.env,
        SHOWCASE_SALES_ROOT: paths.root("sales-data"),
        SHOWCASE_REPORTS_ROOT: paths.root("reports"),
      },
    },
    {
      model: mode === "live" && !context.liveModel,
      workspaceOptions: sandboxProvider ? { sandboxProvider } : {},
    },
  );
  if (!composed.tools) throw new Error("Workspace tools were not composed.");

  // ─── 1. An ApprovalAdapter that pauses the run ─────────────────────────────
  // With no decision yet, throwing RunSuspendedError saves the run and ends
  // this attempt. When the run resumes, the same step asks again and this
  // time finds the person's decision.
  const approvals: ApprovalAdapter = {
    async requestApproval({ runId, stepId, prompt }) {
      const decision = await readJsonFile<Decision>(
        paths.decision(runId, stepId),
      );
      if (!decision)
        throw new RunSuspendedError("approval", { stepId, prompt });
      return {
        approved: decision.approved,
        respondedAt: decision.respondedAt,
        response: { reviewer: decision.reviewer },
      };
    },
  };

  // ─── 2. A durable RunStore ─────────────────────────────────────────────────
  // FileRunStore keeps checkpoints on disk; SqliteRunStore or your own
  // database-backed RunStore work the same way.
  return new AgentRuntime({
    ...composed,
    model:
      mode === "live"
        ? (context.liveModel?.() ?? composed.model!)
        : new ScriptedModelAdapter(durableRunsScript, { pace }),
    tools: mirrorTools(composed.tools, emit),
    approvals,
    runStore: new FileRunStore(path.join(context.dataDirectory, "runs")),
    artifacts: new FileArtifactStore(
      path.join(context.dataDirectory, "artifacts"),
    ),
    stepExecutors: [new PromptStepExecutor(), new ApprovalStepExecutor()],
    conditionEvaluator: new JexlConditionEvaluator(),
    eventSinks: [{ emit: (event) => emit({ kind: "event", event }) }],
  });
};

/** Run one attempt. A pause is a normal outcome, not an error. */
const attempt = async (
  context: DemoContext,
  mode: DemoRunRequest["mode"],
  emit: (message: ShowcaseMessage) => void,
  run: () => Promise<Awaited<ReturnType<AgentRuntime["run"]>>>,
  runId: string,
) => {
  const paths = files(context);
  try {
    const result = await run();
    await rm(paths.pending, { force: true });
    emit({ kind: "result", result: summarizeResult(result) });
  } catch (error) {
    if (!isRunSuspendedError(error)) throw error;
    const pending: PendingRun = {
      runId,
      reason: error.reason,
      details: error.details ?? {},
      mode,
    };
    await writeJsonFile(paths.pending, pending);
  }
};

export const durableRuns: ShowcaseDemo = {
  id: "durable-runs",
  title: "Durable Runs",
  summary:
    "A run pauses for approval, then resumes later with its work intact.",
  tagline:
    "An agent drafts a report, then waits for a person. The run is saved to disk and its sandbox closes; approving it resumes the run in a new attempt with the draft still there.",
  features: ["Approvals", "Token budgets", "Checkpoints", "Resume"],
  sources: [
    {
      path: "demos/durable-runs/agent.yaml",
      language: "yaml",
      caption: "The agent: draft, an approval step, then publish.",
    },
    {
      path: "demos/durable-runs/runtime.config.yaml",
      language: "yaml",
      caption:
        "Host configuration: a read-only data workspace and a read-write reports workspace.",
    },
    {
      path: "demos/durable-runs/host.ts",
      language: "typescript",
      caption:
        "The integration: an ApprovalAdapter that pauses the run, and resume with a new runtime.",
    },
    {
      path: "demos/durable-runs/script.ts",
      language: "typescript",
      caption:
        "Scripted mode only: the model's decisions, computed from the real CSV files.",
    },
  ],

  async describe() {
    return toJson({ manifest, tokenBudget: TOKEN_BUDGET });
  },

  async state(context) {
    const paths = files(context);
    return toJson({
      workspaces: await Promise.all(
        workspaces.map(async (workspace) => ({
          alias: workspace.alias,
          name: workspace.name,
          mode: hostConfig.workspaces[workspace.name]?.mode,
          files: await describeWorkspace({
            root: paths.root(workspace.folder),
            fixture: path.join(fixtures, workspace.folder),
            ...visibilityOf(hostConfig.workspaces[workspace.name]),
          }),
        })),
      ),
      pending: (await readJsonFile<PendingRun>(paths.pending)) ?? null,
    });
  },

  async reset(context) {
    const paths = files(context);
    for (const workspace of workspaces)
      await seedWorkspace(
        path.join(fixtures, workspace.folder),
        paths.root(workspace.folder),
      );
    await rm(paths.pending, { force: true });
  },

  async run(context, request, emit, signal) {
    assertModeAllowed(context.environment, request.mode);
    await this.reset!(context);
    const runtime = createRuntime(context, request.mode, request.pace, emit);
    const runId = `report-${randomUUID()}`;
    emit({
      kind: "accepted",
      runId,
      mode: request.mode,
      sandbox: context.environment.sandbox.kind,
    });
    await attempt(
      context,
      request.mode,
      emit,
      () =>
        runtime.run({
          manifest,
          runId,
          // A cumulative token budget, persisted in every checkpoint.
          ...(request.options.tokenBudget === true
            ? { budget: { maxTotalTokens: TOKEN_BUDGET } }
            : {}),
          signal,
        }),
      runId,
    );
  },

  // ─── 3. Resume a paused run ────────────────────────────────────────────────
  async resume(context, runId, request, emit, signal) {
    const paths = files(context);
    const pending = await readJsonFile<PendingRun>(paths.pending);
    if (!pending || pending.runId !== runId)
      throw new Error("There is no paused run with that ID.");
    assertModeAllowed(context.environment, pending.mode);

    let budget: { maxTotalTokens: number } | undefined;
    if (pending.reason === "approval") {
      const decision = request.options.decision;
      if (decision !== "approve" && decision !== "reject")
        throw new Error("Choose approve or reject.");
      // A real host records the authenticated user here.
      const reviewer =
        typeof request.options.reviewer === "string" &&
        request.options.reviewer.trim()
          ? request.options.reviewer.trim().slice(0, 60)
          : "the reviewer";
      await writeJsonFile(
        paths.decision(runId, String(pending.details.stepId)),
        {
          approved: decision === "approve",
          reviewer,
          respondedAt: new Date().toISOString(),
        } satisfies Decision,
      );
    } else if (pending.reason === "token-budget") {
      const limit = Number(request.options.maxTotalTokens);
      if (
        !Number.isSafeInteger(limit) ||
        limit <= Number(pending.details.consumedTokens ?? 0)
      )
        throw new Error("The new limit must be higher than the tokens used.");
      // The new limit replaces the saved one; it is not an extra allowance.
      budget = { maxTotalTokens: limit };
    }

    // A new runtime with new adapters: nothing is carried over in memory.
    const runtime = createRuntime(context, pending.mode, request.pace, emit);
    emit({
      kind: "accepted",
      runId,
      mode: pending.mode,
      sandbox: context.environment.sandbox.kind,
      resumed: true,
    });
    await attempt(
      context,
      pending.mode,
      emit,
      () =>
        runtime.run({
          runId,
          resume: true,
          manifest,
          ...(budget ? { budget } : {}),
          signal,
        }),
      runId,
    );
  },
};
