import type { PromptStep } from "@clearideas/agent-runtime-contracts";
import type {
  StepExecutionContext,
  StepExecutionResult,
  StepExecutor,
  StepPreflightContext,
} from "@clearideas/agent-runtime-core";

import { PromptExecution } from "./execution.js";
import { abortableSleep } from "./helpers.js";

export interface PromptStepExecutorOptions {
  now?: () => Date;
  generateTranscriptId?: () => string;
  generateToolIdempotencyKey?: () => string;
  defaultMaxToolCalls?: number;
  /** Waits between model retries. Tests replace it to avoid real delays. */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export { compilePromptTemplate } from "@clearideas/agent-runtime-core";
export { ModelCompletionError, ModelTimeoutError } from "./helpers.js";
export {
  PROMPT_POLICY_DEFAULTS,
  resolvePromptPolicies,
  SUMMARIZER_DEFAULTS,
} from "./execution.js";
export {
  isContextOverflowError,
  isInvalidOutputError,
  isRetryableModelError,
} from "./context/errors.js";
export { pruneJson, pruneText } from "./context/prune.js";
export {
  PromptMessageHistoryCompactor,
  type PromptMessageHistoryCompactorOptions,
} from "./history-compactor.js";
export {
  ChunkedSummarizer,
  DEFAULT_SUMMARIZER_INSTRUCTIONS,
  DEFAULT_SUMMARIZER_MAX_PASSES,
  DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
  SummarizerError,
  splitIntoChunks,
} from "./context/summarize.js";
export {
  compactedView,
  contextMarker,
  deriveRounds,
  type ContextMarker,
} from "./context/transcript.js";

export class PromptStepExecutor implements StepExecutor<PromptStep> {
  readonly type = "prompt" as const;
  readonly #now: () => Date;
  readonly #generateTranscriptId: () => string;
  readonly #generateToolIdempotencyKey: () => string;
  readonly #defaultMaxToolCalls: number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: PromptStepExecutorOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#generateTranscriptId =
      options.generateTranscriptId ?? (() => globalThis.crypto.randomUUID());
    this.#generateToolIdempotencyKey =
      options.generateToolIdempotencyKey ??
      (() => `agent-runtime:${globalThis.crypto.randomUUID()}`);
    this.#defaultMaxToolCalls = options.defaultMaxToolCalls ?? 25;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  preflight(step: PromptStep, context: StepPreflightContext): string[] {
    const problems: string[] = [];
    if (!context.model)
      problems.push(`Prompt step ${step.id} requires a ModelAdapter.`);
    if (!(step.model ?? context.manifest.model))
      problems.push(`Prompt step ${step.id} requires a model.`);
    if ((step.tools?.length ?? 0) > 0 && !context.tools)
      problems.push(
        `Prompt step ${step.id} names tools, but no ToolAdapter is configured.`,
      );
    return problems;
  }

  async execute(
    context: StepExecutionContext & { step: PromptStep },
  ): Promise<StepExecutionResult> {
    if (!context.model) {
      throw new Error(`Prompt step ${context.step.id} requires a ModelAdapter`);
    }
    return new PromptExecution(context, {
      now: this.#now,
      generateTranscriptId: this.#generateTranscriptId,
      generateToolIdempotencyKey: this.#generateToolIdempotencyKey,
      defaultMaxToolCalls: this.#defaultMaxToolCalls,
      sleep: this.#sleep,
    }).run();
  }
}
