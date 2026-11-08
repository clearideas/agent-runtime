const encoder = new TextEncoder();

/** UTF-8 size of a JSON value, measured like `limits.maxInputBytes`. */
export const jsonBytes = (value: unknown): number =>
  encoder.encode(JSON.stringify(value) ?? "").byteLength;

/** UTF-8 size of a string as it appears inside JSON (escaped, without quotes). */
export const jsonTextBytes = (text: string): number =>
  Math.max(0, jsonBytes(text) - 2);

export const utf8Bytes = (text: string): number =>
  encoder.encode(text).byteLength;

/** The longest prefix of `text` whose JSON-escaped size fits in `maxBytes`. */
export const headWithinBytes = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  if (jsonTextBytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonTextBytes(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Never split a surrogate pair.
  const end =
    low > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(low - 1)) ? low - 1 : low;
  return text.slice(0, end);
};

/** The longest suffix of `text` whose JSON-escaped size fits in `maxBytes`. */
export const tailWithinBytes = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  if (jsonTextBytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonTextBytes(text.slice(text.length - middle)) <= maxBytes)
      low = middle;
    else high = middle - 1;
  }
  const start = text.length - low;
  const safeStart =
    start < text.length && /[\uDC00-\uDFFF]/u.test(text.charAt(start))
      ? start + 1
      : start;
  return text.slice(safeStart);
};

/** Bytes per token before any usage has been reported. */
export const DEFAULT_BYTES_PER_TOKEN = 4;

/**
 * Estimates tokens from JSON bytes. Starts at four bytes per token and
 * calibrates from each request's measured size and reported input tokens.
 */
export class TokenEstimator {
  #bytesPerToken = DEFAULT_BYTES_PER_TOKEN;
  #calibrated = false;

  get bytesPerToken(): number {
    return this.#bytesPerToken;
  }

  get calibrated(): boolean {
    return this.#calibrated;
  }

  observe(requestBytes: number, inputTokens: number | undefined): void {
    if (
      inputTokens == null ||
      !Number.isFinite(inputTokens) ||
      inputTokens <= 0 ||
      requestBytes <= 0
    )
      return;
    // JSON framing inflates bytes; clamp to plausible tokenizer ratios.
    this.#bytesPerToken = Math.min(
      12,
      Math.max(1.5, requestBytes / inputTokens),
    );
    this.#calibrated = true;
  }

  tokens(bytes: number): number {
    return Math.ceil(bytes / this.#bytesPerToken);
  }

  bytes(tokens: number): number {
    return Math.floor(tokens * this.#bytesPerToken);
  }
}
