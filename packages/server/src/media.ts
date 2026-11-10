/**
 * Media from chat requests. Inline images and files are stored once per
 * scope, addressed by content: the same bytes always map to the same
 * artifact reference, so media a client resends every turn is stored once.
 * The runtime receives references, never bytes, and accepts only the
 * references this server minted for the request's scope.
 */
import { createHash } from "node:crypto";

import type {
  ArtifactRef,
  ConversationContentPart,
} from "@clearideas/agent-runtime-contracts";
import type { ArtifactStore } from "@clearideas/agent-runtime-core";

import { invalidRequest, ServerError } from "./errors.js";
import type { KeyValueStore } from "./kv.js";

const MEDIA_NAMESPACE = "media:v1";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export interface MediaPolicy {
  /** Largest decoded inline part, in bytes. */
  maxInlineBytes: number;
  urls: "reject" | "allow";
  /** Origins such as https://images.example.com that `allow` admits. */
  allowOrigins: readonly string[];
  /** How long an index entry lives after its last use. */
  ttlMs: number;
}

interface DecodedDataUrl {
  mediaType: string;
  bytes: Buffer;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

export const parseDataUrl = (value: string): DecodedDataUrl | undefined => {
  const match = /^data:([^;,]+)((?:;[^;,]+)*),(.*)$/su.exec(value);
  if (!match) return undefined;
  const parameters = match[2]!.split(";").filter(Boolean);
  if (!parameters.includes("base64")) {
    throw invalidRequest("Inline media must be a base64 data URL.", "messages");
  }
  const payload = match[3]!.replace(/\s+/gu, "");
  if (!BASE64.test(payload) || payload.length % 4 === 1) {
    throw invalidRequest("Inline media is not valid base64.", "messages");
  }
  return {
    mediaType: match[1]!.trim().toLowerCase(),
    bytes: Buffer.from(payload, "base64"),
  };
};

const indexKey = (scope: string, sha256: string, mediaType: string): string =>
  `${scope}\u0000content\u0000${sha256}\u0000${mediaType}`;
const mintKey = (scope: string, id: string): string =>
  `${scope}\u0000minted\u0000${id}`;

export class MediaIngestor {
  readonly #index: KeyValueStore;
  readonly #policy: MediaPolicy;

  constructor(index: KeyValueStore, policy: MediaPolicy) {
    this.#index = index;
    this.#policy = policy;
  }

  /** Remove a bounded batch of expired entries, including unread histories. */
  async sweepExpired(limit = 1_000): Promise<number> {
    return (await this.#index.takeExpired(MEDIA_NAMESPACE, limit)).length;
  }

  /** A message part for an image or file given as a data URL or a URL. */
  async part(input: {
    kind: "image" | "file";
    source: string;
    name?: string;
    scope: string;
    artifacts: ArtifactStore;
  }): Promise<ConversationContentPart> {
    const decoded = parseDataUrl(input.source);
    if (decoded) {
      const artifact = await this.#ingest({ ...input, decoded });
      return input.kind === "image"
        ? { type: "image", artifact }
        : {
            type: "file",
            artifact,
            ...(input.name ? { name: input.name } : {}),
          };
    }
    this.#checkUrl(input.source);
    return input.kind === "image"
      ? { type: "image", url: input.source }
      : {
          type: "file",
          url: input.source,
          ...(input.name ? { name: input.name } : {}),
        };
  }

  #checkUrl(source: string): void {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw invalidRequest(
        "Media must be a data URL or an https URL.",
        "messages",
      );
    }
    const allowed =
      this.#policy.urls === "allow" &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      this.#policy.allowOrigins.some(
        (origin) => new URL(origin).origin === url.origin,
      );
    if (!allowed) {
      throw invalidRequest(
        "Media URLs are not accepted by this server. Send the image or file inline as a base64 data URL.",
        "messages",
      );
    }
  }

  async #ingest(input: {
    kind: "image" | "file";
    name?: string;
    scope: string;
    artifacts: ArtifactStore;
    decoded: DecodedDataUrl;
  }): Promise<ArtifactRef> {
    const { bytes, mediaType } = input.decoded;
    if (bytes.byteLength > this.#policy.maxInlineBytes) {
      throw new ServerError(
        413,
        "context_length_exceeded",
        `Inline media is ${bytes.byteLength} bytes, exceeding the limit of ${this.#policy.maxInlineBytes}.`,
        { type: "invalid_request_error", param: "messages" },
      );
    }
    if (input.kind === "image" && !mediaType.startsWith("image/")) {
      throw invalidRequest(
        `An image part must carry an image media type, not ${mediaType}.`,
        "messages",
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = indexKey(input.scope, sha256, mediaType);
    const existing = await this.#index.get(MEDIA_NAMESPACE, key);
    if (existing) {
      const ref = JSON.parse(existing) as ArtifactRef;
      await this.#remember(input.scope, key, ref);
      return ref;
    }
    const extension = EXTENSIONS[mediaType];
    const name =
      input.name ??
      `${input.kind}-${sha256.slice(0, 12)}${extension ? `.${extension}` : ""}`;
    const stored = await input.artifacts.put({
      name,
      mediaType,
      data: new Uint8Array(bytes),
      metadata: { source: "chat-request" },
    });
    // History media must carry sha256; stores that omit it get ours, which
    // matches the stored bytes.
    const ref: ArtifactRef = { ...stored, sha256: stored.sha256 ?? sha256 };
    await this.#remember(input.scope, key, ref);
    return ref;
  }

  /** Record (or refresh) a minted reference under its content and its id. */
  async #remember(scope: string, key: string, ref: ArtifactRef): Promise<void> {
    const value = JSON.stringify(ref);
    await this.#index.set(MEDIA_NAMESPACE, key, value, this.#policy.ttlMs);
    await this.#index.set(
      MEDIA_NAMESPACE,
      mintKey(scope, ref.id),
      value,
      this.#policy.ttlMs,
    );
  }

  /**
   * The runtime's `authorizeArtifact`: accept exactly the references this
   * server minted for the scope. Every other reference is refused.
   */
  async authorize(
    ref: ArtifactRef,
    scope: string | undefined,
  ): Promise<boolean> {
    if (!scope) return false;
    const minted = await this.#index.get(
      MEDIA_NAMESPACE,
      mintKey(scope, ref.id),
    );
    if (!minted) return false;
    const known = JSON.parse(minted) as ArtifactRef;
    return known.sha256 === ref.sha256 && known.mediaType === ref.mediaType;
  }
}
