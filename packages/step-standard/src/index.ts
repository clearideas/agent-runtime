import type {
  ApprovalStep,
  CodeStep,
  JsonObject,
  JsonValue,
  AgentVariableOverride,
  SubRunStep,
  VariableState,
  WebhookStep,
} from "@clearideas/agent-runtime-contracts";
import type {
  StepExecutionContext,
  StepExecutionResult,
  StepExecutor,
} from "@clearideas/agent-runtime-core";
import { RunSuspendedError } from "@clearideas/agent-runtime-core";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type Sleep = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export interface ApprovalStepExecutorOptions {
  /** Human approvals have no default deadline. */
  timeoutMs?: number;
}

export interface WebhookStepExecutorOptions {
  fetch?: FetchLike;
  /**
   * Authorizes the destination immediately before each request. Hosted
   * applications should enforce an allowlist or an egress policy here.
   */
  authorizeDestination?: (
    url: URL,
    context: {
      runId: string;
      stepId: string;
      method: string;
      attempt: number;
      signal?: AbortSignal;
    },
  ) => void | Promise<void>;
  /**
   * Permits webhook requests without a destination policy. Intended only for
   * trusted, local manifests.
   */
  allowUnsafeDestinations?: boolean;
  sleep?: Sleep;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
  maximumRetries?: number;
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
  retryBaseDelayMs?: number;
  retryMaximumDelayMs?: number;
  retryableStatuses?: ReadonlySet<number>;
  now?: () => number;
}

export interface CodeStepExecutorOptions {
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
}

const getMappedVariable = (
  variables: Readonly<VariableState>,
  path: string,
): JsonValue | undefined => {
  let current: unknown = variables;
  for (const segment of path.split(".")) {
    if (
      current == null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    const lower = segment.toLowerCase();
    const key = Object.keys(record).find(
      (candidate) => candidate.toLowerCase() === lower,
    );
    if (!key) return undefined;
    current = record[key];
  }
  return current as JsonValue | undefined;
};

/**
 * Executes an isolated nested run. variableMappings maps child variable names
 * to parent variable paths; without mappings the parent state is cloned.
 */
export class SubRunStepExecutor implements StepExecutor<SubRunStep> {
  readonly type = "sub-run" as const;

  async execute(
    context: StepExecutionContext & { step: SubRunStep },
  ): Promise<StepExecutionResult> {
    if (!context.subRuns) {
      throw new Error(
        `Sub-run step ${context.step.id} requires a SubRunAdapter`,
      );
    }
    if (context.signal?.aborted) throw abortReason(context.signal);
    const variableState: VariableState = context.step.variableMappings
      ? Object.fromEntries(
          Object.entries(context.step.variableMappings).flatMap(
            ([target, source]) => {
              const value = getMappedVariable(context.variables, source);
              return value === undefined
                ? []
                : [[target, structuredClone(value)]];
            },
          ),
        )
      : structuredClone(context.variables as VariableState);
    const variables: AgentVariableOverride[] = Object.entries(
      variableState,
    ).map(([key, value]) => ({ key, value }));

    await context.emit("sub-run.started", {
      hasInlineManifest: context.step.manifest != null,
      hasManifestReference: context.step.manifestRef != null,
      mappedVariableCount: variables.length,
    });
    const resumeContinuation =
      context.resume?.continuation?.type === "sub-run" &&
      context.resume.continuation.stepId === context.step.id &&
      context.resume.continuation.adapter != null &&
      typeof context.resume.continuation.adapter === "object" &&
      !Array.isArray(context.resume.continuation.adapter)
        ? context.resume.continuation.adapter
        : undefined;
    await context.checkpoint?.({
      state: structuredClone(context.variables as VariableState),
      continuation: {
        type: "sub-run",
        phase: "launching",
        stepId: context.step.id,
        ...(resumeContinuation
          ? { adapter: structuredClone(resumeContinuation) }
          : {}),
      },
    });
    const result = await context.subRuns.execute(
      {
        parentRunId: context.runId,
        stepId: context.step.id,
        ...(context.step.manifest ? { manifest: context.step.manifest } : {}),
        ...(context.step.manifestRef
          ? { manifestReference: context.step.manifestRef }
          : {}),
        variables,
        ...(resumeContinuation
          ? { continuation: structuredClone(resumeContinuation) }
          : {}),
      },
      context.signal ? { signal: context.signal } : undefined,
    );
    if (result.status === "suspended") {
      if (!context.checkpoint) {
        throw new Error(
          `Sub-run step ${context.step.id} cannot suspend without checkpoint support`,
        );
      }
      const continuation = result.continuation ?? { childRunId: result.runId };
      await context.checkpoint({
        state: structuredClone(context.variables as VariableState),
        continuation: {
          type: "sub-run",
          phase: "waiting",
          stepId: context.step.id,
          childRunId: result.runId,
          adapter: structuredClone(continuation),
        },
      });
      throw new RunSuspendedError("sub-run", {
        stepId: context.step.id,
        childRunId: result.runId,
      });
    }
    await context.emit("sub-run.completed", {
      childRunId: result.runId,
      hasOutput: result.output !== undefined,
      artifactCount: result.artifacts?.length ?? 0,
    });
    const patch = statePatch(context.step.outputVariable, result.output);
    return {
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(patch ? { statePatch: patch } : {}),
      ...(result.transcript ? { transcript: result.transcript } : {}),
      ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      metadata: {
        childRunId: result.runId,
        hasOutput: result.output !== undefined,
        artifactCount: result.artifacts?.length ?? 0,
      },
    };
  }
}

export class ApprovalRejectedError extends Error {
  readonly action: ApprovalStep["action"];

  constructor(stepId: string, action: ApprovalStep["action"]) {
    super(`Approval was rejected for step ${stepId}`);
    this.name = "ApprovalRejectedError";
    this.action = action;
  }
}

export class ApprovalTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Approval did not resolve within ${timeoutMs}ms`);
    this.name = "ApprovalTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class WebhookHttpError extends Error {
  readonly status: number;
  readonly attempts: number;

  constructor(status: number, attempts: number) {
    super(`Webhook returned HTTP ${status} after ${attempts} attempt(s)`);
    this.name = "WebhookHttpError";
    this.status = status;
    this.attempts = attempts;
  }
}

export class WebhookTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly attempts: number;

  constructor(timeoutMs: number, attempts: number) {
    super(`Webhook timed out after ${timeoutMs}ms on attempt ${attempts}`);
    this.name = "WebhookTimeoutError";
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
  }
}

export class WebhookNetworkError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(`Webhook request failed after ${attempts} attempt(s)`);
    this.name = "WebhookNetworkError";
    this.attempts = attempts;
  }
}

export class WebhookResponseError extends Error {
  readonly status: number;

  constructor(status: number, reason: "too-large" | "invalid-json") {
    super(
      reason === "too-large"
        ? `Webhook response exceeded the configured size limit (HTTP ${status})`
        : `Webhook returned invalid JSON (HTTP ${status})`,
    );
    this.name = "WebhookResponseError";
    this.status = status;
  }
}

export class SandboxExecutionError extends Error {
  readonly exitCode: number;

  constructor(stepId: string, exitCode: number) {
    super(
      `Sandbox execution failed for step ${stepId} with exit code ${exitCode}`,
    );
    this.name = "SandboxExecutionError";
    this.exitCode = exitCode;
  }
}

export class SandboxTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Sandbox execution timed out after ${timeoutMs}ms`);
    this.name = "SandboxTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Operation aborted");

interface OperationSignal {
  signal: AbortSignal;
  didTimeOut(): boolean;
  dispose(): void;
}

const operationSignal = (
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): OperationSignal => {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => controller.abort(parent?.reason);

  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Operation timed out"));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
};

const raceWithSignal = async <T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0 || selected > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return selected;
};

const nonNegativeInteger = (
  value: number,
  maximum: number,
  label: string,
): number => {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value;
};

const defaultSleep: Sleep = async (delayMs, signal) => {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal ? abortReason(signal) : new Error("Operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const statePatch = (
  outputVariable: string | undefined,
  output: JsonValue | undefined,
): StepExecutionResult["statePatch"] =>
  outputVariable && output !== undefined
    ? { set: { [outputVariable]: output } }
    : undefined;

export class ApprovalStepExecutor implements StepExecutor<ApprovalStep> {
  readonly type = "approval" as const;
  readonly #timeoutMs: number | undefined;

  constructor(options: ApprovalStepExecutorOptions = {}) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new Error("Approval timeoutMs must be a positive integer");
    }
    this.#timeoutMs = options.timeoutMs;
  }

  async execute(
    context: StepExecutionContext & { step: ApprovalStep },
  ): Promise<StepExecutionResult> {
    if (!context.approvals) {
      throw new Error(
        `Approval step ${context.step.id} requires an ApprovalAdapter`,
      );
    }
    if (context.signal?.aborted) throw abortReason(context.signal);

    await context.emit("approval.requested", {
      action: context.step.action ?? "pause",
    });
    const operation = operationSignal(context.signal, this.#timeoutMs);
    let result;
    try {
      result = await raceWithSignal(
        context.approvals.requestApproval(
          {
            runId: context.runId,
            stepId: context.step.id,
            prompt: context.step.prompt,
            ...(context.step.metadata
              ? { details: context.step.metadata }
              : {}),
          },
          { signal: operation.signal },
        ),
        operation.signal,
      );
    } catch (error) {
      if (operation.didTimeOut() && this.#timeoutMs !== undefined) {
        throw new ApprovalTimeoutError(this.#timeoutMs);
      }
      throw error;
    } finally {
      operation.dispose();
    }

    await context.emit("approval.resolved", {
      approved: result.approved,
      respondedAt: result.respondedAt,
      hasResponse: result.response !== undefined,
    });
    if (!result.approved) {
      throw new ApprovalRejectedError(context.step.id, context.step.action);
    }

    const output: JsonObject = {
      approved: true,
      respondedAt: result.respondedAt,
      ...(result.response !== undefined ? { response: result.response } : {}),
    };
    const patch = statePatch(context.step.outputVariable, output);
    return {
      output,
      ...(patch ? { statePatch: patch } : {}),
      metadata: {
        approved: true,
        hasResponse: result.response !== undefined,
        action: context.step.action ?? "pause",
      },
    };
  }
}

const DEFAULT_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const setHeader = (headers: Headers, name: string, value: string): void => {
  if (!headers.has(name)) headers.set(name, value);
};

const responseDelayMs = (
  response: Response,
  calculatedDelayMs: number,
  maximumDelayMs: number,
  now: () => number,
): number => {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (!retryAfter) return calculatedDelayMs;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, maximumDelayMs);
  }
  const date = Date.parse(retryAfter);
  return Number.isNaN(date)
    ? calculatedDelayMs
    : Math.min(Math.max(0, date - now()), maximumDelayMs);
};

const readWebhookOutput = async (
  response: Response,
  maximumBytes: number,
): Promise<JsonValue | undefined> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebhookResponseError(response.status, "too-large");
  }
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let receivedBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new WebhookResponseError(response.status, "too-large");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  if (text.length === 0) return undefined;
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
    return text;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new WebhookResponseError(response.status, "invalid-json");
  }
};

export class WebhookStepExecutor implements StepExecutor<WebhookStep> {
  readonly type = "webhook" as const;
  readonly #fetch: FetchLike;
  readonly #authorizeDestination:
    NonNullable<WebhookStepExecutorOptions["authorizeDestination"]> | undefined;
  readonly #allowUnsafeDestinations: boolean;
  readonly #sleep: Sleep;
  readonly #defaultTimeoutMs: number;
  readonly #maximumTimeoutMs: number;
  readonly #maximumRetries: number;
  readonly #maximumRequestBytes: number;
  readonly #maximumResponseBytes: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaximumDelayMs: number;
  readonly #retryableStatuses: ReadonlySet<number>;
  readonly #now: () => number;

  constructor(options: WebhookStepExecutorOptions = {}) {
    const availableFetch = options.fetch ?? globalThis.fetch;
    if (!availableFetch) throw new Error("WebhookStepExecutor requires fetch");
    if (
      !options.authorizeDestination &&
      options.allowUnsafeDestinations !== true
    ) {
      throw new Error(
        "WebhookStepExecutor requires authorizeDestination. " +
          "Use allowUnsafeDestinations only for trusted local manifests.",
      );
    }
    this.#fetch = availableFetch.bind(globalThis);
    this.#authorizeDestination = options.authorizeDestination;
    this.#allowUnsafeDestinations = options.allowUnsafeDestinations === true;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#maximumTimeoutMs = options.maximumTimeoutMs ?? 300_000;
    this.#maximumRetries = options.maximumRetries ?? 10;
    this.#maximumRequestBytes = options.maximumRequestBytes ?? 1_048_576;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 1_048_576;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.#retryMaximumDelayMs = options.retryMaximumDelayMs ?? 30_000;
    this.#retryableStatuses =
      options.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
    this.#now = options.now ?? Date.now;
    positiveInteger(
      this.#defaultTimeoutMs,
      this.#defaultTimeoutMs,
      this.#maximumTimeoutMs,
      "Default webhook timeoutMs",
    );
    nonNegativeInteger(this.#maximumRetries, 100, "Maximum webhook retries");
    positiveInteger(
      this.#maximumRequestBytes,
      this.#maximumRequestBytes,
      Number.MAX_SAFE_INTEGER,
      "Maximum webhook request bytes",
    );
    positiveInteger(
      this.#maximumResponseBytes,
      this.#maximumResponseBytes,
      Number.MAX_SAFE_INTEGER,
      "Maximum webhook response bytes",
    );
    nonNegativeInteger(
      this.#retryBaseDelayMs,
      Number.MAX_SAFE_INTEGER,
      "Webhook retry base delayMs",
    );
    nonNegativeInteger(
      this.#retryMaximumDelayMs,
      Number.MAX_SAFE_INTEGER,
      "Webhook maximum retry delayMs",
    );
  }

  async execute(
    context: StepExecutionContext & { step: WebhookStep },
  ): Promise<StepExecutionResult> {
    if (context.signal?.aborted) throw abortReason(context.signal);
    const url = new URL(context.step.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Webhook URL must use HTTP or HTTPS");
    }
    if (url.username || url.password) {
      throw new Error("Webhook URL must not contain credentials");
    }
    const retries = context.step.retries ?? 0;
    nonNegativeInteger(retries, this.#maximumRetries, "Webhook retries");
    const timeoutMs = positiveInteger(
      context.step.timeoutMs,
      this.#defaultTimeoutMs,
      this.#maximumTimeoutMs,
      "Webhook timeoutMs",
    );
    const method = context.step.method ?? "POST";
    const maximumAttempts = retries + 1;
    const headers = new Headers(context.step.headers);
    if (context.step.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", context.step.idempotencyKey);
    } else {
      setHeader(
        headers,
        "Idempotency-Key",
        `${context.runId}:${context.step.id}`,
      );
    }
    let body: string | undefined;
    if (context.step.body !== undefined && method === "GET") {
      throw new Error("GET webhook steps cannot include a body");
    }
    if (context.step.body !== undefined) {
      body = JSON.stringify(context.step.body);
      if (byteLength(body) > this.#maximumRequestBytes) {
        throw new Error(
          "Webhook request body exceeded the configured size limit",
        );
      }
      setHeader(headers, "Content-Type", "application/json");
    }

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      await context.emit("webhook.attempt.started", {
        attempt,
        maximumAttempts,
        method,
      });
      if (!this.#allowUnsafeDestinations) {
        await this.#authorizeDestination!(url, {
          runId: context.runId,
          stepId: context.step.id,
          method,
          attempt,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      }
      const operation = operationSignal(context.signal, timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(context.step.url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
          signal: operation.signal,
        });
      } catch {
        const timedOut = operation.didTimeOut();
        operation.dispose();
        if (context.signal?.aborted) throw abortReason(context.signal);
        const retry = attempt < maximumAttempts;
        if (!retry) {
          if (timedOut) throw new WebhookTimeoutError(timeoutMs, attempt);
          throw new WebhookNetworkError(attempt);
        }
        const delayMs = this.#retryDelay(attempt);
        await context.emit("webhook.retry.scheduled", {
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          reason: timedOut ? "timeout" : "network",
        });
        await this.#sleep(delayMs, context.signal);
        continue;
      }

      if (!response.ok) {
        operation.dispose();
        const retry =
          attempt < maximumAttempts &&
          this.#retryableStatuses.has(response.status);
        if (!retry) {
          await response.body?.cancel().catch(() => undefined);
          throw new WebhookHttpError(response.status, attempt);
        }
        const delayMs = responseDelayMs(
          response,
          this.#retryDelay(attempt),
          this.#retryMaximumDelayMs,
          this.#now,
        );
        await response.body?.cancel().catch(() => undefined);
        await context.emit("webhook.retry.scheduled", {
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          reason: "http-status",
          status: response.status,
        });
        await this.#sleep(delayMs, context.signal);
        continue;
      }

      let output: JsonValue | undefined;
      try {
        output = await raceWithSignal(
          readWebhookOutput(response, this.#maximumResponseBytes),
          operation.signal,
        );
      } catch (error) {
        const timedOut = operation.didTimeOut();
        operation.dispose();
        if (context.signal?.aborted) throw abortReason(context.signal);
        if (timedOut) {
          if (attempt >= maximumAttempts) {
            throw new WebhookTimeoutError(timeoutMs, attempt);
          }
          const delayMs = this.#retryDelay(attempt);
          await context.emit("webhook.retry.scheduled", {
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
            reason: "timeout",
          });
          await this.#sleep(delayMs, context.signal);
          continue;
        }
        throw error;
      }
      operation.dispose();
      const patch = statePatch(context.step.outputVariable, output);
      await context.emit("webhook.attempt.completed", {
        attempt,
        method,
        status: response.status,
        hasOutput: output !== undefined,
      });
      return {
        ...(output !== undefined ? { output } : {}),
        ...(patch ? { statePatch: patch } : {}),
        metadata: {
          attempts: attempt,
          method,
          status: response.status,
          hasOutput: output !== undefined,
        },
      };
    }

    throw new Error("Webhook exhausted attempts without a result");
  }

  #retryDelay(failedAttempt: number): number {
    return Math.min(
      this.#retryBaseDelayMs * 2 ** (failedAttempt - 1),
      this.#retryMaximumDelayMs,
    );
  }
}

export class CodeStepExecutor implements StepExecutor<CodeStep> {
  readonly type = "code" as const;
  readonly #defaultTimeoutMs: number;
  readonly #maximumTimeoutMs: number;

  constructor(options: CodeStepExecutorOptions = {}) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.#maximumTimeoutMs = options.maximumTimeoutMs ?? 900_000;
  }

  async execute(
    context: StepExecutionContext & { step: CodeStep },
  ): Promise<StepExecutionResult> {
    if (!context.sandbox) {
      throw new Error(`Code step ${context.step.id} requires a SandboxAdapter`);
    }
    if (context.signal?.aborted) throw abortReason(context.signal);
    const timeoutMs = positiveInteger(
      context.step.timeoutMs,
      this.#defaultTimeoutMs,
      this.#maximumTimeoutMs,
      "Code timeoutMs",
    );
    await context.emit("code.execution.started", {
      language: context.step.language,
      timeoutMs,
    });
    const operation = operationSignal(context.signal, timeoutMs);
    let result;
    try {
      result = await raceWithSignal(
        context.sandbox.execute(
          {
            runId: context.runId,
            stepId: context.step.id,
            language: context.step.language,
            code: context.step.code,
            variables: context.variables,
            ...(context.step.environment
              ? { environment: context.step.environment }
              : {}),
            timeoutMs,
          },
          { signal: operation.signal },
        ),
        operation.signal,
      );
    } catch (error) {
      if (operation.didTimeOut()) throw new SandboxTimeoutError(timeoutMs);
      throw error;
    } finally {
      operation.dispose();
    }

    await context.emit("code.execution.completed", {
      exitCode: result.exitCode,
      succeeded: result.exitCode === 0,
      artifactCount: result.artifacts?.length ?? 0,
      hasOutput: result.output !== undefined || result.stdout.length > 0,
    });
    if (result.exitCode !== 0) {
      throw new SandboxExecutionError(context.step.id, result.exitCode);
    }

    const output =
      result.output ?? (result.stdout.length > 0 ? result.stdout : undefined);
    const patch = statePatch(context.step.outputVariable, output);
    return {
      ...(output !== undefined ? { output } : {}),
      ...(patch ? { statePatch: patch } : {}),
      ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      metadata: {
        exitCode: result.exitCode,
        stdoutBytes: byteLength(result.stdout),
        stderrBytes: byteLength(result.stderr),
        artifactCount: result.artifacts?.length ?? 0,
        hasOutput: output !== undefined,
      },
    };
  }
}
