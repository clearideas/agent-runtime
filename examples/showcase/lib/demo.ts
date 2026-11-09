/**
 * The small contract every showcase demo implements. server.ts turns it into
 * HTTP routes; each demo's host.ts is the part worth reading.
 */
import type { JsonValue, RunEvent } from "@clearideas/agent-runtime";

import type { ModelMode, ShowcaseEnvironment } from "./environment.ts";

/** Messages streamed to the browser as newline-delimited JSON. */
export type ShowcaseMessage =
  | {
      kind: "accepted";
      runId: string;
      mode: ModelMode;
      sandbox: ShowcaseEnvironment["sandbox"]["kind"];
      /** Set when this stream continues a paused run. */
      resumed?: boolean;
    }
  /** An Agent Runtime event, unchanged. */
  | { kind: "event"; event: RunEvent }
  /** Tool input and output mirrored by the host (events carry names only). */
  | {
      kind: "tool-io";
      stepId: string;
      toolCallId: string;
      name: string;
      input: JsonValue;
      output?: JsonValue;
      error?: { code: string; message: string };
      /** Artifact references, e.g. an image returned by read_file. */
      artifacts?: JsonValue;
    }
  /** A host-side check made before the run starts (Guardrails). */
  | {
      kind: "preflight";
      title: string;
      outcome: "refused" | "removed" | "verified" | "accepted";
      /** A few words for the board; `detail` has the full message. */
      label: string;
      detail: string;
      /** The tool name the model would use, when a tool was removed. */
      removedTool?: string;
    }
  /** Which execution engine runs the agent, and where (Orchestration). */
  | { kind: "engine"; engine: string; providerData?: JsonValue }
  /** Whether anything reached the host's canary listener (Guardrails). */
  | { kind: "canary"; hit: boolean; url: string; path?: string }
  /**
   * One model request as the host measured it (Long Investigation): sizes and
   * kinds only, never content, so the page can chart the context window.
   */
  | {
      kind: "model-input";
      stepId: string;
      /** "step" for the step's own request, "summarize" for the summarizer. */
      purpose: "step" | "summarize";
      bytes: number;
      limit: number | null;
      segments: Array<{ kind: string; bytes: number; label: string }>;
    }
  /** One summarization, as the host's summarizer adapter saw it (sizes only). */
  | {
      kind: "summarizer";
      stepId: string;
      /** input, transcript, or tool-result */
      summaryKind: string;
      label: string;
      inputBytes: number;
      targetBytes: number;
      outputBytes: number;
    }
  /**
   * The conversation after one chat turn (Data Chat, Document Chat): the
   * history with the reply appended and its signature, for the browser to
   * keep and send back.
   */
  | {
      kind: "conversation";
      conversationId: string;
      scope: string;
      messages: JsonValue;
      signature: JsonValue;
      /** The moderation step's verdict for the newest message. */
      moderation?: JsonValue;
      /** Images the run produced, such as a chart, with their display URLs. */
      artifacts?: JsonValue;
      /** The conversation's workspace files after the turn (Document Chat). */
      files?: JsonValue;
    }
  /** A history refused before any run was created (MESSAGES_* codes). */
  | {
      kind: "conversation-rejected";
      code: string;
      reason?: string;
      message: string;
    }
  | { kind: "result"; result: JsonValue }
  | { kind: "error"; error: { message: string; cancelled: boolean } };

export interface DemoRunRequest {
  mode: ModelMode;
  /** Pace multiplier for the scripted model; 0 in tests. */
  pace: number;
  /** Demo-specific options from the browser, validated by the demo. */
  options: Record<string, unknown>;
}

export interface DemoContext {
  environment: ShowcaseEnvironment;
  /** Private, writable directory for this demo's stores and workspaces. */
  dataDirectory: string;
  /** This server's base URL, e.g. for worker callbacks. */
  serverUrl(): string;
  /**
   * Tests only: a model to use in Live mode instead of the configured
   * provider, so the live code path runs without network access.
   */
  liveModel?: () => import("@clearideas/agent-runtime").ModelAdapter;
}

export interface SourceFile {
  /** Tab label and path relative to the showcase directory. */
  path: string;
  language: "yaml" | "typescript" | "python" | "plaintext";
  /** One sentence explaining why this file matters. */
  caption: string;
}

export interface ShowcaseDemo {
  id: string;
  title: string;
  /** One short sentence for the gallery card. */
  summary: string;
  tagline: string;
  features: string[];
  /**
   * Set when the installed Agent Runtime cannot run this demo (for example,
   * an older published version); the gallery and page show the reason.
   */
  unavailable?: string;
  /** Largest run request body; defaults to 256 KiB. */
  maxRequestBytes?: number;
  /** Source files shown under "How it's built". */
  sources: SourceFile[];
  /** Agent manifest and run defaults for the browser. */
  describe(context: DemoContext): Promise<JsonValue>;
  /**
   * Optional live host-side state, such as a workspace listing. The page may
   * add query parameters, such as the conversation it shows.
   */
  state?(context: DemoContext, url: URL): Promise<JsonValue>;
  reset?(context: DemoContext): Promise<void>;
  /** Extra HTTP routes (e.g. worker callbacks). Return true when handled. */
  route?(
    context: DemoContext,
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    url: URL,
  ): Promise<boolean>;
  /** Release resources such as worker processes when the server stops. */
  close?(): Promise<void>;
  /** Bytes of an artifact produced during a run, for display. */
  artifact?(
    context: DemoContext,
    artifactId: string,
  ): Promise<{ mediaType: string; data: Uint8Array } | undefined>;
  /** Continue a paused run; the browser sends the decision or new budget. */
  resume?(
    context: DemoContext,
    runId: string,
    request: DemoRunRequest,
    emit: (message: ShowcaseMessage) => void,
    signal: AbortSignal,
  ): Promise<void>;
  run(
    context: DemoContext,
    request: DemoRunRequest,
    emit: (message: ShowcaseMessage) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
