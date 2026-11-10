import {
  AgentRuntimeError,
  MessagesValidationError,
  type MessagesErrorCode,
} from "@clearideas/agent-runtime-core";

/** The OpenAI error body: `{ "error": { message, type, param, code } }`. */
export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/** An error with an HTTP status and an OpenAI-shaped body. */
export class ServerError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly param: string | null;
  /** Seconds, sent as Retry-After. */
  readonly retryAfter: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: {
      type?: string;
      param?: string;
      retryAfter?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "ServerError";
    this.status = status;
    this.code = code;
    this.type = options.type ?? defaultType(status);
    this.param = options.param ?? null;
    this.retryAfter = options.retryAfter;
  }

  toBody(): OpenAiErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code,
      },
    };
  }
}

const defaultType = (status: number): string => {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
};

export const invalidRequest = (message: string, param?: string): ServerError =>
  new ServerError(400, "invalid_request_error", message, {
    ...(param ? { param } : {}),
  });

const MESSAGES_ERROR_STATUS: Record<MessagesErrorCode, number> = {
  MESSAGES_NOT_ACCEPTED: 400,
  MESSAGES_REQUIRED: 400,
  MESSAGES_INVALID: 400,
  MESSAGES_MEDIA_UNSUPPORTED: 400,
  MESSAGES_ARTIFACT_UNAUTHORIZED: 400,
  MESSAGES_LIMIT_EXCEEDED: 413,
  MESSAGES_SIGNATURE_REQUIRED: 409,
  MESSAGES_SIGNATURE_INVALID: 409,
};

/**
 * Map an error thrown while creating or executing a run. Client input
 * problems the runtime reports before a run exists keep their message, which
 * describes the request. Run failures are redacted to their code unless the
 * operator exposes error messages: they can contain model output, tool data,
 * or configuration detail.
 */
export const fromRunError = (
  error: unknown,
  options: { exposeErrors: boolean },
): ServerError => {
  if (error instanceof ServerError) return error;
  if (error instanceof MessagesValidationError) {
    const status = MESSAGES_ERROR_STATUS[error.code] ?? 400;
    if (status === 409) {
      return new ServerError(
        409,
        "conversation_not_recognized",
        error.message,
        {
          type: "invalid_request_error",
          param: "messages",
          cause: error,
        },
      );
    }
    if (status === 413) {
      return new ServerError(413, "context_length_exceeded", error.message, {
        type: "invalid_request_error",
        param: "messages",
        cause: error,
      });
    }
    return new ServerError(status, error.code, error.message, {
      type: "invalid_request_error",
      param: "messages",
      cause: error,
    });
  }
  const code =
    error instanceof AgentRuntimeError ? error.code : "AGENT_EXECUTION_FAILED";
  const detail = error instanceof Error ? error.message : String(error);
  return new ServerError(
    500,
    "agent_execution_failed",
    options.exposeErrors
      ? `The agent run failed (${code}): ${detail}`
      : `The agent run failed (${code}).`,
    { cause: error },
  );
};
