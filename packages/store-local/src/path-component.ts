import { createHash } from "node:crypto";

/** Maps untrusted identifiers to fixed-size, traversal-safe path components. */
export const safePathComponent = (value: string, label: string): string => {
  if (!value.trim()) throw new Error(`${label} cannot be empty.`);
  return createHash("sha256").update(value, "utf8").digest("hex");
};
