import type {
  ContentPart,
  JsonObject,
  JsonValue,
  ModelUsage,
  PromptMessage,
  PromptStep,
  ToolCall,
  ToolResult,
  TranscriptItem,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import { RunSuspendedError } from "@clearideas/agent-runtime-core";
import type {
  StepExecutionContext,
  StepExecutionResult,
  StepExecutor,
} from "@clearideas/agent-runtime-core";
import type {
  ModelMessage,
  ModelRequest,
  ModelResult,
  AgentTool,
} from "@clearideas/agent-runtime-core/ports";

export interface PromptStepExecutorOptions {
  now?: () => Date;
  generateTranscriptId?: () => string;
  generateToolIdempotencyKey?: () => string;
  defaultMaxToolCalls?: number;
}

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

interface ModelOperation {
  signal?: AbortSignal;
  didTimeOut(): boolean;
  dispose(): void;
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Model request was aborted");

const modelOperation = (
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

const raceWithSignal = async <T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) return operation;
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
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

const getNestedValue = (
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
    const lowerSegment = segment.toLowerCase();
    const key = Object.keys(record).find(
      (candidate) => candidate.toLowerCase() === lowerSegment,
    );
    if (!key) return undefined;
    current = record[key];
  }
  return current as JsonValue | undefined;
};

const stringifyTemplateValue = (value: JsonValue | undefined): string => {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

export const compilePromptTemplate = (
  template: string,
  variables: Readonly<VariableState>,
): string =>
  template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) =>
    stringifyTemplateValue(getNestedValue(variables, rawPath.trim())),
  );

const modelKey = (step: PromptStep, context: StepExecutionContext): string => {
  const reference = step.model ?? context.manifest.model;
  if (!reference) {
    throw new Error(`Prompt step ${step.id} requires a model`);
  }
  return "ref" in reference
    ? `ref/${reference.ref}`
    : `${reference.provider}/${reference.model}`;
};

const modelOptions = (
  step: PromptStep,
  context: StepExecutionContext,
): JsonObject | undefined => (step.model ?? context.manifest.model)?.options;

const referenceProvider = (reference: PromptStep["model"]): string => {
  if (!reference) return "";
  return "ref" in reference ? "profile" : reference.provider;
};

const transcriptMessages = (items: TranscriptItem[]): ModelMessage[] =>
  items.flatMap((item) =>
    item.role
      ? [
          {
            role: item.role,
            content: item.content,
            ...(item.metadata ? { metadata: item.metadata } : {}),
            ...(item.providerOptions
              ? { providerOptions: item.providerOptions }
              : {}),
          } satisfies ModelMessage,
        ]
      : [],
  );

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
};

const compileMessage = (
  message: PromptMessage,
  variables: Readonly<VariableState>,
): ModelMessage => ({
  ...message,
  content: message.content.map((part) =>
    part.type === "text"
      ? { ...part, text: compilePromptTemplate(part.text, variables) }
      : part,
  ),
});

const resolveMediaPart = async (
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

const resolveMessageMedia = async (
  message: ModelMessage,
  context: StepExecutionContext,
): Promise<ModelMessage> => ({
  ...message,
  content: await Promise.all(
    message.content.map((part) => resolveMediaPart(part, context)),
  ),
});

const initialMessages = async (
  step: PromptStep,
  context: StepExecutionContext,
): Promise<ModelMessage[]> => {
  const messages: ModelMessage[] = [];
  if (step.messages) {
    messages.push(
      ...step.messages.map((message) =>
        compileMessage(message, context.variables),
      ),
    );
  } else {
    if (step.systemPrompt) {
      messages.push({
        role: "system",
        content: [
          {
            type: "text",
            text: compilePromptTemplate(step.systemPrompt, context.variables),
          },
        ],
      });
    }
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: compilePromptTemplate(step.prompt ?? "", context.variables),
        },
      ],
    });
  }
  return Promise.all(
    messages.map((message) => resolveMessageMedia(message, context)),
  );
};

const enforceInputLimits = (
  context: StepExecutionContext & { step: PromptStep },
  messages: ModelMessage[],
): void => {
  const maximumMessages = context.manifest.limits?.maxMessagesPerPrompt;
  if (maximumMessages != null && messages.length > maximumMessages) {
    throw new Error(
      `Prompt step ${context.step.id} has ${messages.length} messages, exceeding the ${maximumMessages}-message input limit`,
    );
  }
  const maximumInputBytes = context.manifest.limits?.maxInputBytes;
  if (maximumInputBytes == null) return;
  const inputBytes = new TextEncoder().encode(
    JSON.stringify(messages),
  ).byteLength;
  if (inputBytes > maximumInputBytes) {
    throw new Error(
      `Prompt step ${context.step.id} input is ${inputBytes} bytes, exceeding the ${maximumInputBytes}-byte input limit`,
    );
  }
};

const usageData = (result: ModelResult): JsonObject | undefined => {
  const usage = [...result.transcript]
    .reverse()
    .find((item) => item.usage)?.usage;
  if (!usage) return undefined;
  return JSON.parse(JSON.stringify({ usage })) as JsonObject;
};

const safeModelCompletedData = (result: ModelResult): JsonObject => ({
  ...(result.finishReason ? { finishReason: result.finishReason } : {}),
  ...(usageData(result) ?? {}),
});

const isTruncatedFinishReason = (finishReason?: string): boolean => {
  const normalized = finishReason?.trim().toLowerCase().replaceAll("-", "_");
  return (
    normalized === "length" ||
    normalized === "max_tokens" ||
    normalized === "max_output_tokens"
  );
};

const hasOutput = (output: JsonValue | undefined): boolean =>
  output !== undefined &&
  (typeof output !== "string" || output.trim().length > 0);

interface PromptContinuation {
  output?: JsonValue;
  hasOutput: boolean;
  finishReason?: string;
  toolCalls: ToolCall[];
  toolIdempotencyKeys: string[];
  nextToolIndex: number;
  toolCallCount: number;
}

const parsePromptContinuation = (
  context: StepExecutionContext & { step: PromptStep },
): PromptContinuation | undefined => {
  const value = context.resume?.continuation;
  if (
    value?.type !== "prompt" ||
    value.stepId !== context.step.id ||
    value.phase !== "model-completed" ||
    typeof value.hasOutput !== "boolean" ||
    !Array.isArray(value.toolCalls) ||
    !Array.isArray(value.toolIdempotencyKeys) ||
    value.toolIdempotencyKeys.length !== value.toolCalls.length ||
    value.toolIdempotencyKeys.some(
      (key) => typeof key !== "string" || key.length === 0,
    ) ||
    !Number.isSafeInteger(value.nextToolIndex) ||
    Number(value.nextToolIndex) < 0 ||
    Number(value.nextToolIndex) > value.toolCalls.length ||
    !Number.isSafeInteger(value.toolCallCount) ||
    Number(value.toolCallCount) < 0
  ) {
    return undefined;
  }
  return {
    ...(value.hasOutput ? { output: structuredClone(value.output) } : {}),
    hasOutput: value.hasOutput,
    ...(typeof value.finishReason === "string"
      ? { finishReason: value.finishReason }
      : {}),
    toolCalls: structuredClone(value.toolCalls) as unknown as ToolCall[],
    toolIdempotencyKeys: [...value.toolIdempotencyKeys] as string[],
    nextToolIndex: Number(value.nextToolIndex),
    toolCallCount: Number(value.toolCallCount),
  };
};

const continuationData = (
  stepId: string,
  result: ModelResult,
  toolIdempotencyKeys: string[],
  nextToolIndex: number,
  toolCallCount: number,
): JsonObject => ({
  type: "prompt",
  phase: "model-completed",
  stepId,
  hasOutput: result.output !== undefined,
  ...(result.output !== undefined
    ? { output: structuredClone(result.output) }
    : {}),
  ...(result.finishReason ? { finishReason: result.finishReason } : {}),
  toolCalls: JSON.parse(JSON.stringify(result.toolCalls ?? [])) as JsonValue,
  toolIdempotencyKeys,
  nextToolIndex,
  toolCallCount,
});

const resultUsage = (result: ModelResult): ModelUsage | undefined =>
  [...result.transcript].reverse().find((item) => item.usage)?.usage;

export class PromptStepExecutor implements StepExecutor<PromptStep> {
  readonly type = "prompt" as const;
  readonly #now: () => Date;
  readonly #generateTranscriptId: () => string;
  readonly #generateToolIdempotencyKey: () => string;
  readonly #defaultMaxToolCalls: number;

  constructor(options: PromptStepExecutorOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#generateTranscriptId =
      options.generateTranscriptId ?? (() => globalThis.crypto.randomUUID());
    this.#generateToolIdempotencyKey =
      options.generateToolIdempotencyKey ??
      (() => `agent-runtime:${globalThis.crypto.randomUUID()}`);
    this.#defaultMaxToolCalls = options.defaultMaxToolCalls ?? 25;
  }

  async execute(
    context: StepExecutionContext & { step: PromptStep },
  ): Promise<StepExecutionResult> {
    if (!context.model) {
      throw new Error(`Prompt step ${context.step.id} requires a ModelAdapter`);
    }
    if (context.tokenBudget && !context.checkpoint) {
      throw new Error("Budgeted prompt execution requires checkpoint support");
    }
    const tools = await this.#resolveTools(context);
    const checkpointPromptRounds =
      context.tokenBudget != null || tools.length > 0;
    const messages = await initialMessages(context.step, context);
    const transcript: TranscriptItem[] = structuredClone(
      context.resume?.transcript ?? [],
    );
    messages.push(
      ...(await Promise.all(
        transcriptMessages(transcript).map((message) =>
          resolveMessageMedia(message, context),
        ),
      )),
    );
    const maxToolCalls =
      context.manifest.limits?.maxToolCallsPerIteration ??
      this.#defaultMaxToolCalls;
    const resumed = parsePromptContinuation(context);
    let toolCallCount = resumed?.toolCallCount ?? 0;
    let nextToolIndex = resumed?.nextToolIndex ?? 0;
    let toolIdempotencyKeys = resumed?.toolIdempotencyKeys ?? [];
    let result: ModelResult | undefined = resumed
      ? {
          ...(resumed.hasOutput ? { output: resumed.output } : {}),
          transcript: [],
          toolCalls: resumed.toolCalls,
          ...(resumed.finishReason
            ? { finishReason: resumed.finishReason }
            : {}),
        }
      : undefined;
    let finalResult: ModelResult | undefined;

    const suspendIfExhausted = (): void => {
      const budget = context.tokenBudget;
      if (!budget || budget.consumedTokens < budget.maxTotalTokens) return;
      throw new RunSuspendedError("token-budget", {
        maxTotalTokens: budget.maxTotalTokens,
        consumedTokens: budget.consumedTokens,
        stepId: context.step.id,
      });
    };

    const checkpoint = async (
      current: ModelResult,
      nextIndex: number,
    ): Promise<void> => {
      if (!checkpointPromptRounds || !context.checkpoint) return;
      await context.checkpoint!({
        state: structuredClone(context.variables as VariableState),
        continuation: continuationData(
          context.step.id,
          current,
          toolIdempotencyKeys,
          nextIndex,
          toolCallCount,
        ),
        transcript,
      });
    };

    while (true) {
      if (!result) {
        suspendIfExhausted();
        enforceInputLimits(context, messages);
        const providerOptions = modelOptions(context.step, context);
        const operation = modelOperation(
          context.signal,
          context.manifest.limits?.providerTimeoutMs,
        );
        const request: ModelRequest = {
          model: modelKey(context.step, context),
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(context.step.outputSchema
            ? { outputSchema: context.step.outputSchema }
            : {}),
          ...(context.step.maxOutputTokens
            ? { maxOutputTokens: context.step.maxOutputTokens }
            : {}),
          ...(providerOptions ? { providerOptions } : {}),
          ...(operation.signal ? { signal: operation.signal } : {}),
        };
        await context.emit("model.started", {
          model: request.model,
          provider: referenceProvider(
            context.step.model ?? context.manifest.model,
          ),
        });
        try {
          result = await this.#invokeModel(context, request);
        } catch (error) {
          if (operation.didTimeOut()) {
            throw new ModelTimeoutError(
              context.manifest.limits!.providerTimeoutMs!,
            );
          }
          throw error;
        } finally {
          operation.dispose();
        }
        transcript.push(...result.transcript);
        messages.push(...transcriptMessages(result.transcript));
        await context.emit("model.completed", safeModelCompletedData(result));

        const usage = resultUsage(result);
        const budgetState = context.tokenBudget
          ? context.tokenBudget.consume(usage ?? {})
          : undefined;
        if (usage) {
          await context.emit("model.usage", {
            usage: JSON.parse(JSON.stringify(usage)) as JsonObject,
            ...(budgetState ?? {}),
          });
        }
        nextToolIndex = 0;
        toolIdempotencyKeys = (result.toolCalls ?? []).map(() =>
          this.#generateToolIdempotencyKey(),
        );
      }

      const calls = result.toolCalls ?? [];
      await checkpoint(result, nextToolIndex);
      if (
        isTruncatedFinishReason(result.finishReason) &&
        context.step.completionPolicy?.onTruncation !== "accept"
      ) {
        throw new ModelCompletionError(
          `Model response for prompt step ${context.step.id} was truncated (${result.finishReason}); increase the output budget or set completionPolicy.onTruncation to accept.`,
          result.finishReason,
        );
      }
      if (calls.length === 0) {
        finalResult = result;
        break;
      }
      suspendIfExhausted();
      if (!context.tools) {
        throw new Error(
          `Model requested tools but no ToolAdapter is configured`,
        );
      }
      if (toolCallCount + (calls.length - nextToolIndex) > maxToolCalls) {
        throw new Error(
          `Prompt step ${context.step.id} exceeded its ${maxToolCalls} tool-call limit`,
        );
      }

      for (
        let toolIndex = nextToolIndex;
        toolIndex < calls.length;
        toolIndex += 1
      ) {
        const call = calls[toolIndex]!;
        await context.emit("model.tool.requested", {
          toolCallId: call.id,
          toolName: call.name,
        });
        await context.emit("model.tool.started", {
          toolCallId: call.id,
          toolName: call.name,
        });
        const toolResult = await context.tools.executeTool(call, {
          runId: context.runId,
          stepId: context.step.id,
          variables: context.variables,
          idempotencyKey: toolIdempotencyKeys[toolIndex]!,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        toolCallCount += 1;
        const toolTranscript = this.#toolTranscript(toolResult);
        transcript.push(toolTranscript);
        messages.push(
          await resolveMessageMedia(
            { role: "tool", content: toolTranscript.content },
            context,
          ),
        );
        await context.emit("model.tool.completed", {
          toolCallId: call.id,
          toolName: call.name,
          failed: toolResult.error != null,
          ...(toolResult.error ? { errorCode: toolResult.error.code } : {}),
        });
        await checkpoint(result, toolIndex + 1);
      }
      result = undefined;
      nextToolIndex = 0;
      toolIdempotencyKeys = [];
    }

    if (!finalResult)
      throw new Error("Prompt execution ended without a result");

    if (
      context.step.completionPolicy?.requireOutput &&
      !hasOutput(finalResult.output)
    ) {
      throw new ModelCompletionError(
        `Model response for prompt step ${context.step.id} did not contain required output.`,
        finalResult.finishReason,
      );
    }

    return {
      ...(finalResult.output === undefined
        ? {}
        : { output: finalResult.output }),
      ...(context.step.outputVariable && finalResult.output !== undefined
        ? {
            statePatch: {
              set: { [context.step.outputVariable]: finalResult.output },
            },
          }
        : {}),
      transcript,
      metadata: {
        model: modelKey(context.step, context),
        toolCallCount,
        streamed: context.model.stream != null,
      },
    };
  }

  async #resolveTools(
    context: StepExecutionContext & { step: PromptStep },
  ): Promise<AgentTool[]> {
    if (!context.step.tools || context.step.tools.length === 0) return [];
    if (!context.tools) {
      throw new Error(
        `Prompt step ${context.step.id} names tools but no ToolAdapter is configured`,
      );
    }
    const available = await context.tools.listTools();
    const byName = new Map(available.map((tool) => [tool.name, tool]));
    return context.step.tools.map((name) => {
      const selected = byName.get(name);
      if (!selected) throw new Error(`Tool ${name} is not available`);
      return selected;
    });
  }

  async #invokeModel(
    context: StepExecutionContext & { step: PromptStep },
    request: ModelRequest,
  ): Promise<ModelResult> {
    if (!context.model?.stream) {
      return raceWithSignal(context.model!.generate(request), request.signal);
    }
    let completed: ModelResult | undefined;
    const iterator = context.model.stream(request)[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await raceWithSignal(iterator.next(), request.signal);
        if (next.done) break;
        const event = next.value;
        if (event.type === "text-delta") {
          await context.emit("model.text.delta", { delta: event.delta });
        } else if (event.type === "reasoning-delta") {
          await context.emit("model.reasoning.delta", { delta: event.delta });
        } else if (event.type === "completed") {
          completed = event.result;
        }
      }
    } finally {
      if (request.signal?.aborted) await iterator.return?.();
    }
    if (!completed)
      throw new Error("Model stream ended without a completed result");
    return completed;
  }

  #toolTranscript(result: ToolResult): TranscriptItem {
    return {
      id: this.#generateTranscriptId(),
      type: "tool-result",
      role: "tool",
      content: [{ type: "tool-result", result }],
      createdAt: this.#now().toISOString(),
    };
  }
}
