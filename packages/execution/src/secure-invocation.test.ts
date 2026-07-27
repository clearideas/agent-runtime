import { describe, expect, it } from "vitest";

import {
  AesGcmWorkerInvocationCodec,
  parseWorkerInvocationEncryptionKey,
  SecureInvocationError,
  type SecureInvocationEnvelope,
} from "./secure-invocation.js";
import { createWorkerInvocation } from "./worker-protocol.js";

const key = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const now = Date.parse("2026-07-25T12:00:00.000Z");
const invocation = createWorkerInvocation({
  runId: "run-1",
  manifest: {
    schemaVersion: "1.0",
    steps: [],
  },
  configuration: {
    providers: {
      openai: {
        apiKey: "test-only-secret",
      },
    },
  },
});

const codec = (
  options: {
    activeKeyId?: string;
    keys?: Record<string, Uint8Array>;
    time?: number;
  } = {},
): AesGcmWorkerInvocationCodec =>
  new AesGcmWorkerInvocationCodec({
    activeKeyId: options.activeKeyId ?? "key-2",
    keys: options.keys ?? { "key-1": key(1), "key-2": key(2) },
    now: () => options.time ?? now,
  });

const binding = {
  executionId: "execution-1",
  runId: "run-1",
  audience: "modal-worker",
};

const tamper = (value: string): string =>
  `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;

describe("AesGcmWorkerInvocationCodec", () => {
  it("round trips an invocation without exposing its secret-bearing payload", () => {
    const envelope = codec().seal(invocation, binding);

    expect(envelope.keyId).toBe("key-2");
    expect(JSON.stringify(envelope)).not.toContain("test-only-secret");
    expect(codec().open(envelope, binding)).toEqual(invocation);
  });

  it("uses a new random nonce for every envelope", () => {
    const first = codec().seal(invocation, binding);
    const second = codec().seal(invocation, binding);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it.each([
    [
      "ciphertext",
      (value: SecureInvocationEnvelope) => ({
        ...value,
        ciphertext: tamper(value.ciphertext),
      }),
    ],
    [
      "authentication tag",
      (value: SecureInvocationEnvelope) => ({
        ...value,
        authTag: tamper(value.authTag),
      }),
    ],
    [
      "audience metadata",
      (value: SecureInvocationEnvelope) => ({
        ...value,
        metadata: { ...value.metadata, audience: "other-worker" },
      }),
    ],
    [
      "run metadata",
      (value: SecureInvocationEnvelope) => ({
        ...value,
        metadata: { ...value.metadata, runId: "run-2" },
      }),
    ],
    [
      "action metadata",
      (value: SecureInvocationEnvelope) => ({
        ...value,
        metadata: { ...value.metadata, action: "resume" as const },
      }),
    ],
    [
      "attempt metadata",
      (value: SecureInvocationEnvelope) => ({
        ...value,
        metadata: { ...value.metadata, attempt: 2 },
      }),
    ],
    [
      "expiry metadata",
      (value: SecureInvocationEnvelope) => ({
        ...value,
        metadata: {
          ...value.metadata,
          expiresAt: "2026-07-25T12:00:01.000Z",
        },
      }),
    ],
  ])("rejects tampered %s", (_label, mutate) => {
    const envelope = codec().seal(invocation, binding);

    expect(() => codec().open(mutate(envelope), binding)).toThrow(
      expect.objectContaining({ code: "AUTHENTICATION_FAILED" }),
    );
  });

  it.each([
    ["audience", { ...binding, audience: "other-worker" }],
    ["run", { ...binding, runId: "run-2" }],
    ["execution", { ...binding, executionId: "execution-2" }],
  ])("rejects the wrong %s binding", (_label, expected) => {
    const envelope = codec().seal(invocation, binding);

    expect(() => codec().open(envelope, expected)).toThrow(
      expect.objectContaining({ code: "BINDING_MISMATCH" }),
    );
  });

  it("rejects expired envelopes", () => {
    const envelope = codec().seal(invocation, { ...binding, ttlMs: 1_000 });
    const later = codec({ time: now + 1_001 });

    expect(() => later.open(envelope, binding)).toThrow(
      expect.objectContaining({ code: "EXPIRED" }),
    );
  });

  it("supports key rotation while the prior key remains in the keyring", () => {
    const previous = codec({
      activeKeyId: "key-1",
      keys: { "key-1": key(1) },
    }).seal(invocation, binding);
    const rotated = codec({
      activeKeyId: "key-2",
      keys: { "key-1": key(1), "key-2": key(2) },
    });

    expect(rotated.open(previous, binding)).toEqual(invocation);
    expect(rotated.seal(invocation, binding).keyId).toBe("key-2");
  });

  it("fails closed when an envelope uses a key outside the keyring", () => {
    const envelope = codec({
      activeKeyId: "retired",
      keys: { retired: key(3) },
    }).seal(invocation, binding);

    expect(() => codec().open(envelope, binding)).toThrow(
      expect.objectContaining({ code: "UNKNOWN_KEY" }),
    );
  });

  it("allows independent transport and worker codec instances to share a keyring", () => {
    const transport = codec();
    const worker = codec();
    const envelope = transport.seal(invocation, binding);

    expect(worker.open(envelope, binding)).toEqual(invocation);
  });
});

describe("parseWorkerInvocationEncryptionKey", () => {
  it("accepts explicit canonical base64url and hex encodings", () => {
    const bytes = key(7);

    expect(
      parseWorkerInvocationEncryptionKey(
        `base64:${Buffer.from(bytes).toString("base64url")}`,
      ),
    ).toEqual(Buffer.from(bytes));
    expect(
      parseWorkerInvocationEncryptionKey(
        `hex:${Buffer.from(bytes).toString("hex")}`,
      ),
    ).toEqual(Buffer.from(bytes));
  });

  it.each(["plain-text-key", "base64:YWJjZA==", "hex:abcd"])(
    "rejects ambiguous or incorrectly sized string key %s",
    (value) => {
      expect(() => parseWorkerInvocationEncryptionKey(value)).toThrow(
        SecureInvocationError,
      );
    },
  );
});
