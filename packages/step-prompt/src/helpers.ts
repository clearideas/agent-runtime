/**
 * Low-level helpers shared by the prompt executor: model-call timeouts and
 * cancellation, media resolution, and result inspection.
 */
import type {
  ContentPart,
  JsonObject,
  JsonValue,
  ModelReference,
  ModelUsage,
  PromptStep,
} from "@clearideas/agent-runtime-contracts";
import type { StepExecutionContext } from "@clearideas/agent-runtime-core";
import type {
  ModelMessage,
  ModelResult,
} from "@clearideas/agent-runtime-core/ports";

export class ModelTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Model request timed out after ${timeoutMs}ms`);
    this.name = "ModelTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ModelCompletionError extends Error {
  readonly finishReason: string | undefined;

  constructor(message: string, finishReason?: string) {
    super(message);
    this.name = "ModelCompletionError";
    this.finishReason = finishReason;
  }
}

export interface ModelOperation {
  signal?: AbortSignal;
  didTimeOut(): boolean;
  dispose(): void;
}

export const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Model request was aborted");

export const modelOperation = (
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): ModelOperation => {
  if (!parent && timeoutMs == null) {
    return { didTimeOut: () => false, dispose: () => undefined };
  }
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  if (timeoutMs != null) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ModelTimeoutError(timeoutMs));
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
};

/**
 * Run `start` unless the signal is already aborted, and settle with whichever
 * comes first: the operation or the abort. The operation is started here, not
 * by the caller, so a cancelled request never starts work whose rejection
 * nothing would observe; once started, its outcome is always observed.
 */
export const raceWithSignal = async <T>(
  start: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) return start();
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    // Subscribe before invoking host code: start() may abort synchronously.
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      Promise.resolve(start()).then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
};

/** A model reference as the request key a ModelAdapter receives. */
export const modelKeyFromReference = (
  reference: ModelReference | undefined,
  stepId: string,
): string => {
  if (!reference) {
    throw new Error(`Prompt step ${stepId} requires a model`);
  }
  return "ref" in reference
    ? `ref/${reference.ref}`
    : `${reference.provider}/${reference.model}`;
};

export const referenceProvider = (
  reference: ModelReference | undefined,
): string => {
  if (!reference) return "";
  return "ref" in reference ? "profile" : reference.provider;
};

export const stepModelReference = (
  step: PromptStep,
  context: StepExecutionContext,
): ModelReference | undefined => step.model ?? context.manifest.model;

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
};

export const resolveMediaPart = async (
  part: ContentPart,
  context: StepExecutionContext,
): Promise<ContentPart> => {
  if (
    part.type === "tool-result" &&
    part.result.artifacts != null &&
    part.result.artifacts.length > 0 &&
    context.artifacts
  ) {
    const artifacts = await Promise.all(
      part.result.artifacts.map(async (artifact) => {
        const loaded = await context.artifacts!.get(artifact);
        return {
          ...artifact,
          uri: `data:${loaded.ref.mediaType};base64,${bytesToBase64(loaded.data)}`,
          mediaType: loaded.ref.mediaType,
          size: loaded.data.byteLength,
        };
      }),
    );
    return {
      ...part,
      result: { ...part.result, artifacts },
    };
  }
  if (
    (part.type !== "image" && part.type !== "file") ||
    part.artifact == null ||
    part.data != null
  ) {
    return part;
  }
  if (context.artifacts) {
    const loaded = await context.artifacts.get(part.artifact);
    return {
      ...part,
      data: bytesToBase64(loaded.data),
      mediaType: part.mediaType ?? loaded.ref.mediaType,
      ...(part.type === "file" ? { name: part.name ?? loaded.ref.name } : {}),
    };
  }
  if (part.artifact.uri == null) {
    throw new Error(
      `Prompt media artifact ${part.artifact.id} requires an ArtifactStore or URI`,
    );
  }
  return part;
};

export const resolveMessageMedia = async (
  message: ModelMessage,
  context: StepExecutionContext,
): Promise<ModelMessage> => ({
  ...message,
  content: await Promise.all(
    message.content.map((part) => resolveMediaPart(part, context)),
  ),
});

export const usageData = (result: ModelResult): JsonObject | undefined => {
  const usage = [...result.transcript]
    .reverse()
    .find((item) => item.usage)?.usage;
  if (!usage) return undefined;
  return JSON.parse(JSON.stringify({ usage })) as JsonObject;
};

export const safeModelCompletedData = (result: ModelResult): JsonObject => ({
  ...(result.finishReason ? { finishReason: result.finishReason } : {}),
  ...(usageData(result) ?? {}),
});

export const isTruncatedFinishReason = (finishReason?: string): boolean => {
  const normalized = finishReason?.trim().toLowerCase().replaceAll("-", "_");
  return (
    normalized === "length" ||
    normalized === "max_tokens" ||
    normalized === "max_output_tokens"
  );
};

export const hasOutput = (output: JsonValue | undefined): boolean =>
  output !== undefined &&
  (typeof output !== "string" || output.trim().length > 0);

export const resultUsage = (result: ModelResult): ModelUsage | undefined =>
  [...result.transcript].reverse().find((item) => item.usage)?.usage;

export const reportedTotalTokens = (usage: ModelUsage): number | undefined => {
  if (usage.totalTokens != null) return usage.totalTokens;
  if (usage.inputTokens == null && usage.outputTokens == null) return undefined;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
};

/** Sum usages field by field; undefined when nothing was reported. */
export const addUsage = (
  left: ModelUsage | undefined,
  right: ModelUsage | undefined,
): ModelUsage | undefined => {
  if (!left) return right ? structuredClone(right) : undefined;
  if (!right) return structuredClone(left);
  const sum: ModelUsage = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "totalTokens",
    "estimatedCost",
  ] as const) {
    const a = left[key];
    const b = right[key];
    if (a != null || b != null) sum[key] = (a ?? 0) + (b ?? 0);
  }
  if (left.metadata?.estimated === true || right.metadata?.estimated === true)
    sum.metadata = { estimated: true };
  return sum;
};

/** Exponential backoff that can be cancelled. */
export const abortableSleep = (
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
