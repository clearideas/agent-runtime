/**
 * One execution of a prompt step: the model/tool loop plus the safeguards
 * that let it finish instead of failing on recoverable conditions.
 *
 * - Context: the opening prompt, individual tool results, and older tool
 *   rounds are reduced (summarized or pruned) when the input nears a
 *   trigger, a hard limit, or the provider's context window.
 * - Model errors: retryable failures are retried with backoff; a context
 *   overflow reported by the provider is compacted and retried.
 * - Output: invalid structured output, empty answers, and truncated
 *   responses get a bounded number of repair turns.
 * - Tools: invalid and out-of-scope tool calls are answered with an error
 *   instead of being executed, and reaching the tool-call limit asks the
 *   model for a final answer.
 *
 * Every reduction is a marker item in the durable transcript, so resuming
 * rebuilds the same model input without repeating model calls.
 */
import type {
  ContextPolicy,
  ContextStrategy,
  ContextSummarizer,
  ContextTrigger,
  ContextVariablePolicy,
  ContentPart,
  ExecutionPolicies,
  JsonObject,
  JsonValue,
  ModelUsage,
  PromptStep,
  ToolCall,
  ToolResult,
  TranscriptItem,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import {
  isRunSuspendedError,
  RunSuspendedError,
  type StepExecutionContext,
  type StepExecutionResult,
} from "@clearideas/agent-runtime-core";
import type {
  AgentTool,
  ContextSummarizeRequest,
  ContextSummarizeResult,
  ModelDescription,
  ModelMessage,
  ModelRequest,
  ModelResult,
} from "@clearideas/agent-runtime-core/ports";

import {
  describeError,
  errorSummary,
  isContextOverflowError,
  isInvalidOutputError,
  isRetryableModelError,
} from "./context/errors.js";
import { jsonBytes, jsonTextBytes, TokenEstimator } from "./context/measure.js";
import { buildOpeningPrompt, type OpeningPrompt } from "./context/opening.js";
import {
  clipToolResultPart,
  pruneJson,
  pruneText,
  stubToolResultPart,
} from "./context/prune.js";
import {
  ChunkedSummarizer,
  type SummarizeInput,
  type SummarizerCallInput,
  SummarizerError,
  summarizerMessages,
  type SummaryKind,
} from "./context/summarize.js";
import { type TemplateSlot, templateSlots } from "./context/template.js";
import {
  compactedView,
  type ContextMarker,
  contextMarker,
  deriveRounds,
  fingerprint,
  type InputSlotReduction,
  inputReductions,
  markerMetadata,
  nextMarkerSequence,
  renderItemsAsText,
  splitRetained,
  summaryCompactions,
  toolRoundsSinceCompaction,
  type TranscriptRound,
  viewMessages,
} from "./context/transcript.js";
import {
  abortReason,
  hasOutput,
  isTruncatedFinishReason,
  ModelCompletionError,
  modelKeyFromReference,
  modelOperation,
  ModelTimeoutError,
  raceWithSignal,
  referenceProvider,
  reportedTotalTokens,
  resolveMessageMedia,
  resultUsage,
  safeModelCompletedData,
  stepModelReference,
} from "./helpers.js";

export interface PromptExecutionDependencies {
  now(): Date;
  generateTranscriptId(): string;
  generateToolIdempotencyKey(): string;
  defaultMaxToolCalls: number;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}

type PromptContext = StepExecutionContext & { step: PromptStep };

/** Built-in policy values used when neither host, manifest, nor step sets one. */
export const PROMPT_POLICY_DEFAULTS = {
  strategy: "prune" as ContextStrategy,
  retainToolRounds: 2,
  maxCompactions: 25,
  /** Applied when the adapter describes the model's input window. */
  contextRatio: 0.8,
  toolCallLimit: "finalize" as const,
  modelRetry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 20_000 },
  outputRepairAttempts: 1,
  overflowRetries: 3,
  /** Size a reduction aims for, as a fraction of the trigger. */
  reduceTo: 0.25,
  /** Opening-prompt budget as a fraction of the trigger. */
  openingShareWithTools: 0.5,
  openingShareWithoutTools: 0.9,
  /** Single tool-result cap as a fraction of the trigger. */
  toolResultShare: 0.4,
};

const STUB_MINIMUM_BYTES = 600;
/** Smallest summary a compaction asks for, and the size of a removal note. */
/** Built-in summarizer defaults; every value is a summarizer policy setting. */
export const SUMMARIZER_DEFAULTS = {
  summaryShare: 0.25,
  minSummaryBytes: 1_024,
  maxSummaryBytes: 16_384,
  minimumMaxCalls: 16,
  callsPerCompaction: 8,
  chunkBytes: 48_000,
  maxPasses: 4,
};
const MINIMUM_NOTE_BYTES = 400;
/** Calls a removal note lists by name and main argument. */
const MAXIMUM_LISTED_CALLS = 40;

/** A tool call as `name(first string argument)`, short enough for a note. */
const describeCall = (call: ToolCall): string => {
  const argument = Object.values(call.input).find(
    (value): value is string => typeof value === "string",
  );
  const shown =
    argument === undefined
      ? ""
      : argument.length > 60
        ? `${argument.slice(0, 57)}...`
        : argument;
  return `${call.name}(${shown})`;
};
const MESSAGE_OVERHEAD_BYTES = 300;
const DEFAULT_CHUNK_BYTES = SUMMARIZER_DEFAULTS.chunkBytes;
const TASK_OUTLINE_BYTES = 2_000;

interface ResolvedSummarizerSettings {
  summaryShare: number;
  minSummaryBytes: number;
  maxSummaryBytes: number;
  maxCalls: number;
}

interface Fits {
  /** Where a reduction aims, reducing older material only. */
  goal: number;
  /** What the next request needs; only this justifies reducing newest rounds. */
  must: number;
  goalMet(): boolean;
  mustMet(): boolean;
}

interface ResolvedPolicies {
  context: {
    strategy: ContextStrategy;
    trigger: ContextTrigger;
    retainToolRounds: number;
    maxCompactions: number;
    maxToolResultBytes: number | undefined;
    reduceTo: number;
    overflowRetries: number;
    /** Undefined: the default depends on whether the step has tools. */
    openingShare: number | undefined;
    toolResultShare: number;
    summarizer: ContextSummarizer;
    variables: Record<string, ContextVariablePolicy>;
  };
  toolCallLimit: "finalize" | "fail";
  modelRetry: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
  };
  outputRepairAttempts: number;
}

export const resolvePromptPolicies = (
  policies: ExecutionPolicies | undefined,
): ResolvedPolicies => {
  const context: ContextPolicy = policies?.context ?? {};
  return {
    context: {
      strategy: context.strategy ?? PROMPT_POLICY_DEFAULTS.strategy,
      trigger: context.trigger ?? {},
      retainToolRounds:
        context.retain?.recentToolRounds ??
        PROMPT_POLICY_DEFAULTS.retainToolRounds,
      maxCompactions:
        context.maxCompactions ?? PROMPT_POLICY_DEFAULTS.maxCompactions,
      maxToolResultBytes: context.maxToolResultBytes,
      reduceTo: context.reduceTo ?? PROMPT_POLICY_DEFAULTS.reduceTo,
      overflowRetries:
        context.overflowRetries ?? PROMPT_POLICY_DEFAULTS.overflowRetries,
      openingShare: context.openingShare,
      toolResultShare:
        context.toolResultShare ?? PROMPT_POLICY_DEFAULTS.toolResultShare,
      summarizer: context.summarizer ?? {},
      variables: context.variables ?? {},
    },
    toolCallLimit:
      policies?.toolCallLimit ?? PROMPT_POLICY_DEFAULTS.toolCallLimit,
    modelRetry: {
      maxAttempts:
        policies?.modelRetry?.maxAttempts ??
        PROMPT_POLICY_DEFAULTS.modelRetry.maxAttempts,
      initialDelayMs:
        policies?.modelRetry?.initialDelayMs ??
        PROMPT_POLICY_DEFAULTS.modelRetry.initialDelayMs,
      maxDelayMs:
        policies?.modelRetry?.maxDelayMs ??
        PROMPT_POLICY_DEFAULTS.modelRetry.maxDelayMs,
    },
    outputRepairAttempts:
      policies?.outputRepair?.maxAttempts ??
      PROMPT_POLICY_DEFAULTS.outputRepairAttempts,
  };
};

interface PendingModelResult {
  result: ModelResult;
  nextToolIndex: number;
  toolIdempotencyKeys: string[];
}

interface RestoredContinuation {
  toolCallCount: number;
  pending?: PendingModelResult;
}

/** Replaying this journal rebuilds map/reduce passes without repeating model calls. */
interface SummaryJournal {
  key: string;
  plans: number[];
  calls: Array<{ key: string; text?: string; error?: string }>;
  result?: string;
}

const parsePromptContinuation = (
  context: PromptContext,
): RestoredContinuation | undefined => {
  const value = context.resume?.continuation;
  if (value?.type !== "prompt" || value.stepId !== context.step.id)
    return undefined;
  if (
    !Number.isSafeInteger(value.toolCallCount) ||
    Number(value.toolCallCount) < 0
  )
    return undefined;
  const toolCallCount = Number(value.toolCallCount);
  if (value.phase === "ready") return { toolCallCount };
  if (
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
    Number(value.nextToolIndex) > value.toolCalls.length
  ) {
    return undefined;
  }
  return {
    toolCallCount,
    pending: {
      result: {
        ...(value.hasOutput ? { output: structuredClone(value.output) } : {}),
        transcript: [],
        toolCalls: structuredClone(value.toolCalls) as unknown as ToolCall[],
        ...(typeof value.finishReason === "string"
          ? { finishReason: value.finishReason }
          : {}),
      },
      nextToolIndex: Number(value.nextToolIndex),
      toolIdempotencyKeys: [...value.toolIdempotencyKeys] as string[],
    },
  };
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value != null && typeof value === "object" && !Array.isArray(value);

const invalidCallError = (call: ToolCall): string | undefined => {
  const runtime = call.metadata?.agentRuntime;
  if (!isJsonObject(runtime) || runtime.invalid !== true) return undefined;
  return typeof runtime.error === "string"
    ? runtime.error
    : "Invalid tool call.";
};

const hasToolResultFor = (
  items: readonly TranscriptItem[],
  callId: string,
): boolean =>
  items.some((item) =>
    item.content.some(
      (part) => part.type === "tool-result" && part.result.callId === callId,
    ),
  );

const toolResultText = (result: ToolResult): string =>
  result.error != null
    ? result.error.message
    : typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output ?? null);

/** Distribute `available` bytes over sizes; small entries keep their size. */
const waterFill = (sizes: readonly number[], available: number): number[] => {
  const order = sizes
    .map((size, index) => ({ size, index }))
    .sort((left, right) => left.size - right.size);
  const caps = [...sizes];
  let remaining = Math.max(0, available);
  for (let position = 0; position < order.length; position += 1) {
    const share = Math.floor(remaining / (order.length - position));
    const entry = order[position]!;
    if (entry.size <= share) {
      remaining -= entry.size;
      continue;
    }
    for (let rest = position; rest < order.length; rest += 1)
      caps[order[rest]!.index] = share;
    break;
  }
  return caps;
};

export class PromptExecution {
  readonly #context: PromptContext;
  readonly #deps: PromptExecutionDependencies;
  readonly #policy: ResolvedPolicies;
  readonly #modelKey: string;
  readonly #estimator = new TokenEstimator();
  readonly #resolvedCache = new Map<string, ModelMessage>();
  #transcript: TranscriptItem[];
  #tools: AgentTool[] = [];
  #allowedTools = new Set<string>();
  #unavailableTools: Array<{ name: string; reason: string }> = [];
  #opening!: OpeningPrompt;
  #task = "";
  #initialMessages: ModelMessage[] = [];
  #messages: ModelMessage[] = [];
  #dirty = true;
  #description: ModelDescription | undefined;
  #overflowCeilingBytes: number | undefined;
  #toolCallCount = 0;
  #maxToolCalls: number;
  #repairsUsed = 0;
  #outputTokenOverride: number | undefined;
  #checkpointRounds = false;
  #pending: PendingModelResult | undefined;
  #pendingReductions: string[] = [];
  #summaryJournals: SummaryJournal[] = [];
  #activeSummary: SummaryJournal | undefined;
  #summaryCallCursor = 0;
  #summaryPlanCursor = 0;
  /** Built-in summarizer calls made in this step execution. */
  #summarizerCallsUsed = 0;
  #usageEstimateReported = false;
  #compactionLimitReported = false;
  #reductions = 0;

  constructor(context: PromptContext, deps: PromptExecutionDependencies) {
    this.#context = context;
    this.#deps = deps;
    this.#policy = resolvePromptPolicies(context.policies);
    this.#modelKey = modelKeyFromReference(
      stepModelReference(context.step, context),
      context.step.id,
    );
    this.#transcript = structuredClone(context.resume?.transcript ?? []);
    this.#maxToolCalls =
      context.manifest.limits?.maxToolCallsPerIteration ??
      deps.defaultMaxToolCalls;
  }

  get #step(): PromptStep {
    return this.#context.step;
  }

  get #strategy(): ContextStrategy {
    return this.#policy.context.strategy;
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  async run(): Promise<StepExecutionResult> {
    const context = this.#context;
    if (!context.model) {
      throw new Error(`Prompt step ${this.#step.id} requires a ModelAdapter`);
    }
    if (context.tokenBudget && !context.checkpoint) {
      throw new Error("Budgeted prompt execution requires checkpoint support");
    }
    const restored = parsePromptContinuation(context);
    this.#toolCallCount = restored?.toolCallCount ?? 0;
    this.#pending = restored?.pending;
    this.#restoreProgress();
    await this.#prepare();
    await this.#finishToolReductions();
    let pending: PendingModelResult | undefined = restored?.pending;
    let finalResult: ModelResult | undefined;

    while (true) {
      if (!pending) {
        // A run cancelled during a tool call must not start another turn.
        if (context.signal?.aborted) throw abortReason(context.signal);
        this.#suspendIfExhausted();
        const finalize =
          this.#policy.toolCallLimit === "finalize" &&
          this.#tools.length > 0 &&
          this.#toolCallCount >= this.#maxToolCalls;
        await this.#fitContext("trigger");
        if (finalize) await this.#ensureFinalizeNotice();
        await this.#rebuild();
        this.#enforceInputLimits();
        const result = await this.#requestModel(finalize);
        pending = this.#pending = {
          result,
          nextToolIndex: 0,
          toolIdempotencyKeys: (result.toolCalls ?? []).map(() =>
            this.#deps.generateToolIdempotencyKey(),
          ),
        };
      }

      const { result } = pending;
      const calls = result.toolCalls ?? [];
      await this.#checkpointPending(pending);

      if (
        isTruncatedFinishReason(result.finishReason) &&
        this.#step.completionPolicy?.onTruncation !== "accept"
      ) {
        if (await this.#repairTruncation(result)) {
          this.#pending = undefined;
          await this.#checkpointReady();
          pending = undefined;
          continue;
        }
        throw new ModelCompletionError(
          `Model response for prompt step ${this.#step.id} was truncated (${result.finishReason}); increase the output budget or set completionPolicy.onTruncation to accept.`,
          result.finishReason,
        );
      }
      if (calls.length === 0) {
        if (
          this.#step.completionPolicy?.requireOutput &&
          !hasOutput(result.output) &&
          (await this.#repairEmptyOutput())
        ) {
          this.#pending = undefined;
          await this.#checkpointReady();
          pending = undefined;
          continue;
        }
        finalResult = result;
        break;
      }

      this.#suspendIfExhausted();
      await this.#executeToolCalls(pending);
      pending = this.#pending = undefined;
      await this.#checkpointReady();
    }

    if (!finalResult)
      throw new Error("Prompt execution ended without a result");
    if (
      this.#step.completionPolicy?.requireOutput &&
      !hasOutput(finalResult.output)
    ) {
      throw new ModelCompletionError(
        `Model response for prompt step ${this.#step.id} did not contain required output.`,
        finalResult.finishReason,
      );
    }

    return {
      ...(finalResult.output === undefined
        ? {}
        : { output: finalResult.output }),
      ...(this.#step.outputVariable && finalResult.output !== undefined
        ? {
            statePatch: {
              set: { [this.#step.outputVariable]: finalResult.output },
            },
          }
        : {}),
      transcript: this.#transcript,
      metadata: {
        model: this.#modelKey,
        toolCallCount: this.#toolCallCount,
        streamed: context.model!.stream != null,
        ...(this.#reductions > 0
          ? { contextReductions: this.#reductions }
          : {}),
      },
    };
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  async #prepare(): Promise<void> {
    const context = this.#context;
    this.#tools = await this.#resolveTools();
    this.#allowedTools = new Set(this.#tools.map((tool) => tool.name));
    this.#checkpointRounds = context.checkpoint != null;
    this.#description = await this.#describe(this.#modelKey);
    this.#opening = buildOpeningPrompt(this.#step, context.variables);
    this.#task = pruneText(this.#opening.outline(), TASK_OUTLINE_BYTES);
    this.#applyStoredInputReductions();
    await this.#renderInitial();
    if (this.#unavailableTools.length > 0) {
      await context.emit("diagnostic", {
        code: "TOOLS_UNAVAILABLE",
        tools: this.#unavailableTools.map((tool) => tool.name),
      });
    }
    await this.#applyVariableCaps();
    await this.#fitOpeningPrompt();
  }

  async #resolveTools(): Promise<AgentTool[]> {
    const context = this.#context;
    const names = this.#step.tools ?? [];
    if (names.length === 0) return [];
    if (!context.tools) {
      throw new Error(
        `Prompt step ${this.#step.id} names tools but no ToolAdapter is configured`,
      );
    }
    const available = await context.tools.listTools();
    const byName = new Map(available.map((tool) => [tool.name, tool]));
    const selected: AgentTool[] = [];
    for (const name of names) {
      const tool = byName.get(name);
      if (tool) {
        selected.push(tool);
        continue;
      }
      if (context.tools.isToolExcluded?.(name) === true) continue;
      const reason = context.tools.unavailableToolReason?.(name);
      if (reason !== undefined) {
        this.#unavailableTools.push({ name, reason });
        continue;
      }
      throw new Error(`Tool ${name} is not available`);
    }
    return selected;
  }

  async #describe(model: string): Promise<ModelDescription | undefined> {
    try {
      return (await this.#context.model?.describeModel?.(model)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  // ─── Opening prompt ───────────────────────────────────────────────────────

  #variablePolicy(path: string): ContextVariablePolicy {
    const variables = this.#policy.context.variables;
    const lower = path.toLowerCase();
    const root = lower.split(".")[0] ?? lower;
    const entry =
      Object.entries(variables).find(([key]) => key.toLowerCase() === lower) ??
      Object.entries(variables).find(([key]) => key.toLowerCase() === root);
    return entry?.[1] ?? {};
  }

  #slotStrategy(path: string): ContextStrategy {
    return this.#variablePolicy(path).strategy ?? this.#strategy;
  }

  #applyStoredInputReductions(): void {
    const stored = inputReductions(this.#transcript);
    if (stored.size === 0) return;
    for (const template of this.#opening.templates) {
      template.segments.forEach((segment, index) => {
        if (!("slot" in segment)) return;
        const reduction = stored.get(`${template.location}#${index}`);
        if (
          reduction &&
          reduction.sourceHash === fingerprint(segment.slot.originalText)
        )
          segment.slot.text = reduction.text;
      });
    }
  }

  async #renderInitial(): Promise<void> {
    const rendered = this.#opening.render();
    if (this.#unavailableTools.length > 0) {
      const notice: ModelMessage = {
        role: "system",
        content: [
          {
            type: "text",
            text: `These tools are unavailable for this step right now and cannot be called: ${this.#unavailableTools
              .map((tool) => `${tool.name} (${tool.reason})`)
              .join(
                "; ",
              )}. Complete the task without them, and say so if that limits the answer.`,
          },
        ],
      };
      const firstNonSystem = rendered.findIndex(
        (message) => message.role !== "system",
      );
      rendered.splice(
        firstNonSystem < 0 ? rendered.length : firstNonSystem,
        0,
        notice,
      );
    }
    this.#initialMessages = await Promise.all(
      rendered.map((message) => resolveMessageMedia(message, this.#context)),
    );
    this.#dirty = true;
  }

  /** Variables with an explicit maxBytes are always capped. */
  async #applyVariableCaps(): Promise<void> {
    const targets: Array<{
      template: OpeningPrompt["templates"][number];
      index: number;
      slot: TemplateSlot;
      cap: number;
    }> = [];
    for (const entry of templateSlots(this.#opening.templates)) {
      const policy = this.#variablePolicy(entry.slot.path);
      if (policy.keep || policy.maxBytes == null) continue;
      if (this.#slotStrategy(entry.slot.path) === "fail") continue;
      if (jsonTextBytes(entry.slot.text) <= policy.maxBytes) continue;
      targets.push({ ...entry, cap: policy.maxBytes });
    }
    if (targets.length > 0) await this.#reduceSlots(targets, "variable-limit");
  }

  /** Reduce the opening prompt when it alone would use most of the budget. */
  async #fitOpeningPrompt(): Promise<void> {
    if (this.#strategy === "fail") return;
    const { triggerBytes } = this.#thresholds();
    if (!Number.isFinite(triggerBytes)) return;
    const share =
      this.#policy.context.openingShare ??
      (this.#tools.length > 0
        ? PROMPT_POLICY_DEFAULTS.openingShareWithTools
        : PROMPT_POLICY_DEFAULTS.openingShareWithoutTools);
    const budget = Math.floor(triggerBytes * share);
    if (jsonBytes(this.#initialMessages) <= budget) return;
    await this.#reduceOpeningPrompt(budget, "opening-prompt");
  }

  /** Shrink interpolated variables so the opening prompt fits `budget`. */
  async #reduceOpeningPrompt(budget: number, reason: string): Promise<boolean> {
    const candidates = templateSlots(this.#opening.templates).filter(
      ({ slot }) =>
        this.#variablePolicy(slot.path).keep !== true &&
        this.#slotStrategy(slot.path) !== "fail" &&
        jsonTextBytes(slot.text) > 256,
    );
    if (candidates.length === 0) return false;
    const sizes = candidates.map(({ slot }) => jsonTextBytes(slot.text));
    const reducible = sizes.reduce((total, size) => total + size, 0);
    const fixed = jsonBytes(this.#initialMessages) - reducible;
    const available = Math.max(candidates.length * 256, budget - fixed);
    const caps = waterFill(sizes, available);
    const targets = candidates.flatMap((candidate, position) =>
      caps[position]! < sizes[position]!
        ? [{ ...candidate, cap: Math.max(256, caps[position]!) }]
        : [],
    );
    if (targets.length === 0) return false;
    await this.#reduceSlots(targets, reason);
    return true;
  }

  async #reduceSlots(
    targets: Array<{
      template: OpeningPrompt["templates"][number];
      index: number;
      slot: TemplateSlot;
      cap: number;
    }>,
    reason: string,
  ): Promise<void> {
    const reductions: InputSlotReduction[] = [];
    const reused = new Map<
      string,
      { text: string; strategy: "summarize" | "prune" }
    >();
    const events: JsonObject[] = [];
    for (const target of targets) {
      const before = jsonTextBytes(target.slot.text);
      const key = `${fingerprint(target.slot.text)}@${target.cap}`;
      const reduced =
        reused.get(key) ??
        (await this.#reduceText({
          text: target.slot.text,
          value: target.slot.value,
          cap: target.cap,
          strategy: this.#slotStrategy(target.slot.path),
          kind: "input",
          label: `the variable ${target.slot.path}`,
        }));
      reused.set(key, reduced);
      target.slot.text = reduced.text;
      reductions.push({
        location: target.template.location,
        index: target.index,
        path: target.slot.path,
        sourceHash: fingerprint(target.slot.originalText),
        text: reduced.text,
        strategy: reduced.strategy,
      });
      events.push({
        scope: "input",
        strategy: reduced.strategy,
        reason,
        variable: target.slot.path,
        bytesBefore: before,
        bytesAfter: jsonTextBytes(reduced.text),
      });
    }
    this.#pushMarker({
      kind: "input",
      strategy: reductions.some((entry) => entry.strategy === "summarize")
        ? "summarize"
        : "prune",
      reason,
      slots: reductions,
    });
    await this.#renderInitial();
    for (const event of events) {
      await this.#emitReduced(event);
    }
    await this.#checkpointReady();
  }

  /** Reduce one text to `cap` bytes with a strategy; summarize falls back to prune when allowed. */
  async #reduceText(input: {
    text: string;
    value?: JsonValue | undefined;
    cap: number;
    strategy: ContextStrategy;
    kind: SummaryKind;
    label: string;
  }): Promise<{ text: string; strategy: "summarize" | "prune" }> {
    if (
      input.strategy === "summarize" ||
      input.strategy === "summarize-or-prune"
    ) {
      try {
        const summary = await this.#summarize({
          text: input.text,
          targetBytes: Math.floor(input.cap * 0.9),
          kind: input.kind,
          label: input.label,
          task: this.#task,
        });
        if (
          input.strategy === "summarize-or-prune" &&
          jsonTextBytes(summary) > input.cap
        )
          return { text: pruneText(summary, input.cap), strategy: "summarize" };
        return { text: summary, strategy: "summarize" };
      } catch (error) {
        this.#rethrowControlFlow(error);
        if (input.strategy === "summarize") throw this.#summaryFailure(error);
        await this.#context.emit("diagnostic", {
          code: "CONTEXT_SUMMARY_FAILED",
          scope: input.kind,
          message: describeError(error),
        });
      }
    }
    const structured = input.value != null && typeof input.value === "object";
    return {
      text: structured
        ? pruneJson(input.value!, input.cap)
        : pruneText(input.text, input.cap, input.label),
      strategy: "prune",
    };
  }

  // ─── Messages and limits ──────────────────────────────────────────────────

  async #rebuild(): Promise<void> {
    if (!this.#dirty) return;
    const originals = new Map(this.#transcript.map((item) => [item.id, item]));
    const view = compactedView(this.#transcript);
    const resolved: ModelMessage[] = [];
    for (const item of view) {
      if (!item.role) continue;
      const original = originals.get(item.id) === item;
      const key = original
        ? item.id
        : `${item.id}:${fingerprint(JSON.stringify(item.content))}`;
      let message = this.#resolvedCache.get(key);
      if (!message) {
        message = await resolveMessageMedia(
          viewMessages([item])[0]!,
          this.#context,
        );
        this.#resolvedCache.set(key, message);
      }
      resolved.push(message);
    }
    this.#messages = [...this.#initialMessages, ...resolved];
    this.#dirty = false;
  }

  #thresholds(): {
    triggerBytes: number;
    hardBytes: number | undefined;
    maxMessages: number | undefined;
  } {
    const limits = this.#context.manifest.limits;
    const trigger = this.#policy.context.trigger;
    const candidates: number[] = [];
    if (trigger.inputBytes != null) candidates.push(trigger.inputBytes);
    if (trigger.inputTokens != null)
      candidates.push(this.#estimator.bytes(trigger.inputTokens));
    const window = this.#description?.maxInputTokens;
    const ratio =
      trigger.contextRatio ??
      (window != null ? PROMPT_POLICY_DEFAULTS.contextRatio : undefined);
    if (window != null && ratio != null)
      candidates.push(this.#estimator.bytes(window * ratio));
    if (limits?.maxInputBytes != null) candidates.push(limits.maxInputBytes);
    if (this.#overflowCeilingBytes != null)
      candidates.push(this.#overflowCeilingBytes);
    return {
      triggerBytes: candidates.length > 0 ? Math.min(...candidates) : Infinity,
      hardBytes: limits?.maxInputBytes,
      maxMessages: limits?.maxMessagesPerPrompt,
    };
  }

  #enforceInputLimits(): void {
    const { hardBytes, maxMessages } = this.#thresholds();
    if (maxMessages != null && this.#messages.length > maxMessages) {
      throw new Error(
        `Prompt step ${this.#step.id} has ${this.#messages.length} messages, exceeding the ${maxMessages}-message input limit`,
      );
    }
    if (hardBytes == null) return;
    const inputBytes = jsonBytes(this.#messages);
    if (inputBytes > hardBytes) {
      throw new Error(
        `Prompt step ${this.#step.id} input is ${inputBytes} bytes, exceeding the ${hardBytes}-byte input limit`,
      );
    }
  }

  // ─── Context reduction ────────────────────────────────────────────────────

  /**
   * Compact when the input reaches a trigger, a hard limit, or (after a
   * provider overflow) a learned ceiling.
   *
   * Two thresholds guide the reduction. The goal (`reduceTo` of the trigger,
   * 25% by default) leaves room for many more rounds before the next
   * reduction. It is reached by reducing older rounds and, when needed, by
   * keeping fewer retained rounds, down to the newest one, whose results the
   * model may not have seen yet. The must threshold (just under the trigger)
   * is the only reason to reduce the newest round or the opening prompt.
   */
  async #fitContext(reason: "trigger" | "overflow"): Promise<void> {
    if (this.#strategy === "fail") return;
    await this.#rebuild();
    const { triggerBytes, maxMessages } = this.#thresholds();
    const bytes = jsonBytes(this.#messages);
    const overBytes = bytes >= triggerBytes;
    const overMessages =
      maxMessages != null && this.#messages.length > maxMessages;
    const roundsTrigger = this.#policy.context.trigger.toolRounds;
    const roundsDue =
      roundsTrigger != null &&
      toolRoundsSinceCompaction(
        deriveRounds(compactedView(this.#transcript)),
      ) >= roundsTrigger;
    if (reason === "trigger" && !overBytes && !overMessages && !roundsDue)
      return;
    const finite = Number.isFinite(triggerBytes);
    const goal = finite
      ? Math.floor(triggerBytes * this.#policy.context.reduceTo)
      : Infinity;
    const must = finite ? triggerBytes - 1 : Infinity;
    const countFits = (): boolean =>
      maxMessages == null || this.#messages.length <= maxMessages;
    const fits: Fits = {
      goal,
      must,
      goalMet: () => jsonBytes(this.#messages) <= goal && countFits(),
      mustMet: () => jsonBytes(this.#messages) <= must && countFits(),
    };
    const label =
      reason === "overflow"
        ? "provider-context-overflow"
        : overBytes
          ? "input-size"
          : overMessages
            ? "message-count"
            : "tool-rounds";
    const forceOnce =
      reason === "trigger" && roundsDue && !overBytes && !overMessages;

    await this.#compactTranscript(fits, label, forceOnce);
    if (fits.mustMet() || forceOnce) return;
    // Older rounds are gone; what remains is the opening prompt and the
    // newest work. Shrink the opening prompt's variables to make room.
    await this.#rebuild();
    const viewBytes =
      jsonBytes(this.#messages) - jsonBytes(this.#initialMessages);
    if (finite)
      await this.#reduceOpeningPrompt(
        Math.max(Math.floor(goal * 0.5), goal - viewBytes),
        label,
      );
    await this.#rebuild();
  }

  async #compactTranscript(
    fits: Fits,
    reason: string,
    forceOnce: boolean,
  ): Promise<void> {
    if (!forceOnce && fits.goalMet()) return;
    const strategy = this.#strategy;
    if (strategy === "summarize" || strategy === "summarize-or-prune") {
      if (
        summaryCompactions(this.#transcript) >=
        this.#policy.context.maxCompactions
      ) {
        if (!this.#compactionLimitReported) {
          this.#compactionLimitReported = true;
          await this.#context.emit("diagnostic", {
            code: "COMPACTION_LIMIT_REACHED",
            maxCompactions: this.#policy.context.maxCompactions,
          });
        }
        if (strategy === "summarize") return;
      } else {
        const done = await this.#summarizeRounds(fits, reason, forceOnce);
        if (done || strategy === "summarize") return;
      }
    }
    await this.#pruneRounds(fits, reason, forceOnce);
  }

  #viewRounds(): TranscriptRound[] {
    return deriveRounds(compactedView(this.#transcript));
  }

  async #messageBytesOf(items: readonly TranscriptItem[]): Promise<number> {
    const messages = await Promise.all(
      viewMessages(items).map((message) =>
        resolveMessageMedia(message, this.#context),
      ),
    );
    return messages.reduce(
      (total, message) => total + jsonBytes(message) + 1,
      0,
    );
  }

  /**
   * How many of the newest tool rounds to keep verbatim in this reduction.
   *
   * Start from `retain.recentToolRounds` and keep fewer, down to the newest
   * round, until the opening prompt, the kept rounds, and a minimal summary or
   * note fit the goal. One reduction then removes everything older, so it
   * cuts deep once instead of a little every round. When even the newest round
   * cannot meet the goal, keep it anyway if it fits under the trigger: its
   * results may not have reached the model yet.
   */
  async #chooseRetention(fits: Fits, minimumKept: number): Promise<number> {
    const configured = this.#policy.context.retainToolRounds;
    if (configured <= 0) return 0;
    const rounds = this.#viewRounds();
    const opening = jsonBytes(this.#initialMessages);
    const keptBytes = async (retain: number) =>
      opening +
      (await this.#messageBytesOf(
        splitRetained(rounds, retain).retained.flatMap((round) => round.items),
      )) +
      MESSAGE_OVERHEAD_BYTES +
      minimumKept;
    for (let retain = configured; retain >= 1; retain -= 1) {
      if ((await keptBytes(retain)) <= fits.goal) return retain;
    }
    return (await keptBytes(1)) <= fits.must ? 1 : 0;
  }

  /**
   * Replace older rounds with one summary, in a single summarizer pass. The
   * newest round is folded in only when the input cannot otherwise get under
   * the trigger.
   */
  async #summarizeRounds(
    fits: Fits,
    reason: string,
    forceOnce: boolean,
  ): Promise<boolean> {
    const chosen = forceOnce
      ? this.#policy.context.retainToolRounds
      : await this.#chooseRetention(
          fits,
          this.#summarizerSettings().minSummaryBytes,
        );
    // A second pass, with nothing kept, only when the first cannot fit.
    for (const retain of chosen > 0 && !forceOnce ? [chosen, 0] : [chosen]) {
      await this.#rebuild();
      const { prefix, retained } = splitRetained(this.#viewRounds(), retain);
      if (!prefix.some((round) => round.kind === "tool")) {
        if (forceOnce || fits.mustMet()) return true;
        continue;
      }
      const prefixItems = prefix.flatMap((round) => round.items);
      const retainedItems = retained.flatMap((round) => round.items);
      const fixed =
        jsonBytes(this.#initialMessages) +
        (await this.#messageBytesOf(retainedItems)) +
        MESSAGE_OVERHEAD_BYTES;
      const prefixBytes = await this.#messageBytesOf(prefixItems);
      // Share of what it replaces, within the configured bounds and the
      // room left under the goal.
      const summaryLimits = this.#summarizerSettings();
      const summaryTarget = Math.max(
        summaryLimits.minSummaryBytes,
        Math.min(
          fits.goal - fixed,
          summaryLimits.maxSummaryBytes,
          Math.max(
            summaryLimits.minSummaryBytes,
            Math.floor(prefixBytes * summaryLimits.summaryShare),
          ),
        ),
      );
      const callsBefore = this.#summarizerCallsUsed;
      const bytesBefore = jsonBytes(this.#messages);
      let summary: string;
      try {
        summary = await this.#summarize({
          text: renderItemsAsText(prefixItems),
          targetBytes: summaryTarget,
          kind: "transcript",
          label: `${prefix.filter((round) => round.kind === "tool").length} earlier tool rounds`,
          task: this.#task,
        });
      } catch (error) {
        this.#rethrowControlFlow(error);
        if (this.#strategy === "summarize") throw this.#summaryFailure(error);
        await this.#context.emit("diagnostic", {
          code: "CONTEXT_SUMMARY_FAILED",
          scope: "transcript",
          message: describeError(error),
        });
        return false;
      }
      const summarizedRounds = prefix.filter(
        (round) => round.kind === "tool",
      ).length;
      this.#pushMarker(
        {
          kind: "summary",
          strategy: "summarize",
          reason,
          replaces: prefixItems.map((item) => item.id),
          ...(retainedItems[0] ? { anchor: retainedItems[0].id } : {}),
        },
        "user",
        `[Summary of earlier work in this step, written by Agent Runtime to fit the context window. It replaces ${summarizedRounds} earlier tool rounds.]\n\n${summary}`,
      );
      await this.#rebuild();
      await this.#emitReduced({
        scope: "transcript",
        strategy: "summarize",
        reason,
        summarizedRounds,
        retainedRounds: retained.filter((round) => round.kind === "tool")
          .length,
        bytesBefore,
        bytesAfter: jsonBytes(this.#messages),
        compaction: summaryCompactions(this.#transcript),
        summaryTargetBytes: summaryTarget,
        summarizerCalls: this.#summarizerCallsUsed - callsBefore,
      });
      await this.#checkpointReady();
      if (forceOnce || fits.mustMet()) return true;
      if (
        summaryCompactions(this.#transcript) >=
        this.#policy.context.maxCompactions
      )
        return false;
    }
    return fits.mustMet();
  }

  /**
   * Stub and remove older rounds in one reduction that reaches the goal when
   * it can. Kept rounds are clipped, and then given up, only to get under
   * the trigger.
   */
  async #pruneRounds(
    fits: Fits,
    reason: string,
    forceOnce: boolean,
  ): Promise<void> {
    const chosen = forceOnce
      ? this.#policy.context.retainToolRounds
      : await this.#chooseRetention(fits, MINIMUM_NOTE_BYTES);
    for (let retain = chosen; retain >= 0; retain -= 1) {
      // 1. Stub large tool outputs in older rounds. Skipped when even removing
      //    every older round cannot reach the goal: they will all go anyway.
      await this.#rebuild();
      let { prefix, retained } = splitRetained(this.#viewRounds(), retain);
      const prefixBytes = await this.#messageBytesOf(
        prefix.flatMap((round) => round.items),
      );
      const reachable =
        forceOnce ||
        jsonBytes(this.#messages) - prefixBytes + MINIMUM_NOTE_BYTES <=
          fits.goal;
      const stubs: Record<string, ContentPart[]> = {};
      for (const item of reachable
        ? prefix.flatMap((round) => round.items)
        : []) {
        if (contextMarker(item)) continue;
        if (!item.content.some((part) => part.type === "tool-result")) continue;
        if (
          item.content.every(
            (part) =>
              part.type !== "tool-result" ||
              (isJsonObject(part.result.output) &&
                part.result.output.agentRuntime === "omitted"),
          )
        )
          continue;
        if ((await this.#messageBytesOf([item])) < STUB_MINIMUM_BYTES) continue;
        stubs[item.id] = item.content.map((part) =>
          part.type === "tool-result" ? stubToolResultPart(part) : part,
        );
      }
      if (Object.keys(stubs).length > 0) {
        const bytesBefore = jsonBytes(this.#messages);
        this.#pushMarker({
          kind: "rewrite",
          strategy: "prune",
          reason,
          rewrites: stubs,
        });
        await this.#rebuild();
        await this.#emitReduced({
          scope: "transcript",
          strategy: "prune",
          reason,
          stubbedResults: Object.keys(stubs).length,
          bytesBefore,
          bytesAfter: jsonBytes(this.#messages),
        });
        if (forceOnce || fits.goalMet()) {
          await this.#checkpointReady();
          return;
        }
      }

      // 2. Remove older rounds, oldest first, until the goal is met. When the
      //    goal is out of reach, every older round goes, so the next
      //    reduction is many rounds away rather than one.
      ({ prefix, retained } = splitRetained(this.#viewRounds(), retain));
      if (prefix.length > 0) {
        const sizes = await Promise.all(
          prefix.map((round) => this.#messageBytesOf(round.items)),
        );
        let current = jsonBytes(this.#messages);
        let count = 0;
        const countLimit = this.#thresholds().maxMessages;
        let messageCount = this.#messages.length;
        while (count < prefix.length) {
          current -= sizes[count]!;
          messageCount -= prefix[count]!.items.filter(
            (item) => item.role,
          ).length;
          count += 1;
          if (
            !forceOnce &&
            current + MESSAGE_OVERHEAD_BYTES <= fits.goal &&
            (countLimit == null || messageCount + 1 <= countLimit)
          )
            break;
        }
        await this.#removeRounds(
          prefix.slice(0, count),
          prefix[count] ?? retained[0],
          reason,
        );
      }
      if (forceOnce || fits.goalMet() || fits.mustMet()) {
        await this.#checkpointReady();
        return;
      }

      // 3. Before giving up a kept round, clip its tool outputs.
      if (retained.length > 0) {
        await this.#clipRounds(retained, fits.must, reason);
        if (fits.mustMet()) {
          await this.#checkpointReady();
          return;
        }
      }
    }
    await this.#checkpointReady();
  }

  async #removeRounds(
    rounds: readonly TranscriptRound[],
    next: TranscriptRound | undefined,
    reason: string,
  ): Promise<void> {
    if (rounds.length === 0) return;
    const bytesBefore = jsonBytes(this.#messages);
    const tools: Record<string, number> = {};
    const calls: string[] = [];
    let removedRounds = 0;
    for (const round of rounds) {
      for (const item of round.items) {
        const marker = contextMarker(item);
        if (marker?.kind === "note" && marker.removedRounds) {
          removedRounds += marker.removedRounds;
          for (const [name, count] of Object.entries(marker.removedTools ?? {}))
            tools[name] = (tools[name] ?? 0) + count;
          calls.push(...(marker.removedCalls ?? []));
        }
        for (const part of item.content) {
          if (part.type !== "tool-call") continue;
          tools[part.call.name] = (tools[part.call.name] ?? 0) + 1;
          calls.push(describeCall(part.call));
        }
      }
      if (round.kind === "tool") removedRounds += 1;
    }
    // Keep the newest calls when there are too many to list.
    const listed = calls.slice(-MAXIMUM_LISTED_CALLS);
    const hadSummary = rounds.some(
      (round) => contextMarker(round.items[0]!)?.kind === "summary",
    );
    const toolList = Object.entries(tools)
      .map(([name, count]) => `${name} ×${count}`)
      .join(", ");
    this.#pushMarker(
      {
        kind: "note",
        strategy: "prune",
        reason,
        replaces: rounds.flatMap((round) => round.items.map((item) => item.id)),
        removedRounds,
        removedTools: tools,
        removedCalls: listed,
        ...(next?.items[0] ? { anchor: next.items[0].id } : {}),
      },
      "user",
      `[Agent Runtime removed ${removedRounds} earlier tool round${removedRounds === 1 ? "" : "s"}${hadSummary ? " and an earlier summary" : ""} from this conversation to fit the context window${toolList ? ` (tools called: ${toolList})` : ""}. Their results are no longer visible; call a tool again if you need its output.${
        listed.length > 0
          ? ` Calls already made${calls.length > listed.length ? ` (the latest ${listed.length} of ${calls.length})` : ""}: ${listed.join("; ")}.`
          : ""
      }]`,
    );
    await this.#rebuild();
    await this.#emitReduced({
      scope: "transcript",
      strategy: "prune",
      reason,
      removedRounds,
      bytesBefore,
      bytesAfter: jsonBytes(this.#messages),
    });
  }

  async #clipRounds(
    rounds: readonly TranscriptRound[],
    target: number,
    reason: string,
  ): Promise<void> {
    if (!Number.isFinite(target)) return;
    const toolItems = rounds
      .flatMap((round) => round.items)
      .filter(
        (item) =>
          !contextMarker(item) &&
          item.content.some((part) => part.type === "tool-result"),
      );
    if (toolItems.length === 0) return;
    const toolBytes = await this.#messageBytesOf(toolItems);
    const otherBytes = jsonBytes(this.#messages) - toolBytes;
    const perItem = Math.floor(
      (target - otherBytes - MESSAGE_OVERHEAD_BYTES) / toolItems.length,
    );
    const payload = Math.max(512, perItem - MESSAGE_OVERHEAD_BYTES);
    const rewrites: Record<string, ContentPart[]> = {};
    for (const item of toolItems) {
      if (
        (await this.#messageBytesOf([item])) <=
        payload + MESSAGE_OVERHEAD_BYTES
      )
        continue;
      rewrites[item.id] = item.content.map((part) =>
        part.type === "tool-result" ? clipToolResultPart(part, payload) : part,
      );
    }
    if (Object.keys(rewrites).length === 0) return;
    const bytesBefore = jsonBytes(this.#messages);
    this.#pushMarker({ kind: "rewrite", strategy: "prune", reason, rewrites });
    await this.#rebuild();
    await this.#emitReduced({
      scope: "tool-result",
      strategy: "prune",
      reason,
      clippedResults: Object.keys(rewrites).length,
      bytesBefore,
      bytesAfter: jsonBytes(this.#messages),
    });
  }

  /** Cap one new tool result so a single large output cannot fill the input. */
  async #capToolResult(item: TranscriptItem): Promise<void> {
    if (this.#strategy === "fail") return;
    const { triggerBytes } = this.#thresholds();
    const cap =
      this.#policy.context.maxToolResultBytes ??
      (Number.isFinite(triggerBytes)
        ? Math.floor(triggerBytes * this.#policy.context.toolResultShare)
        : undefined);
    if (cap == null) return;
    const size = await this.#messageBytesOf([item]);
    if (size <= cap) return;
    const part = item.content.find(
      (entry): entry is Extract<ContentPart, { type: "tool-result" }> =>
        entry.type === "tool-result",
    );
    if (!part) return;
    const payload = Math.max(256, cap - MESSAGE_OVERHEAD_BYTES);
    let rewritten: Extract<ContentPart, { type: "tool-result" }> | undefined;
    let strategy: "summarize" | "prune" = "prune";
    if (
      this.#strategy === "summarize" ||
      this.#strategy === "summarize-or-prune"
    ) {
      try {
        const summary = await this.#summarize({
          text: toolResultText(part.result),
          targetBytes: Math.floor(payload * 0.8),
          kind: "tool-result",
          label: part.result.name,
          task: this.#task,
        });
        rewritten = {
          ...part,
          result: {
            callId: part.result.callId,
            name: part.result.name,
            output: `[Agent Runtime summary of a ${size}-byte tool output]\n${
              jsonTextBytes(summary) > payload
                ? pruneText(summary, payload)
                : summary
            }`,
          },
        };
        strategy = "summarize";
      } catch (error) {
        this.#rethrowControlFlow(error);
        if (this.#strategy === "summarize") throw this.#summaryFailure(error);
        await this.#context.emit("diagnostic", {
          code: "CONTEXT_SUMMARY_FAILED",
          scope: "tool-result",
          message: describeError(error),
        });
      }
    }
    rewritten ??= clipToolResultPart(part, payload);
    this.#pushMarker({
      kind: "rewrite",
      strategy,
      reason: "tool-result-size",
      rewrites: {
        [item.id]: item.content.map((entry) =>
          entry === part ? rewritten! : entry,
        ),
      },
    });
    this.#dirty = true;
    await this.#emitReduced({
      scope: "tool-result",
      strategy,
      reason: "tool-result-size",
      toolName: part.result.name,
      bytesBefore: size,
      bytesAfter: jsonBytes(rewritten),
    });
  }

  #pushMarker(
    marker: Omit<ContextMarker, "sequence">,
    role?: "user",
    text?: string,
    usage?: ModelUsage,
  ): TranscriptItem {
    const item: TranscriptItem = {
      id: this.#deps.generateTranscriptId(),
      type: "message",
      ...(role ? { role } : {}),
      content: text ? [{ type: "text", text }] : [],
      createdAt: this.#deps.now().toISOString(),
      ...(usage ? { usage } : {}),
      metadata: markerMetadata({
        ...marker,
        sequence: nextMarkerSequence(this.#transcript),
      }),
    };
    this.#transcript.push(item);
    this.#dirty = true;
    return item;
  }

  async #emitReduced(data: JsonObject): Promise<void> {
    this.#reductions += 1;
    await this.#context.emit("context.reduced", data);
  }

  #rethrowControlFlow(error: unknown): void {
    if (isRunSuspendedError(error)) throw error;
    if (this.#context.signal?.aborted) throw abortReason(this.#context.signal);
  }

  #summaryFailure(error: unknown): Error {
    return new ModelCompletionError(
      `Prompt step ${this.#step.id} could not summarize its context (context strategy "summarize"): ${describeError(error)}`,
    );
  }

  // ─── Summarizer ───────────────────────────────────────────────────────────

  /** The step's summarizer settings with every default filled in. */
  #summarizerSettings(): ResolvedSummarizerSettings {
    const settings = this.#policy.context.summarizer;
    return {
      summaryShare: settings.summaryShare ?? SUMMARIZER_DEFAULTS.summaryShare,
      minSummaryBytes:
        settings.minSummaryBytes ?? SUMMARIZER_DEFAULTS.minSummaryBytes,
      maxSummaryBytes:
        settings.maxSummaryBytes ?? SUMMARIZER_DEFAULTS.maxSummaryBytes,
      maxCalls:
        settings.maxCalls ??
        Math.max(
          SUMMARIZER_DEFAULTS.minimumMaxCalls,
          this.#policy.context.maxCompactions *
            SUMMARIZER_DEFAULTS.callsPerCompaction,
        ),
    };
  }

  /**
   * Condense material. A host ContextSummarizerAdapter, when configured, sees
   * every request and may change or replace it; `next` is the built-in
   * summarizer.
   */
  async #summarize(input: SummarizeInput): Promise<string> {
    const request: ContextSummarizeRequest = {
      runId: this.#context.runId,
      stepId: this.#step.id,
      kind: input.kind,
      label: input.label,
      task: input.task,
      text: input.text,
      targetBytes: input.targetBytes,
      settings: structuredClone(this.#policy.context.summarizer),
      ...(this.#context.signal ? { signal: this.#context.signal } : {}),
    };
    const key = fingerprint(
      JSON.stringify([
        { ...request, signal: undefined },
        this.#context.variables,
      ]),
    );
    let journal = this.#summaryJournals.find((entry) => entry.key === key);
    if (!journal) {
      journal = { key, plans: [], calls: [] };
      this.#summaryJournals.push(journal);
    }
    if (journal.result !== undefined) return journal.result;
    this.#activeSummary = journal;
    this.#summaryCallCursor = 0;
    this.#summaryPlanCursor = 0;
    try {
      const adapter = this.#context.summarizer;
      if (adapter) this.#suspendIfExhausted();
      const result = adapter
        ? await adapter.summarize(request, (next) =>
            this.#builtInSummarize(next),
          )
        : await this.#builtInSummarize(request);
      const valid =
        typeof result.text === "string" && result.text.trim().length > 0;
      if (valid) journal.result = result.text.trim();
      if (result.usage) await this.#recordHostSummarizerUsage(result.usage);
      if (!valid) {
        throw new SummarizerError(
          `The summarizer returned nothing for ${input.label}.`,
        );
      }
      await this.#checkpointReady();
      return journal.result!;
    } finally {
      this.#activeSummary = undefined;
    }
  }

  /** Agent Runtime's summarizer: chunked calls through the step's ModelAdapter. */
  async #builtInSummarize(
    request: ContextSummarizeRequest,
  ): Promise<ContextSummarizeResult> {
    const settings = request.settings;
    const reference =
      settings.model ?? stepModelReference(this.#step, this.#context);
    const key = modelKeyFromReference(reference, this.#step.id);
    const description =
      key === this.#modelKey ? this.#description : await this.#describe(key);
    const hardBytes = this.#context.manifest.limits?.maxInputBytes;
    let chunkBytes =
      settings.chunkBytes ??
      (description?.maxInputTokens
        ? this.#estimator.bytes(description.maxInputTokens * 0.5)
        : DEFAULT_CHUNK_BYTES);
    // Freeze the plan so a resumed operation traverses the same chunk/pass order.
    const planIndex = this.#summaryPlanCursor++;
    const plans = this.#activeSummary!.plans;
    chunkBytes = plans[planIndex] ?? chunkBytes;
    plans[planIndex] = chunkBytes;
    const maxCalls = settings.maxCalls ?? this.#summarizerSettings().maxCalls;
    const summarizer = new ChunkedSummarizer({
      call: (input) => this.#callSummarizer(key, reference, input, maxCalls),
      chunkBytes,
      maxCalls,
      ...(hardBytes != null ? { maxInputBytes: hardBytes } : {}),
      ...(settings.maxPasses ? { maxPasses: settings.maxPasses } : {}),
      ...(settings.systemPrompt ? { systemPrompt: settings.systemPrompt } : {}),
      ...(settings.prompt ? { prompt: settings.prompt } : {}),
      ...(settings.prompts
        ? {
            prompts: {
              ...(settings.prompts.input
                ? { input: settings.prompts.input }
                : {}),
              ...(settings.prompts.transcript
                ? { transcript: settings.prompts.transcript }
                : {}),
              ...(settings.prompts.toolResult
                ? { "tool-result": settings.prompts.toolResult }
                : {}),
            },
          }
        : {}),
      ...(settings.maxOutputTokens
        ? { maxOutputTokens: settings.maxOutputTokens }
        : {}),
      ...(description?.maxOutputTokens
        ? { modelMaxOutputTokens: description.maxOutputTokens }
        : {}),
      variables: this.#context.variables as VariableState,
    });
    return {
      text: await summarizer.summarize({
        text: request.text,
        targetBytes: request.targetBytes,
        kind: request.kind,
        label: request.label,
        task: request.task,
      }),
    };
  }

  /** Usage a host summarizer reports counts like the built-in summarizer's. */
  async #recordHostSummarizerUsage(usage: ModelUsage): Promise<void> {
    const budgetState =
      this.#context.tokenBudget && reportedTotalTokens(usage) != null
        ? this.#context.tokenBudget.consume(usage)
        : undefined;
    this.#pushMarker(
      { kind: "usage", strategy: "none", reason: "host-summarizer" },
      undefined,
      undefined,
      usage,
    );
    await this.#checkpointReady();
    await this.#context.emit("model.usage", {
      usage: JSON.parse(JSON.stringify(usage)) as JsonObject,
      purpose: "summarize",
      source: "host",
      ...(budgetState ?? {}),
    });
  }

  async #callSummarizer(
    model: string,
    reference: PromptStep["model"],
    input: SummarizerCallInput,
    maxCalls: number,
  ): Promise<string> {
    const messages = summarizerMessages(input);
    const request: ModelRequest = {
      model,
      messages,
      maxOutputTokens: input.maxOutputTokens,
      ...(reference?.options ? { providerOptions: reference.options } : {}),
    };
    const requestBytes = jsonBytes(messages);
    const hardBytes = this.#context.manifest.limits?.maxInputBytes;
    if (hardBytes != null && requestBytes > hardBytes)
      throw new SummarizerError(
        `Summarizer input is ${requestBytes} bytes, exceeding the ${hardBytes}-byte input limit.`,
      );
    const journal = this.#activeSummary!;
    const index = this.#summaryCallCursor++;
    const key = fingerprint(JSON.stringify(request));
    const saved = journal.calls[index];
    if (saved?.key === key) {
      if (saved.error !== undefined) throw new SummarizerError(saved.error);
      return saved.text!;
    }
    journal.calls.splice(index);
    if (this.#summarizerCallsUsed >= maxCalls)
      throw new SummarizerError(
        `Prompt step ${this.#step.id} has used its ${maxCalls} summarizer calls.`,
      );
    this.#suspendIfExhausted();
    this.#summarizerCallsUsed += 1;
    const result = await this.#invoke(request, {
      purpose: "summarize",
      stream: false,
      provider: referenceProvider(reference),
    });
    const usage = await this.#recordUsage(result, requestBytes, "summarize");
    if (usage)
      this.#pushMarker(
        { kind: "usage", strategy: "none", reason: "summarizer" },
        undefined,
        undefined,
        usage,
      );
    let error: string | undefined;
    if ((result.toolCalls?.length ?? 0) > 0) {
      error = "The summarizer requested tool calls.";
    }
    if (isTruncatedFinishReason(result.finishReason)) {
      error = `The summarizer's output was truncated (${result.finishReason}); raise the summarizer's maxOutputTokens.`;
    }
    const output = result.output;
    const text =
      typeof output === "string"
        ? output
        : output === undefined
          ? ""
          : JSON.stringify(output);
    journal.calls.push({ key, ...(error ? { error } : { text }) });
    await this.#checkpointReady();
    if (error) throw new SummarizerError(error);
    return text;
  }

  // ─── Model calls ──────────────────────────────────────────────────────────

  async #requestModel(finalize: boolean): Promise<ModelResult> {
    const context = this.#context;
    const reference = stepModelReference(this.#step, context);
    let overflowRetries = 0;
    while (true) {
      const maxOutputTokens =
        this.#outputTokenOverride ?? this.#step.maxOutputTokens;
      const request: ModelRequest = {
        model: this.#modelKey,
        messages: this.#messages,
        ...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
        ...(finalize && this.#tools.length > 0
          ? { toolChoice: "none" as const }
          : {}),
        ...(this.#step.outputSchema
          ? { outputSchema: this.#step.outputSchema }
          : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(reference?.options ? { providerOptions: reference.options } : {}),
      };
      const requestBytes = jsonBytes(this.#messages);
      let result: ModelResult;
      try {
        result = await this.#invoke(request, {
          stream: true,
          provider: referenceProvider(reference),
        });
      } catch (error) {
        if (context.signal?.aborted) throw error;
        if (
          isContextOverflowError(error) &&
          this.#strategy !== "fail" &&
          overflowRetries < this.#policy.context.overflowRetries
        ) {
          overflowRetries += 1;
          this.#overflowCeilingBytes = Math.floor(
            Math.min(this.#overflowCeilingBytes ?? Infinity, requestBytes) *
              0.75,
          );
          await context.emit("model.retry", {
            reason: "context-overflow",
            attempt: overflowRetries,
            inputBytes: requestBytes,
            ...errorSummary(error),
          });
          await this.#fitContext("overflow");
          await this.#rebuild();
          this.#enforceInputLimits();
          continue;
        }
        if (
          isInvalidOutputError(error) &&
          this.#repairsUsed < this.#policy.outputRepairAttempts
        ) {
          this.#repairsUsed += 1;
          await context.emit("model.retry", {
            reason: "invalid-output",
            attempt: this.#repairsUsed,
            ...errorSummary(error),
          });
          this.#pushMarker(
            { kind: "note", strategy: "none", reason: "invalid-output" },
            "user",
            `[Agent Runtime] Your previous response could not be used: ${pruneText(describeError(error), 600)} Respond again with only a final answer that matches the required output format.`,
          );
          await this.#checkpointReady();
          await this.#rebuild();
          this.#enforceInputLimits();
          continue;
        }
        throw error;
      }

      this.#transcript.push(...result.transcript);
      this.#dirty = true;
      await context.emit("model.completed", safeModelCompletedData(result));
      await this.#recordUsage(result, requestBytes);
      if (finalize && (result.toolCalls?.length ?? 0) > 0) {
        // The model ignored toolChoice: none. Answer its calls so the
        // history stays valid, and keep its text as the final answer.
        for (const call of result.toolCalls ?? []) {
          if (
            call.providerExecuted ||
            hasToolResultFor(result.transcript, call.id)
          )
            continue;
          this.#transcript.push(
            this.#toolTranscript({
              callId: call.id,
              name: call.name,
              error: {
                code: "tool_call_limit_reached",
                message: `The ${this.#maxToolCalls}-call tool limit for this step has been reached.`,
              },
            }),
          );
        }
        result = { ...result, toolCalls: [] };
      }
      return result;
    }
  }

  /** Invoke the model with the retry policy. Streams only for the main request. */
  async #invoke(
    request: ModelRequest,
    options: { stream: boolean; provider: string; purpose?: string },
  ): Promise<ModelResult> {
    const context = this.#context;
    const retry = this.#policy.modelRetry;
    const timeoutMs = context.manifest.limits?.providerTimeoutMs;
    for (let attempt = 1; ; attempt += 1) {
      this.#suspendIfExhausted();
      const operation = modelOperation(context.signal, timeoutMs);
      const attemptRequest: ModelRequest = {
        ...request,
        ...(operation.signal ? { signal: operation.signal } : {}),
      };
      await context.emit("model.started", {
        model: request.model,
        provider: options.provider,
        ...(options.purpose ? { purpose: options.purpose } : {}),
      });
      try {
        const result = options.stream
          ? await this.#streamModel(attemptRequest)
          : await raceWithSignal(
              () => context.model!.generate(attemptRequest),
              attemptRequest.signal,
            );
        if (options.purpose) {
          await context.emit("model.completed", {
            ...safeModelCompletedData(result),
            purpose: options.purpose,
          });
        }
        return result;
      } catch (caught) {
        const error = operation.didTimeOut()
          ? new ModelTimeoutError(timeoutMs!)
          : caught;
        if (context.signal?.aborted) throw error;
        if (attempt >= retry.maxAttempts || !isRetryableModelError(error))
          throw error;
        const delayMs = Math.min(
          retry.maxDelayMs,
          retry.initialDelayMs * 2 ** (attempt - 1),
        );
        await context.emit("model.retry", {
          reason: "retryable-error",
          attempt,
          maxAttempts: retry.maxAttempts,
          delayMs,
          ...(options.purpose ? { purpose: options.purpose } : {}),
          ...errorSummary(error),
        });
        await this.#deps.sleep(delayMs, context.signal);
      } finally {
        operation.dispose();
      }
    }
  }

  async #streamModel(request: ModelRequest): Promise<ModelResult> {
    const context = this.#context;
    if (!context.model?.stream) {
      return raceWithSignal(
        () => context.model!.generate(request),
        request.signal,
      );
    }
    if (request.signal?.aborted) throw abortReason(request.signal);
    let completed: ModelResult | undefined;
    const iterator = context.model.stream(request)[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await raceWithSignal(
          () => iterator.next(),
          request.signal,
        );
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
      // Ask the adapter to clean up, but do not wait: an async generator
      // queues return() behind a pending next(), so awaiting it would block
      // cancellation and timeouts on an adapter that ignores the signal.
      if (request.signal?.aborted)
        void Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => undefined);
    }
    if (!completed)
      throw new Error("Model stream ended without a completed result");
    return completed;
  }

  /**
   * Calibrate token estimates, consume the run budget, and emit usage. When
   * a budgeted provider reports no usage, an estimate is recorded instead of
   * failing the step.
   */
  async #recordUsage(
    result: ModelResult,
    requestBytes: number,
    purpose?: string,
  ): Promise<ModelUsage | undefined> {
    const context = this.#context;
    let usage = resultUsage(result);
    if (!purpose && usage && usage.metadata?.estimated !== true) {
      this.#estimator.observe(requestBytes, usage.inputTokens);
    }
    if (context.tokenBudget && (!usage || reportedTotalTokens(usage) == null)) {
      const inputTokens = this.#estimator.tokens(requestBytes);
      const outputTokens = this.#estimator.tokens(
        jsonBytes(result.transcript.map((item) => item.content)),
      );
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        metadata: { estimated: true },
      };
      const carrier = [...result.transcript]
        .reverse()
        .find((item) => item.role === "assistant");
      if (carrier && !purpose) carrier.usage = usage;
      if (!this.#usageEstimateReported) {
        this.#usageEstimateReported = true;
        await context.emit("diagnostic", {
          code: "USAGE_ESTIMATED",
          message:
            "The model did not report token usage; the run budget uses an estimate.",
        });
      }
    }
    const budgetState = context.tokenBudget
      ? context.tokenBudget.consume(usage ?? {})
      : undefined;
    if (usage) {
      await context.emit("model.usage", {
        usage: JSON.parse(JSON.stringify(usage)) as JsonObject,
        ...(purpose ? { purpose } : {}),
        ...(budgetState ?? {}),
      });
    }
    return usage;
  }

  #suspendIfExhausted(): void {
    const budget = this.#context.tokenBudget;
    if (!budget || budget.consumedTokens < budget.maxTotalTokens) return;
    throw new RunSuspendedError("token-budget", {
      maxTotalTokens: budget.maxTotalTokens,
      consumedTokens: budget.consumedTokens,
      stepId: this.#step.id,
    });
  }

  // ─── Repairs ──────────────────────────────────────────────────────────────

  async #ensureFinalizeNotice(): Promise<void> {
    const view = compactedView(this.#transcript);
    const last = view.at(-1);
    if (last && contextMarker(last)?.reason === "tool-call-limit") return;
    this.#pushMarker(
      { kind: "note", strategy: "none", reason: "tool-call-limit" },
      "user",
      `[Agent Runtime] This step has used its limit of ${this.#maxToolCalls} tool calls. Do not call any more tools. Using the information gathered so far, give your final answer now.`,
    );
    await this.#context.emit("diagnostic", {
      code: "TOOL_CALL_LIMIT_REACHED",
      maxToolCalls: this.#maxToolCalls,
    });
    await this.#checkpointReady();
  }

  /** Retry a truncated response once with a larger output budget. */
  async #repairTruncation(result: ModelResult): Promise<boolean> {
    if (this.#repairsUsed >= this.#policy.outputRepairAttempts) return false;
    const modelLimit = this.#description?.maxOutputTokens;
    const current =
      this.#outputTokenOverride ??
      this.#step.maxOutputTokens ??
      resultUsage(result)?.outputTokens;
    if (current == null) return false;
    const next = Math.min(current * 2, modelLimit ?? current * 2);
    if (next <= current) return false;
    this.#repairsUsed += 1;
    this.#outputTokenOverride = next;
    this.#pushMarker({
      kind: "rewrite",
      strategy: "none",
      reason: "truncated-response",
      replaces: result.transcript.map((item) => item.id),
    });
    await this.#context.emit("model.retry", {
      reason: "truncated-output",
      attempt: this.#repairsUsed,
      maxOutputTokens: next,
    });
    await this.#checkpointReady();
    return true;
  }

  async #repairEmptyOutput(): Promise<boolean> {
    if (this.#repairsUsed >= this.#policy.outputRepairAttempts) return false;
    this.#repairsUsed += 1;
    this.#pushMarker(
      { kind: "note", strategy: "none", reason: "empty-output" },
      "user",
      "[Agent Runtime] Your previous response was empty. Give your final answer now.",
    );
    await this.#context.emit("model.retry", {
      reason: "empty-output",
      attempt: this.#repairsUsed,
    });
    await this.#checkpointReady();
    return true;
  }

  // ─── Tools ────────────────────────────────────────────────────────────────

  /** Why a call must not run, or undefined when it may. */
  #rejection(call: ToolCall): { code: string; message: string } | undefined {
    const invalid = invalidCallError(call);
    if (invalid !== undefined)
      return { code: "tool_call_invalid", message: invalid };
    if (!this.#allowedTools.has(call.name)) {
      return {
        code: "tool_not_allowed",
        message: `Tool "${call.name}" is not available in this step.${
          this.#allowedTools.size > 0
            ? ` Available tools: ${[...this.#allowedTools].join(", ")}.`
            : ""
        }`,
      };
    }
    if (
      this.#policy.toolCallLimit === "finalize" &&
      this.#toolCallCount >= this.#maxToolCalls
    ) {
      return {
        code: "tool_call_limit_reached",
        message: `The ${this.#maxToolCalls}-call tool limit for this step has been reached; answer with the information gathered so far.`,
      };
    }
    return undefined;
  }

  async #executeToolCalls(pending: PendingModelResult): Promise<void> {
    const context = this.#context;
    const { result } = pending;
    const calls = result.toolCalls ?? [];
    const executable = calls
      .slice(pending.nextToolIndex)
      .filter((call) => !call.providerExecuted && !this.#rejection(call));
    if (executable.length > 0 && !context.tools) {
      throw new Error(`Model requested tools but no ToolAdapter is configured`);
    }
    if (
      this.#policy.toolCallLimit === "fail" &&
      this.#toolCallCount + executable.length > this.#maxToolCalls
    ) {
      throw new Error(
        `Prompt step ${this.#step.id} exceeded its ${this.#maxToolCalls} tool-call limit across the prompt step`,
      );
    }

    for (
      let toolIndex = pending.nextToolIndex;
      toolIndex < calls.length;
      toolIndex += 1
    ) {
      const call = calls[toolIndex]!;
      // Provider-executed tools already have their results in the response.
      if (!call.providerExecuted) {
        await context.emit("model.tool.requested", {
          toolCallId: call.id,
          toolName: call.name,
        });
        const rejection = this.#rejection(call);
        if (rejection) {
          this.#toolCallCount += 1;
          // The adapter may already have answered an invalid call.
          if (!hasToolResultFor(this.#transcript, call.id)) {
            this.#transcript.push(
              this.#toolTranscript({
                callId: call.id,
                name: call.name,
                error: rejection,
              }),
            );
            this.#dirty = true;
          }
          await context.emit("model.tool.completed", {
            toolCallId: call.id,
            toolName: call.name,
            failed: true,
            rejected: true,
            errorCode: rejection.code,
          });
        } else {
          await context.emit("model.tool.started", {
            toolCallId: call.id,
            toolName: call.name,
          });
          const toolResult = await context.tools!.executeTool(call, {
            runId: context.runId,
            stepId: this.#step.id,
            variables: context.variables,
            idempotencyKey: pending.toolIdempotencyKeys[toolIndex]!,
            ...(context.workspaces ? { workspaces: context.workspaces } : {}),
            ...(context.runSandbox ? { runSandbox: context.runSandbox } : {}),
            ...(context.signal ? { signal: context.signal } : {}),
          });
          this.#toolCallCount += 1;
          const item = this.#toolTranscript(toolResult);
          this.#transcript.push(item);
          this.#dirty = true;
          pending.nextToolIndex = toolIndex + 1;
          this.#pendingReductions.push(item.id);
          await this.#checkpointPending(pending);
          await context.emit("model.tool.completed", {
            toolCallId: call.id,
            toolName: call.name,
            failed: toolResult.error != null,
            ...(toolResult.error ? { errorCode: toolResult.error.code } : {}),
          });
          await this.#finishToolReductions();
        }
      }
      pending.nextToolIndex = toolIndex + 1;
      await this.#checkpointPending(pending);
    }
  }

  #toolTranscript(result: ToolResult): TranscriptItem {
    return {
      id: this.#deps.generateTranscriptId(),
      type: "tool-result",
      role: "tool",
      content: [{ type: "tool-result", result }],
      createdAt: this.#deps.now().toISOString(),
    };
  }

  // ─── Checkpoints ──────────────────────────────────────────────────────────

  #restoreProgress(): void {
    const value = this.#context.resume?.continuation;
    if (value?.type !== "prompt" || value.stepId !== this.#step.id) return;
    if (
      Array.isArray(value.pendingReductions) &&
      value.pendingReductions.every((id) => typeof id === "string")
    )
      this.#pendingReductions = [...value.pendingReductions] as string[];
    if (
      Number.isSafeInteger(value.summarizerCallsUsed) &&
      Number(value.summarizerCallsUsed) >= 0
    )
      this.#summarizerCallsUsed = Number(value.summarizerCallsUsed);
    if (
      Array.isArray(value.summaryJournals) &&
      value.summaryJournals.every((entry) => {
        if (
          !isJsonObject(entry) ||
          typeof entry.key !== "string" ||
          !Array.isArray(entry.plans) ||
          !Array.isArray(entry.calls)
        )
          return false;
        return (
          (entry.result === undefined || typeof entry.result === "string") &&
          entry.plans.every(
            (size) =>
              typeof size === "number" && Number.isFinite(size) && size > 0,
          ) &&
          entry.calls.every(
            (call) =>
              isJsonObject(call) &&
              typeof call.key === "string" &&
              (typeof call.text === "string" || typeof call.error === "string"),
          )
        );
      })
    )
      this.#summaryJournals = structuredClone(
        value.summaryJournals,
      ) as unknown as SummaryJournal[];
    if (
      isJsonObject(value.tokenEstimate) &&
      value.tokenEstimate.calibrated === true &&
      typeof value.tokenEstimate.bytesPerToken === "number"
    )
      this.#estimator.observe(value.tokenEstimate.bytesPerToken, 1);
    if (
      typeof value.overflowCeilingBytes === "number" &&
      Number.isFinite(value.overflowCeilingBytes) &&
      value.overflowCeilingBytes > 0
    )
      this.#overflowCeilingBytes = value.overflowCeilingBytes;
  }

  async #finishToolReductions(): Promise<void> {
    while (this.#pendingReductions.length > 0) {
      const item = this.#transcript.find(
        (entry) => entry.id === this.#pendingReductions[0],
      );
      if (item) await this.#capToolResult(item);
      this.#pendingReductions.shift();
      await this.#checkpointReady();
    }
  }

  async #checkpointPending(pending: PendingModelResult): Promise<void> {
    this.#pending = pending;
    await this.#checkpointReady();
  }

  /** Commit transcript changes made between model turns (reductions, notes). */
  async #checkpointReady(): Promise<void> {
    if (!this.#checkpointRounds || !this.#context.checkpoint) return;
    const pending = this.#pending;
    await this.#context.checkpoint({
      state: structuredClone(this.#context.variables as VariableState),
      continuation: {
        type: "prompt",
        phase: pending ? "model-completed" : "ready",
        stepId: this.#step.id,
        toolCallCount: this.#toolCallCount,
        ...(pending
          ? {
              hasOutput: pending.result.output !== undefined,
              ...(pending.result.output !== undefined
                ? { output: structuredClone(pending.result.output) }
                : {}),
              ...(pending.result.finishReason
                ? { finishReason: pending.result.finishReason }
                : {}),
              toolCalls: JSON.parse(
                JSON.stringify(pending.result.toolCalls ?? []),
              ) as JsonValue,
              toolIdempotencyKeys: pending.toolIdempotencyKeys,
              nextToolIndex: pending.nextToolIndex,
            }
          : {}),
        pendingReductions: [...this.#pendingReductions],
        summarizerCallsUsed: this.#summarizerCallsUsed,
        summaryJournals: JSON.parse(
          JSON.stringify(this.#summaryJournals),
        ) as JsonValue,
        tokenEstimate: {
          bytesPerToken: this.#estimator.bytesPerToken,
          calibrated: this.#estimator.calibrated,
        },
        ...(this.#overflowCeilingBytes != null
          ? { overflowCeilingBytes: this.#overflowCeilingBytes }
          : {}),
      },
      transcript: this.#transcript,
    });
  }
}
