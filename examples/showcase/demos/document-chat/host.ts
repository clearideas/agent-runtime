/**
 * Document Chat — a chat about a Word document, built on conversation
 * messages and a workspace per conversation.
 *
 *   agent.yaml           declares `messages` and a `conversation` workspace;
 *                        reads the newest .docx, asks the model for edits,
 *                        and writes the revision, all in the run sandbox
 *   runtime.config.yaml  the conversation workspace and the sandbox
 *   this file            one run per chat turn, and one directory per
 *                        conversation for its files
 *
 * The browser keeps the conversation's history and the host's signature, as
 * in Data Chat. The files stay on the host: an upload is saved in the
 * conversation's directory under the turn it arrives in, the message names
 * it, and each revision the agent writes lands beside it. The history only
 * ever carries text.
 *
 * Read the numbered sections; everything else is demo plumbing.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as agentRuntime from "@clearideas/agent-runtime";
import {
  AgentRuntime,
  CodeStepExecutor,
  composeRuntime,
  FileAgentManifestSource,
  FileArtifactStore,
  FileRunStore,
  JexlConditionEvaluator,
  loadAgentRuntimeConfig,
  PromptStepExecutor,
  type AgentManifest,
  type JsonValue,
  type RunEvent,
  type RunResult,
} from "@clearideas/agent-runtime";

import type { ShowcaseDemo } from "../../lib/demo.ts";
import { readDocx } from "../../lib/docx.ts";
import {
  applySandboxChoice,
  assertModeAllowed,
} from "../../lib/environment.ts";
import {
  mirrorTools,
  summarizeResult,
  toJson,
  withModelOverrides,
} from "../../lib/host-kit.ts";
import { ScriptedModelAdapter } from "../../lib/scripted-model.ts";
import { documentChatScript } from "./script.ts";

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(demoDirectory, "fixture", "proposal.docx");
/** Largest document a message may attach. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Conversation messages arrived in the 0.8.0 runtime. These
 * exports are read through the module namespace, so the showcase still
 * type-checks against runtimes that predate them.
 */
interface Signature {
  keyId: string;
  count: number;
}
interface Signer {
  sign(input: { messages: unknown[]; scope?: string }): Promise<Signature>;
  verify(input: {
    messages: unknown[];
    scope?: string;
    signature: unknown;
  }): Promise<{ valid: boolean; reason?: string }>;
}
const runtimeExports = agentRuntime as unknown as Record<string, unknown>;
const createHmacMessageSigner = runtimeExports.createHmacMessageSigner as
  | ((options: { activeKeyId: string; keys: Record<string, string> }) => Signer)
  | undefined;
const PromptMessageHistoryCompactor =
  runtimeExports.PromptMessageHistoryCompactor as
    (new () => object) | undefined;
const conversationTurns = runtimeExports.conversationTurns as
  ((history: unknown[]) => { currentTurn: number }) | undefined;

const NEEDS_RUNTIME =
  "Document Chat needs an Agent Runtime with conversation messages and turn numbers, newer than the installed @clearideas/agent-runtime. Run `npm run use-local-runtime` in examples/showcase to use this repository's packages.";

// ─── 1. Load the portable agent and the host's configuration ─────────────────
type ChatManifest = AgentManifest & {
  messages: { maxMessages: number; maxBytes: number };
};
const loaded = await (async (): Promise<
  { manifest: ChatManifest } | { unavailable: string }
> => {
  if (
    !createHmacMessageSigner ||
    !PromptMessageHistoryCompactor ||
    !conversationTurns
  )
    return { unavailable: NEEDS_RUNTIME };
  try {
    return {
      manifest: (await new FileAgentManifestSource(
        demoDirectory,
        "agent.yaml",
      ).loadManifest()) as ChatManifest,
    };
  } catch (error) {
    return {
      unavailable: `${NEEDS_RUNTIME} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
})();
const unavailable = "unavailable" in loaded ? loaded.unavailable : undefined;
const manifest: ChatManifest =
  "manifest" in loaded
    ? loaded.manifest
    : ({
        schemaVersion: "1.0",
        messages: { maxMessages: 8, maxBytes: 24000 },
        steps: [
          { id: "read", name: "Read", type: "code" },
          { id: "revise", name: "Revise", type: "prompt", prompt: "" },
          { id: "save", name: "Save", type: "code" },
        ],
      } as unknown as ChatManifest);
const hostConfig = await loadAgentRuntimeConfig(
  path.join(demoDirectory, "runtime.config.yaml"),
);

const SUGGESTIONS = [
  "Tighten the introduction.",
  "Add a short timeline after the plan.",
  "Change the setup estimate to three days.",
  "Add a risks section before the cost.",
  "What have we changed so far?",
  "Rename it to “One review workspace”.",
];

const paths = (dataDirectory: string) => ({
  conversations: path.join(dataDirectory, "conversations"),
  runs: path.join(dataDirectory, "runs"),
  artifacts: path.join(dataDirectory, "artifacts"),
  key: path.join(dataDirectory, "messages-signing.key"),
});

// ─── 2. The host's signing key ───────────────────────────────────────────────
// As in Data Chat: the key belongs to the host. Here the signature also
// decides who may use a conversation's files (section 3).
const signers = new Map<string, Signer>();
const signerFor = async (dataDirectory: string): Promise<Signer> => {
  const existing = signers.get(dataDirectory);
  if (existing) return existing;
  const file = paths(dataDirectory).key;
  if (!existsSync(file)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `hex:${randomBytes(32).toString("hex")}\n`, {
      mode: 0o600,
    });
    await chmod(file, 0o600).catch(() => undefined);
  }
  const signer = createHmacMessageSigner!({
    activeKeyId: "showcase",
    keys: { showcase: (await readFile(file, "utf8")).trim() },
  });
  signers.set(dataDirectory, signer);
  return signer;
};

const CONVERSATION_ID = /^c-[a-f0-9-]{36}$/u;
const scopeOf = (conversation: string) =>
  `showcase/document-chat/${conversation}`;
const directoryOf = (dataDirectory: string, conversation: string) =>
  path.join(paths(dataDirectory).conversations, conversation);

// ─── Files in a conversation's workspace ─────────────────────────────────────

/** turns/NNN/input or turns/NNN/output, then a name the workspace accepts. */
const FILE_PATH =
  /^turns\/(\d{3})\/(input|output)\/([A-Za-z0-9_][A-Za-z0-9._-]*\.docx)$/u;
const turnDirectory = (turn: number) =>
  `turns/${String(turn).padStart(3, "0")}`;

/** An upload's name, reduced to the characters workspace paths allow. */
const safeName = (name: unknown) => {
  const base = path
    .basename(typeof name === "string" ? name : "document.docx")
    .replace(/\.docx$/iu, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9_]+|-+$/gu, "")
    .slice(0, 80);
  return `${base || "document"}.docx`;
};

interface ConversationFile {
  path: string;
  turn: number;
  kind: "input" | "output";
  size: number;
  /** Paragraphs and tables for the preview; null when unreadable. */
  blocks: JsonValue;
}

/** Every document in a conversation's workspace, oldest first. */
const conversationFiles = async (
  directory: string,
): Promise<ConversationFile[]> => {
  const root = path.join(directory, "turns");
  const entries = await readdir(root, { recursive: true }).catch(() => []);
  const files: ConversationFile[] = [];
  for (const entry of entries) {
    const relative = `turns/${String(entry).split(path.sep).join("/")}`;
    const match = FILE_PATH.exec(relative);
    if (!match) continue;
    const bytes = await readFile(path.join(directory, relative));
    let blocks: JsonValue = null;
    try {
      blocks = toJson(readDocx(bytes));
    } catch {
      // Shown without a preview.
    }
    files.push({
      path: relative,
      turn: Number(match[1]),
      kind: match[2] as "input" | "output",
      size: bytes.length,
      blocks,
    });
  }
  return files.sort(
    (left, right) =>
      left.turn - right.turn ||
      Number(left.kind === "output") - Number(right.kind === "output") ||
      left.path.localeCompare(right.path),
  );
};

/** The conversation's files as the stage's host-files panel shows them. */
const hostView = (files: ConversationFile[]) => {
  const latest = files.at(-1)?.turn;
  return [
    {
      alias: "files",
      name: "conversation",
      mode: "read_write",
      files: files.map((file) => ({
        path: file.path,
        size: file.size,
        visible: true,
        status:
          file.turn === latest && file.kind === "output"
            ? "created"
            : "unchanged",
      })),
    },
  ];
};

const sendFile = (response: ServerResponse, name: string, data: Buffer) => {
  response.writeHead(200, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-type":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "content-disposition": `attachment; filename="${name}"`,
  });
  response.end(data);
};

/** A refusal raised before the run exists (MESSAGES_* codes). */
const conversationRefusal = (error: unknown) => {
  const typed = error as {
    code?: unknown;
    reason?: unknown;
    message?: unknown;
  };
  return typeof typed.code === "string" && typed.code.startsWith("MESSAGES_")
    ? {
        code: typed.code,
        ...(typeof typed.reason === "string" ? { reason: typed.reason } : {}),
        message: String(typed.message),
      }
    : undefined;
};

export const documentChat: ShowcaseDemo = {
  id: "document-chat",
  title: "Document Chat",
  summary:
    "Edit a Word document by chatting; every file stays in the conversation's workspace.",
  tagline:
    "A chat about a Word document, one run per message: the newest version is read and rewritten as a real .docx inside the run sandbox, and every file stays in a workspace the host keeps for the conversation, filed by turn.",
  features: [
    "Conversation messages",
    "Workspace per conversation",
    "Turn numbers",
    "Real .docx in the sandbox",
    "History compaction",
    "Signed history",
  ],
  ...(unavailable ? { unavailable } : {}),
  // An uploaded document travels in the request, base64-encoded.
  maxRequestBytes: 8 * 1024 * 1024,
  sources: [
    {
      path: "demos/document-chat/agent.yaml",
      language: "yaml",
      caption:
        "The portable agent: it declares messages and a conversation workspace, reads the .docx, asks for edits, and writes the revision.",
    },
    {
      path: "demos/document-chat/runtime.config.yaml",
      language: "yaml",
      caption:
        "Host configuration: the conversation workspace, whose directory the host chooses per run, and the sandbox.",
    },
    {
      path: "demos/document-chat/host.ts",
      language: "typescript",
      caption:
        "The integration: one run per chat turn, one directory per conversation, uploads filed by turn.",
    },
    {
      path: "demos/document-chat/script.ts",
      language: "typescript",
      caption:
        "Scripted mode only: the model's edits, computed from the numbered paragraphs and the conversation.",
    },
  ],

  async describe(context) {
    return toJson({
      manifest,
      suggestions: SUGGESTIONS,
      sample: {
        name: "proposal.docx",
        url: "/api/demos/document-chat/sample",
      },
      maxUploadBytes: MAX_UPLOAD_BYTES,
      limits: {
        maxMessages: manifest.messages.maxMessages,
        maxBytes: manifest.messages.maxBytes,
      },
      conversationsRoot: paths(context.dataDirectory).conversations,
    });
  },

  /** The files of the conversation the page shows (?conversation=c-…). */
  async state(context, url) {
    const conversation = url.searchParams.get("conversation") ?? "";
    if (!CONVERSATION_ID.test(conversation))
      return { workspaces: [], files: [] };
    const files = await conversationFiles(
      directoryOf(context.dataDirectory, conversation),
    );
    return toJson({ workspaces: hostView(files), files });
  },

  async reset(context) {
    await rm(paths(context.dataDirectory).conversations, {
      recursive: true,
      force: true,
    });
  },

  /**
   * The sample document, and downloads of a conversation's files. Here the
   * conversation ID is the browser's key to its files; a production host
   * checks that the conversation belongs to the signed-in user.
   */
  async route(context, request, response, url) {
    if (request.method !== "GET") return false;
    if (url.pathname === "/api/demos/document-chat/sample") {
      sendFile(response, "proposal.docx", await readFile(SAMPLE));
      return true;
    }
    if (url.pathname !== "/api/demos/document-chat/files") return false;
    const conversation = url.searchParams.get("conversation") ?? "";
    const file = url.searchParams.get("path") ?? "";
    const match = FILE_PATH.exec(file);
    const bytes =
      CONVERSATION_ID.test(conversation) && match
        ? await readFile(
            path.join(directoryOf(context.dataDirectory, conversation), file),
          ).catch(() => undefined)
        : undefined;
    if (!bytes) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unknown file." }));
      return true;
    }
    sendFile(response, match![3]!, bytes);
    return true;
  },

  async run(context, request, emit, signal) {
    if (unavailable) throw new Error(unavailable);
    assertModeAllowed(context.environment, request.mode);
    const { options } = request;
    let text =
      typeof options.text === "string"
        ? options.text.trim().slice(0, 2000)
        : "";
    if (!text) throw new Error("Type a message first.");
    const history = Array.isArray(options.messages) ? options.messages : [];
    const signer = await signerFor(context.dataDirectory);

    // ─── 3. Which conversation, and may this request use its files? ─────────
    // A first message starts a new conversation with a new directory. A later
    // message names its conversation, and the host opens that directory only
    // for a history it signed for that conversation: a replayed or edited
    // history cannot read or add files. Agent Runtime checks the signature
    // again when the run is created.
    let conversation = `c-${randomUUID()}`;
    if (history.length > 0) {
      const claimed = String(options.conversationId ?? "");
      const verification =
        CONVERSATION_ID.test(claimed) && options.signature
          ? await signer.verify({
              messages: history,
              scope: scopeOf(claimed),
              signature: options.signature,
            })
          : { valid: false, reason: "authentication-failed" };
      if (!verification.valid) {
        emit({
          kind: "conversation-rejected",
          code: options.signature
            ? "MESSAGES_SIGNATURE_INVALID"
            : "MESSAGES_SIGNATURE_REQUIRED",
          ...(verification.reason ? { reason: verification.reason } : {}),
          message:
            "The host did not sign this history for this conversation, so it will not open the conversation's files.",
        });
        return;
      }
      conversation = claimed;
    }
    const scope = scopeOf(conversation);
    const directory = directoryOf(context.dataDirectory, conversation);

    // ─── 4. File an upload under the turn it arrives in ──────────────────────
    // Agent Runtime numbers turns from the history alone: the reply to this
    // message will complete turn `currentTurn`. The message names the file;
    // the bytes never enter the history.
    const turn = conversationTurns!(history).currentTurn;
    const upload = options.upload as
      { name?: unknown; data?: unknown } | undefined;
    if (upload && typeof upload.data === "string") {
      const bytes = Buffer.from(upload.data, "base64");
      if (bytes.length > MAX_UPLOAD_BYTES)
        throw new Error("The document is larger than 5 MB.");
      try {
        readDocx(bytes);
      } catch {
        throw new Error("That file is not a Word document (.docx).");
      }
      const file = `${turnDirectory(turn)}/input/${safeName(upload.name)}`;
      await mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await writeFile(path.join(directory, file), bytes);
      text += `\n\n[Attached: ${file}]`;
    } else if ((await conversationFiles(directory)).length === 0) {
      throw new Error("Attach a Word document (.docx) to start.");
    }

    // ─── 5. Compose adapters, with this conversation's directory ─────────────
    // The manifest names the workspace "conversation"; this run binds it to
    // the conversation's own directory.
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
          SHOWCASE_CONVERSATION_ROOT: directory,
        },
      },
      {
        model: request.mode === "live" && !context.liveModel,
        workspaceOptions: sandboxProvider ? { sandboxProvider } : {},
      },
    );
    if (!composed.tools) throw new Error("Workspace tools were not composed.");

    const runId = `doc-${randomUUID()}`;
    let accepted = false;
    const forward = (event: RunEvent) => {
      if (!accepted) {
        accepted = true;
        emit({
          kind: "accepted",
          runId,
          mode: request.mode,
          sandbox: context.environment.sandbox.kind,
        });
      }
      emit({ kind: "event", event });
    };

    const runtime = new AgentRuntime({
      ...composed,
      model:
        request.mode === "live"
          ? (context.liveModel?.() ?? composed.model!)
          : new ScriptedModelAdapter(documentChatScript, {
              pace: request.pace,
            }),
      tools: mirrorTools(composed.tools, emit),
      runStore: new FileRunStore(paths(context.dataDirectory).runs),
      artifacts: new FileArtifactStore(paths(context.dataDirectory).artifacts),
      stepExecutors: [new PromptStepExecutor(), new CodeStepExecutor()],
      conditionEvaluator: new JexlConditionEvaluator(),
      eventSinks: [{ emit: forward }],
      messages: {
        signer,
        compactor: new PromptMessageHistoryCompactor!(),
      },
    } as unknown as ConstructorParameters<typeof AgentRuntime>[0]);

    // ─── 6. One run per turn: the history so far, plus the new message ───────
    let result: RunResult;
    try {
      result = await runtime.run({
        manifest,
        runId,
        messages: [...history, { role: "user", content: text }],
        ...(options.signature ? { messagesSignature: options.signature } : {}),
        messagesScope: scope,
        signal,
      } as Parameters<AgentRuntime["run"]>[0]);
    } catch (error) {
      const refusal = conversationRefusal(error);
      if (!refusal) throw error;
      emit({ kind: "conversation-rejected", ...refusal });
      return;
    }

    // ─── 7. Return the reply, the signed history, and the files ──────────────
    const returned = result as RunResult & {
      messages?: JsonValue[];
      messagesSignature?: JsonValue;
    };
    const files = await conversationFiles(directory);
    emit({
      kind: "conversation",
      conversationId: conversation,
      scope,
      messages: toJson(returned.messages ?? []),
      signature: toJson(returned.messagesSignature ?? null),
      files: toJson(files),
    });
    emit({ kind: "result", result: summarizeResult(result) });
  },
};
