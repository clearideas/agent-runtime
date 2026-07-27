import type {
  ArtifactRef,
  AgentManifest,
  AgentRunExecution,
  AgentRunManifest,
  ExecutionCursor,
  JsonObject,
  JsonValue,
  ModelUsage,
  RunCheckpoint,
  RunError,
  RunEvent,
  AgentStep,
  AgentVariableOverride,
  RunResult,
  StatePatch,
  StepResult,
  TranscriptItem,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import {
  agentManifestSchema,
  parseAgentRunManifest,
  parseRunCheckpoint,
  valueMatchesAgentVariableType,
} from "@clearideas/agent-runtime-contracts";
import { parse as parseYaml } from "yaml";

import type {
  ApprovalAdapter,
  ArtifactStore,
  Clock,
  CompletedRunRecord,
  EventSink,
  IdGenerator,
  AgentManifestSource,
  ModelAdapter,
  RunRecord,
  RunStore,
  SandboxAdapter,
  SubRunAdapter,
  ToolAdapter,
} from "./ports/index.js";
import { cryptoIdGenerator, systemClock } from "./ports/index.js";
import { buildExecutionWaves } from "./execution-plan.js";
import { applyStatePatch, snapshotState } from "./state.js";

export interface StepExecutionResult {
  output?: JsonValue;
  statePatch?: StatePatch;
  transcript?: TranscriptItem[];
  artifacts?: ArtifactRef[];
  metadata?: JsonObject;
}

export interface StepExecutionContext {
  runId: string;
  manifest: AgentManifest;
  step: AgentStep;
  stepIndex: number;
  stepPath?: string;
  variables: Readonly<VariableState>;
  /** Prior committed top-level results, in execution order. */
  stepResults?: Readonly<StepResult[]>;
  signal?: AbortSignal | undefined;
  model?: ModelAdapter | undefined;
  tools?: ToolAdapter | undefined;
  artifacts?: ArtifactStore | undefined;
  approvals?: ApprovalAdapter | undefined;
  sandbox?: SandboxAdapter | undefined;
  subRuns?: SubRunAdapter | undefined;
  emit(type: string, data?: JsonObject): Promise<RunEvent>;
  /** Present when this step is resuming from a nested checkpoint. */
  resume?: {
    cursor: ExecutionCursor;
    continuation?: JsonObject;
    transcript?: TranscriptItem[];
    artifacts?: ArtifactRef[];
  };
  /** Execute a registered child step without committing the parent step. */
  executeChild?(
    step: AgentStep,
    variables: Readonly<VariableState>,
    stepPath: string,
  ): Promise<StepExecutionResult>;
  /** Commit resumable state while a nested step remains active. */
  checkpoint?(input: NestedCheckpointInput): Promise<void>;
  evaluateCondition?(
    expression: string,
    variables: Readonly<VariableState>,
  ): Promise<boolean>;
}

export interface NestedCheckpointInput {
  state: VariableState;
  cursor?: Omit<ExecutionCursor, "stepIndex">;
  continuation?: JsonObject;
  /** Cumulative transcript produced by this step since it began or resumed. */
  transcript?: TranscriptItem[];
  /** Cumulative artifacts produced by this step since it began or resumed. */
  artifacts?: ArtifactRef[];
}

export interface StepExecutor<TStep extends AgentStep = AgentStep> {
  readonly type: TStep["type"];
  execute(
    context: StepExecutionContext & { step: TStep },
  ): Promise<StepExecutionResult>;
}

export interface ConditionEvaluator {
  evaluate(
    expression: string,
    variables: Readonly<VariableState>,
  ): boolean | Promise<boolean>;
}

export interface ManifestHasher {
  hash(manifest: AgentManifest): string | Promise<string>;
}

export interface AgentRuntimeDependencies {
  runStore: RunStore;
  agentManifestSource?: AgentManifestSource;
  eventSinks?: EventSink[];
  stepExecutors: Iterable<StepExecutor>;
  model?: ModelAdapter;
  tools?: ToolAdapter;
  artifacts?: ArtifactStore;
  approvals?: ApprovalAdapter;
  sandbox?: SandboxAdapter;
  subRuns?: SubRunAdapter;
  conditionEvaluator?: ConditionEvaluator;
  clock?: Clock;
  idGenerator?: IdGenerator;
  manifestHasher?: ManifestHasher;
  runtimeVersion?: string;
  /** Host ceiling for dependency-safe top-level step concurrency. Defaults to 8. */
  maxParallelSteps?: number;
  /** Event sinks are observational by default and cannot invalidate a commit. */
  eventSinkFailurePolicy?: "continue" | "fail-run";
  onEventSinkError?: (error: unknown, event: RunEvent) => void;
}

export interface RunRequest {
  /** Portable agent run contract. The referenced agent is loaded through AgentManifestSource. */
  agentRunManifest?: AgentRunManifest;
  /** Resolved-agent embedding convenience; mutually exclusive with agentRunManifest. */
  manifest?: AgentManifest;
  manifestReference?: string;
  runId?: string;
  variables?: AgentVariableOverride[];
  /** Step scheduling for resolved-agent embedding and execution adapters. */
  execution?: AgentRunExecution;
  signal?: AbortSignal;
  /** Resume from the latest committed checkpoint for runId. */
  resume?: boolean;
  /** Allow recovery to supersede a run still marked running. Host orchestration must prove ownership expired. */
  allowRunningTakeover?: boolean;
}

export interface AgentExecutionResult extends RunResult {
  /** Backward-compatible alias for state. */
  variables: VariableState;
}

interface TopLevelStepOutcome {
  step: AgentStep;
  stepIndex: number;
  skipped: boolean;
  result?: StepExecutionResult;
  stepResult?: StepResult;
}

class TopLevelStepExecutionError extends Error {
  readonly step: AgentStep;
  readonly cause: unknown;

  constructor(step: AgentStep, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TopLevelStepExecutionError";
    this.step = step;
    this.cause = cause;
  }
}

/**
 * Cooperative control-flow signal used by executors after committing a
 * resumable checkpoint. Agent Runtime persists a suspended lifecycle state
 * instead of treating the yielded attempt as a failure.
 */
export class RunSuspendedError extends Error {
  readonly code = "RUN_SUSPENDED";
  readonly reason: string;
  readonly details: JsonObject | undefined;

  constructor(reason: string, details?: JsonObject) {
    super(`Run suspended: ${reason}`);
    this.name = "RunSuspendedError";
    this.reason = reason;
    this.details = details;
  }
}

export const isRunSuspendedError = (
  error: unknown,
): error is RunSuspendedError =>
  error instanceof RunSuspendedError ||
  (error instanceof Error &&
    error.name === "RunSuspendedError" &&
    (error as Error & { code?: string }).code === "RUN_SUSPENDED");

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** A deterministic cryptographic manifest fingerprint for checkpoint safety. */
export const defaultManifestHasher: ManifestHasher = {
  hash: async (manifest) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stableStringify(manifest)),
    );
    return `sha256:${[...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
  },
};

const toRunError = (error: unknown): RunError => {
  const source = error instanceof Error ? error : new Error(String(error));
  return {
    code: "AGENT_EXECUTION_FAILED",
    message: source.message,
    retryable: false,
    ...(source.name === "Error" ? {} : { details: { name: source.name } }),
  };
};

const isAbortError = (signal?: AbortSignal): boolean =>
  signal?.aborted === true;

const assertParallelWaveStatePatches = (
  outcomes: TopLevelStepOutcome[],
): void => {
  if (outcomes.length < 2) return;
  for (const outcome of outcomes) {
    if (outcome.skipped || !outcome.result?.statePatch) continue;
    const patch = outcome.result.statePatch;
    const allowed = outcome.step.outputVariable;
    const writes = Object.keys(patch.set ?? {});
    const hasUnexpectedWrite =
      writes.some((key) => key !== allowed) || (patch.unset?.length ?? 0) > 0;
    if (hasUnexpectedWrite) {
      throw new Error(
        `Parallel step ${outcome.step.id} attempted to mutate state outside its outputVariable`,
      );
    }
  }
};

export const resolveAgentVariables = (
  manifest: AgentManifest,
  supplied: AgentVariableOverride[] | undefined,
): VariableState => {
  const definitions = manifest.variables ?? [];
  const definitionsByKey = new Map(
    definitions.map((definition) => [definition.key, definition]),
  );
  const state: VariableState = {};

  for (const definition of definitions) {
    if (definition.value !== undefined) {
      state[definition.key] = structuredClone(definition.value);
    }
  }

  const overrideKeys = new Set<string>();
  for (const override of supplied ?? []) {
    const normalizedKey = override.key.toLowerCase();
    if (overrideKeys.has(normalizedKey)) {
      throw new Error(`Duplicate run variable override: ${override.key}`);
    }
    overrideKeys.add(normalizedKey);

    const definition = definitionsByKey.get(override.key);
    if (!definition) {
      throw new Error(
        `Run variable is not declared by the agent: ${override.key}`,
      );
    }
    if (!valueMatchesAgentVariableType(override.value, definition.type)) {
      throw new Error(
        `Run variable ${override.key} must be ${definition.type}`,
      );
    }
    state[definition.key] = structuredClone(override.value);
  }

  const missing = definitions
    .filter(
      (definition) =>
        definition.requiresOverride === true &&
        !overrideKeys.has(definition.key.toLowerCase()),
    )
    .map((definition) => definition.key);
  if (missing.length > 0) {
    throw new Error(
      `Missing required runtime variable overrides: ${missing.join(", ")}`,
    );
  }
  return state;
};

const jsonByteLength = (value: JsonValue): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const assertRecoverableCheckpoint = (input: {
  checkpoint: RunCheckpoint;
  runId: string;
  manifest: AgentManifest;
  runAttempt: number;
}): void => {
  const { runId, manifest, runAttempt } = input;
  const checkpoint = parseRunCheckpoint(input.checkpoint);
  if (checkpoint.runId !== runId)
    throw new Error(`Checkpoint does not belong to run ${runId}`);
  if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1) {
    throw new Error(
      `Checkpoint sequence for run ${runId} must be a positive safe integer`,
    );
  }
  const checkpointAttempt = checkpoint.attempt ?? 1;
  if (
    !Number.isSafeInteger(checkpointAttempt) ||
    checkpointAttempt < 1 ||
    checkpointAttempt > runAttempt
  ) {
    throw new Error(`Checkpoint attempt for run ${runId} is not recoverable`);
  }
  if (checkpoint.contractVersion !== "1.0") {
    throw new Error(
      `Unsupported checkpoint contract version ${checkpoint.contractVersion}`,
    );
  }
  if (
    checkpoint.cursor == null ||
    !Number.isSafeInteger(checkpoint.cursor.stepIndex) ||
    checkpoint.cursor.stepIndex < 0 ||
    checkpoint.cursor.stepIndex > manifest.steps.length
  ) {
    throw new Error(
      `Checkpoint cursor for run ${runId} is outside the manifest`,
    );
  }
  if (checkpoint.cursor.stepIndex < manifest.steps.length) {
    const activeTopLevelStep = manifest.steps[checkpoint.cursor.stepIndex]?.id;
    const activePath = checkpoint.cursor.stepPath ?? checkpoint.cursor.stepId;
    if (
      activeTopLevelStep &&
      activePath &&
      activePath !== activeTopLevelStep &&
      !activePath.startsWith(`${activeTopLevelStep}/`)
    ) {
      throw new Error(
        `Checkpoint active step does not match the manifest for run ${runId}`,
      );
    }
  }
  if (
    checkpoint.state == null ||
    typeof checkpoint.state !== "object" ||
    Array.isArray(checkpoint.state) ||
    !Array.isArray(checkpoint.stepResults) ||
    !Array.isArray(checkpoint.transcript) ||
    !Array.isArray(checkpoint.artifacts)
  ) {
    throw new Error(`Checkpoint payload for run ${runId} is malformed`);
  }
  for (const [name, active, complete] of [
    ["transcript", checkpoint.activeStepTranscript, checkpoint.transcript],
    ["artifacts", checkpoint.activeStepArtifacts, checkpoint.artifacts],
  ] as const) {
    if (active == null) continue;
    if (!Array.isArray(active) || active.length > complete.length) {
      throw new Error(
        `Checkpoint active-step ${name} for run ${runId} is malformed`,
      );
    }
    const committedTail = complete.slice(complete.length - active.length);
    if (JSON.stringify(committedTail) !== JSON.stringify(active)) {
      throw new Error(
        `Checkpoint active-step ${name} for run ${runId} is inconsistent`,
      );
    }
  }
};

const withoutActiveTail = <T>(complete: T[], active: T[] | undefined): T[] =>
  active && active.length > 0 ? complete.slice(0, -active.length) : complete;

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value != null && typeof value === "object" && !Array.isArray(value);

const runtimeExtension = (
  value: JsonValue | undefined,
): JsonObject | undefined =>
  isJsonObject(value) && isJsonObject(value.agentRuntime)
    ? value.agentRuntime
    : undefined;

const usesStepOutputStateProjection = (manifest: AgentManifest): boolean =>
  runtimeExtension(manifest.extensions)?.stateProjection ===
  "step-output-state-v1";

const parseStructuredOutput = (value: JsonValue): JsonValue => {
  if (typeof value !== "string") return structuredClone(value);
  let stripped = value.trim();
  const fence = stripped.match(/^```([^\n\r]*)\r?\n([\s\S]*?)\r?\n```$/);
  if (fence) {
    const language = fence[1]?.trim().toLowerCase();
    if (
      language === "json" ||
      language === "yaml" ||
      language === "yml" ||
      language === ""
    ) {
      stripped = fence[2]?.trim() ?? "";
      if (language === "yaml" || language === "yml") {
        try {
          const parsed = parseYaml(stripped) as unknown;
          if (parsed != null && typeof parsed === "object")
            return parsed as JsonValue;
        } catch {
          return value;
        }
      }
    }
  }
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return value;
  try {
    return JSON.parse(stripped) as JsonValue;
  } catch {
    return value;
  }
};

const withProjectedStepState = (
  manifest: AgentManifest,
  step: AgentStep,
  stepIndex: number,
  result: StepExecutionResult,
): StepExecutionResult => {
  if (!usesStepOutputStateProjection(manifest) || result.output === undefined)
    return result;
  const projected = parseStructuredOutput(result.output);
  const stateKey =
    typeof runtimeExtension(step.extensions)?.stateKey === "string"
      ? String(runtimeExtension(step.extensions)?.stateKey)
      : `step-${stepIndex + 1}`;
  return {
    ...result,
    statePatch: {
      ...(result.statePatch ?? {}),
      set: {
        ...(result.statePatch?.set ?? {}),
        [stateKey]: projected,
        "step-previous": projected,
        ...(step.outputVariable ? { [step.outputVariable]: projected } : {}),
      },
    },
  };
};

const stringifyOutput = (value: JsonValue | undefined): string =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

export const selectRunOutput = (
  manifest: AgentManifest,
  stepResults: StepResult[],
): JsonValue | undefined => {
  const selectedIds = manifest.steps
    .filter((step) => step.includeInFinalOutput === true)
    .map((step) => step.id);
  if (selectedIds.length === 0) return stepResults.at(-1)?.output;
  const outputs = selectedIds.flatMap((stepId) => {
    const output = stepResults.find(
      (result) => result.stepId === stepId,
    )?.output;
    return output === undefined ? [] : [output];
  });
  if (outputs.length === 0) return stepResults.at(-1)?.output;
  if (usesStepOutputStateProjection(manifest)) {
    const selectedOutput = outputs
      .map(stringifyOutput)
      .filter((output) => output !== "");
    if (selectedOutput.length > 0) return selectedOutput.join("\n\n");
    for (const result of [...stepResults].reverse()) {
      const step = manifest.steps[result.stepIndex];
      if (step?.type === "webhook" || step?.type === "approval") continue;
      const fallback = stringifyOutput(result.output);
      if (fallback !== "") return fallback;
    }
    return "";
  }
  return outputs.length === 1 ? outputs[0] : outputs;
};

export const aggregateModelUsage = (
  transcript: TranscriptItem[],
): ModelUsage | undefined => {
  const usages = transcript.flatMap((item) => (item.usage ? [item.usage] : []));
  if (usages.length === 0) return undefined;
  const sum = (key: keyof ModelUsage): number | undefined => {
    const values = usages
      .map((usage) => usage[key])
      .filter((value): value is number => typeof value === "number");
    return values.length > 0
      ? values.reduce((total, value) => total + value, 0)
      : undefined;
  };
  const result: ModelUsage = {};
  const inputTokens = sum("inputTokens");
  const outputTokens = sum("outputTokens");
  const reasoningTokens = sum("reasoningTokens");
  const cachedInputTokens = sum("cachedInputTokens");
  const cacheWriteTokens = sum("cacheWriteTokens");
  const totalTokens = sum("totalTokens");
  const estimatedCost = sum("estimatedCost");
  if (inputTokens != null) result.inputTokens = inputTokens;
  if (outputTokens != null) result.outputTokens = outputTokens;
  if (reasoningTokens != null) result.reasoningTokens = reasoningTokens;
  if (cachedInputTokens != null) result.cachedInputTokens = cachedInputTokens;
  if (cacheWriteTokens != null) result.cacheWriteTokens = cacheWriteTokens;
  if (totalTokens != null) result.totalTokens = totalTokens;
  if (estimatedCost != null) result.estimatedCost = estimatedCost;
  return result;
};

/**
 * Persistence-neutral Agent Runtime with ordered commits. Sequential runs
 * checkpoint each step; parallel runs checkpoint dependency-safe prompt waves.
 */
export class AgentRuntime {
  readonly #dependencies: AgentRuntimeDependencies;
  readonly #executors: Map<string, StepExecutor>;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #manifestHasher: ManifestHasher;
  readonly #eventSequences = new Map<string, number>();
  readonly #eventTails = new Map<string, Promise<void>>();
  readonly #checkpointSequences = new Map<string, number>();
  readonly #runAttempts = new Map<string, number>();
  readonly #activeRunIds = new Set<string>();

  constructor(dependencies: AgentRuntimeDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? systemClock;
    this.#ids = dependencies.idGenerator ?? cryptoIdGenerator;
    this.#manifestHasher = dependencies.manifestHasher ?? defaultManifestHasher;
    this.#executors = new Map();

    for (const executor of dependencies.stepExecutors) {
      if (this.#executors.has(executor.type)) {
        throw new Error(
          `Duplicate step executor registered for ${executor.type}`,
        );
      }
      this.#executors.set(executor.type, executor);
    }
  }

  async run(request: RunRequest): Promise<AgentExecutionResult> {
    let normalizedRequest = request;
    if (request.agentRunManifest) {
      if (
        request.resume ||
        request.manifest ||
        request.manifestReference ||
        request.variables ||
        request.runId ||
        request.execution
      ) {
        throw new Error(
          "agentRunManifest cannot be combined with resume, manifest, manifestReference, variables, runId, or execution",
        );
      }
      const agentRunManifest = parseAgentRunManifest(request.agentRunManifest);
      const { agentRunManifest: _agentRunManifest, ...hostOptions } = request;
      normalizedRequest = {
        ...hostOptions,
        manifestReference: agentRunManifest.agent.ref,
        ...(agentRunManifest.runId ? { runId: agentRunManifest.runId } : {}),
        ...(agentRunManifest.variables
          ? { variables: agentRunManifest.variables }
          : {}),
        ...(agentRunManifest.execution
          ? { execution: agentRunManifest.execution }
          : {}),
      };
    }
    if (normalizedRequest.resume && !normalizedRequest.runId) {
      throw new Error("A runId is required to resume a run");
    }
    if (normalizedRequest.resume && normalizedRequest.variables != null) {
      throw new Error(
        "Run variable overrides cannot be supplied when resuming a run",
      );
    }
    const runId = normalizedRequest.runId ?? this.#ids.generateId("run");
    if (this.#activeRunIds.has(runId)) {
      throw new Error(
        `Run ${runId} is already active in this Agent Runtime process`,
      );
    }
    this.#activeRunIds.add(runId);
    try {
      return await this.#run({ ...normalizedRequest, runId });
    } finally {
      this.#activeRunIds.delete(runId);
      this.#eventSequences.delete(runId);
      this.#eventTails.delete(runId);
      this.#checkpointSequences.delete(runId);
      this.#runAttempts.delete(runId);
    }
  }

  async #run(
    request: RunRequest & { runId: string },
  ): Promise<AgentExecutionResult> {
    const runId = request.runId;
    const existingRecord = request.resume
      ? await this.#dependencies.runStore.loadRun(runId)
      : null;
    if (request.resume && !existingRecord) {
      throw new Error(`Run ${runId} does not exist`);
    }
    if (
      existingRecord?.status === "completed" ||
      existingRecord?.status === "cancelled"
    ) {
      throw new Error(`Run ${runId} is already ${existingRecord.status}`);
    }

    const rawManifest = request.manifest
      ? request.manifest
      : request.manifestReference
        ? await this.#resolveManifest(request)
        : (existingRecord?.manifest ?? (await this.#resolveManifest(request)));
    const parsedManifest = agentManifestSchema.safeParse(rawManifest);
    if (!parsedManifest.success) {
      const reasons = parsedManifest.error.issues
        .map((issue) => issue.message)
        .join("; ");
      throw new Error(`Agent manifest is invalid: ${reasons}`);
    }
    const manifest = parsedManifest.data;
    if (
      manifest.limits?.maxSteps != null &&
      manifest.steps.length > manifest.limits.maxSteps
    ) {
      throw new Error(
        `Manifest declares ${manifest.steps.length} steps, exceeding its ${manifest.limits.maxSteps}-step limit`,
      );
    }
    const latestCheckpoint = request.resume
      ? await this.#dependencies.runStore.loadLatestCheckpoint(runId)
      : null;
    if (request.resume && !latestCheckpoint) {
      throw new Error(`Run ${runId} has no checkpoint to resume`);
    }
    if (latestCheckpoint && existingRecord) {
      assertRecoverableCheckpoint({
        checkpoint: latestCheckpoint,
        runId,
        manifest,
        runAttempt: existingRecord.attempt ?? 1,
      });
    }
    if (
      latestCheckpoint &&
      latestCheckpoint.manifestHash !==
        (await this.#manifestHasher.hash(manifest))
    ) {
      throw new Error(`Manifest does not match checkpoint for run ${runId}`);
    }

    const startedAt =
      existingRecord?.createdAt ?? this.#clock.now().toISOString();
    const startStepIndex = latestCheckpoint?.cursor.stepIndex ?? 0;
    let variables: VariableState = latestCheckpoint
      ? structuredClone(latestCheckpoint.state)
      : resolveAgentVariables(manifest, request.variables);
    const stepResults: StepResult[] = structuredClone(
      latestCheckpoint?.stepResults ?? [],
    );
    const transcript: TranscriptItem[] = structuredClone(
      withoutActiveTail(
        latestCheckpoint?.transcript ?? [],
        latestCheckpoint?.activeStepTranscript,
      ),
    );
    const artifacts: ArtifactRef[] = structuredClone(
      withoutActiveTail(
        latestCheckpoint?.artifacts ?? [],
        latestCheckpoint?.activeStepArtifacts,
      ),
    );

    const record: RunRecord = {
      runId,
      manifest,
      status: "running",
      attempt: 1,
      state: structuredClone(variables),
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    let uncommittedSteps: AgentStep[] = [];
    if (!request.resume) {
      await this.#dependencies.runStore.createRun(record);
      this.#runAttempts.set(runId, 1);
    } else {
      const attempt = await this.#dependencies.runStore.resumeRun(
        runId,
        this.#clock.now().toISOString(),
        request.allowRunningTakeover
          ? { allowRunningTakeover: true }
          : undefined,
      );
      this.#runAttempts.set(runId, attempt);
      record.attempt = attempt;
      this.#checkpointSequences.set(runId, latestCheckpoint!.sequence);
    }
    try {
      await this.#emit(runId, request.resume ? "run.resumed" : "run.started", {
        manifestId: manifest.id ?? null,
        startStepIndex,
      });
      if (!request.resume) {
        await this.#checkpoint({
          runId,
          manifest,
          nextStepIndex: 0,
          variables,
          stepResults,
          transcript,
          artifacts,
        });
      }

      const executionWaves = buildExecutionWaves(
        manifest,
        startStepIndex,
        request.execution,
        this.#dependencies.maxParallelSteps ?? 8,
      );
      for (const wave of executionWaves) {
        this.#throwIfAborted(request.signal);
        const waveVariables = snapshotState(variables);
        const waveStepResults = structuredClone(stepResults);
        uncommittedSteps = wave.stepIndexes.flatMap((stepIndex) => {
          const step = manifest.steps[stepIndex];
          return step ? [step] : [];
        });
        const settled = await Promise.allSettled(
          wave.stepIndexes.map((stepIndex) =>
            this.#executeTopLevelStep({
              runId,
              manifest,
              stepIndex,
              variables: waveVariables,
              stepResults: waveStepResults,
              transcript,
              artifacts,
              signal: request.signal,
              latestCheckpoint,
            }),
          ),
        );
        const failures = settled.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason as unknown] : [],
        );
        if (failures.length > 0) {
          const suspended = failures.find(isRunSuspendedError);
          if (suspended) {
            uncommittedSteps = [];
            throw suspended;
          }
          for (const failure of failures) {
            const wrapped =
              failure instanceof TopLevelStepExecutionError
                ? failure
                : undefined;
            if (wrapped) {
              await this.#emit(
                runId,
                "step.failed",
                {
                  error: toRunError(wrapped.cause) as unknown as JsonValue,
                },
                wrapped.step.id,
              );
            }
          }
          uncommittedSteps = [];
          const first = failures[0];
          throw first instanceof TopLevelStepExecutionError
            ? first.cause
            : first;
        }

        const outcomes = settled
          .flatMap((outcome) =>
            outcome.status === "fulfilled" ? [outcome.value] : [],
          )
          .sort((left, right) => left.stepIndex - right.stepIndex);
        assertParallelWaveStatePatches(outcomes);
        for (const outcome of outcomes) {
          if (outcome.skipped || !outcome.result || !outcome.stepResult)
            continue;
          variables = applyStatePatch(variables, outcome.result.statePatch);
          transcript.push(...(outcome.result.transcript ?? []));
          artifacts.push(...(outcome.result.artifacts ?? []));
          stepResults.push(outcome.stepResult);
        }

        const nextStepIndex = (wave.stepIndexes.at(-1) ?? -1) + 1;
        await this.#checkpoint({
          runId,
          manifest,
          nextStepIndex,
          variables,
          stepResults,
          transcript,
          artifacts,
        });
        for (const outcome of outcomes) {
          await this.#emit(
            runId,
            outcome.skipped ? "step.skipped" : "step.completed",
            outcome.skipped ? undefined : { stepIndex: outcome.stepIndex },
            outcome.step.id,
          );
        }
        uncommittedSteps = [];
      }

      this.#throwIfAborted(request.signal);
      const output = selectRunOutput(manifest, stepResults);
      this.#assertOutputWithinLimit(manifest, output, "final run output");
      const usage = aggregateModelUsage(transcript);
      const completedAt = this.#clock.now().toISOString();
      const completedRecord: CompletedRunRecord = {
        ...record,
        status: "completed",
        state: structuredClone(variables),
        updatedAt: completedAt,
        ...(output === undefined ? {} : { output }),
        transcript: structuredClone(transcript),
        artifacts: structuredClone(artifacts),
        ...(usage ? { usage } : {}),
      };
      await this.#dependencies.runStore.completeRun(completedRecord);
      try {
        await this.#emit(runId, "run.completed");
      } catch {
        // Durable completion is authoritative; an observer cannot roll it back.
      }
      this.#eventSequences.delete(runId);
      this.#eventTails.delete(runId);
      this.#checkpointSequences.delete(runId);
      this.#runAttempts.delete(runId);

      return {
        runId,
        state: variables,
        variables,
        stepResults,
        transcript,
        artifacts,
        startedAt,
        completedAt,
        ...(usage ? { usage } : {}),
        ...(output === undefined ? {} : { output }),
      };
    } catch (error) {
      if (isRunSuspendedError(error)) {
        const suspendedAt = this.#clock.now().toISOString();
        await this.#dependencies.runStore.suspendRun(
          runId,
          suspendedAt,
          this.#runAttempts.get(runId) ?? 1,
        );
        try {
          await this.#emit(runId, "run.suspended", {
            reason: error.reason,
            ...(error.details ? { details: error.details } : {}),
          });
        } finally {
          this.#eventSequences.delete(runId);
          this.#eventTails.delete(runId);
          this.#checkpointSequences.delete(runId);
          this.#runAttempts.delete(runId);
        }
        throw error;
      }
      const runError = toRunError(error);
      const failedAt = this.#clock.now().toISOString();
      const cancelled = isAbortError(request.signal);
      if (cancelled) {
        await this.#dependencies.runStore.cancelRun(
          runId,
          failedAt,
          this.#runAttempts.get(runId) ?? 1,
        );
      } else {
        await this.#dependencies.runStore.failRun(
          runId,
          runError,
          failedAt,
          this.#runAttempts.get(runId) ?? 1,
        );
      }
      try {
        for (const step of uncommittedSteps) {
          await this.#emit(
            runId,
            "step.failed",
            { error: runError as unknown as JsonValue },
            step.id,
          );
        }
        await this.#emit(runId, cancelled ? "run.cancelled" : "run.failed", {
          error: runError as unknown as JsonValue,
        });
      } finally {
        this.#eventSequences.delete(runId);
        this.#eventTails.delete(runId);
        this.#checkpointSequences.delete(runId);
        this.#runAttempts.delete(runId);
      }
      throw error;
    }
  }

  async #executeTopLevelStep(input: {
    runId: string;
    manifest: AgentManifest;
    stepIndex: number;
    variables: Readonly<VariableState>;
    stepResults: Readonly<StepResult[]>;
    transcript: TranscriptItem[];
    artifacts: ArtifactRef[];
    signal?: AbortSignal | undefined;
    latestCheckpoint: RunCheckpoint | null;
  }): Promise<TopLevelStepOutcome> {
    const step = input.manifest.steps[input.stepIndex];
    if (!step) {
      throw new Error(`Manifest step ${input.stepIndex} does not exist`);
    }

    try {
      if (!(await this.#shouldExecute(step, { ...input.variables }))) {
        return { step, stepIndex: input.stepIndex, skipped: true };
      }

      const executor = this.#executors.get(step.type);
      if (!executor) {
        throw new Error(`No step executor registered for ${step.type}`);
      }

      await this.#emit(
        input.runId,
        "step.started",
        { stepIndex: input.stepIndex },
        step.id,
      );
      const checkpointNested = (nested: NestedCheckpointInput) =>
        this.#checkpoint({
          runId: input.runId,
          manifest: input.manifest,
          nextStepIndex: input.stepIndex,
          cursor: {
            stepIndex: input.stepIndex,
            stepId: step.id,
            stepPath: step.id,
            ...(nested.cursor ?? {}),
          },
          variables: nested.state,
          stepResults: [...input.stepResults],
          transcript: [...input.transcript, ...(nested.transcript ?? [])],
          artifacts: [...input.artifacts, ...(nested.artifacts ?? [])],
          ...(nested.continuation ? { continuation: nested.continuation } : {}),
          activeStepTranscript: nested.transcript ?? [],
          activeStepArtifacts: nested.artifacts ?? [],
        });

      const result = await executor.execute({
        runId: input.runId,
        manifest: input.manifest,
        step,
        stepIndex: input.stepIndex,
        stepPath: step.id,
        variables: snapshotState({ ...input.variables }),
        stepResults: structuredClone(input.stepResults),
        signal: input.signal,
        model: this.#dependencies.model,
        tools: this.#dependencies.tools,
        artifacts: this.#dependencies.artifacts,
        approvals: this.#dependencies.approvals,
        sandbox: this.#dependencies.sandbox,
        subRuns: this.#dependencies.subRuns,
        emit: (type, data) =>
          this.#emit(input.runId, type, data, step.id, step.id),
        ...(input.latestCheckpoint?.cursor.stepIndex === input.stepIndex
          ? {
              resume: {
                cursor: input.latestCheckpoint.cursor,
                ...(input.latestCheckpoint.continuation
                  ? { continuation: input.latestCheckpoint.continuation }
                  : {}),
                ...(input.latestCheckpoint.activeStepTranscript
                  ? {
                      transcript: structuredClone(
                        input.latestCheckpoint.activeStepTranscript,
                      ),
                    }
                  : {}),
                ...(input.latestCheckpoint.activeStepArtifacts
                  ? {
                      artifacts: structuredClone(
                        input.latestCheckpoint.activeStepArtifacts,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
        executeChild: (childStep, childVariables, childPath) =>
          this.#executeChild({
            runId: input.runId,
            manifest: input.manifest,
            parentStepIndex: input.stepIndex,
            step: childStep,
            stepPath: childPath,
            variables: childVariables,
            signal: input.signal,
            latestCheckpoint: input.latestCheckpoint,
            stepResults: input.stepResults,
            checkpoint: checkpointNested,
          }),
        checkpoint: checkpointNested,
        evaluateCondition: (expression, conditionVariables) =>
          this.#evaluateCondition(expression, conditionVariables),
      });

      this.#throwIfAborted(input.signal);
      this.#assertOutputWithinLimit(
        input.manifest,
        result.output,
        `step ${step.id}`,
      );
      const projectedResult = withProjectedStepState(
        input.manifest,
        step,
        input.stepIndex,
        result,
      );
      const stepUsage = aggregateModelUsage(result.transcript ?? []);
      const stepResult: StepResult = {
        stepId: step.id,
        stepIndex: input.stepIndex,
        status: "completed",
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.transcript ? { transcript: result.transcript } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(stepUsage ? { usage: stepUsage } : {}),
        completedAt: this.#clock.now().toISOString(),
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
      return {
        step,
        stepIndex: input.stepIndex,
        skipped: false,
        result: projectedResult,
        stepResult,
      };
    } catch (error) {
      if (isRunSuspendedError(error)) throw error;
      throw new TopLevelStepExecutionError(step, error);
    }
  }

  async #resolveManifest(request: RunRequest): Promise<AgentManifest> {
    if (request.manifest) return request.manifest;
    if (!this.#dependencies.agentManifestSource) {
      throw new Error("An agent manifest or AgentManifestSource is required");
    }
    return this.#dependencies.agentManifestSource.loadManifest(
      request.manifestReference,
    );
  }

  #assertOutputWithinLimit(
    manifest: AgentManifest,
    output: JsonValue | undefined,
    label: string,
  ): void {
    const maxOutputBytes = manifest.limits?.maxOutputBytes;
    if (output === undefined || maxOutputBytes == null) return;
    const outputBytes = jsonByteLength(output);
    if (outputBytes > maxOutputBytes) {
      throw new Error(
        `${label} is ${outputBytes} bytes, exceeding the ${maxOutputBytes}-byte output limit`,
      );
    }
  }

  async #shouldExecute(
    step: AgentStep,
    variables: VariableState,
  ): Promise<boolean> {
    if (!step.when) return true;
    if (!this.#dependencies.conditionEvaluator) {
      throw new Error(
        `Step ${step.id} has a condition but no ConditionEvaluator is configured`,
      );
    }
    return this.#dependencies.conditionEvaluator.evaluate(step.when, variables);
  }

  async #evaluateCondition(
    expression: string,
    variables: Readonly<VariableState>,
  ): Promise<boolean> {
    if (expression.trim() === "") return true;
    if (!this.#dependencies.conditionEvaluator) {
      throw new Error(
        "A ConditionEvaluator is required for loop conditions and goals",
      );
    }
    return this.#dependencies.conditionEvaluator.evaluate(
      expression,
      variables,
    );
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Run cancelled");
  }

  async #executeChild(input: {
    runId: string;
    manifest: AgentManifest;
    parentStepIndex: number;
    step: AgentStep;
    stepPath: string;
    variables: Readonly<VariableState>;
    signal?: AbortSignal | undefined;
    latestCheckpoint: RunCheckpoint | null;
    stepResults: Readonly<StepResult[]>;
    checkpoint: (input: NestedCheckpointInput) => Promise<void>;
  }): Promise<StepExecutionResult> {
    this.#throwIfAborted(input.signal);
    if (!(await this.#shouldExecute(input.step, { ...input.variables }))) {
      await this.#emit(
        input.runId,
        "step.skipped",
        undefined,
        input.step.id,
        input.stepPath,
      );
      return { metadata: { skipped: true } };
    }

    const executor = this.#executors.get(input.step.type);
    if (!executor) {
      throw new Error(`No step executor registered for ${input.step.type}`);
    }

    await this.#emit(
      input.runId,
      "step.started",
      { stepIndex: input.parentStepIndex },
      input.step.id,
      input.stepPath,
    );
    const cursorPath = input.latestCheckpoint?.cursor.stepPath;
    const isResumingPath =
      input.latestCheckpoint?.cursor.stepIndex === input.parentStepIndex &&
      (cursorPath === input.stepPath ||
        cursorPath?.startsWith(`${input.stepPath}/`) === true);

    const result = await executor.execute({
      runId: input.runId,
      manifest: input.manifest,
      step: input.step,
      stepIndex: input.parentStepIndex,
      stepPath: input.stepPath,
      variables: snapshotState({ ...input.variables }),
      stepResults: structuredClone(input.stepResults),
      signal: input.signal,
      model: this.#dependencies.model,
      tools: this.#dependencies.tools,
      artifacts: this.#dependencies.artifacts,
      approvals: this.#dependencies.approvals,
      sandbox: this.#dependencies.sandbox,
      subRuns: this.#dependencies.subRuns,
      emit: (type, data) =>
        this.#emit(input.runId, type, data, input.step.id, input.stepPath),
      ...(isResumingPath && input.latestCheckpoint
        ? {
            resume: {
              cursor: input.latestCheckpoint.cursor,
              ...(input.latestCheckpoint.continuation
                ? { continuation: input.latestCheckpoint.continuation }
                : {}),
              ...(input.latestCheckpoint.activeStepTranscript
                ? {
                    transcript: structuredClone(
                      input.latestCheckpoint.activeStepTranscript,
                    ),
                  }
                : {}),
              ...(input.latestCheckpoint.activeStepArtifacts
                ? {
                    artifacts: structuredClone(
                      input.latestCheckpoint.activeStepArtifacts,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      executeChild: (childStep, childVariables, childPath) =>
        this.#executeChild({
          ...input,
          step: childStep,
          stepPath: childPath,
          variables: childVariables,
        }),
      checkpoint: (nested) =>
        input.checkpoint({
          ...nested,
          cursor: {
            stepId: input.step.id,
            stepPath: input.stepPath,
            ...(nested.cursor ?? {}),
          },
        }),
      evaluateCondition: (expression, conditionVariables) =>
        this.#evaluateCondition(expression, conditionVariables),
    });

    await this.#emit(
      input.runId,
      "step.completed",
      { stepIndex: input.parentStepIndex },
      input.step.id,
      input.stepPath,
    );
    return withProjectedStepState(
      input.manifest,
      input.step,
      input.parentStepIndex,
      result,
    );
  }

  async #checkpoint(input: {
    runId: string;
    manifest: AgentManifest;
    nextStepIndex: number;
    variables: VariableState;
    stepResults: StepResult[];
    transcript: TranscriptItem[];
    artifacts: ArtifactRef[];
    activeStepTranscript?: TranscriptItem[];
    activeStepArtifacts?: ArtifactRef[];
    cursor?: ExecutionCursor;
    continuation?: JsonObject;
  }): Promise<void> {
    const checkpointSequence =
      (this.#checkpointSequences.get(input.runId) ?? 0) + 1;
    const checkpoint: RunCheckpoint = {
      id: this.#ids.generateId("checkpoint"),
      runId: input.runId,
      sequence: checkpointSequence,
      attempt: this.#runAttempts.get(input.runId) ?? 1,
      manifestHash: await this.#manifestHasher.hash(input.manifest),
      contractVersion: "1.0",
      runtimeVersion: this.#dependencies.runtimeVersion ?? "0.1.0",
      cursor: input.cursor ?? { stepIndex: input.nextStepIndex },
      state: structuredClone(input.variables),
      stepResults: structuredClone(input.stepResults),
      transcript: structuredClone(input.transcript),
      artifacts: structuredClone(input.artifacts),
      ...(input.activeStepTranscript
        ? { activeStepTranscript: structuredClone(input.activeStepTranscript) }
        : {}),
      ...(input.activeStepArtifacts
        ? { activeStepArtifacts: structuredClone(input.activeStepArtifacts) }
        : {}),
      ...(input.continuation
        ? { continuation: structuredClone(input.continuation) }
        : {}),
      createdAt: this.#clock.now().toISOString(),
    };
    await this.#dependencies.runStore.saveCheckpoint(checkpoint);
    this.#checkpointSequences.set(input.runId, checkpointSequence);
    await this.#emit(input.runId, "checkpoint.saved", {
      checkpointId: checkpoint.id,
      nextStepIndex: checkpoint.cursor.stepIndex,
    });
  }

  async #emit(
    runId: string,
    type: string,
    data?: JsonObject,
    stepId?: string,
    stepPath?: string,
  ): Promise<RunEvent> {
    const previous = this.#eventTails.get(runId) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const event = {
        id: this.#ids.generateId("event"),
        runId,
        type,
        sequence: (this.#eventSequences.get(runId) ?? 0) + 1,
        attempt: this.#runAttempts.get(runId) ?? 1,
        timestamp: this.#clock.now().toISOString(),
        ...(stepId ? { stepId, stepPath: stepPath ?? stepId } : {}),
        ...(data ? { data } : {}),
      } as RunEvent;
      this.#eventSequences.set(runId, event.sequence);

      for (const sink of this.#dependencies.eventSinks ?? []) {
        try {
          await sink.emit(event);
        } catch (error) {
          this.#dependencies.onEventSinkError?.(error, event);
          if (this.#dependencies.eventSinkFailurePolicy === "fail-run")
            throw error;
        }
      }
      return event;
    });
    this.#eventTails.set(
      runId,
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
    return pending;
  }
}
