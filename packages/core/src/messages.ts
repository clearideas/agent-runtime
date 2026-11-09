/**
 * Conversation messages: the history an agent manifest declares it accepts,
 * a run supplies, and steps read through their `history` setting or the
 * `messages` variable. This module holds everything core does with a history
 * that does not depend on a running AgentRuntime: canonical signing,
 * selection, the variable view, pre-creation validation, and compaction
 * planning.
 */
import {
  conversationMessagesInputSchema,
  MESSAGES_SIGNATURE_ALGORITHM,
  MESSAGES_SIGNATURE_VERSION,
  MESSAGES_VARIABLE,
  messagesMarkerOf,
  type AgentManifest,
  type AgentStep,
  type ArtifactRef,
  type ConversationContentPart,
  type ConversationMessage,
  type ExecutionPolicies,
  type JsonObject,
  type JsonValue,
  type MessagesMarker,
  type MessagesSignature,
  type ModelReference,
  type RunEvent,
  type StatePatch,
  type StepHistory,
  type TranscriptItem,
  type VariableState,
} from "@clearideas/agent-runtime-contracts";

import type {
  ArtifactStore,
  ContextSummarizerAdapter,
  ModelAdapter,
} from "./ports/index.js";
import type { TokenBudgetContext } from "./agent-runtime.js";
import { compilePromptTemplate } from "./templates.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

export type MessagesErrorCode =
  | "MESSAGES_NOT_ACCEPTED"
  | "MESSAGES_REQUIRED"
  | "MESSAGES_INVALID"
  | "MESSAGES_LIMIT_EXCEEDED"
  | "MESSAGES_SIGNATURE_REQUIRED"
  | "MESSAGES_SIGNATURE_INVALID"
  | "MESSAGES_ARTIFACT_UNAUTHORIZED"
  | "MESSAGES_MEDIA_UNSUPPORTED";

/** A supplied history was refused before the run was created. */
export class MessagesValidationError extends Error {
  readonly code: MessagesErrorCode;
  readonly retryable = false;
  /** Machine-readable cause, for example a signature failure reason. */
  readonly reason: string | undefined;

  constructor(code: MessagesErrorCode, message: string, reason?: string) {
    super(message);
    this.name = "MessagesValidationError";
    this.code = code;
    this.reason = reason;
  }
}

// ─── Canonical JSON (RFC 8785) ──────────────────────────────────────────────

/**
 * JSON Canonicalization Scheme (RFC 8785): object keys sorted by UTF-16 code
 * units, no insignificant whitespace, ECMAScript number serialization, and
 * `undefined` object members omitted. Signatures are computed over this
 * text, so other implementations can reproduce them byte for byte.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value))
        throw new Error("Canonical JSON cannot encode a non-finite number.");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value))
        return `[${value
          .map((item) => (item === undefined ? "null" : canonicalJson(item)))
          .join(",")}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
    }
    default:
      throw new Error(`Canonical JSON cannot encode a ${typeof value}.`);
  }
};

// ─── Signing ────────────────────────────────────────────────────────────────

const SIGNING_DOMAIN = "clearideas-agent-runtime/messages/v1\n";
const MINIMUM_SIGNING_KEY_BYTES = 32;

/** The exact text a messages signature authenticates. */
export const messagesSigningPayload = (
  messages: readonly ConversationMessage[],
  scope: string | undefined,
): string =>
  `${SIGNING_DOMAIN}${canonicalJson({
    version: MESSAGES_SIGNATURE_VERSION,
    scope: scope ?? null,
    messages,
  })}`;

export type MessagesVerification =
  | { valid: true }
  | { valid: false; reason: "unknown-key" | "authentication-failed" };

/**
 * Signs and verifies conversation histories. Keys come only from trusted host
 * configuration; hosts that keep keys in a KMS implement this interface.
 */
export interface MessageHistorySigner {
  sign(input: {
    messages: readonly ConversationMessage[];
    scope?: string | undefined;
  }): Promise<MessagesSignature>;
  verify(input: {
    messages: readonly ConversationMessage[];
    scope?: string | undefined;
    signature: MessagesSignature;
  }): Promise<MessagesVerification>;
}

export interface HmacMessageSignerOptions {
  /** The key that signs. It must also appear in `keys`. */
  activeKeyId: string;
  /**
   * Verification keys by id; the active key also signs. String keys use
   * `base64:<base64url>` or `hex:<hex>`. Each key has at least 32 bytes.
   */
  keys: Readonly<Record<string, string | Uint8Array>>;
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** Decode a signing key without accepting ambiguous raw strings. */
export const parseMessageSigningKey = (
  value: string | Uint8Array,
): Uint8Array => {
  let key: Uint8Array;
  if (typeof value !== "string") {
    key = Uint8Array.from(value);
  } else if (value.startsWith("base64:")) {
    const encoded = value.slice("base64:".length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded))
      throw new Error("Base64 message signing keys must use base64url.");
    key = fromBase64Url(encoded);
  } else if (value.startsWith("hex:")) {
    const encoded = value.slice("hex:".length);
    if (!/^(?:[A-Fa-f0-9]{2})+$/u.test(encoded))
      throw new Error("Hex message signing keys must contain hex byte pairs.");
    key = Uint8Array.from(
      encoded.match(/../gu)!.map((pair) => Number.parseInt(pair, 16)),
    );
  } else {
    throw new Error(
      "String message signing keys must start with base64: or hex:.",
    );
  }
  if (key.byteLength < MINIMUM_SIGNING_KEY_BYTES)
    throw new Error(
      `Message signing keys must contain at least ${MINIMUM_SIGNING_KEY_BYTES} bytes.`,
    );
  return key;
};

/** HMAC-SHA-256 signer over RFC 8785 canonical JSON, computed with WebCrypto. */
export const createHmacMessageSigner = (
  options: HmacMessageSignerOptions,
): MessageHistorySigner => {
  const keyBytes = new Map<string, Uint8Array>();
  for (const [id, value] of Object.entries(options.keys)) {
    if (!id) throw new Error("Message signing key ids cannot be empty.");
    keyBytes.set(id, parseMessageSigningKey(value));
  }
  if (!keyBytes.has(options.activeKeyId))
    throw new Error(
      `The active message signing key ${options.activeKeyId} is not configured.`,
    );
  const imported = new Map<string, Promise<CryptoKey>>();
  const cryptoKey = (id: string): Promise<CryptoKey> => {
    let key = imported.get(id);
    if (!key) {
      key = crypto.subtle.importKey(
        "raw",
        keyBytes.get(id)! as Uint8Array<ArrayBuffer>,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
      imported.set(id, key);
    }
    return key;
  };
  const encode = (
    messages: readonly ConversationMessage[],
    scope: string | undefined,
  ): Uint8Array<ArrayBuffer> =>
    new TextEncoder().encode(messagesSigningPayload(messages, scope));

  return {
    async sign({ messages, scope }) {
      const mac = await crypto.subtle.sign(
        "HMAC",
        await cryptoKey(options.activeKeyId),
        encode(messages, scope),
      );
      return {
        version: MESSAGES_SIGNATURE_VERSION,
        algorithm: MESSAGES_SIGNATURE_ALGORITHM,
        keyId: options.activeKeyId,
        count: messages.length,
        value: toBase64Url(new Uint8Array(mac)),
      };
    },
    async verify({ messages, scope, signature }) {
      if (!keyBytes.has(signature.keyId))
        return { valid: false, reason: "unknown-key" };
      if (
        signature.version !== MESSAGES_SIGNATURE_VERSION ||
        signature.algorithm !== MESSAGES_SIGNATURE_ALGORITHM ||
        signature.count !== messages.length
      )
        return { valid: false, reason: "authentication-failed" };
      let mac: Uint8Array;
      try {
        mac = fromBase64Url(signature.value);
      } catch {
        return { valid: false, reason: "authentication-failed" };
      }
      const valid = await crypto.subtle.verify(
        "HMAC",
        await cryptoKey(signature.keyId),
        mac as Uint8Array<ArrayBuffer>,
        encode(messages, scope),
      );
      return valid
        ? { valid: true }
        : { valid: false, reason: "authentication-failed" };
    },
  };
};

// ─── History structure ──────────────────────────────────────────────────────

export const declaresMessages = (manifest: AgentManifest): boolean =>
  manifest.messages != null;

const encoder = new TextEncoder();
/** UTF-8 bytes of a value's JSON, the measure `maxBytes` uses. */
export const historyBytes = (value: unknown): number =>
  encoder.encode(JSON.stringify(value) ?? "").byteLength;

/** The leading runtime marker of a history, when it has one. */
export const historyMarker = (
  history: readonly ConversationMessage[],
): MessagesMarker | undefined => messagesMarkerOf(history[0]);

/**
 * Index where the new turn starts: the trailing `user` messages after the
 * last `assistant` message, never including a leading marker.
 */
export const newTurnStart = (
  history: readonly ConversationMessage[],
): number => {
  const first = historyMarker(history) ? 1 : 0;
  let index = history.length;
  while (index > first && history[index - 1]!.role === "user") index -= 1;
  return index;
};

export const mediaPlaceholder = (
  part: Extract<ConversationContentPart, { type: "image" | "file" }>,
): string => {
  const name =
    (part.type === "file" ? part.name : undefined) ?? part.artifact?.name;
  const mediaType = part.mediaType ?? part.artifact?.mediaType;
  const detail = [name, mediaType ? `(${mediaType})` : undefined]
    .filter(Boolean)
    .join(" ");
  return `[${part.type}${detail ? `: ${detail}` : ""}]`;
};

const partText = (part: ConversationContentPart): string => {
  switch (part.type) {
    case "text":
      return part.text;
    case "json":
      return JSON.stringify(part.value);
    case "image":
    case "file":
      return mediaPlaceholder(part);
  }
};

/** A message as plain text: text parts, stringified JSON, and media placeholders. */
export const messageText = (message: ConversationMessage): string =>
  message.content.map(partText).join("\n");

/** The marker's text without its preamble: the summary, or the note. */
export const markerBody = (message: ConversationMessage): string => {
  const marker = messagesMarkerOf(message);
  const texts = message.content.flatMap((part) =>
    part.type === "text" ? [part.text] : [],
  );
  if (marker?.kind === "summary" && texts.length > 1)
    return texts.slice(1).join("\n");
  return texts.join("\n");
};

// ─── Turns ──────────────────────────────────────────────────────────────────

/** Where one message sits in the whole conversation, across compactions. */
export interface MessagePlace {
  /**
   * The exchange it belongs to. A turn is the user's messages and the reply
   * that completes them: turn N ends with the N-th assistant reply.
   */
  turn: number;
  /** 1-based position among every message the conversation has had. */
  position: number;
}

export interface ConversationTurns {
  /** The turn the next reply completes: the current run's turn. */
  currentTurn: number;
  /** What a leading summary or note stands for, when there is one. */
  summarized: { turns: number; messages: number } | undefined;
  /** One entry per history message; undefined for the leading marker. */
  places: Array<MessagePlace | undefined>;
}

/**
 * Number a history's turns and positions, counting what a leading marker
 * covers, so numbers stay stable across compactions. Hosts can use the same
 * numbers, for example to file a user's upload under its turn.
 */
export const conversationTurns = (
  history: readonly ConversationMessage[],
): ConversationTurns => {
  const marker = historyMarker(history);
  const coveredTurns = marker?.turns ?? 0;
  const coveredMessages = marker?.replaces ?? 0;
  const first = marker ? 1 : 0;
  let replies = 0;
  const places = history.map((message, index) => {
    if (index < first) return undefined;
    const position = coveredMessages + index - first + 1;
    if (message.role === "assistant") {
      replies += 1;
      return { turn: coveredTurns + replies, position };
    }
    return { turn: coveredTurns + replies + 1, position };
  });
  return {
    currentTurn: coveredTurns + replies + 1,
    summarized: marker
      ? { turns: coveredTurns, messages: coveredMessages }
      : undefined,
    places,
  };
};

/** "turn 3" or "turns 1–10". */
export const turnRange = (first: number, last: number): string =>
  first === last ? `turn ${last}` : `turns ${first}–${last}`;

/** A history as plain text, in the format of `messages.text`. */
export const renderHistoryText = (
  messages: readonly ConversationMessage[],
  places: ReadonlyArray<MessagePlace | undefined> = conversationTurns(messages)
    .places,
): string =>
  messages
    .map((message, index) => {
      const marker = index === 0 ? messagesMarkerOf(message) : undefined;
      if (marker?.kind === "summary")
        return `[Summary of ${
          (marker.turns ?? 0) > 0
            ? turnRange(1, marker.turns!)
            : "the earlier conversation"
        }]\n${markerBody(message)}`;
      if (marker?.kind === "note") return markerBody(message);
      const place = places[index];
      return `${message.role}${place ? ` (turn ${place.turn})` : ""}: ${messageText(message)}`;
    })
    .join("\n\n");

// ─── Selection and the messages variable ────────────────────────────────────

/** What one step sees of the effective history. */
export interface HistorySelection {
  /** Marker first when included; media mode applied. */
  messages: ConversationMessage[];
  /** Turn and position of each selected message; undefined for the marker. */
  places: Array<MessagePlace | undefined>;
  /** The current run's turn. */
  currentTurn: number;
  /** What the history's marker covers, whether or not it is selected. */
  summarized: { turns: number; messages: number } | undefined;
  /** The step set `history`. Only then are turns inserted or histories forwarded. */
  explicit: boolean;
  /** Prompt steps insert `messages` as model turns. */
  insert: boolean;
  media: "include" | "latest" | "omit";
}

const applyMediaMode = (
  messages: ConversationMessage[],
  media: HistorySelection["media"],
): ConversationMessage[] => {
  if (media === "include") return messages;
  let keep = -1;
  if (media === "latest") {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (
        messages[index]!.role === "user" &&
        !messagesMarkerOf(messages[index])
      ) {
        keep = index;
        break;
      }
    }
  }
  return messages.map((message, index) =>
    index === keep ||
    !message.content.some(
      (part) => part.type === "image" || part.type === "file",
    )
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type === "image" || part.type === "file"
              ? {
                  type: "text" as const,
                  text: mediaPlaceholder(part),
                  ...(part.metadata ? { metadata: part.metadata } : {}),
                }
              : part,
          ),
        },
  );
};

/** Apply a step's `history` setting to the effective history. */
export const selectHistory = (
  history: readonly ConversationMessage[],
  setting: StepHistory | undefined,
): HistorySelection => {
  const options = setting === "all" ? {} : (setting ?? {});
  const turns = conversationTurns(history);
  const marker = historyMarker(history) ? history[0] : undefined;
  const first = marker ? 1 : 0;
  const start =
    options.last != null
      ? Math.max(first, history.length - options.last)
      : first;
  const includeMarker =
    marker != null && (options.summary ?? options.last == null);
  const media = options.media ?? "include";
  return {
    messages: applyMediaMode(
      structuredClone([
        ...(includeMarker ? [marker] : []),
        ...history.slice(start),
      ]),
      media,
    ),
    places: [
      ...(includeMarker ? [undefined] : []),
      ...turns.places.slice(start),
    ],
    currentTurn: turns.currentTurn,
    summarized: turns.summarized,
    explicit: setting !== undefined,
    insert: setting !== undefined && options.insert !== false,
    media,
  };
};

const roleText = (
  message: ConversationMessage | undefined,
  place: MessagePlace | undefined,
): JsonValue =>
  message
    ? {
        role: message.role,
        text: messageText(message),
        ...(place ? { turn: place.turn, position: place.position } : {}),
      }
    : null;

/** The read-only `messages` variable for one step's selection. */
export const messagesView = (selection: HistorySelection): JsonObject => {
  const hasMarker = messagesMarkerOf(selection.messages[0]) != null;
  const marker = hasMarker ? selection.messages[0] : undefined;
  const all = hasMarker ? selection.messages.slice(1) : selection.messages;
  const places = hasMarker ? selection.places.slice(1) : selection.places;
  let lastUserIndex = all.length - 1;
  while (lastUserIndex >= 0 && all[lastUserIndex]!.role !== "user")
    lastUserIndex -= 1;
  return {
    all: all.map((message, index) => ({
      ...structuredClone(message),
      ...(places[index]
        ? { turn: places[index]!.turn, position: places[index]!.position }
        : {}),
    })) as unknown as JsonValue,
    count: all.length,
    turn: selection.currentTurn,
    last: roleText(all.at(-1), places.at(-1)),
    lastUser:
      lastUserIndex >= 0
        ? roleText(all[lastUserIndex], places[lastUserIndex])
        : null,
    summary: marker ? markerBody(marker) : null,
    summarized: selection.summarized ? { ...selection.summarized } : null,
    text: renderHistoryText(selection.messages, selection.places),
  };
};

const isMessagesKey = (key: string): boolean =>
  key.toLowerCase() === MESSAGES_VARIABLE;

/** Variables with the step's `messages` view, when the manifest declares messages. */
export const withMessagesView = (
  manifest: AgentManifest,
  variables: Readonly<VariableState>,
  selection: HistorySelection | undefined,
): VariableState => {
  const base = withoutMessagesView(manifest, variables);
  if (!declaresMessages(manifest) || !selection) return base;
  return { ...base, [MESSAGES_VARIABLE]: messagesView(selection) };
};

/**
 * Variables without the `messages` view. A no-op for manifests that do not
 * declare messages, where `messages` is an ordinary variable name.
 */
export const withoutMessagesView = (
  manifest: AgentManifest,
  variables: Readonly<VariableState>,
): VariableState => {
  if (!declaresMessages(manifest)) return { ...variables };
  return Object.fromEntries(
    Object.entries(variables).filter(([key]) => !isMessagesKey(key)),
  );
};

/** A state patch that cannot write the `messages` view into run state. */
export const withoutMessagesPatch = (
  manifest: AgentManifest,
  patch: StatePatch | undefined,
): StatePatch | undefined => {
  if (!patch || !declaresMessages(manifest)) return patch;
  const set = patch.set
    ? Object.fromEntries(
        Object.entries(patch.set).filter(([key]) => !isMessagesKey(key)),
      )
    : undefined;
  const unset = patch.unset?.filter(
    (path) => !isMessagesKey(path.split(".")[0]?.trim() ?? ""),
  );
  return {
    ...(set ? { set } : {}),
    ...(unset ? { unset } : {}),
  };
};

/** The output history: the effective history plus the final output as assistant text. */
export const outputHistory = (
  history: readonly ConversationMessage[],
  output: JsonValue | undefined,
): ConversationMessage[] => [
  ...structuredClone(history as ConversationMessage[]),
  ...(output === undefined
    ? []
    : [
        {
          role: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text:
                typeof output === "string" ? output : JSON.stringify(output),
            },
          ],
        },
      ]),
];

// ─── Host options ───────────────────────────────────────────────────────────

export interface ArtifactAuthorizationContext {
  runId: string;
  scope?: string | undefined;
}

/** Host configuration for conversation messages. Never read from a manifest. */
export interface AgentRuntimeMessagesOptions {
  signer?: MessageHistorySigner;
  /** Host-enforced; a manifest cannot relax it. */
  requireSignature?: boolean;
  /**
   * Authorizes artifact references the runtime did not sign or ingest. Without
   * it, such references are rejected.
   */
  authorizeArtifact?(
    ref: ArtifactRef,
    context: ArtifactAuthorizationContext,
  ): boolean | Promise<boolean>;
  /** Largest inline media part accepted for ingestion. Default 10 MiB. */
  maxInlineBytes?: number;
  /** Absolute ceiling on supplied messages. Default 500. */
  maxSuppliedMessages?: number;
  /** Absolute ceiling on supplied history bytes, excluding inline media. Default 2 MB. */
  maxSuppliedBytes?: number;
  /** Run-level compaction. createRuntime wires the prompt package's implementation. */
  compactor?: MessageHistoryCompactor;
}

export const MESSAGES_DEFAULTS = {
  maxInlineBytes: 10 * 1024 * 1024,
  maxSuppliedMessages: 500,
  maxSuppliedBytes: 2_000_000,
} as const;

// ─── Compaction port ────────────────────────────────────────────────────────

export interface MessageHistoryCompactionRequest {
  runId: string;
  manifest: AgentManifest;
  /** The material: the replaced messages rendered as text. */
  text: string;
  /** For example "34 earlier messages". */
  label: string;
  /** What the conversation is about: the manifest description, else its name. */
  task: string;
  /** Bytes of the replaced material. */
  segmentBytes: number;
  /** Most bytes the summary may use: the room left under the target. */
  maxTargetBytes: number;
  /** Effective history policies: host, manifest, messages.context, enforced. */
  policies: ExecutionPolicies;
  model?: ModelAdapter | undefined;
  summarizer?: ContextSummarizerAdapter | undefined;
  tokenBudget?: TokenBudgetContext | undefined;
  /** Completed summarizer calls from an interrupted attempt. */
  journal?: JsonObject | undefined;
  /** Persist progress: the journal and usage items recorded so far. */
  checkpoint(input: {
    journal: JsonObject;
    transcript: TranscriptItem[];
  }): Promise<void>;
  emit(type: string, data?: JsonObject): Promise<RunEvent>;
  signal?: AbortSignal | undefined;
}

export interface MessageHistoryCompactionResult {
  text: string;
  /** Usage items recorded during this attempt, for the run transcript. */
  transcript: TranscriptItem[];
  summarizerCalls: number;
}

/** Summarizes the oldest part of a conversation history, once per run. */
export interface MessageHistoryCompactor {
  summarize(
    request: MessageHistoryCompactionRequest,
  ): Promise<MessageHistoryCompactionResult>;
}

// ─── Compaction planning ────────────────────────────────────────────────────

/** Room kept for a marker while choosing which recent messages stay verbatim. */
const MARKER_RESERVE_BYTES = 1_024;
const MARKER_OVERHEAD_BYTES = 400;

export type HistoryCompactionReason = "message-count" | "input-size";

export interface HistoryCompactionPlan {
  reason: HistoryCompactionReason;
  /** The previous marker plus the older messages it replaces. */
  segment: ConversationMessage[];
  /** Messages kept verbatim: recent messages and the new turn. */
  retained: ConversationMessage[];
  previous: MessagesMarker | undefined;
  /** Messages (excluding a previous marker) the new marker replaces. */
  replacedMessages: number;
  /** Completed turns (assistant replies) among the replaced messages. */
  replacedTurns: number;
  /** Room for the marker under the byte target. */
  markerBytes: number;
}

/** Why a history crosses its declared triggers, if it does. */
export const compactionReason = (
  history: readonly ConversationMessage[],
  manifest: AgentManifest,
): HistoryCompactionReason | undefined => {
  const declaration = manifest.messages;
  if (!declaration) return undefined;
  if (
    declaration.maxMessages != null &&
    history.length > declaration.maxMessages
  )
    return "message-count";
  if (
    declaration.maxBytes != null &&
    historyBytes(history) > declaration.maxBytes
  )
    return "input-size";
  return undefined;
};

/** The new turn alone exceeds a trigger: nothing can make this history fit. */
export const newTurnExceedsTriggers = (
  history: readonly ConversationMessage[],
  manifest: AgentManifest,
): boolean => {
  const declaration = manifest.messages;
  if (!declaration) return false;
  const newTurn = history.slice(newTurnStart(history));
  return (
    (declaration.maxMessages != null &&
      newTurn.length > declaration.maxMessages) ||
    (declaration.maxBytes != null &&
      historyBytes(newTurn) > declaration.maxBytes)
  );
};

/**
 * Choose what one compaction replaces. The new turn is always kept. Recent
 * whole turns are kept, newest first, while the marker, the recent messages,
 * and the new turn fit `reduceTo` of each trigger.
 */
export const planHistoryCompaction = (
  history: readonly ConversationMessage[],
  manifest: AgentManifest,
  reduceTo: number,
): HistoryCompactionPlan | undefined => {
  const reason = compactionReason(history, manifest);
  if (!reason) return undefined;
  const declaration = manifest.messages!;
  const previous = historyMarker(history);
  const first = previous ? 1 : 0;
  const turnStart = newTurnStart(history);
  const newTurn = history.slice(turnStart);
  const middle = history.slice(first, turnStart);
  const countTarget =
    declaration.maxMessages != null
      ? Math.max(
          newTurn.length + 1,
          Math.floor(declaration.maxMessages * reduceTo),
        )
      : Infinity;
  const bytesTarget =
    declaration.maxBytes != null
      ? Math.floor(declaration.maxBytes * reduceTo)
      : Infinity;
  const reserve = Number.isFinite(bytesTarget)
    ? Math.min(MARKER_RESERVE_BYTES, Math.floor(bytesTarget / 4))
    : MARKER_RESERVE_BYTES;
  // Cut only between turns (after a reply), so the marker covers whole turns.
  const endsTurn = (cut: number) =>
    cut === 0 || middle[cut - 1]!.role === "assistant";
  let keep = 0;
  for (let next = 1; next <= middle.length; next += 1) {
    const candidate = [...middle.slice(middle.length - next), ...newTurn];
    if (1 + candidate.length > countTarget) break;
    if (historyBytes(candidate) + reserve > bytesTarget) break;
    if (endsTurn(middle.length - next)) keep = next;
  }
  const recent = keep > 0 ? middle.slice(middle.length - keep) : [];
  const older = middle.slice(0, middle.length - keep);
  if (older.length === 0 && !previous) return undefined;
  const retained = [...recent, ...newTurn];
  const room = Number.isFinite(bytesTarget)
    ? bytesTarget - historyBytes(retained) - MARKER_OVERHEAD_BYTES
    : Infinity;
  return {
    reason,
    segment: history.slice(0, first + older.length),
    retained: structuredClone(retained),
    previous,
    replacedMessages: older.length,
    replacedTurns: older.filter((message) => message.role === "assistant")
      .length,
    markerBytes: Math.max(256, room),
  };
};

/** Manifest wording for compaction markers (`messages.markers`). */
export interface MarkerWording {
  summary?: string | undefined;
  note?: string | undefined;
}

/** Values a marker template can use. */
const markerValues = (turns: number, messages: number): VariableState => ({
  context: {
    firstTurn: turns > 0 ? 1 : 0,
    lastTurn: turns,
    turns: turns > 0 ? (turns === 1 ? "1" : `1–${turns}`) : "",
    messages,
  },
});

const summaryHeading = (
  turns: number,
  messages: number,
  template: string | undefined,
): string =>
  template
    ? compilePromptTemplate(template, markerValues(turns, messages))
    : `[Summary of ${
        turns > 0
          ? `${turnRange(1, turns)} of this conversation`
          : "the earlier conversation"
      }, written by Agent Runtime to fit the context window. It replaces ${messages} earlier messages.]`;

const noteText = (
  turns: number,
  messages: number,
  template: string | undefined,
): string =>
  template
    ? compilePromptTemplate(template, markerValues(turns, messages))
    : turns > 0
      ? `[Agent Runtime removed ${turnRange(1, turns)} (${messages} messages) of this conversation to fit the context window.]`
      : `[Agent Runtime removed ${messages} earlier messages of this conversation to fit the context window.]`;

/** The label a summarizer sees for what it condenses, e.g. "turns 1–10". */
export const compactionLabel = (plan: HistoryCompactionPlan): string => {
  const turns = (plan.previous?.turns ?? 0) + plan.replacedTurns;
  return turns > 0
    ? `${turnRange(1, turns)} of the conversation`
    : `${plan.replacedMessages} earlier messages`;
};

const markerMetadata = (marker: MessagesMarker): JsonObject => ({
  agentRuntime: { messages: { ...marker } },
});

/** A summary marker that replaces the plan's segment. */
export const summaryMarkerMessage = (
  plan: HistoryCompactionPlan,
  summary: string,
  wording: MarkerWording = {},
): ConversationMessage => {
  const marker: MessagesMarker = {
    kind: "summary",
    replaces: (plan.previous?.replaces ?? 0) + plan.replacedMessages,
    turns: (plan.previous?.turns ?? 0) + plan.replacedTurns,
    sequence: (plan.previous?.sequence ?? 0) + 1,
    strategy: "summarize",
  };
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: summaryHeading(marker.turns!, marker.replaces, wording.summary),
      },
      { type: "text", text: summary },
    ],
    metadata: markerMetadata(marker),
  };
};

const clipText = (text: string, maxBytes: number): string => {
  if (historyBytes(text) <= maxBytes) return text;
  const suffix = " [...]";
  let end = text.length;
  while (end > 0 && historyBytes(text.slice(0, end)) + 8 > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return `${text.slice(0, end)}${suffix}`;
};

/**
 * The marker after pruning: an existing summary is kept (clipped to fit) and
 * its count grows; otherwise a note records how many messages were removed.
 */
export const pruneMarkerMessage = (
  plan: HistoryCompactionPlan,
  segmentFirst: ConversationMessage | undefined,
  wording: MarkerWording = {},
): ConversationMessage => {
  const replaces = (plan.previous?.replaces ?? 0) + plan.replacedMessages;
  const turns = (plan.previous?.turns ?? 0) + plan.replacedTurns;
  const sequence = (plan.previous?.sequence ?? 0) + 1;
  if (plan.previous?.kind === "summary" && segmentFirst) {
    const marker: MessagesMarker = {
      kind: "summary",
      replaces,
      turns,
      sequence,
      strategy: "prune",
    };
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: summaryHeading(turns, replaces, wording.summary),
        },
        {
          type: "text",
          text: clipText(markerBody(segmentFirst), plan.markerBytes),
        },
      ],
      metadata: markerMetadata(marker),
    };
  }
  return {
    role: "user",
    content: [{ type: "text", text: noteText(turns, replaces, wording.note) }],
    metadata: markerMetadata({
      kind: "note",
      replaces,
      turns,
      sequence,
      strategy: "prune",
    }),
  };
};

// ─── Validation before the run is created ───────────────────────────────────

export interface PreparedHistory {
  /** Normalized, verified, with inline media ingested: the run record's supplied history. */
  history: ConversationMessage[];
  signedCount: number;
  verified: boolean;
  ingestedArtifacts: number;
  compaction: "pending" | "complete";
}

export interface PrepareHistoryInput {
  runId: string;
  manifest: AgentManifest;
  messages: unknown;
  signature?: MessagesSignature | undefined;
  scope?: string | undefined;
  options: AgentRuntimeMessagesOptions;
  artifacts?: ArtifactStore | undefined;
  /** The effective history context strategy. */
  strategy: string;
  /** Image capability by model key, when the model adapter describes it. */
  describeModel?:
    | ((model: string) => Promise<{ imageInput?: boolean } | undefined>)
    | undefined;
}

const fail = (
  code: MessagesErrorCode,
  message: string,
  reason?: string,
): never => {
  throw new MessagesValidationError(code, message, reason);
};

const withoutInlineData = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutInlineData);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "data" && typeof item === "string"
          ? ""
          : withoutInlineData(item),
      ]),
    );
  }
  return value;
};

const base64Bytes = (value: string): Uint8Array => {
  try {
    const binary = atob(value.replace(/\s+/gu, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return fail(
      "MESSAGES_INVALID",
      "Inline message media must be valid base64.",
    );
  }
};

const modelKey = (reference: ModelReference | undefined): string | undefined =>
  reference == null
    ? undefined
    : "ref" in reference
      ? `ref/${reference.ref}`
      : `${reference.provider}/${reference.model}`;

const promptStepsWithHistory = (
  steps: readonly AgentStep[],
): Array<Extract<AgentStep, { type: "prompt" }>> =>
  steps.flatMap((step) =>
    step.type === "loop"
      ? promptStepsWithHistory(step.steps)
      : step.type === "prompt" && step.history !== undefined
        ? [step]
        : [],
  );

/**
 * Validate a supplied history against the manifest's declaration and host
 * policy, verify its signature, authorize and ingest media, and decide
 * whether it must be compacted. Throws MessagesValidationError before any run
 * state exists. Returns undefined for manifests that do not declare messages.
 */
export const prepareSuppliedHistory = async (
  input: PrepareHistoryInput,
): Promise<PreparedHistory | undefined> => {
  const { manifest, options } = input;
  const declaration = manifest.messages;
  if (!declaration) {
    if (input.messages !== undefined || input.signature !== undefined)
      fail(
        "MESSAGES_NOT_ACCEPTED",
        "Conversation messages were supplied, but the agent manifest does not declare messages.",
      );
    return undefined;
  }

  // Ceilings first, on the raw input, before any parsing work.
  const maxMessages =
    options.maxSuppliedMessages ?? MESSAGES_DEFAULTS.maxSuppliedMessages;
  const maxBytes =
    options.maxSuppliedBytes ?? MESSAGES_DEFAULTS.maxSuppliedBytes;
  if (Array.isArray(input.messages) && input.messages.length > maxMessages)
    fail(
      "MESSAGES_LIMIT_EXCEEDED",
      `The conversation has ${input.messages.length} messages, exceeding the host limit of ${maxMessages}.`,
    );
  if (
    input.messages !== undefined &&
    historyBytes(withoutInlineData(input.messages)) > maxBytes
  )
    fail(
      "MESSAGES_LIMIT_EXCEEDED",
      `The conversation exceeds the host limit of ${maxBytes} bytes.`,
    );

  const parsed = conversationMessagesInputSchema.safeParse(
    input.messages ?? [],
  );
  if (!parsed.success)
    fail(
      "MESSAGES_INVALID",
      `Conversation messages are invalid: ${parsed.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; ")}`,
    );
  const history = structuredClone(parsed.data!);
  if (declaration.required === true && history.length === 0)
    fail(
      "MESSAGES_REQUIRED",
      "The agent requires conversation messages, and none were supplied.",
    );

  // Signature: an exact prefix, then only user messages.
  const required =
    declaration.requireSignature === true || options.requireSignature === true;
  const turnStart = newTurnStart(history);
  let signedCount = 0;
  if (input.signature) {
    const signature = input.signature;
    if (!options.signer)
      fail(
        "MESSAGES_SIGNATURE_INVALID",
        "A conversation signature was supplied, but no message signer is configured.",
        "no-signer",
      );
    if (signature.count > history.length)
      fail(
        "MESSAGES_SIGNATURE_INVALID",
        "The conversation signature covers more messages than were supplied.",
        "authentication-failed",
      );
    const verification = await options.signer!.verify({
      messages: history.slice(0, signature.count),
      scope: input.scope,
      signature,
    });
    if (!verification.valid)
      fail(
        "MESSAGES_SIGNATURE_INVALID",
        `The conversation signature is invalid (${verification.reason}).`,
        verification.reason,
      );
    if (
      history.slice(signature.count).some((message) => message.role !== "user")
    )
      fail(
        "MESSAGES_SIGNATURE_INVALID",
        "Only user messages may follow the signed part of a conversation.",
        "unsigned-assistant",
      );
    signedCount = signature.count;
  } else if (required && turnStart > 0) {
    fail(
      "MESSAGES_SIGNATURE_REQUIRED",
      "The conversation must be signed: only a first turn of user messages may be unsigned.",
    );
  }

  // Media: references need a store, integrity data, and authorization.
  const inline: Array<{ message: number; part: number }> = [];
  for (const [messageIndex, message] of history.entries()) {
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== "image" && part.type !== "file") continue;
      if (part.data !== undefined) {
        if (!input.artifacts)
          fail(
            "MESSAGES_INVALID",
            "Inline message media requires an ArtifactStore.",
          );
        const size = base64Bytes(part.data).byteLength;
        const limit =
          options.maxInlineBytes ?? MESSAGES_DEFAULTS.maxInlineBytes;
        if (size > limit)
          fail(
            "MESSAGES_LIMIT_EXCEEDED",
            `Inline message media is ${size} bytes, exceeding the host limit of ${limit}.`,
          );
        inline.push({ message: messageIndex, part: partIndex });
        continue;
      }
      if (!part.artifact) continue;
      if (!input.artifacts)
        fail(
          "MESSAGES_INVALID",
          "Message media artifact references require an ArtifactStore.",
        );
      if (!part.artifact.sha256)
        fail(
          "MESSAGES_INVALID",
          `Message media artifact ${part.artifact.id} requires sha256.`,
        );
      if (messageIndex < signedCount) continue;
      const authorized = options.authorizeArtifact
        ? await options.authorizeArtifact(part.artifact, {
            runId: input.runId,
            scope: input.scope,
          })
        : false;
      if (authorized !== true)
        fail(
          "MESSAGES_ARTIFACT_UNAUTHORIZED",
          `Message media artifact ${part.artifact.id} is not authorized for this run.`,
        );
    }
  }

  // Declared image capability: a static mismatch fails validation.
  if (input.describeModel) {
    for (const step of promptStepsWithHistory(manifest.steps)) {
      const selection = selectHistory(history, step.history);
      if (!selection.insert || selection.media === "omit") continue;
      const hasImage = selection.messages.some((message) =>
        message.content.some((part) => part.type === "image"),
      );
      if (!hasImage) continue;
      const key = modelKey(step.model ?? manifest.model);
      if (!key) continue;
      const description = await input.describeModel(key).catch(() => undefined);
      if (description?.imageInput === false)
        fail(
          "MESSAGES_MEDIA_UNSUPPORTED",
          `Step ${step.id} would send images to ${key}, which is declared without image input; set history.media to omit.`,
        );
    }
  }

  // Compaction: decided before creation, so strategy fail costs nothing.
  if (newTurnExceedsTriggers(history, manifest))
    fail(
      "MESSAGES_LIMIT_EXCEEDED",
      "The newest user messages alone exceed the conversation's declared limits.",
    );
  const reason = compactionReason(history, manifest);
  if (reason && input.strategy === "fail")
    fail(
      "MESSAGES_LIMIT_EXCEEDED",
      `The conversation exceeds its declared ${reason === "message-count" ? "maxMessages" : "maxBytes"}, and its context strategy is fail.`,
    );

  // Ingest inline media last, so a refused history leaves nothing behind.
  for (const location of inline) {
    const message = history[location.message]!;
    const part = message.content[location.part] as Extract<
      ConversationContentPart,
      { type: "image" | "file" }
    >;
    const ref = await input.artifacts!.put({
      name:
        (part.type === "file" ? part.name : undefined) ??
        `message-${location.message + 1}-part-${location.part + 1}`,
      mediaType: part.mediaType!,
      data: base64Bytes(part.data!),
      metadata: { source: "messages", runId: input.runId },
    });
    const { data: _data, url: _url, ...rest } = part;
    message.content[location.part] = { ...rest, artifact: ref };
  }

  return {
    history,
    signedCount,
    verified: input.signature != null,
    ingestedArtifacts: inline.length,
    compaction: reason ? "pending" : "complete",
  };
};
