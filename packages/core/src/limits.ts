import { DEFAULT_RUN_LIMITS } from "@clearideas/agent-runtime-contracts";
import type {
  AgentManifest,
  ArtifactRef,
  ModelUsage,
  RunCheckpoint,
  RunLedger,
  RunLimits,
  RunSandboxUsageLimits,
  TranscriptItem,
} from "@clearideas/agent-runtime-contracts";

/** A run's limits after layering; a limit that is absent does not apply. */
export type EffectiveRunLimits = Omit<RunLimits, "sandbox"> & {
  sandbox: RunSandboxUsageLimits;
};

const RUN_LIMIT_KEYS = [
  "maxTotalTokens",
  "maxStepTokens",
  "maxEstimatedCost",
  "maxRunActiveMs",
  "maxStepActiveMs",
  "maxRecoveries",
  "maxResumesWithoutProgress",
  "maxTurnsPerPrompt",
  "maxLoopIterations",
  "maxArtifacts",
  "maxArtifactBytes",
  "maxCheckpointBytes",
] as const satisfies ReadonlyArray<Exclude<keyof RunLimits, "sandbox">>;

const SANDBOX_LIMIT_KEYS = [
  "maxCommands",
  "maxSeconds",
  "commandTimeoutMs",
  "maxCommandTimeoutMs",
  "maxStdoutBytes",
  "maxStderrBytes",
  "maxOutputFiles",
  "maxOutputBytes",
] as const satisfies ReadonlyArray<keyof RunSandboxUsageLimits>;

/** The run-limit fields of a manifest's `limits`, without its other limits. */
export const manifestRunLimits = (manifest: AgentManifest): RunLimits => {
  const limits = manifest.limits ?? {};
  const picked: RunLimits = {};
  for (const key of RUN_LIMIT_KEYS) {
    if (limits[key] !== undefined) picked[key] = limits[key];
  }
  if (limits.sandbox) picked.sandbox = { ...limits.sandbox };
  return picked;
};

/** Later layers replace earlier ones field by field. */
export const mergeRunLimits = (
  ...layers: Array<RunLimits | undefined>
): RunLimits => {
  const merged: RunLimits = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of RUN_LIMIT_KEYS) {
      if (layer[key] !== undefined) merged[key] = layer[key];
    }
    if (layer.sandbox) {
      merged.sandbox = { ...(merged.sandbox ?? {}) };
      for (const key of SANDBOX_LIMIT_KEYS) {
        if (layer.sandbox[key] !== undefined)
          merged.sandbox[key] = layer.sandbox[key];
      }
    }
  }
  return merged;
};

/**
 * Resolve a run's limits: `DEFAULT_RUN_LIMITS`, then the host's defaults,
 * then the manifest, then limits granted for this run. Host ceilings
 * (`enforcedLimits`) apply last and can only lower a value.
 */
export const resolveRunLimits = (
  manifest: AgentManifest,
  layers: {
    defaults?: RunLimits | undefined;
    granted?: RunLimits | undefined;
    ceilings?: RunLimits | undefined;
  } = {},
): EffectiveRunLimits => {
  const requested = mergeRunLimits(
    DEFAULT_RUN_LIMITS,
    layers.defaults,
    manifestRunLimits(manifest),
    layers.granted,
  );
  const ceilings = layers.ceilings;
  const effective: EffectiveRunLimits = { sandbox: {} };
  const lowest = (value?: number, ceiling?: number) =>
    value !== undefined && ceiling !== undefined
      ? Math.min(value, ceiling)
      : (value ?? ceiling);
  for (const key of RUN_LIMIT_KEYS) {
    const resolved = lowest(requested[key], ceilings?.[key]);
    if (resolved !== undefined) effective[key] = resolved;
  }
  for (const key of SANDBOX_LIMIT_KEYS) {
    const resolved = lowest(requested.sandbox?.[key], ceilings?.sandbox?.[key]);
    if (resolved !== undefined) effective.sandbox[key] = resolved;
  }
  return effective;
};

const reportedTotalTokens = (usage: ModelUsage): number | undefined => {
  if (usage.totalTokens != null) return usage.totalTokens;
  if (usage.inputTokens == null && usage.outputTokens == null) return undefined;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
};

export const transcriptTokens = (
  transcript: readonly TranscriptItem[],
): number =>
  transcript.reduce((total, item) => {
    const reported = item.usage ? reportedTotalTokens(item.usage) : undefined;
    return (
      total + (reported != null && Number.isFinite(reported) ? reported : 0)
    );
  }, 0);

/** Estimated cost adapters reported in a transcript. */
export const transcriptCost = (transcript: readonly TranscriptItem[]): number =>
  transcript.reduce((total, item) => {
    const cost = item.usage?.estimatedCost;
    return (
      total + (typeof cost === "number" && Number.isFinite(cost) ? cost : 0)
    );
  }, 0);

const artifactUsage = (
  artifacts: readonly ArtifactRef[],
): RunLedger["artifacts"] => ({
  count: artifacts.length,
  bytes: artifacts.reduce((total, artifact) => total + (artifact.size ?? 0), 0),
});

/** Cumulative sandbox usage from a 1.1 ledger or a 1.0 checkpoint's metadata. */
export const sandboxUsageFromCheckpoint = (
  checkpoint: RunCheckpoint | null,
): RunLedger["sandbox"] => {
  if (checkpoint?.ledger?.sandbox) return { ...checkpoint.ledger.sandbox };
  const value = checkpoint?.metadata?.sandboxBudget;
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.commandsUsed) ||
    typeof value.sandboxSecondsUsed !== "number"
  )
    return undefined;
  return {
    commands: Number(value.commandsUsed),
    seconds: Number(value.sandboxSecondsUsed),
  };
};

/**
 * Tracks one run's durable usage during an attempt. It starts from the
 * ledger of the checkpoint the attempt resumed (or derives one from a 1.0
 * checkpoint), and produces the ledger each new checkpoint carries.
 */
export class RunLedgerTracker {
  readonly #now: () => number;
  #baseActiveMs: number;
  #attemptStartedAt: number;
  /** The step execution that is running, keyed by its execution key. */
  #step:
    | { key: string; baseActiveMs: number; startedAt: number; tokens: number }
    | undefined;
  /** The step execution the resumed checkpoint was inside, if any. */
  #resumedStep: RunLedger["step"];
  #sandbox: RunLedger["sandbox"];
  #stalledResumes: RunLedger["stalledResumes"];
  #recoveries: number;
  #progress: number | undefined;
  #granted: RunLimits | undefined;
  #tokens = 0;
  #cost = 0;
  #artifacts: RunLedger["artifacts"] = { count: 0, bytes: 0 };
  #inherited: RunLedger["inherited"];

  constructor(input: { checkpoint: RunCheckpoint | null; now: () => number }) {
    this.#now = input.now;
    const ledger = input.checkpoint?.ledger;
    this.#baseActiveMs = ledger?.activeMs ?? 0;
    this.#attemptStartedAt = this.#now();
    this.#sandbox = sandboxUsageFromCheckpoint(input.checkpoint);
    this.#stalledResumes = ledger?.stalledResumes
      ? { ...ledger.stalledResumes }
      : undefined;
    this.#recoveries = ledger?.recoveries ?? 0;
    this.#progress = input.checkpoint
      ? (ledger?.progress ?? input.checkpoint.sequence)
      : undefined;
    this.#granted = ledger?.granted
      ? structuredClone(ledger.granted)
      : undefined;
    this.#inherited = ledger?.inherited
      ? structuredClone(ledger.inherited)
      : undefined;
    this.#resumedStep = ledger?.step ? { ...ledger.step } : undefined;
    if (input.checkpoint) this.#observeContent(input.checkpoint);
  }

  /** Limits granted for this run, including earlier attempts' grants. */
  get granted(): RunLimits | undefined {
    return this.#granted;
  }

  grant(limits: RunLimits | undefined): void {
    if (!limits) return;
    this.#granted = mergeRunLimits(this.#granted, limits);
  }

  get stalledResumes(): RunLedger["stalledResumes"] {
    return this.#stalledResumes;
  }

  set stalledResumes(value: RunLedger["stalledResumes"]) {
    this.#stalledResumes = value;
  }

  /** Recoveries so far: resumes after a failure, interruption, or error block. */
  get recoveries(): number {
    return this.#recoveries;
  }

  recordRecovery(): void {
    this.#recoveries += 1;
  }

  /** The sequence of the latest checkpoint that recorded progress. */
  get progress(): number | undefined {
    return this.#progress;
  }

  get activeMs(): number {
    return this.#baseActiveMs + (this.#now() - this.#attemptStartedAt);
  }

  /** The running step execution's key, if one is tracked. */
  get stepKey(): string | undefined {
    return this.#step?.key;
  }

  /** Active time of a step execution, across attempts (0 if not running). */
  stepActiveMs(key: string): number {
    if (this.#step?.key !== key) return 0;
    return this.#step.baseActiveMs + (this.#now() - this.#step.startedAt);
  }

  /**
   * A step execution began or resumed in this attempt. Its time and tokens
   * continue from the resumed checkpoint when it is the same execution.
   */
  startStep(key: string): void {
    if (this.#step?.key === key) return;
    const resumed =
      this.#resumedStep?.key === key ? this.#resumedStep : undefined;
    this.#resumedStep = undefined;
    this.#step = {
      key,
      baseActiveMs: resumed?.activeMs ?? 0,
      startedAt: this.#now(),
      tokens: resumed?.tokens ?? 0,
    };
  }

  /** The step execution finished (or the attempt left it). */
  endStep(key?: string): void {
    if (key === undefined || this.#step?.key === key) this.#step = undefined;
  }

  /** Tokens the running step execution has reported so far. */
  setStepTokens(key: string, tokens: number): void {
    if (this.#step?.key === key) this.#step.tokens = tokens;
  }

  setSandbox(usage: RunLedger["sandbox"]): void {
    if (usage) this.#sandbox = { ...usage };
  }

  get sandbox(): RunLedger["sandbox"] {
    return this.#sandbox;
  }

  get tokens(): number {
    return this.#tokens;
  }

  get estimatedCost(): number {
    return this.#cost;
  }

  get stepTokens(): number {
    return this.#step?.tokens ?? 0;
  }

  get artifacts(): RunLedger["artifacts"] {
    return this.#artifacts;
  }

  /** Record the usage a checkpoint's content represents and return its ledger. */
  observe(checkpoint: {
    sequence: number;
    transcript: readonly TranscriptItem[];
    artifacts: readonly ArtifactRef[];
  }): RunLedger {
    this.#progress = checkpoint.sequence;
    this.#observeContent(checkpoint);
    return this.snapshot();
  }

  /** Usage of this run alone: inherited usage is not counted. */
  #observeContent(content: {
    transcript: readonly TranscriptItem[];
    artifacts: readonly ArtifactRef[];
  }): void {
    const inherited = this.#inherited;
    this.#tokens = Math.max(
      0,
      transcriptTokens(content.transcript) - (inherited?.tokens ?? 0),
    );
    this.#cost = Math.max(
      0,
      transcriptCost(content.transcript) - (inherited?.estimatedCost ?? 0),
    );
    const all = artifactUsage(content.artifacts);
    this.#artifacts = {
      count: Math.max(0, all.count - (inherited?.artifacts.count ?? 0)),
      bytes: Math.max(0, all.bytes - (inherited?.artifacts.bytes ?? 0)),
    };
  }

  snapshot(): RunLedger {
    return {
      tokens: this.#tokens,
      activeMs: Math.round(this.activeMs),
      ...(this.#cost > 0 ? { estimatedCost: this.#cost } : {}),
      ...(this.#step
        ? {
            step: {
              key: this.#step.key,
              tokens: this.#step.tokens,
              activeMs: Math.round(this.stepActiveMs(this.#step.key)),
            },
          }
        : {}),
      artifacts: { ...this.#artifacts },
      ...(this.#progress !== undefined ? { progress: this.#progress } : {}),
      ...(this.#sandbox ? { sandbox: { ...this.#sandbox } } : {}),
      ...(this.#recoveries > 0 ? { recoveries: this.#recoveries } : {}),
      ...(this.#stalledResumes
        ? { stalledResumes: { ...this.#stalledResumes } }
        : {}),
      ...(this.#granted ? { granted: structuredClone(this.#granted) } : {}),
      ...(this.#inherited
        ? { inherited: structuredClone(this.#inherited) }
        : {}),
    };
  }
}

/** The ledger a run seeded from `checkpoint` starts with. */
export const seededLedger = (checkpoint: RunCheckpoint): RunLedger => {
  const cost = transcriptCost(checkpoint.transcript);
  return {
    tokens: 0,
    activeMs: 0,
    artifacts: { count: 0, bytes: 0 },
    inherited: {
      tokens: transcriptTokens(checkpoint.transcript),
      ...(cost > 0 ? { estimatedCost: cost } : {}),
      artifacts: artifactUsage(checkpoint.artifacts),
    },
  };
};
