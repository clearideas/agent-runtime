/**
 * The conversation ledger maps what a chat client sends back to the history
 * the runtime issued, so a returning conversation continues from the
 * runtime's own signed, compacted history instead of the client's copy.
 *
 * Keys are content addresses of the client-visible conversation; values are
 * the runtime's output history. A client that resends exactly what it was
 * shown finds its entry. A client that changed anything does not, and is
 * handled by the operator's `onUnrecognized` policy.
 */
import { createHash } from "node:crypto";

import type {
  ConversationContentPart,
  ConversationMessage,
  MessagesSignature,
} from "@clearideas/agent-runtime-contracts";
import { canonicalJson } from "@clearideas/agent-runtime-core";

import type { KeyValueStore } from "./kv.js";

const LEDGER_NAMESPACE = "ledger:v1";

export type LedgerMatch = "exact" | "user-turns";

type ProjectedPart =
  | { text: string }
  | { json: unknown }
  | { media: "image" | "file"; source: string };

interface ProjectedMessage {
  role: "user" | "assistant";
  parts: ProjectedPart[];
}

const normalizeText = (text: string): string =>
  text.replace(/\r\n?/gu, "\n").replace(/[ \t\n]+$/u, "");

const projectPart = (
  part: ConversationContentPart,
): ProjectedPart | undefined => {
  switch (part.type) {
    case "text": {
      const text = normalizeText(part.text);
      return text ? { text } : undefined;
    }
    case "json":
      return { json: part.value };
    case "image":
    case "file":
      return {
        media: part.type,
        source: part.artifact?.sha256
          ? `sha256:${part.artifact.sha256}`
          : part.url
            ? `url:${part.url}`
            : `ref:${part.artifact?.id ?? ""}`,
      };
  }
};

/**
 * The client-visible form of a conversation: roles, normalized text, and
 * media by content. With `user-turns`, assistant text is ignored, so a
 * client that rewrites replies still matches.
 */
export const projectConversation = (
  messages: readonly ConversationMessage[],
  match: LedgerMatch,
): ProjectedMessage[] =>
  messages.map((message) => ({
    role: message.role,
    parts:
      match === "user-turns" && message.role === "assistant"
        ? []
        : message.content.flatMap((part) => {
            const projected = projectPart(part);
            return projected ? [projected] : [];
          }),
  }));

export const ledgerKey = (input: {
  scope: string;
  model: string;
  match: LedgerMatch;
  messages: readonly ConversationMessage[];
}): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        version: 1,
        scope: input.scope,
        model: input.model,
        match: input.match,
        conversation: projectConversation(input.messages, input.match),
      }),
    )
    .digest("hex");

export interface LedgerEntry {
  /** The runtime's output history: what the next turn continues from. */
  history: ConversationMessage[];
  signature?: MessagesSignature;
  scope: string;
  runId: string;
  model: string;
  manifestHash: string;
  createdAt: string;
}

export class ConversationLedger {
  readonly #store: KeyValueStore;
  readonly #ttlMs: number;
  readonly #match: LedgerMatch;

  constructor(
    store: KeyValueStore,
    options: { ttlMs: number; match: LedgerMatch },
  ) {
    this.#store = store;
    this.#ttlMs = options.ttlMs;
    this.#match = options.match;
  }

  /** Remove a bounded batch of expired entries, including unread histories. */
  async sweepExpired(limit = 1_000): Promise<number> {
    return (await this.#store.takeExpired(LEDGER_NAMESPACE, limit)).length;
  }

  get match(): LedgerMatch {
    return this.#match;
  }

  /** The runtime history issued for this client-visible conversation, if any. */
  async lookup(input: {
    scope: string;
    model: string;
    messages: readonly ConversationMessage[];
  }): Promise<LedgerEntry | undefined> {
    const value = await this.#store.get(
      LEDGER_NAMESPACE,
      ledgerKey({ ...input, match: this.#match }),
    );
    if (!value) return undefined;
    const entry = JSON.parse(value) as LedgerEntry;
    // Defence in depth: the scope is part of the key, and must also match.
    return entry.scope === input.scope && entry.model === input.model
      ? entry
      : undefined;
  }

  /** Record the history issued after the client-visible conversation `messages`. */
  async record(input: {
    messages: readonly ConversationMessage[];
    entry: LedgerEntry;
  }): Promise<void> {
    await this.#store.set(
      LEDGER_NAMESPACE,
      ledgerKey({
        scope: input.entry.scope,
        model: input.entry.model,
        match: this.#match,
        messages: input.messages,
      }),
      JSON.stringify(input.entry),
      this.#ttlMs,
    );
  }
}
