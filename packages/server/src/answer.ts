/**
 * Which step's text may stream as the reply.
 *
 * The reply is the run's final output. A step's text may stream live only
 * when that step's output is certain to be the reply: it is a candidate for
 * the final output, no earlier candidate produced output, and every later
 * step that could contribute to the final output will provably be skipped.
 * Everything else streams only once the run has committed its output.
 */
import type {
  AgentManifest,
  AgentStep,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import type {
  ConditionEvaluator,
  StepExecutionContext,
  StepExecutor,
} from "@clearideas/agent-runtime-core";

export type StreamMode = "auto" | "live" | "committed";

/** A top-level step whose output can become the reply. */
export interface AnswerCandidate {
  stepId: string;
  index: number;
  /** A prompt step without structured output or tools: its text deltas are its output. */
  streamable: boolean;
}

export interface AnswerPlan {
  /** Top-level steps whose output can be the reply. */
  candidates: AnswerCandidate[];
  /** True when steps mark includeInFinalOutput; otherwise the last completed step is the reply. */
  explicit: boolean;
  /** Per-step state projections change output selection; never stream live. */
  projected: boolean;
}

const usesStateProjection = (manifest: AgentManifest): boolean => {
  const runtime = manifest.extensions?.agentRuntime;
  return (
    runtime != null &&
    typeof runtime === "object" &&
    !Array.isArray(runtime) &&
    (runtime as Record<string, unknown>).stateProjection ===
      "step-output-state-v1"
  );
};

const isStreamable = (step: AgentStep): boolean =>
  step.type === "prompt" &&
  step.outputSchema === undefined &&
  (step.tools?.length ?? 0) === 0;

/** Computed once per served model at startup. */
export const planAnswer = (manifest: AgentManifest): AnswerPlan => {
  const explicit = manifest.steps.some(
    (step) => step.includeInFinalOutput === true,
  );
  const candidates = manifest.steps.flatMap((step, index) =>
    !explicit || step.includeInFinalOutput === true
      ? [{ stepId: step.id, index, streamable: isStreamable(step) }]
      : [],
  );
  return { candidates, explicit, projected: usesStateProjection(manifest) };
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Whether a condition reads a variable, directly or through a template. */
export const conditionReads = (expression: string, key: string): boolean => {
  const escaped = escapeRegExp(key);
  return (
    new RegExp(String.raw`\{\{\s*${escaped}(?:\.|\s*\}\})`, "iu").test(
      expression,
    ) ||
    new RegExp(
      String.raw`(^|[^A-Za-z0-9_.-])${escaped}(?=$|\.|[^A-Za-z0-9_.-])`,
      "iu",
    ).test(expression)
  );
};

/** Variables a step writes, or undefined when they cannot be known statically. */
const knownWrites = (step: AgentStep): string[] | undefined => {
  if (step.type !== "prompt") return undefined;
  return step.outputVariable ? [step.outputVariable] : [];
};

/**
 * Decide, as a candidate step starts, whether its text can stream live.
 * `variables` are the step's own input variables, which later `when`
 * conditions are evaluated against.
 */
export const canStreamLive = async (input: {
  manifest: AgentManifest;
  plan: AnswerPlan;
  mode: StreamMode;
  step: AgentStep;
  variables: Readonly<VariableState>;
  /** Candidates that already completed in this run. */
  completedCandidates: ReadonlySet<string>;
  evaluator: ConditionEvaluator;
}): Promise<boolean> => {
  const { manifest, plan, step } = input;
  if (input.mode === "committed" || plan.projected) return false;
  const candidate = plan.candidates.find((entry) => entry.stepId === step.id);
  if (!candidate?.streamable) return false;
  // An earlier candidate's output would be part of the final output too.
  if (plan.explicit && input.completedCandidates.size > 0) return false;
  if (input.mode === "live") return true;

  const contributes = new Set(plan.candidates.map((entry) => entry.stepId));
  const written = new Set(knownWrites(step) ?? []);
  let writesKnown = true;
  for (const later of manifest.steps.slice(candidate.index + 1)) {
    if (!plan.explicit || contributes.has(later.id)) {
      // This step could add to or replace the reply; prove it is skipped.
      const condition = later.when?.trim();
      if (!condition || !writesKnown) return false;
      if (conditionReads(condition, "messages")) return false;
      for (const key of written) {
        if (conditionReads(condition, key)) return false;
      }
      let runs: boolean;
      try {
        runs = await input.evaluator.evaluate(condition, input.variables);
      } catch {
        return false;
      }
      if (runs) return false;
      continue;
    }
    const writes = knownWrites(later);
    if (writes === undefined) writesKnown = false;
    else for (const key of writes) written.add(key);
  }
  return true;
};

/**
 * Wrap a step executor so the server learns, before a top-level step runs,
 * which step it is and with which variables.
 */
export const observeStepStarts = (
  executor: StepExecutor,
  onStart: (
    step: AgentStep,
    variables: Readonly<VariableState>,
  ) => void | Promise<void>,
): StepExecutor => ({
  type: executor.type,
  ...(executor.preflight
    ? { preflight: executor.preflight.bind(executor) }
    : {}),
  execute: async (context: StepExecutionContext) => {
    if (context.stepPath === context.step.id) {
      await onStart(context.step, context.variables);
    }
    return executor.execute(context);
  },
});
