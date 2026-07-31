import type {
  AgentManifest,
  AgentRunExecution,
  AgentStep,
  PromptStep,
} from "@clearideas/agent-runtime-contracts";

export interface ExecutionWave {
  stepIndexes: number[];
}

const stepOutputStateProjectionEnabled = (manifest: AgentManifest): boolean => {
  const runtime = manifest.extensions?.agentRuntime;
  return (
    runtime != null &&
    typeof runtime === "object" &&
    !Array.isArray(runtime) &&
    runtime.stateProjection === "step-output-state-v1"
  );
};

const isParallelPromptStep = (step: AgentStep): step is PromptStep =>
  step.type === "prompt" &&
  (step.tools == null || step.tools.length === 0) &&
  step.extensions == null;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const templateReadsVariable = (
  source: string | undefined,
  key: string,
): boolean => {
  if (!source) return false;
  const escaped = escapeRegExp(key);
  return new RegExp(String.raw`\{\{\s*${escaped}(?:\.|\s*\}\})`, "iu").test(
    source,
  );
};

const conditionReadsVariable = (
  expression: string | undefined,
  key: string,
): boolean => {
  if (!expression) return false;
  if (templateReadsVariable(expression, key)) return true;
  const escaped = escapeRegExp(key);
  return new RegExp(
    String.raw`(^|[^A-Za-z0-9_.-])${escaped}(?=$|\.|[^A-Za-z0-9_.-])`,
    "iu",
  ).test(expression);
};

const readsVariable = (step: PromptStep, key: string): boolean =>
  templateReadsVariable(step.systemPrompt, key) ||
  templateReadsVariable(step.prompt, key) ||
  (step.messages?.some((message) =>
    message.content.some(
      (part) => part.type === "text" && templateReadsVariable(part.text, key),
    ),
  ) ??
    false) ||
  conditionReadsVariable(step.when, key);

const dependsOnCurrentWave = (
  step: PromptStep,
  currentWave: AgentStep[],
): boolean =>
  currentWave.some((priorStep) => {
    const written = priorStep.outputVariable;
    if (!written) return false;
    return step.outputVariable === written || readsVariable(step, written);
  });

/**
 * Builds contiguous execution waves so the existing ordered checkpoint cursor
 * remains sufficient for recovery. Only tool-free prompt steps without runtime
 * extensions are eligible for parallel execution.
 */
export const buildExecutionWaves = (
  manifest: AgentManifest,
  startStepIndex: number,
  execution: AgentRunExecution | undefined,
  hostMaximumConcurrency = 8,
): ExecutionWave[] => {
  const maximumConcurrency = Math.max(
    1,
    Math.min(
      execution?.maxConcurrency ?? 4,
      Math.max(1, hostMaximumConcurrency),
    ),
  );
  const parallel =
    execution?.mode === "parallel" &&
    maximumConcurrency > 1 &&
    !stepOutputStateProjectionEnabled(manifest);

  const waves: ExecutionWave[] = [];
  let current: number[] = [];

  const flush = (): void => {
    while (current.length > 0) {
      waves.push({ stepIndexes: current.slice(0, maximumConcurrency) });
      current = current.slice(maximumConcurrency);
    }
  };

  for (
    let stepIndex = startStepIndex;
    stepIndex < manifest.steps.length;
    stepIndex += 1
  ) {
    const step = manifest.steps[stepIndex];
    if (!step) continue;

    if (!parallel || !isParallelPromptStep(step)) {
      flush();
      waves.push({ stepIndexes: [stepIndex] });
      continue;
    }

    const currentSteps = current.flatMap((index) => {
      const candidate = manifest.steps[index];
      return candidate ? [candidate] : [];
    });
    if (dependsOnCurrentWave(step, currentSteps)) flush();
    current.push(stepIndex);
    if (current.length === maximumConcurrency) flush();
  }
  flush();
  return waves;
};
