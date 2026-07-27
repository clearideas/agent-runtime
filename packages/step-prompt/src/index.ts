import type {
  JsonObject,
  JsonValue,
  PromptStep,
  ToolResult,
  TranscriptItem,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
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
      ? [{ role: item.role, content: item.content } satisfies ModelMessage]
      : [],
  );

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

export class PromptStepExecutor implements StepExecutor<PromptStep> {
  readonly type = "prompt" as const;
  readonly #now: () => Date;
  readonly #generateTranscriptId: () => string;
  readonly #defaultMaxToolCalls: number;

  constructor(options: PromptStepExecutorOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#generateTranscriptId =
      options.generateTranscriptId ?? (() => globalThis.crypto.randomUUID());
    this.#defaultMaxToolCalls = options.defaultMaxToolCalls ?? 25;
  }

  async execute(
    context: StepExecutionContext & { step: PromptStep },
  ): Promise<StepExecutionResult> {
    if (!context.model) {
      throw new Error(`Prompt step ${context.step.id} requires a ModelAdapter`);
    }
    const tools = await this.#resolveTools(context);
    const messages: ModelMessage[] = [];
    if (context.step.systemPrompt) {
      messages.push({
        role: "system",
        content: [
          {
            type: "text",
            text: compilePromptTemplate(
              context.step.systemPrompt,
              context.variables,
            ),
          },
        ],
      });
    }
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: compilePromptTemplate(context.step.prompt, context.variables),
        },
      ],
    });

    const transcript: TranscriptItem[] = [];
    const maxToolCalls =
      context.manifest.limits?.maxToolCallsPerIteration ??
      this.#defaultMaxToolCalls;
    let toolCallCount = 0;
    let result: ModelResult;

    while (true) {
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

      const calls = result.toolCalls ?? [];
      if (
        isTruncatedFinishReason(result.finishReason) &&
        context.step.completionPolicy?.onTruncation !== "accept"
      ) {
        throw new ModelCompletionError(
          `Model response for prompt step ${context.step.id} was truncated (${result.finishReason}); increase the output budget or set completionPolicy.onTruncation to accept.`,
          result.finishReason,
        );
      }
      if (calls.length === 0) break;
      if (!context.tools) {
        throw new Error(
          `Model requested tools but no ToolAdapter is configured`,
        );
      }
      if (toolCallCount + calls.length > maxToolCalls) {
        throw new Error(
          `Prompt step ${context.step.id} exceeded its ${maxToolCalls} tool-call limit`,
        );
      }

      for (const call of calls) {
        toolCallCount += 1;
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
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const toolTranscript = this.#toolTranscript(toolResult);
        transcript.push(toolTranscript);
        messages.push({ role: "tool", content: toolTranscript.content });
        await context.emit("model.tool.completed", {
          toolCallId: call.id,
          toolName: call.name,
          failed: toolResult.error != null,
          ...(toolResult.error ? { errorCode: toolResult.error.code } : {}),
        });
      }
    }

    if (
      context.step.completionPolicy?.requireOutput &&
      !hasOutput(result.output)
    ) {
      throw new ModelCompletionError(
        `Model response for prompt step ${context.step.id} did not contain required output.`,
        result.finishReason,
      );
    }

    return {
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(context.step.outputVariable && result.output !== undefined
        ? {
            statePatch: {
              set: { [context.step.outputVariable]: result.output },
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
