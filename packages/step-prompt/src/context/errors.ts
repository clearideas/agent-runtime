/**
 * Provider-neutral classification of model errors. Adapters may set `code`
 * explicitly; otherwise the checks duck-type the AI SDK error shapes
 * (`statusCode`, `isRetryable`, `responseBody`, `cause`, `lastError`) and
 * fall back to well-known provider messages.
 */

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  statusCode?: unknown;
  status?: unknown;
  isRetryable?: unknown;
  retryable?: unknown;
  responseBody?: unknown;
  cause?: unknown;
  lastError?: unknown;
  errors?: unknown;
}

/** The error and the errors it wraps, outermost first, without cycles. */
const errorChain = (error: unknown): ErrorLike[] => {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && chain.length < 12) {
    const current = pending.shift();
    if (current == null || typeof current !== "object" || seen.has(current))
      continue;
    seen.add(current);
    const candidate = current as ErrorLike;
    chain.push(candidate);
    pending.push(candidate.cause, candidate.lastError);
    if (Array.isArray(candidate.errors)) pending.push(...candidate.errors);
  }
  return chain;
};

const statusOf = (error: ErrorLike): number | undefined => {
  const value = error.statusCode ?? error.status;
  return typeof value === "number" ? value : undefined;
};

const textOf = (error: ErrorLike): string =>
  [error.message, error.responseBody]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

const CONTEXT_OVERFLOW_PATTERN =
  /context[_ -]?length|context[_ -]?window|maximum context|prompt is too long|input is too long|too many (input )?tokens|request too large|exceed\w*[^.]{0,60}\b(context|tokens?)\b|token limit|reduce the length/iu;

/** The model rejected the request because its input was too large. */
export const isContextOverflowError = (error: unknown): boolean =>
  errorChain(error).some((entry) => {
    if (entry.code === "MODEL_CONTEXT_OVERFLOW") return true;
    const status = statusOf(entry);
    // 429 "request too large" messages describe rate limits, not the window.
    if (status != null && status !== 400 && status !== 413 && status !== 422)
      return false;
    return CONTEXT_OVERFLOW_PATTERN.test(textOf(entry));
  });

const RETRYABLE_STATUSES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 529,
]);
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "MODEL_TIMEOUT",
  "MODEL_PROVIDER_UNAVAILABLE",
]);
const NETWORK_PATTERN =
  /socket hang up|fetch failed|network error|connection (reset|closed|refused)|terminated|overloaded/iu;

/**
 * The request may succeed if repeated: timeouts, rate limits, provider
 * overload, and dropped connections. Oversized input is never retryable.
 */
export const isRetryableModelError = (error: unknown): boolean => {
  if (isContextOverflowError(error)) return false;
  return errorChain(error).some((entry) => {
    if (entry.name === "ModelTimeoutError") return true;
    if (entry.isRetryable === true || entry.retryable === true) return true;
    const status = statusOf(entry);
    if (status != null && RETRYABLE_STATUSES.has(status)) return true;
    if (typeof entry.code === "string" && RETRYABLE_CODES.has(entry.code))
      return true;
    return status == null && NETWORK_PATTERN.test(textOf(entry));
  });
};

/** The final answer did not match the step's output schema. */
export const isInvalidOutputError = (error: unknown): boolean =>
  errorChain(error).some(
    (entry) =>
      entry.name === "AI_NoObjectGeneratedError" ||
      entry.name === "NoObjectGeneratedError" ||
      entry.code === "MODEL_OUTPUT_INVALID",
  );

export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const errorSummary = (
  error: unknown,
): { name?: string; statusCode?: number } => {
  const first = errorChain(error)[0];
  if (!first) return {};
  const status = statusOf(first);
  return {
    ...(typeof first.name === "string" ? { name: first.name } : {}),
    ...(status != null ? { statusCode: status } : {}),
  };
};
