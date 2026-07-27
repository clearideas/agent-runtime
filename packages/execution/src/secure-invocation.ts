import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  EXECUTION_PROTOCOL_VERSION,
  type ResumeExecutionRequest,
} from "./contracts.js";
import {
  parseWorkerInvocation,
  type WorkerInvocation,
} from "./worker-protocol.js";

export const SECURE_INVOCATION_ENVELOPE_VERSION = "1.0" as const;
export const SECURE_INVOCATION_ALGORITHM = "A256GCM" as const;

export interface SecureInvocationMetadata {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  executionId: string;
  runId: string;
  action: WorkerInvocation["action"];
  attempt: number;
  audience: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SecureInvocationEnvelope {
  envelopeVersion: typeof SECURE_INVOCATION_ENVELOPE_VERSION;
  algorithm: typeof SECURE_INVOCATION_ALGORITHM;
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  metadata: SecureInvocationMetadata;
}

export interface SealWorkerInvocationOptions {
  executionId: string;
  runId: string;
  audience: string;
  ttlMs?: number;
}

export interface OpenWorkerInvocationOptions {
  executionId: string;
  runId: string;
  audience: string;
}

export interface WorkerInvocationEnvelopeCodec {
  seal(
    invocation: WorkerInvocation,
    options: SealWorkerInvocationOptions,
  ): SecureInvocationEnvelope;
  open(
    envelope: SecureInvocationEnvelope | unknown,
    options: OpenWorkerInvocationOptions,
  ): WorkerInvocation;
}

export interface AesGcmWorkerInvocationCodecOptions {
  activeKeyId: string;
  keys: Readonly<Record<string, string | Uint8Array>>;
  defaultTtlMs?: number;
  maximumTtlMs?: number;
  clockSkewMs?: number;
  now?: () => number;
}

export type SecureInvocationErrorCode =
  | "INVALID_ENVELOPE"
  | "UNKNOWN_KEY"
  | "AUTHENTICATION_FAILED"
  | "BINDING_MISMATCH"
  | "EXPIRED"
  | "NOT_YET_VALID";

export class SecureInvocationError extends Error {
  readonly code: SecureInvocationErrorCode;

  constructor(
    code: SecureInvocationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SecureInvocationError";
    this.code = code;
  }
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAXIMUM_TTL_MS = 15 * 60_000;
const DEFAULT_CLOCK_SKEW_MS = 30_000;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const requireNonEmptyString = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      `${label} must be a non-empty string.`,
    );
  }
  return value;
};

const requireKeyId = (value: unknown, label: string): string => {
  const keyId = requireNonEmptyString(value, label);
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      `${label} has an invalid format.`,
    );
  }
  return keyId;
};

const decodeCanonicalBase64Url = (
  value: unknown,
  label: string,
  expectedLength?: number,
): Buffer => {
  const encoded = requireNonEmptyString(value, label);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      `${label} must be unpadded base64url.`,
    );
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      `${label} must use canonical base64url encoding.`,
    );
  }
  if (expectedLength != null && decoded.length !== expectedLength) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      `${label} must decode to ${expectedLength} bytes.`,
    );
  }
  return decoded;
};

/**
 * Parse an AES-256 key without accepting ambiguous raw strings. String keys
 * must use either `base64:<unpadded-base64url>` or `hex:<64-hex-characters>`.
 */
export const parseWorkerInvocationEncryptionKey = (
  value: string | Uint8Array,
): Buffer => {
  let key: Buffer;
  if (typeof value !== "string") {
    key = Buffer.from(value);
  } else if (value.startsWith("base64:")) {
    key = decodeCanonicalBase64Url(
      value.slice("base64:".length),
      "Encryption key",
    );
  } else if (value.startsWith("hex:")) {
    const encoded = value.slice("hex:".length);
    if (!/^[A-Fa-f0-9]{64}$/.test(encoded)) {
      throw new SecureInvocationError(
        "INVALID_ENVELOPE",
        "Hex encryption keys must contain exactly 64 hexadecimal characters.",
      );
    }
    key = Buffer.from(encoded, "hex");
  } else {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      "String encryption keys must start with base64: or hex:.",
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      `Encryption keys must contain exactly ${KEY_BYTES} bytes.`,
    );
  }
  return key;
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      `${label} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
};

const requireIsoTimestamp = (value: unknown, label: string): string => {
  const timestamp = requireNonEmptyString(value, label);
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== timestamp
  ) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      `${label} must be a canonical ISO 8601 timestamp.`,
    );
  }
  return timestamp;
};

const parseMetadata = (value: unknown): SecureInvocationMetadata => {
  const metadata = asRecord(value, "Secure invocation metadata");
  if (metadata.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      "Unsupported execution protocol version.",
    );
  }
  if (metadata.action !== "run" && metadata.action !== "resume") {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      "Invocation action must be run or resume.",
    );
  }
  if (!Number.isSafeInteger(metadata.attempt) || Number(metadata.attempt) < 1) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      "Invocation attempt must be a positive safe integer.",
    );
  }
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    executionId: requireNonEmptyString(metadata.executionId, "Execution ID"),
    runId: requireNonEmptyString(metadata.runId, "Run ID"),
    action: metadata.action,
    attempt: Number(metadata.attempt),
    audience: requireNonEmptyString(metadata.audience, "Invocation audience"),
    issuedAt: requireIsoTimestamp(metadata.issuedAt, "Issued-at timestamp"),
    expiresAt: requireIsoTimestamp(metadata.expiresAt, "Expiry timestamp"),
  };
};

export const parseSecureInvocationEnvelope = (
  value: unknown,
): SecureInvocationEnvelope => {
  const envelope = asRecord(value, "Secure invocation envelope");
  if (envelope.envelopeVersion !== SECURE_INVOCATION_ENVELOPE_VERSION) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      "Unsupported secure envelope version.",
    );
  }
  if (envelope.algorithm !== SECURE_INVOCATION_ALGORITHM) {
    throw new SecureInvocationError(
      "INVALID_ENVELOPE",
      "Unsupported secure envelope algorithm.",
    );
  }
  return {
    envelopeVersion: SECURE_INVOCATION_ENVELOPE_VERSION,
    algorithm: SECURE_INVOCATION_ALGORITHM,
    keyId: requireKeyId(envelope.keyId, "Encryption key ID"),
    nonce: decodeCanonicalBase64Url(
      envelope.nonce,
      "Envelope nonce",
      NONCE_BYTES,
    ).toString("base64url"),
    ciphertext: decodeCanonicalBase64Url(
      envelope.ciphertext,
      "Envelope ciphertext",
    ).toString("base64url"),
    authTag: decodeCanonicalBase64Url(
      envelope.authTag,
      "Envelope authentication tag",
      AUTH_TAG_BYTES,
    ).toString("base64url"),
    metadata: parseMetadata(envelope.metadata),
  };
};

const authenticatedData = (envelope: {
  envelopeVersion: SecureInvocationEnvelope["envelopeVersion"];
  algorithm: SecureInvocationEnvelope["algorithm"];
  keyId: string;
  metadata: SecureInvocationMetadata;
}): Buffer =>
  Buffer.from(
    JSON.stringify({
      envelopeVersion: envelope.envelopeVersion,
      algorithm: envelope.algorithm,
      keyId: envelope.keyId,
      metadata: envelope.metadata,
    }),
    "utf8",
  );

const invocationAttempt = (invocation: WorkerInvocation): number =>
  invocation.action === "resume"
    ? (invocation.request as ResumeExecutionRequest).attempt
    : 1;

const equalText = (left: string, right: string): boolean => {
  const leftDigest = Buffer.from(left, "utf8");
  const rightDigest = Buffer.from(right, "utf8");
  const maximumLength = Math.max(leftDigest.length, rightDigest.length);
  const leftPadded = Buffer.alloc(maximumLength);
  const rightPadded = Buffer.alloc(maximumLength);
  leftDigest.copy(leftPadded);
  rightDigest.copy(rightPadded);
  return (
    timingSafeEqual(leftPadded, rightPadded) &&
    leftDigest.length === rightDigest.length
  );
};

export class AesGcmWorkerInvocationCodec implements WorkerInvocationEnvelopeCodec {
  readonly #activeKeyId: string;
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #defaultTtlMs: number;
  readonly #maximumTtlMs: number;
  readonly #clockSkewMs: number;
  readonly #now: () => number;

  constructor(options: AesGcmWorkerInvocationCodecOptions) {
    this.#activeKeyId = requireKeyId(
      options.activeKeyId,
      "Active encryption key ID",
    );
    const keys = new Map<string, Buffer>();
    for (const [keyId, value] of Object.entries(options.keys)) {
      keys.set(
        requireKeyId(keyId, "Encryption key ID"),
        parseWorkerInvocationEncryptionKey(value),
      );
    }
    if (!keys.has(this.#activeKeyId)) {
      throw new SecureInvocationError(
        "UNKNOWN_KEY",
        "The active encryption key ID is not present in the keyring.",
      );
    }
    if (keys.size === 0) {
      throw new SecureInvocationError(
        "UNKNOWN_KEY",
        "The encryption keyring is empty.",
      );
    }
    this.#keys = keys;
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#maximumTtlMs = options.maximumTtlMs ?? DEFAULT_MAXIMUM_TTL_MS;
    this.#clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.#now = options.now ?? Date.now;
    for (const [label, value] of [
      ["defaultTtlMs", this.#defaultTtlMs],
      ["maximumTtlMs", this.#maximumTtlMs],
      ["clockSkewMs", this.#clockSkewMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new SecureInvocationError(
          "INVALID_ENVELOPE",
          `${label} must be a non-negative safe integer.`,
        );
      }
    }
    if (this.#defaultTtlMs === 0 || this.#defaultTtlMs > this.#maximumTtlMs) {
      throw new SecureInvocationError(
        "INVALID_ENVELOPE",
        "defaultTtlMs must be positive and no greater than maximumTtlMs.",
      );
    }
  }

  seal(
    invocation: WorkerInvocation,
    options: SealWorkerInvocationOptions,
  ): SecureInvocationEnvelope {
    const parsedInvocation = parseWorkerInvocation(invocation);
    const executionId = requireNonEmptyString(
      options.executionId,
      "Execution ID",
    );
    const runId = requireNonEmptyString(options.runId, "Run ID");
    const audience = requireNonEmptyString(
      options.audience,
      "Invocation audience",
    );
    if (
      parsedInvocation.request.runId != null &&
      !equalText(parsedInvocation.request.runId, runId)
    ) {
      throw new SecureInvocationError(
        "BINDING_MISMATCH",
        "Worker invocation does not match the requested run binding.",
      );
    }
    const ttlMs = options.ttlMs ?? this.#defaultTtlMs;
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > this.#maximumTtlMs
    ) {
      throw new SecureInvocationError(
        "INVALID_ENVELOPE",
        `Envelope ttlMs must be between 1 and ${this.#maximumTtlMs}.`,
      );
    }
    const now = this.#now();
    const metadata: SecureInvocationMetadata = {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      executionId,
      runId,
      action: parsedInvocation.action,
      attempt: invocationAttempt(parsedInvocation),
      audience,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    const nonce = randomBytes(NONCE_BYTES);
    const key = this.#keys.get(this.#activeKeyId)!;
    const envelopeHeader = {
      envelopeVersion: SECURE_INVOCATION_ENVELOPE_VERSION,
      algorithm: SECURE_INVOCATION_ALGORITHM,
      keyId: this.#activeKeyId,
      metadata,
    } as const;
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(authenticatedData(envelopeHeader));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(parsedInvocation), "utf8"),
      cipher.final(),
    ]);
    return {
      ...envelopeHeader,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  open(
    input: SecureInvocationEnvelope | unknown,
    options: OpenWorkerInvocationOptions,
  ): WorkerInvocation {
    const envelope = parseSecureInvocationEnvelope(input);
    const key = this.#keys.get(envelope.keyId);
    if (!key) {
      throw new SecureInvocationError(
        "UNKNOWN_KEY",
        "The secure invocation envelope uses an unavailable key ID.",
      );
    }
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.nonce, "base64url"),
        { authTagLength: AUTH_TAG_BYTES },
      );
      decipher.setAAD(authenticatedData(envelope));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
    } catch (error) {
      throw new SecureInvocationError(
        "AUTHENTICATION_FAILED",
        "Secure invocation authentication failed.",
        { cause: error },
      );
    }

    const now = this.#now();
    const issuedAt = Date.parse(envelope.metadata.issuedAt);
    const expiresAt = Date.parse(envelope.metadata.expiresAt);
    if (issuedAt > now + this.#clockSkewMs) {
      throw new SecureInvocationError(
        "NOT_YET_VALID",
        "Secure invocation is not yet valid.",
      );
    }
    if (expiresAt <= now) {
      throw new SecureInvocationError(
        "EXPIRED",
        "Secure invocation has expired.",
      );
    }
    if (expiresAt <= issuedAt || expiresAt - issuedAt > this.#maximumTtlMs) {
      throw new SecureInvocationError(
        "INVALID_ENVELOPE",
        "Secure invocation has an invalid validity interval.",
      );
    }
    if (
      !equalText(envelope.metadata.executionId, options.executionId) ||
      !equalText(envelope.metadata.runId, options.runId) ||
      !equalText(envelope.metadata.audience, options.audience)
    ) {
      throw new SecureInvocationError(
        "BINDING_MISMATCH",
        "Secure invocation does not match its execution binding.",
      );
    }

    let invocation: WorkerInvocation;
    try {
      invocation = parseWorkerInvocation(plaintext.toString("utf8"));
    } catch (error) {
      throw new SecureInvocationError(
        "INVALID_ENVELOPE",
        "Secure invocation plaintext is invalid.",
        { cause: error },
      );
    } finally {
      plaintext.fill(0);
    }
    if (
      invocation.action !== envelope.metadata.action ||
      invocationAttempt(invocation) !== envelope.metadata.attempt ||
      (invocation.request.runId != null &&
        !equalText(invocation.request.runId, envelope.metadata.runId))
    ) {
      throw new SecureInvocationError(
        "BINDING_MISMATCH",
        "Secure invocation metadata does not match its payload.",
      );
    }
    return invocation;
  }
}
