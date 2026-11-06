/**
 * Document Library — a read-only workspace next to an MCP tool.
 *
 *   agent.yaml           binds the library read-only and the ticket system
 *   runtime.config.yaml  which files are published, and where tickets go
 *   this file            composes both tool sources and keeps the artifacts
 *
 * Workspace tools and MCP tools arrive through one ToolAdapter: composeRuntime
 * merges them, and the model sees a single list of tools.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentRuntime,
  composeRuntime,
  FileAgentManifestSource,
  FileArtifactStore,
  FileRunStore,
  JexlConditionEvaluator,
  loadAgentRuntimeConfig,
  PromptStepExecutor,
  type ArtifactRef,
} from "@clearideas/agent-runtime";

import type { DemoContext, ShowcaseDemo } from "../../lib/demo.ts";
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
import { startMcpServer } from "../../lib/mcp-server.ts";
import { ScriptedModelAdapter } from "../../lib/scripted-model.ts";
import { describeWorkspace, seedWorkspace } from "../../lib/workspace-files.ts";
import { documentLibraryScript } from "./script.ts";

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(demoDirectory, "fixture", "policy-library");

export const QUESTIONS = [
  "How many days of annual leave do I get?",
  "How does expense approval work?",
  "Is there a home-office stipend?",
];

const manifest = await new FileAgentManifestSource(
  demoDirectory,
  "agent.yaml",
).loadManifest();
const hostConfig = await loadAgentRuntimeConfig(
  path.join(demoDirectory, "runtime.config.yaml"),
);
const libraryDefinition = hostConfig.workspaces["policy-library"];

const paths = (context: DemoContext) => ({
  library: path.join(context.dataDirectory, "policy-library"),
  artifacts: path.join(context.dataDirectory, "artifacts"),
});

/** Artifact references seen in tool results, so the page can show them. */
const artifactRefs = new Map<string, ArtifactRef>();
let ticketNumber = 1041;

export const documentLibrary: ShowcaseDemo = {
  id: "document-library",
  title: "Document Library",
  summary:
    "Answer questions from documents the agent can read but never change.",
  tagline:
    "A policy assistant searches a read-only library, looks at a diagram as an image, and files a ticket through an MCP server when no published policy has the answer.",
  features: [
    "Read-only workspaces",
    "Visibility globs",
    "Image artifacts",
    "MCP tools",
  ],
  sources: [
    {
      path: "demos/document-library/agent.yaml",
      language: "yaml",
      caption: "The agent: research with workspace and MCP tools, then reply.",
    },
    {
      path: "demos/document-library/runtime.config.yaml",
      language: "yaml",
      caption:
        "Host configuration: which library files are published, and the ticket system.",
    },
    {
      path: "demos/document-library/host.ts",
      language: "typescript",
      caption:
        "The integration: one composed ToolAdapter and an ArtifactStore for images.",
    },
    {
      path: "demos/document-library/script.ts",
      language: "typescript",
      caption: "Scripted mode only: the model's decisions.",
    },
  ],

  async describe() {
    return toJson({ manifest, questions: QUESTIONS });
  },

  async state(context) {
    return toJson({
      workspaces: [
        {
          alias: "library",
          name: "policy-library",
          mode: "read",
          files: await describeWorkspace({
            root: paths(context).library,
            fixture,
            ...visibilityOf(libraryDefinition),
          }),
        },
      ],
    });
  },

  async reset(context) {
    const library = paths(context).library;
    await seedWorkspace(fixture, library);
    // Made at seed time: a version-control folder is never addressable.
    await mkdir(path.join(library, ".git"), { recursive: true });
    await writeFile(
      path.join(library, ".git", "HEAD"),
      "ref: refs/heads/main\n",
    );
  },

  async artifact(context, artifactId) {
    const ref = artifactRefs.get(artifactId);
    if (!ref) return undefined;
    const { data } = await new FileArtifactStore(paths(context).artifacts).get(
      ref,
    );
    return { mediaType: ref.mediaType, data };
  },

  async run(context, request, emit, signal) {
    assertModeAllowed(context.environment, request.mode);
    const question =
      typeof request.options.question === "string" &&
      QUESTIONS.includes(request.options.question)
        ? request.options.question
        : QUESTIONS[0]!;
    await this.reset!(context);

    // The ticket system is an ordinary MCP server; here, a local stand-in.
    const tickets = await startMcpServer("tickets", [
      {
        name: "create",
        description: "Create a ticket for People Operations.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            details: { type: "string" },
          },
          required: ["title", "details"],
          additionalProperties: false,
        },
        call: () => ({ id: `PEOPLE-${++ticketNumber}`, status: "open" }),
      },
    ]);

    try {
      const { config, sandboxProvider } = applySandboxChoice(
        withModelOverrides(hostConfig),
        context.environment.sandbox,
      );

      // ─── 1. Compose workspace tools and MCP tools together ─────────────────
      const composed = composeRuntime(
        manifest,
        config,
        {
          environment: {
            ...process.env,
            SHOWCASE_LIBRARY_ROOT: paths(context).library,
            SHOWCASE_TICKETS_URL: tickets.url,
          },
        },
        {
          model: request.mode === "live" && !context.liveModel,
          workspaceOptions: sandboxProvider ? { sandboxProvider } : {},
          toolOptions: {
            // MCP calls pass their own host hook; this one only allows
            // creating tickets.
            authorizeTool({ toolName }) {
              if (toolName !== "create")
                throw new Error(`${toolName} is not allowed.`);
            },
          },
        },
      );
      if (!composed.tools) throw new Error("Tools were not composed.");

      // ─── 2. An ArtifactStore for binary files ──────────────────────────────
      // read_file never returns base64. Binary files are stored as artifacts
      // and attached to the tool result; multimodal models receive the image.
      const runtime = new AgentRuntime({
        ...composed,
        model:
          request.mode === "live"
            ? (context.liveModel?.() ?? composed.model!)
            : new ScriptedModelAdapter(documentLibraryScript, {
                pace: request.pace,
              }),
        tools: mirrorTools(composed.tools, (message) => {
          if (message.kind === "tool-io" && Array.isArray(message.artifacts))
            for (const ref of message.artifacts as unknown as ArtifactRef[])
              artifactRefs.set(ref.id, ref);
          emit(message);
        }),
        artifacts: new FileArtifactStore(paths(context).artifacts),
        runStore: new FileRunStore(path.join(context.dataDirectory, "runs")),
        stepExecutors: [new PromptStepExecutor()],
        conditionEvaluator: new JexlConditionEvaluator(),
        eventSinks: [{ emit: (event) => emit({ kind: "event", event }) }],
      });

      const runId = `library-${randomUUID()}`;
      emit({
        kind: "accepted",
        runId,
        mode: request.mode,
        sandbox: context.environment.sandbox.kind,
      });
      const result = await runtime.run({
        manifest,
        runId,
        variables: [{ key: "question", value: question }],
        signal,
      });
      emit({ kind: "result", result: summarizeResult(result) });
    } finally {
      await tickets.close();
    }
  },
};
