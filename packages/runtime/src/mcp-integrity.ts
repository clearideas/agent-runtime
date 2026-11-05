import { createHash } from "node:crypto";

/**
 * The subset of an MCP `tools/list` entry that Agent Runtime exposes to a
 * model or to host metadata. Hosts capture this shape when a connection is
 * created and reviewed; the runtime verifies it again at discovery time.
 */
export interface McpToolMetadata {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  annotations?: Record<string, unknown> | undefined;
}

export const MCP_TOOL_DIGEST_ALGORITHM = "sha256" as const;
/**
 * Identifies both the hash and the canonicalization rules in
 * `canonicalizeMcpToolMetadata`. Hosts store only digests, which cannot be
 * recomputed from a digest alone, so the rules behind this prefix are frozen.
 * A change to the covered fields or canonical form must introduce a new
 * prefix (for example `sha256v2:`) and keep verifying existing `sha256:` pins.
 */
export const MCP_TOOL_DIGEST_PREFIX = `${MCP_TOOL_DIGEST_ALGORITHM}:` as const;
export const mcpToolDigestPattern = /^sha256:[0-9a-f]{64}$/u;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const isEmptyTopLevelValue = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (isPlainObject(value) && Object.keys(value).length === 0);

/**
 * Recursively orders object keys so equivalent JSON documents canonicalize to
 * the same text. `undefined` members are omitted (JSON semantics); `null`
 * values and array order are preserved because both may carry meaning inside
 * a JSON Schema.
 */
const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
};

/**
 * Produces the canonical JSON text that `computeMcpToolDigest` hashes.
 *
 * Rules, which are part of the `sha256:` digest contract and must not change
 * (see `MCP_TOOL_DIGEST_PREFIX`):
 * - Only `name`, `title`, `description`, `inputSchema`, and `annotations`
 *   participate. Other server fields (`outputSchema`, `_meta`, icons) do not
 *   reach a model and are ignored.
 * - A top-level field that is `undefined`, `null`, an empty string, or an
 *   empty object is omitted, so "absent" and "empty" are equivalent.
 * - Nested objects are key-sorted recursively with `undefined` members
 *   omitted; `null` values and array order are preserved.
 * - Output has no insignificant whitespace.
 */
export const canonicalizeMcpToolMetadata = (tool: McpToolMetadata): string => {
  if (typeof tool?.name !== "string" || tool.name.length === 0) {
    throw new Error("MCP tool metadata requires a non-empty name.");
  }
  const subject: Record<string, unknown> = { name: tool.name };
  for (const field of [
    "title",
    "description",
    "inputSchema",
    "annotations",
  ] as const) {
    const value = tool[field];
    if (isEmptyTopLevelValue(value)) continue;
    subject[field] = JSON.parse(JSON.stringify(value)) as unknown;
  }
  return JSON.stringify(canonicalValue(subject));
};

/**
 * Computes the stable `sha256:<hex>` digest of a tool definition. Hosts should
 * record this value when a connection is reviewed and place it in the
 * connection's `toolIntegrity.digests` so the runtime can verify the
 * definition before it is exposed to a model.
 */
export const computeMcpToolDigest = (tool: McpToolMetadata): string =>
  `${MCP_TOOL_DIGEST_PREFIX}${createHash(MCP_TOOL_DIGEST_ALGORITHM)
    .update(canonicalizeMcpToolMetadata(tool), "utf8")
    .digest("hex")}`;

/**
 * `mismatch`: the digest differs from `toolIntegrity.digests`;
 * `unpinned`: the connection pins tools but not this one;
 * `rejected`: the host's `verifyToolMetadata` callback threw (see `cause`).
 */
export type McpToolIntegrityFailureReason =
  "mismatch" | "unpinned" | "rejected";

const failureMessage = (input: {
  connectionRef: string;
  toolName: string;
  reason: McpToolIntegrityFailureReason;
  expectedDigest?: string | undefined;
  actualDigest: string;
  cause?: unknown;
}): string => {
  const subject = `Connection "${input.connectionRef}" tool "${input.toolName}"`;
  switch (input.reason) {
    case "mismatch":
      return `${subject} metadata digest ${input.actualDigest} does not match the host-approved digest ${input.expectedDigest}.`;
    case "unpinned":
      return `${subject} has no host-approved digest in toolIntegrity.digests (discovered ${input.actualDigest}).`;
    case "rejected":
      return `${subject} metadata was rejected by the host: ${
        input.cause instanceof Error ? input.cause.message : String(input.cause)
      }`;
  }
};

/** Raised when a discovered MCP tool definition does not match host-approved metadata. */
export class McpToolIntegrityError extends Error {
  readonly connectionRef: string;
  readonly toolName: string;
  readonly reason: McpToolIntegrityFailureReason;
  readonly expectedDigest: string | undefined;
  readonly actualDigest: string;
  readonly tool: McpToolMetadata;

  constructor(input: {
    connectionRef: string;
    toolName: string;
    reason: McpToolIntegrityFailureReason;
    expectedDigest?: string | undefined;
    actualDigest: string;
    tool: McpToolMetadata;
    cause?: unknown;
  }) {
    super(
      failureMessage(input),
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "McpToolIntegrityError";
    this.connectionRef = input.connectionRef;
    this.toolName = input.toolName;
    this.reason = input.reason;
    this.expectedDigest = input.expectedDigest;
    this.actualDigest = input.actualDigest;
    this.tool = input.tool;
  }
}
