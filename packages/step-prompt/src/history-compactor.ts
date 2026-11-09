/**
 * Run-level compaction of a conversation history: summarizes the oldest part
 * of the history once per run, before the first step, with the same
 * summarizer, policies, host adapter, retries, budget, and journaling that
 * prompt steps use for their own context.
 */
import type {
  ContextSummarizer,
  JsonObject,
  ModelUsage,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";
import {
  RunSuspendedError,
  type MessageHistoryCompactionRequest,
  type MessageHistoryCompactionResult,
  type MessageHistoryCompactor,
} from "@clearideas/agent-runtime-core";
import type {
  ContextSummarizeRequest,
  ContextSummarizeResult,
  ModelRequest,
  ModelResult,
} from "@clearideas/agent-runtime-core/ports";

import { errorSummary, isRetryableModelError } from "./context/errors.js";
import { jsonBytes, jsonTextBytes } from "./context/measure.js";
import { pruneText } from "./context/prune.js";
import {
  ChunkedSummarizer,
  SummarizerError,
  summarizerMessages,
  type SummarizerCallInput,
} from "./context/summarize.js";
import { fingerprint } from "./context/transcript.js";
import {
  abortableSleep,
  isTruncatedFinishReason,
  ModelTimeoutError,
  modelKeyFromReference,
  modelOperation,
  raceWithSignal,
  referenceProvider,
  reportedTotalTokens,
  resultUsage,
  safeModelCompletedData,
} from "./helpers.js";
import { PROMPT_POLICY_DEFAULTS, SUMMARIZER_DEFAULTS } from "./execution.js";

export interface PromptMessageHistoryCompactorOptions {
  now?: () => Date;
  generateTranscriptId?: () => string;
  /** Waits between model retries. Tests replace it to avoid real delays. */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface HistoryJournal extends JsonObject {
  plans: number[];
  calls: Array<{ key: string; text?: string; error?: string }>;
}

const BYTES_PER_TOKEN = 4;

const parseJournal = (value: JsonObject | undefined): HistoryJournal => {
  const plans = Array.isArray(value?.plans)
    ? value.plans.filter((plan): plan is number => typeof plan === "number")
    : [];
  const calls = Array.isArray(value?.calls)
    ? value.calls.flatMap((call) =>
        call != null &&
        typeof call === "object" &&
        !Array.isArray(call) &&
        typeof call.key === "string"
          ? [
              {
                key: call.key,
                ...(typeof call.text === "string" ? { text: call.text } : {}),
                ...(typeof call.error === "string"
                  ? { error: call.error }
                  : {}),
              },
            ]
          : [],
      )
    : [];
  return { plans, calls };
};

/** Summarizes conversation histories for AgentRuntime's run-level compaction. */
export class PromptMessageHistoryCompactor implements MessageHistoryCompactor {
  readonly #now: () => Date;
  readonly #generateTranscriptId: () => string;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: PromptMessageHistoryCompactorOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#generateTranscriptId =
      options.generateTranscriptId ?? (() => globalThis.crypto.randomUUID());
    this.#sleep = options.sleep ?? abortableSleep;
  }

  async summarize(
    request: MessageHistoryCompactionRequest,
  ): Promise<MessageHistoryCompactionResult> {
    const settings: ContextSummarizer =
      request.policies.context?.summarizer ?? {};
    const journal = parseJournal(request.journal);
    const transcript: TranscriptItem[] = [];
    let calls = 0;
    let callCursor = 0;
    let planCursor = 0;

    const share = settings.summaryShare ?? SUMMARIZER_DEFAULTS.summaryShare;
    const minimum =
      settings.minSummaryBytes ?? SUMMARIZER_DEFAULTS.minSummaryBytes;
    const maximum =
      settings.maxSummaryBytes ?? SUMMARIZER_DEFAULTS.maxSummaryBytes;
    const targetBytes = Math.max(
      256,
      Math.min(
        request.maxTargetBytes,
        Math.min(maximum, Math.max(minimum, request.segmentBytes * share)),
      ),
    );
    const maxCalls =
      settings.maxCalls ??
      Math.max(
        SUMMARIZER_DEFAULTS.minimumMaxCalls,
        (request.policies.context?.maxCompactions ??
          PROMPT_POLICY_DEFAULTS.maxCompactions) *
          SUMMARIZER_DEFAULTS.callsPerCompaction,
      );
    const retry = {
      maxAttempts:
        request.policies.modelRetry?.maxAttempts ??
        PROMPT_POLICY_DEFAULTS.modelRetry.maxAttempts,
      initialDelayMs:
        request.policies.modelRetry?.initialDelayMs ??
        PROMPT_POLICY_DEFAULTS.modelRetry.initialDelayMs,
      maxDelayMs:
        request.policies.modelRetry?.maxDelayMs ??
        PROMPT_POLICY_DEFAULTS.modelRetry.maxDelayMs,
    };

    const suspendIfExhausted = (): void => {
      const budget = request.tokenBudget;
      if (!budget || budget.consumedTokens < budget.maxTotalTokens) return;
      throw new RunSuspendedError("token-budget", {
        maxTotalTokens: budget.maxTotalTokens,
        consumedTokens: budget.consumedTokens,
        scope: "messages",
      });
    };

    const recordUsage = async (
      usage: ModelUsage,
      source?: "host",
    ): Promise<void> => {
      const budgetState =
        request.tokenBudget && reportedTotalTokens(usage) != null
          ? request.tokenBudget.consume(usage)
          : undefined;
      transcript.push({
        id: this.#generateTranscriptId(),
        type: "message",
        content: [],
        createdAt: this.#now().toISOString(),
        usage,
        metadata: {
          agentRuntime: {
            context: {
              kind: "usage",
              strategy: "none",
              reason: "messages-summarizer",
            },
          },
        },
      });
      await request.emit("model.usage", {
        usage: JSON.parse(JSON.stringify(usage)) as JsonObject,
        purpose: "summarize",
        ...(source ? { source } : {}),
        ...(budgetState ?? {}),
      });
    };

    const save = () =>
      request.checkpoint({
        journal: structuredClone(journal),
        transcript: structuredClone(transcript),
      });

    const invoke = async (
      modelRequest: ModelRequest,
      provider: string,
    ): Promise<ModelResult> => {
      const model = request.model;
      if (!model)
        throw new SummarizerError(
          "Summarizing the conversation requires a ModelAdapter.",
        );
      const timeoutMs = request.manifest.limits?.providerTimeoutMs;
      for (let attempt = 1; ; attempt += 1) {
        suspendIfExhausted();
        const operation = modelOperation(request.signal, timeoutMs);
        try {
          await request.emit("model.started", {
            model: modelRequest.model,
            provider,
            purpose: "summarize",
          });
          const result = await raceWithSignal(
            () =>
              model.generate({
                ...modelRequest,
                ...(operation.signal ? { signal: operation.signal } : {}),
              }),
            operation.signal,
          );
          await request.emit("model.completed", {
            ...safeModelCompletedData(result),
            purpose: "summarize",
          });
          return result;
        } catch (caught) {
          const error = operation.didTimeOut()
            ? new ModelTimeoutError(timeoutMs!)
            : caught;
          if (request.signal?.aborted) throw error;
          if (attempt >= retry.maxAttempts || !isRetryableModelError(error))
            throw error;
          const delayMs = Math.min(
            retry.maxDelayMs,
            retry.initialDelayMs * 2 ** (attempt - 1),
          );
          await request.emit("model.retry", {
            reason: "retryable-error",
            attempt,
            maxAttempts: retry.maxAttempts,
            delayMs,
            purpose: "summarize",
            ...errorSummary(error),
          });
          await this.#sleep(delayMs, request.signal);
        } finally {
          operation.dispose();
        }
      }
    };

    const builtIn = async (
      summarizeRequest: ContextSummarizeRequest,
    ): Promise<ContextSummarizeResult> => {
      const requested = summarizeRequest.settings;
      const reference = requested.model ?? request.manifest.model;
      const key = modelKeyFromReference(reference, "messages");
      const description = await Promise.resolve(
        request.model?.describeModel?.(key),
      ).catch(() => undefined);
      const hardBytes = request.manifest.limits?.maxInputBytes;
      const planIndex = planCursor++;
      const chunkBytes =
        journal.plans[planIndex] ??
        requested.chunkBytes ??
        (description?.maxInputTokens
          ? Math.floor(description.maxInputTokens * 0.5 * BYTES_PER_TOKEN)
          : SUMMARIZER_DEFAULTS.chunkBytes);
      journal.plans[planIndex] = chunkBytes;
      const summarizer = new ChunkedSummarizer({
        call: async (input: SummarizerCallInput) => {
          const messages = summarizerMessages(input);
          const modelRequest: ModelRequest = {
            model: key,
            messages,
            maxOutputTokens: input.maxOutputTokens,
            ...(reference?.options
              ? { providerOptions: reference.options }
              : {}),
          };
          const requestBytes = jsonBytes(messages);
          if (hardBytes != null && requestBytes > hardBytes)
            throw new SummarizerError(
              `Summarizer input is ${requestBytes} bytes, exceeding the ${hardBytes}-byte input limit.`,
            );
          const index = callCursor++;
          const callKey = fingerprint(JSON.stringify(modelRequest));
          const saved = journal.calls[index];
          if (saved?.key === callKey) {
            if (saved.error !== undefined)
              throw new SummarizerError(saved.error);
            return saved.text!;
          }
          journal.calls.splice(index);
          if (calls >= maxCalls)
            throw new SummarizerError(
              `Summarizing the conversation needs more than ${maxCalls} summarizer calls.`,
            );
          calls += 1;
          const result = await invoke(
            modelRequest,
            referenceProvider(reference),
          );
          let usage = resultUsage(result);
          if (
            request.tokenBudget &&
            (!usage || reportedTotalTokens(usage) == null)
          ) {
            const inputTokens = Math.ceil(requestBytes / BYTES_PER_TOKEN);
            const outputTokens = Math.ceil(
              jsonBytes(result.transcript.map((item) => item.content)) /
                BYTES_PER_TOKEN,
            );
            usage = {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              metadata: { estimated: true },
            };
          }
          if (usage) await recordUsage(usage);
          let error: string | undefined;
          if ((result.toolCalls?.length ?? 0) > 0)
            error = "The summarizer requested tool calls.";
          if (isTruncatedFinishReason(result.finishReason))
            error = `The summarizer's output was truncated (${result.finishReason}); raise the summarizer's maxOutputTokens.`;
          const output = result.output;
          const text =
            typeof output === "string"
              ? output
              : output === undefined
                ? ""
                : JSON.stringify(output);
          journal.calls.push({
            key: callKey,
            ...(error ? { error } : { text }),
          });
          await save();
          if (error) throw new SummarizerError(error);
          return text;
        },
        chunkBytes,
        maxCalls,
        ...(hardBytes != null ? { maxInputBytes: hardBytes } : {}),
        ...(requested.maxPasses ? { maxPasses: requested.maxPasses } : {}),
        ...(requested.systemPrompt
          ? { systemPrompt: requested.systemPrompt }
          : {}),
        ...(requested.prompt ? { prompt: requested.prompt } : {}),
        ...(requested.prompts?.messages
          ? { prompts: { messages: requested.prompts.messages } }
          : {}),
        ...(requested.maxOutputTokens
          ? { maxOutputTokens: requested.maxOutputTokens }
          : {}),
        ...(description?.maxOutputTokens
          ? { modelMaxOutputTokens: description.maxOutputTokens }
          : {}),
        variables: {},
      });
      return {
        text: await summarizer.summarize({
          text: summarizeRequest.text,
          targetBytes: summarizeRequest.targetBytes,
          kind: "messages",
          label: summarizeRequest.label,
          task: summarizeRequest.task,
        }),
      };
    };

    const summarizeRequest: ContextSummarizeRequest = {
      runId: request.runId,
      // History compaction belongs to the run, not a step.
      stepId: "",
      kind: "messages",
      label: request.label,
      task: request.task,
      text: request.text,
      targetBytes: Math.floor(targetBytes),
      settings: structuredClone(settings),
      ...(request.signal ? { signal: request.signal } : {}),
    };
    let result: ContextSummarizeResult;
    if (request.summarizer) {
      suspendIfExhausted();
      result = await request.summarizer.summarize(summarizeRequest, builtIn);
      if (result.usage) {
        await recordUsage(result.usage, "host");
        await save();
      }
    } else {
      result = await builtIn(summarizeRequest);
    }
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (!text)
      throw new SummarizerError(
        `The summarizer returned nothing for ${request.label}.`,
      );
    return {
      text:
        jsonTextBytes(text) > request.maxTargetBytes
          ? pruneText(text, request.maxTargetBytes)
          : text,
      transcript,
      summarizerCalls: calls,
    };
  }
}
