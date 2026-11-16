/**
 * Durable Runs — how a host pauses, resumes, edits, and restarts a run.
 *
 *   agent.yaml           drafts a report, waits for approval, then publishes
 *   runtime.config.yaml  a read-only data workspace and a read-write reports one
 *   this file            the host: approvals, snapshots, limits, and restarts
 *
 * A paused run is saved by the RunStore. Nothing stays in memory: resuming
 * builds a brand-new AgentRuntime, as it would after a server restart.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentRuntime,
  AgentRuntimeError,
  ApprovalStepExecutor,
  assessManifestChange,
  composeRuntime,
  FileAgentManifestSource,
  FileArtifactStore,
  FileRunStore,
  isRunSuspendedError,
  JexlConditionEvaluator,
  loadAgentRuntimeConfig,
  LocalDirectoryWorkspace,
  parseAgentManifest,
  PromptStepExecutor,
  RunSuspendedError,
  type AgentManifest,
  type ApprovalAdapter,
  type JsonObject,
  type ModelAdapter,
  type RunCheckpoint,
  type WorkspaceCommitPoint,
  type WorkspaceProvider,
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
/** Small enough that the run is blocked while drafting when the limit is on. */
export const TOKEN_LIMIT = 1_000;

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

// ─── Edits a person can make to the agent between attempts ───────────────────
// A hosted page offers fixed edits; a real host would take an edited manifest.
// Whether a resume or restart accepts an edit depends on what already ran.

/** The manifest with one more sentence in a prompt step's system prompt. */
const withInstruction = (
  source: AgentManifest,
  stepId: string,
  sentence: string,
): AgentManifest =>
  parseAgentManifest({
    ...source,
    steps: source.steps.map((step) =>
      step.id === stepId && "systemPrompt" in step
        ? { ...step, systemPrompt: `${step.systemPrompt} ${sentence}` }
        : step,
    ),
  });

export const EDITS: Record<
  string,
  {
    label: string;
    detail: string;
    apply: (source: AgentManifest) => AgentManifest;
  }
> = {
  "turn-limit": {
    label: "Cap each prompt step at 12 model turns",
    detail: "limits.maxTurnsPerPrompt: 12",
    apply: (source) => ({
      ...source,
      limits: { ...source.limits, maxTurnsPerPrompt: 12 },
    }),
  },
  "publish-summary": {
    label: "Publish: start the report with a one-line summary",
    detail: "steps.publish.systemPrompt",
    apply: (source) =>
      withInstruction(
        source,
        "publish",
        "Begin the published report with a one-line summary.",
      ),
  },
  "draft-thousands": {
    label: "Draft: round amounts to thousands ($453K)",
    detail: "steps.draft.systemPrompt",
    apply: (source) =>
      withInstruction(
        source,
        "draft",
        "Round amounts to the nearest thousand, such as $453K.",
      ),
  },
  "quarter-q2": {
    label: "Report on Q2 instead of Q3",
    detail: "variables.quarter: Q2",
    apply: (source) => ({
      ...source,
      variables: (source.variables ?? []).map((variable) =>
        variable.key === "quarter" ? { ...variable, value: "Q2" } : variable,
      ),
    }),
  },
};

const editOf = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !Object.hasOwn(EDITS, value))
    throw new Error("Unknown edit.");
  return value;
};

const manifestFor = (edit: string | undefined): AgentManifest =>
  edit ? EDITS[edit]!.apply(manifest) : manifest;

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
  snapshot: (token: string) =>
    path.join(context.dataDirectory, "snapshots", token),
  pending: path.join(context.dataDirectory, "pending.json"),
  outage: path.join(context.dataDirectory, "outage.json"),
  lastRun: path.join(context.dataDirectory, "last-run.json"),
  decision: (runId: string, stepId: string) =>
    path.join(context.dataDirectory, "decisions", `${runId}.${stepId}.json`),
});

const readJsonFile = async <T>(file: string): Promise<T | undefined> =>
  JSON.parse(await readFile(file, "utf8").catch(() => "null")) ?? undefined;

const writeJsonFile = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
};

const runStoreOf = (context: DemoContext) =>
  new FileRunStore(path.join(context.dataDirectory, "runs"));

// ─── 1. Snapshots at step commit points ──────────────────────────────────────
// When a step completes, the runtime calls commit() on each read-write
// workspace it changed, after every change is copied back. This store copies
// the reports folder and returns a token; the runtime records the token in
// the step's checkpoint, a restart point.

class SnapshottingWorkspace extends LocalDirectoryWorkspace {
  readonly #root: string;
  readonly #snapshot: (token: string) => string;

  constructor(root: string, snapshot: (token: string) => string) {
    super({ root, mode: "read_write" });
    this.#root = root;
    this.#snapshot = snapshot;
  }

  async commit(point: WorkspaceCommitPoint) {
    const token = `${point.runId}.${point.checkpointSequence}`;
    await cp(this.#root, this.#snapshot(token), { recursive: true });
    return { token };
  }
}

// A run restarted from a step hands the provider the tokens recorded at that
// step (restoreFrom). This provider puts the snapshot back before the run
// sees the workspace, so files match the step the run restarts from.
const restoringSnapshots = (
  provider: WorkspaceProvider,
  context: DemoContext,
): WorkspaceProvider => ({
  async resolveWorkspace(binding, resolution) {
    const alias = binding.alias ?? binding.ref;
    const token = resolution?.restoreFrom?.[alias];
    if (token) {
      const paths = files(context);
      const folder = workspaces.find(
        (workspace) => workspace.name === binding.ref,
      )!.folder;
      await rm(paths.root(folder), { recursive: true, force: true });
      await cp(paths.snapshot(token), paths.root(folder), { recursive: true });
    }
    return provider.resolveWorkspace(binding, resolution);
  },
});

// ─── 2. A model provider that goes down ──────────────────────────────────────
// With the outage on, every model call during Publish fails as a provider
// outage would, until the person says the provider is back. The step retries
// (policies.modelRetry), then the run is blocked instead of failed:
// policies.onFailure is pause.

const withOutage = (
  model: ModelAdapter,
  isDown: () => boolean,
): ModelAdapter => {
  const outage = () =>
    new AgentRuntimeError(
      "The model provider is unavailable (HTTP 503).",
      "MODEL_PROVIDER_UNAVAILABLE",
      true,
    );
  return {
    generate: async (request) => {
      if (isDown()) throw outage();
      return model.generate(request);
    },
    ...(model.stream
      ? {
          async *stream(request) {
            if (isDown()) throw outage();
            yield* model.stream!(request);
          },
        }
      : {}),
    ...(model.describeModel
      ? { describeModel: (name: string) => model.describeModel!(name) }
      : {}),
  };
};

// ─── The runtime for one attempt ─────────────────────────────────────────────

const createRuntime = async (
  context: DemoContext,
  runId: string,
  mode: DemoRunRequest["mode"],
  pace: number,
  emit: (message: ShowcaseMessage) => void,
) => {
  const paths = files(context);
  const outage =
    (await readJsonFile<{ runId: string }>(paths.outage))?.runId === runId;
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
      workspaceOptions: {
        ...(sandboxProvider ? { sandboxProvider } : {}),
        createWorkspace: (name) =>
          name === "reports"
            ? new SnapshottingWorkspace(paths.root("reports"), paths.snapshot)
            : undefined,
      },
    },
  );
  if (!composed.tools || !composed.workspaces)
    throw new Error("Workspace tools were not composed.");

  // ─── 3. An ApprovalAdapter that pauses the run ─────────────────────────────
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

  let currentStep: string | undefined;
  const model =
    mode === "live"
      ? (context.liveModel?.() ?? composed.model!)
      : new ScriptedModelAdapter(durableRunsScript, { pace });

  // ─── 4. A durable RunStore ─────────────────────────────────────────────────
  // FileRunStore keeps checkpoints on disk; SqliteRunStore or your own
  // database-backed RunStore work the same way.
  return new AgentRuntime({
    ...composed,
    model: outage ? withOutage(model, () => currentStep === "publish") : model,
    tools: mirrorTools(composed.tools, emit),
    workspaces: restoringSnapshots(composed.workspaces, context),
    approvals,
    runStore: runStoreOf(context),
    artifacts: new FileArtifactStore(
      path.join(context.dataDirectory, "artifacts"),
    ),
    stepExecutors: [new PromptStepExecutor(), new ApprovalStepExecutor()],
    conditionEvaluator: new JexlConditionEvaluator(),
    eventSinks: [
      {
        emit: (event) => {
          if (event.type === "step.started") currentStep = event.stepId;
          emit({ kind: "event", event });
        },
      },
    ],
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

// ─── 5. Restart points and what an edit would do ─────────────────────────────
// Every step that completes leaves a restart point: a checkpoint with the
// step's results and the workspace tokens from its commit point. A new run
// can start from one. assessManifestChange tells, before anything runs,
// whether a resume or restart accepts an edited agent.

const restartPoints = async (
  context: DemoContext,
  runId: string,
  edited: AgentManifest,
) => {
  const store = runStoreOf(context);
  const points = await store.listCheckpoints(runId, { boundaries: true });
  const described = [];
  for (const point of points) {
    // After the last step there is nothing left to run.
    if (
      !point.boundary ||
      point.boundary.stepIndex >= manifest.steps.length - 1
    )
      continue;
    const checkpoint = await store.loadCheckpoint(runId, point.sequence);
    if (!checkpoint) continue;
    const token = checkpoint.workspaces?.reports?.token;
    const snapshot = token
      ? await describeWorkspace({
          root: files(context).snapshot(token),
          fixture: path.join(fixtures, "reports"),
        })
      : [];
    described.push({
      sequence: point.sequence,
      stepId: point.boundary.stepPath,
      createdAt: point.createdAt,
      snapshot: token
        ? { token, files: snapshot.map((file) => file.path) }
        : null,
      assessment: await assessManifestChange(checkpoint, edited),
    });
  }
  return described;
};

const historyOf = async (context: DemoContext, edited: AgentManifest) => {
  const last = await readJsonFile<{ runId: string }>(files(context).lastRun);
  if (!last) return null;
  const store = runStoreOf(context);
  const record = await store.loadRun(last.runId);
  const latest = await store.loadLatestCheckpoint(last.runId);
  if (!record || !latest) return null;
  const seededFrom = latest.metadata?.seededFrom ?? null;
  return {
    runId: last.runId,
    status: record.status,
    attempts: latest.attempt ?? 1,
    seededFrom,
    ledger: latest.ledger
      ? {
          tokens: latest.ledger.tokens,
          recoveries: latest.ledger.recoveries ?? 0,
          blocked: latest.ledger.blocked ?? null,
        }
      : null,
    restartPoints: await restartPoints(context, last.runId, edited),
  };
};

const seedFor = async (
  context: DemoContext,
  from: unknown,
): Promise<RunCheckpoint> => {
  const { runId, sequence } = (from ?? {}) as {
    runId?: unknown;
    sequence?: unknown;
  };
  if (
    typeof runId !== "string" ||
    !/^report-[0-9a-f-]{36}$/u.test(runId) ||
    !Number.isSafeInteger(sequence)
  )
    throw new Error("Choose a restart point.");
  const seed = await runStoreOf(context).loadCheckpoint(
    runId,
    sequence as number,
  );
  if (!seed?.boundary) throw new Error("That restart point is not available.");
  return seed;
};

export const durableRuns: ShowcaseDemo = {
  id: "durable-runs",
  title: "Durable Runs",
  summary:
    "A run pauses for approval, a limit, or an outage, then resumes or restarts from a step.",
  tagline:
    "An agent drafts a report, then waits for a person. The run is saved to disk and its sandbox closes; approving resumes it in a new attempt with the draft still there. Every completed step is a restart point with a snapshot of the reports folder, and edits to the agent are checked against what already ran.",
  features: [
    "Approvals",
    "Run limits",
    "Pause on failure",
    "Checkpoints",
    "Resume",
    "Step snapshots",
    "Restart from a step",
    "Manifest changes",
  ],
  sources: [
    {
      path: "demos/durable-runs/agent.yaml",
      language: "yaml",
      caption:
        "The agent: draft, an approval step, then publish; failures pause the run.",
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
        "The integration: snapshots at step commit points, an ApprovalAdapter that pauses, resume, restart, and edit checks.",
    },
    {
      path: "demos/durable-runs/script.ts",
      language: "typescript",
      caption:
        "Scripted mode only: the model's decisions, computed from the real CSV files and the instructions it is given.",
    },
  ],

  async describe() {
    return toJson({
      manifest,
      tokenLimit: TOKEN_LIMIT,
      edits: Object.entries(EDITS).map(([id, edit]) => ({
        id,
        label: edit.label,
        detail: edit.detail,
      })),
    });
  },

  async state(context, url) {
    const paths = files(context);
    const edit = editOf(url.searchParams.get("edit"));
    const edited = manifestFor(edit);
    const pending = (await readJsonFile<PendingRun>(paths.pending)) ?? null;
    const checkpoint = pending
      ? await runStoreOf(context).loadLatestCheckpoint(pending.runId)
      : null;
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
      pending,
      edit: edit ?? null,
      // What resuming the paused run with the selected edit would do.
      resumeAssessment: checkpoint
        ? await assessManifestChange(checkpoint, edited)
        : null,
      history: await historyOf(context, edited),
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
    await rm(paths.outage, { force: true });
  },

  // ─── 6. Start a run, or restart one from a step ────────────────────────────
  async run(context, request, emit, signal) {
    assertModeAllowed(context.environment, request.mode);
    const edit = editOf(request.options.edit);
    const seed = request.options.restartFrom
      ? await seedFor(context, request.options.restartFrom)
      : undefined;
    // Check the edit before touching anything. The runtime refuses it too,
    // but only after this host has reset its folders.
    if (seed) {
      const assessment = await assessManifestChange(seed, manifestFor(edit));
      if (assessment.outcome === "refused")
        throw new Error(
          `The run cannot restart from there with this edit. ${assessment.reason}`,
        );
    }
    await this.reset!(context);
    const runId = `report-${randomUUID()}`;
    await writeJsonFile(files(context).lastRun, { runId });
    if (request.options.outage === true)
      await writeJsonFile(files(context).outage, { runId });
    const runtime = await createRuntime(
      context,
      runId,
      request.mode,
      request.pace,
      emit,
    );
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
          manifest: manifestFor(edit),
          runId,
          // A restart is a new run that starts from another run's step
          // checkpoint: its results, history, and workspace snapshots.
          ...(seed ? { seed } : {}),
          // Limits granted for this run; a later resume may raise them.
          ...(request.options.tokenLimit === true
            ? { limits: { maxTotalTokens: TOKEN_LIMIT } }
            : {}),
          signal,
        }),
      runId,
    );
  },

  // ─── 7. Resume a paused run ────────────────────────────────────────────────
  async resume(context, runId, request, emit, signal) {
    const paths = files(context);
    const pending = await readJsonFile<PendingRun>(paths.pending);
    if (!pending || pending.runId !== runId)
      throw new Error("There is no paused run with that ID.");
    assertModeAllowed(context.environment, pending.mode);
    const edit = editOf(request.options.edit);
    // Check the edit before recording a decision for a resume that would
    // be refused.
    const checkpoint = await runStoreOf(context).loadLatestCheckpoint(runId);
    if (checkpoint) {
      const assessment = await assessManifestChange(
        checkpoint,
        manifestFor(edit),
      );
      if (assessment.outcome === "refused")
        throw new Error(
          `The run cannot resume with this edit. ${assessment.reason}`,
        );
    }

    let limits: { maxTotalTokens: number } | undefined;
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
    } else if (pending.details.cause === "limit") {
      const limit = Number(request.options.maxTotalTokens);
      if (
        !Number.isSafeInteger(limit) ||
        limit <= Number(pending.details.used ?? 0)
      )
        throw new Error("The new limit must be higher than the tokens used.");
      // Granted limits are saved with the run and apply to later attempts.
      limits = { maxTotalTokens: limit };
    }
    // A run blocked by an error resumes as it is, once the cause is fixed.
    if (pending.details.cause === "error")
      await rm(paths.outage, { force: true });

    // A new runtime with new adapters: nothing is carried over in memory.
    const runtime = await createRuntime(
      context,
      runId,
      pending.mode,
      request.pace,
      emit,
    );
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
          // The agent as it is now. An edit the checkpoint cannot accept is
          // refused (MANIFEST_CHANGED) and the run is left as it was.
          manifest: manifestFor(edit),
          ...(limits ? { limits } : {}),
          signal,
        }),
      runId,
    );
  },
};
