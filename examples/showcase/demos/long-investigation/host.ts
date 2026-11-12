/**
 * Long Investigation — a step that reads more than fits in its input limit.
 *
 *   agent.yaml           one investigation step that reads 16 logs, and the
 *                        manifest's context policy (what to keep, how much)
 *   runtime.config.yaml  a read-only workspace with the logs
 *   this file            the host's default context strategy, and a model
 *                        wrapper that measures every request for the page
 *
 * The logs and the runbook together are more than three times `limits.maxInputBytes`.
 * With the strategy Off the step fails at the limit, as before context
 * management existed. With Prune or Summarize, Agent Runtime reduces the
 * opening prompt and the older tool rounds before each request would be too
 * large, and the run finishes.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as agentRuntime from "@clearideas/agent-runtime";
import {
  AgentRuntime,
  type AgentManifest,
  composeRuntime,
  FileAgentManifestSource,
  FileRunStore,
  JexlConditionEvaluator,
  loadAgentRuntimeConfig,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  PromptStepExecutor,
} from "@clearideas/agent-runtime";

import type {
  DemoContext,
  ShowcaseDemo,
  ShowcaseMessage,
} from "../../lib/demo.ts";
import {
  applySandboxChoice,
  assertModeAllowed,
} from "../../lib/environment.ts";
import {
  forwardDescribeModel,
  summarizeResult,
  toJson,
  visibilityOf,
  withModelOverrides,
} from "../../lib/host-kit.ts";
import { ObservedToolAdapter } from "../../lib/observed-tools.ts";
import { ScriptedModelAdapter } from "../../lib/scripted-model.ts";
import { describeWorkspace, seedWorkspace } from "../../lib/workspace-files.ts";
import { createInvestigationScript } from "./script.ts";

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(demoDirectory, "fixture");

type ContextStrategy = "summarize-or-prune" | "prune" | "fail";

// ─── Does the installed runtime support context management? ────────────────
// This demo needs the execution policies and context management added after
// Agent Runtime 0.6.3. Against an older runtime (such as the published 0.6.3
// this example may be installed with), the demo reports why it cannot run
// instead of stopping the whole showcase. See the README's note on developing
// against unreleased runtime changes.

/** The version of the @clearideas/agent-runtime package Node resolved. */
const installedRuntimeVersion = (): string => {
  try {
    let directory = path.dirname(
      createRequire(import.meta.url).resolve("@clearideas/agent-runtime"),
    );
    for (let depth = 0; depth < 4; depth += 1) {
      const file = path.join(directory, "package.json");
      if (existsSync(file)) {
        const json = JSON.parse(readFileSync(file, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (json.name === "@clearideas/agent-runtime")
          return json.version ?? "unknown";
      }
      directory = path.dirname(directory);
    }
  } catch {
    // Fall through.
  }
  return "unknown";
};

/** The summarizer's built-in system prompt; absent before context management. */
const SUMMARIZER_SYSTEM_PROMPT = (agentRuntime as Record<string, unknown>)
  .DEFAULT_SUMMARIZER_SYSTEM_PROMPT as string | undefined;

const loadManifest = async (): Promise<
  { manifest: AgentManifest } | { unavailable: string }
> => {
  const needs = `Long Investigation needs an Agent Runtime with context management, newer than the installed @clearideas/agent-runtime ${installedRuntimeVersion()}. Run \`npm run use-local-runtime\` in examples/showcase to use this repository's packages.`;
  if (!SUMMARIZER_SYSTEM_PROMPT) return { unavailable: needs };
  try {
    return {
      manifest: await new FileAgentManifestSource(
        demoDirectory,
        "agent.yaml",
      ).loadManifest(),
    };
  } catch (error) {
    return {
      unavailable: `${needs} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
};
const loaded = await loadManifest();
const unavailable = "unavailable" in loaded ? loaded.unavailable : undefined;
/** A placeholder keeps the page renderable when the demo cannot run. */
const manifest: AgentManifest =
  "manifest" in loaded
    ? loaded.manifest
    : {
        schemaVersion: "1.0",
        steps: [
          {
            id: "investigate",
            name: "Investigate",
            type: "prompt",
            prompt: "",
          },
          { id: "report", name: "Report", type: "prompt", prompt: "" },
        ],
        limits: { maxInputBytes: 40_000 },
      };

const hostConfig = await loadAgentRuntimeConfig(
  path.join(demoDirectory, "runtime.config.yaml"),
);
const runbook = await readFile(path.join(fixtures, "runbook.md"), "utf8");
const logFiles = await readdir(path.join(fixtures, "incident-logs", "logs"));
const logBytes = (
  await Promise.all(
    logFiles.map(
      async (file) =>
        (await stat(path.join(fixtures, "incident-logs", "logs", file))).size,
    ),
  )
).reduce((total, size) => total + size, 0);

/** The strategies the page offers. Off is `fail`: no reduction at all. */
export const STRATEGIES: Array<{
  value: ContextStrategy;
  label: string;
  help: string;
}> = [
  {
    value: "summarize-or-prune",
    label: "Summarize",
    help: "A summarizer model condenses the runbook and older rounds; pruning is the fallback.",
  },
  {
    value: "prune",
    label: "Prune",
    help: "No extra model calls: clip the runbook, stub old tool outputs, drop the oldest rounds.",
  },
  {
    value: "fail",
    label: "Off",
    help: "No reduction: the step fails at the input limit, as it did before context management.",
  },
];

const roots = (context: DemoContext) => ({
  logs: path.join(context.dataDirectory, "incident-logs"),
  runs: path.join(context.dataDirectory, "runs"),
});

// ─── Measuring what the model receives ───────────────────────────────────────
// This wrapper is for the page only: it reports the size and kind of each
// message in every request. It never forwards content.

const encoder = new TextEncoder();
const sizeOf = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).byteLength;

const textOf = (message: ModelMessage) =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

const segmentOf = (message: ModelMessage) => {
  const bytes = sizeOf(message);
  switch (message.role) {
    case "system":
      return { kind: "system", bytes, label: "System prompt" };
    case "user": {
      const text = textOf(message);
      if (text.startsWith("[Summary of earlier work"))
        return { kind: "summary", bytes, label: "Summary of earlier rounds" };
      const removed = /^\[Agent Runtime removed (\d+)/u.exec(text);
      if (removed)
        return {
          kind: "note",
          bytes,
          label: `Note: ${removed[1]} rounds removed`,
        };
      if (text.startsWith("[Agent Runtime]"))
        return { kind: "note", bytes, label: "Runtime note" };
      return { kind: "opening", bytes, label: "Opening prompt" };
    }
    case "assistant": {
      const calls = message.content.flatMap((part) =>
        part.type === "tool-call"
          ? [
              `${part.call.name.split("__").pop()} ${String(part.call.input.path ?? "")}`.trim(),
            ]
          : [],
      );
      return {
        kind: "call",
        bytes,
        label: calls.length > 0 ? calls.join(", ") : "Answer",
      };
    }
    case "tool": {
      const part = message.content[0];
      const result = part?.type === "tool-result" ? part.result : undefined;
      const output = result?.output as Record<string, unknown> | undefined;
      const reduced =
        output && typeof output === "object" ? output.agentRuntime : undefined;
      // A stub keeps a preview of the original output, including its path.
      const stubPath =
        typeof output?.preview === "string"
          ? /"path":"([^"]+)"/u.exec(output.preview)?.[1]
          : undefined;
      const tool = result?.name.split("__").pop() ?? "tool";
      return {
        kind:
          reduced === "omitted"
            ? "stub"
            : reduced === "clipped"
              ? "clipped"
              : "result",
        bytes,
        label:
          typeof output?.path === "string"
            ? output.path
            : (stubPath ?? `${tool} result`),
      };
    }
  }
};

const measured = (
  model: ModelAdapter,
  report: (request: ModelRequest) => void,
): ModelAdapter => ({
  generate: (request) => {
    report(request);
    return model.generate(request);
  },
  ...(model.stream
    ? {
        stream: (request: ModelRequest) => {
          report(request);
          return model.stream!(request);
        },
      }
    : {}),
  ...forwardDescribeModel(model),
});

/** A read_file result without its text, so the page gets sizes and counts. */
const withoutContent = (output: unknown) => {
  if (output && typeof output === "object" && "content" in output) {
    const { content, ...rest } = output as { content: unknown };
    return toJson({
      ...rest,
      contentBytes: encoder.encode(String(content)).byteLength,
    });
  }
  return toJson(output);
};

export const longInvestigation: ShowcaseDemo = {
  id: "long-investigation",
  title: "Long Investigation",
  summary:
    "Explore context pruning and summarization during a long-running investigation.",
  tagline:
    "An on-call agent reads 16 service logs and a long runbook to find an incident's root cause: more than three times its input limit. Agent Runtime prunes or summarizes the opening prompt and older tool rounds before each request would be too large.",
  ...(unavailable ? { unavailable } : {}),
  features: [
    "Context management",
    "Opening-prompt reduction",
    "Tool-loop compaction",
    "Execution policies",
  ],
  sources: [
    {
      path: "demos/long-investigation/agent.yaml",
      language: "yaml",
      caption:
        "The agent: one long investigation step, and its context policy.",
    },
    {
      path: "demos/long-investigation/runtime.config.yaml",
      language: "yaml",
      caption: "Host configuration: the read-only log workspace.",
    },
    {
      path: "demos/long-investigation/host.ts",
      language: "typescript",
      caption:
        "The integration: the host's default context strategy, and a wrapper that measures each request for this page.",
    },
    {
      path: "demos/long-investigation/script.ts",
      language: "typescript",
      caption:
        "Scripted mode only: the model's decisions, and its answers to the summarizer.",
    },
  ],

  async describe() {
    return toJson({
      manifest,
      strategies: STRATEGIES,
      limit: manifest.limits?.maxInputBytes ?? null,
      // The goal line on the chart: the manifest's setting, else the runtime's.
      reduceTo:
        (manifest as { policies?: { context?: { reduceTo?: number } } })
          .policies?.context?.reduceTo ??
        (
          (agentRuntime as Record<string, unknown>).PROMPT_POLICY_DEFAULTS as
            { reduceTo?: number } | undefined
        )?.reduceTo ??
        0.25,
      runbookBytes: encoder.encode(runbook).byteLength,
      logBytes,
      logCount: logFiles.length,
    });
  },

  async state(context) {
    return toJson({
      workspaces: [
        {
          alias: "logs",
          name: "incident-logs",
          mode: "read",
          files: await describeWorkspace({
            root: roots(context).logs,
            fixture: path.join(fixtures, "incident-logs"),
            ...visibilityOf(hostConfig.workspaces["incident-logs"]),
          }),
        },
      ],
    });
  },

  async reset(context) {
    await seedWorkspace(
      path.join(fixtures, "incident-logs"),
      roots(context).logs,
    );
  },

  async run(context, request, emit, signal) {
    if (unavailable) throw new Error(unavailable);
    assertModeAllowed(context.environment, request.mode);
    const strategy =
      STRATEGIES.find((entry) => entry.value === request.options.strategy)
        ?.value ?? STRATEGIES[0]!.value;
    await this.reset!(context);

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
          SHOWCASE_LOGS_ROOT: roots(context).logs,
        },
      },
      {
        model: request.mode === "live" && !context.liveModel,
        workspaceOptions: sandboxProvider ? { sandboxProvider } : {},
      },
    );
    if (!composed.tools) throw new Error("Workspace tools were not composed.");

    let currentStep = "";
    const limit = manifest.limits?.maxInputBytes ?? null;
    const model = measured(
      request.mode === "live"
        ? (context.liveModel?.() ?? composed.model!)
        : new ScriptedModelAdapter(createInvestigationScript(), {
            pace: request.pace,
          }),
      (modelRequest) => {
        const summarizer = modelRequest.messages.some(
          (message) =>
            message.role === "system" &&
            textOf(message) === SUMMARIZER_SYSTEM_PROMPT,
        );
        emit({
          kind: "model-input",
          stepId: currentStep,
          purpose: summarizer ? "summarize" : "step",
          bytes: sizeOf(modelRequest.messages),
          limit,
          segments: summarizer ? [] : modelRequest.messages.map(segmentOf),
        } satisfies ShowcaseMessage);
      },
    );

    // ─── The host's default context strategy ─────────────────────────────────
    // Host defaults are the lowest policy layer: the manifest's `policies`
    // (retain, summarizer, variables) merge over this, field by field.
    //
    // ─── The host's summarizer adapter ───────────────────────────────────────
    // Every summarization passes through the host. This one calls the built-in
    // summarizer (`next`) unchanged and reports sizes to the page; a host can
    // also rewrite the request, redact the material, cache results, or
    // summarize some other way.
    const hostControls = {
      policies: { context: { strategy } },
      summarizer: {
        summarize: async (
          request: {
            stepId: string;
            kind: string;
            label: string;
            text: string;
            targetBytes: number;
          },
          // `never` accepts the runtime's request type without importing it,
          // so this host also type-checks against older runtimes.
          next: (request: never) => Promise<{ text: string }>,
        ) => {
          const result = await next(request as never);
          emit({
            kind: "summarizer",
            stepId: request.stepId,
            summaryKind: request.kind,
            label: request.label,
            inputBytes: encoder.encode(request.text).byteLength,
            targetBytes: request.targetBytes,
            outputBytes: encoder.encode(result.text).byteLength,
          });
          return result;
        },
      },
    };

    const runtime = new AgentRuntime({
      ...composed,
      ...hostControls,
      model,
      // Mirror each tool call to the page without the log text itself: the
      // terminal shows the path and line count; the model gets the content.
      tools: new ObservedToolAdapter(
        composed.tools,
        ({ stepId, call, result }) =>
          emit({
            kind: "tool-io",
            stepId,
            toolCallId: call.id,
            name: call.name,
            input: toJson(call.input),
            ...(result.error
              ? {
                  error: {
                    code: result.error.code,
                    message: result.error.message,
                  },
                }
              : { output: withoutContent(result.output) }),
          }),
      ),
      runStore: new FileRunStore(roots(context).runs),
      stepExecutors: [new PromptStepExecutor()],
      conditionEvaluator: new JexlConditionEvaluator(),
      eventSinks: [
        {
          emit: (event) => {
            if (event.type === "step.started" && event.stepId)
              currentStep = event.stepId;
            emit({ kind: "event", event });
          },
        },
      ],
    });

    const runId = `investigation-${randomUUID()}`;
    emit({
      kind: "accepted",
      runId,
      mode: request.mode,
      sandbox: context.environment.sandbox.kind,
    });
    const result = await runtime.run({
      manifest,
      runId,
      variables: [{ key: "runbook", value: runbook }],
      signal,
    });
    emit({ kind: "result", result: summarizeResult(result) });
  },
};
