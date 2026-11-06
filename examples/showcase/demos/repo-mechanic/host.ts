/**
 * Repo Mechanic — how a host gives an agent a workspace.
 *
 *   agent.yaml           names the "invoice-service" workspace and the tools it wants
 *   runtime.config.yaml  says where that workspace lives, what is visible, and
 *                        which programs the run sandbox may execute
 *   this file            composes Agent Runtime with host policy and runs it
 *
 * Read the numbered sections; everything else is demo plumbing.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentRuntime,
  CodeStepExecutor,
  composeRuntime,
  FileAgentManifestSource,
  FileArtifactStore,
  FileRunStore,
  JexlConditionEvaluator,
  loadAgentRuntimeConfig,
  parseAgentRuntimeConfig,
  PromptStepExecutor,
  type AgentRuntimeConfig,
  type JsonValue,
  type RunResult,
} from "@clearideas/agent-runtime";

import type { ShowcaseDemo } from "../../lib/demo.ts";
import {
  applySandboxChoice,
  assertModeAllowed,
} from "../../lib/environment.ts";
import {
  ObservedToolAdapter,
  truncateForDisplay,
} from "../../lib/observed-tools.ts";
import { ScriptedModelAdapter } from "../../lib/scripted-model.ts";
import { describeWorkspace, seedWorkspace } from "../../lib/workspace-files.ts";
import { repoMechanicScript } from "./script.ts";

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(demoDirectory, "fixture");
const WORKSPACE = "invoice-service";

// ─── 1. Load the portable agent and the host's configuration ─────────────────
// The manifest is portable: it could run under the CLI, a remote worker, or
// another host. The configuration is host-owned and never comes from a request.
const manifest = await new FileAgentManifestSource(
  demoDirectory,
  "agent.yaml",
).loadManifest();
const hostConfig = await loadAgentRuntimeConfig(
  path.join(demoDirectory, "runtime.config.yaml"),
);

/** Live mode may select another provider or model without editing YAML. */
const withModelOverrides = (config: AgentRuntimeConfig): AgentRuntimeConfig =>
  parseAgentRuntimeConfig({
    ...config,
    models: {
      ...config.models,
      default: {
        ...config.models.default,
        provider:
          process.env.SHOWCASE_PROVIDER ?? config.models.default!.provider,
        model: process.env.SHOWCASE_MODEL ?? config.models.default!.model,
      },
    },
  });

const repositoryRoot = (dataDirectory: string) =>
  path.join(dataDirectory, "invoice-service");

const workspaceDefinition = hostConfig.workspaces[WORKSPACE]!;
const visibility =
  workspaceDefinition.driver === "local"
    ? {
        ...(workspaceDefinition.include
          ? { include: workspaceDefinition.include }
          : {}),
        ...(workspaceDefinition.exclude
          ? { exclude: workspaceDefinition.exclude }
          : {}),
      }
    : {};

const summarize = (result: RunResult): JsonValue =>
  JSON.parse(
    JSON.stringify({
      runId: result.runId,
      output: result.output ?? null,
      state: result.state,
      stepResults: result.stepResults.map((step) => ({
        stepId: step.stepId,
        status: step.status,
        output: step.output ?? null,
      })),
      usage: result.usage ?? null,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    }),
  ) as JsonValue;

export const repoMechanic: ShowcaseDemo = {
  id: "repo-mechanic",
  title: "Repo Mechanic",
  summary: "An agent fixes a failing test inside a sandbox, under host policy.",
  tagline:
    "An agent reproduces a bug, edits the code, and proves the fix — every file operation and test run executes inside an isolated run sandbox.",
  features: [
    "Workspaces",
    "Run sandbox",
    "Allowlisted commands",
    "Host policy hooks",
    "Code steps in the sandbox",
    "Sync-back & audit trail",
  ],
  sources: [
    {
      path: "demos/repo-mechanic/agent.yaml",
      language: "yaml",
      caption:
        "The portable agent: it binds the workspace by name and narrows the tools.",
    },
    {
      path: "demos/repo-mechanic/runtime.config.yaml",
      language: "yaml",
      caption:
        "Host configuration: where the workspace lives, what is visible, and the sandbox command policy.",
    },
    {
      path: "demos/repo-mechanic/host.ts",
      language: "typescript",
      caption:
        "The integration: compose adapters, add host policy hooks, and run.",
    },
    {
      path: "demos/repo-mechanic/script.ts",
      language: "typescript",
      caption:
        "Scripted mode only: the model's decisions, computed from real tool results.",
    },
  ],

  async describe(context) {
    return JSON.parse(
      JSON.stringify({
        manifest,
        workspace: {
          name: WORKSPACE,
          hostRoot: repositoryRoot(context.dataDirectory),
          mode: workspaceDefinition.mode,
          ...visibility,
        },
        sandbox: {
          limits: hostConfig.sandbox?.limits ?? {},
          commands: Object.keys(hostConfig.sandbox?.commands ?? {}),
        },
      }),
    ) as JsonValue;
  },

  async state(context) {
    return JSON.parse(
      JSON.stringify({
        workspaces: [
          {
            alias: "repo",
            name: WORKSPACE,
            mode: workspaceDefinition.mode,
            files: await describeWorkspace({
              root: repositoryRoot(context.dataDirectory),
              fixture: fixtureDirectory,
              ...visibility,
            }),
          },
        ],
      }),
    ) as JsonValue;
  },

  async reset(context) {
    await seedWorkspace(
      fixtureDirectory,
      repositoryRoot(context.dataDirectory),
    );
  },

  async run(context, request, emit, signal) {
    assertModeAllowed(context.environment, request.mode);
    const allowWrites = request.options.allowWrites !== false;
    const issue =
      typeof request.options.issue === "string" && request.options.issue.trim()
        ? request.options.issue.trim().slice(0, 500)
        : undefined;
    const root = repositoryRoot(context.dataDirectory);
    if (request.options.resetWorkspace !== false) {
      await seedWorkspace(fixtureDirectory, root);
    }

    // ─── 2. Choose the sandbox this machine supports ──────────────────────────
    const { config, sandboxProvider } = applySandboxChoice(
      withModelOverrides(hostConfig),
      context.environment.sandbox,
    );

    // ─── 3. Compose adapters from configuration, with host policy hooks ───────
    // composeRuntime returns the workspace provider, the run sandbox, and a
    // tool adapter that serves `repo__*` tools by relaying each call into the
    // sandbox. The hooks run before anything executes; throwing denies.
    const composed = composeRuntime(
      manifest,
      config,
      // Environment references in the configuration resolve from here, so one
      // configuration can serve every tenant or checkout.
      { environment: { ...process.env, SHOWCASE_REPO_ROOT: root } },
      {
        model: request.mode === "live" && !context.liveModel,
        workspaceOptions: {
          ...(sandboxProvider ? { sandboxProvider } : {}),
          authorizeWorkspace({ binding }) {
            if (binding.ref !== WORKSPACE)
              throw new Error(`Workspace ${binding.ref} is not authorized.`);
          },
          authorizeSandbox({ mounts }) {
            if (mounts.some((mount) => mount.alias !== "repo"))
              throw new Error("Unexpected mount in the run sandbox.");
          },
          // Every command — built-in file operations, allowlisted programs,
          // and code steps — passes through here with its exact argv.
          authorizeCommand({ record }) {
            if (
              !allowWrites &&
              (record.name === "write_file" || record.name === "delete_file")
            ) {
              throw new Error(
                "Writes to invoice-service are disabled by the host policy.",
              );
            }
          },
        },
      },
    );
    if (!composed.tools) throw new Error("Workspace tools were not composed.");

    // ─── 4. Create the runtime and stream its events ─────────────────────────
    const runtime = new AgentRuntime({
      ...composed,
      model:
        request.mode === "live"
          ? (context.liveModel?.() ?? composed.model!)
          : new ScriptedModelAdapter(repoMechanicScript, {
              pace: request.pace,
            }),
      // Mirror tool payloads to the browser (events carry names only).
      tools: new ObservedToolAdapter(
        composed.tools,
        ({ stepId, call, result }) =>
          emit({
            kind: "tool-io",
            stepId,
            toolCallId: call.id,
            name: call.name,
            input: truncateForDisplay(call.input),
            ...(result.error
              ? {
                  error: {
                    code: result.error.code,
                    message: result.error.message,
                  },
                }
              : { output: truncateForDisplay(result.output) }),
          }),
      ),
      runStore: new FileRunStore(path.join(context.dataDirectory, "runs")),
      artifacts: new FileArtifactStore(
        path.join(context.dataDirectory, "artifacts"),
      ),
      stepExecutors: [new PromptStepExecutor(), new CodeStepExecutor()],
      conditionEvaluator: new JexlConditionEvaluator(),
      eventSinks: [{ emit: (event) => emit({ kind: "event", event }) }],
    });

    const runId = `repo-${randomUUID()}`;
    emit({
      kind: "accepted",
      runId,
      mode: request.mode,
      sandbox: context.environment.sandbox.kind,
    });
    const result = await runtime.run({
      manifest,
      runId,
      ...(issue ? { variables: [{ key: "issue", value: issue }] } : {}),
      signal,
    });
    emit({ kind: "result", result: summarize(result) });
  },
};
