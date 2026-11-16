import { z } from "zod";

export const AGENT_MANIFEST_SCHEMA_VERSION = "1.0" as const;
export const AGENT_RUN_MANIFEST_SCHEMA_VERSION = "1.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

export type VariableState = Record<string, JsonValue>;
export const variableStateSchema: z.ZodType<VariableState> = z.record(
  z.string(),
  jsonValueSchema,
);

const RESERVED_VARIABLE_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
export const isSafeVariablePath = (value: string): boolean => {
  const segments = value.split(".").map((segment) => segment.trim());
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        !RESERVED_VARIABLE_PATH_SEGMENTS.has(segment.toLowerCase()),
    )
  );
};
export const variablePathSchema = z
  .string()
  .min(1)
  .refine(
    isSafeVariablePath,
    "Variable paths cannot contain empty or prototype-sensitive segments.",
  );

export const AGENT_VARIABLE_TYPES = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "json",
] as const;
export type AgentVariableType = (typeof AGENT_VARIABLE_TYPES)[number];

export const agentVariableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) => !value.includes("."),
    "Variable keys cannot contain dots; use dot notation only to read properties inside object values.",
  )
  .refine(
    (value) => !RESERVED_VARIABLE_PATH_SEGMENTS.has(value.toLowerCase()),
    "Variable keys cannot use prototype-sensitive names.",
  );

export interface StatePatch {
  set?: VariableState;
  unset?: string[];
}

export interface ArtifactRef {
  id: string;
  name: string;
  mediaType: string;
  uri?: string;
  size?: number;
  sha256?: string;
  metadata?: JsonObject;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  metadata?: JsonObject;
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonObject;
  stepId?: string;
  providerExecuted?: boolean;
  metadata?: JsonObject;
}

export interface ToolResult {
  callId: string;
  name: string;
  output?: JsonValue;
  error?: RunError;
  artifacts?: ArtifactRef[];
  metadata?: JsonObject;
}

export type ContentPart = (
  | { type: "text"; text: string }
  | { type: "reasoning"; text?: string; encrypted?: string }
  | { type: "json"; value: JsonValue }
  | {
      type: "image";
      artifact?: ArtifactRef;
      url?: string;
      /** Base64-encoded bytes. Prefer artifact references for durable histories. */
      data?: string;
      mediaType?: string;
    }
  | {
      type: "file";
      artifact?: ArtifactRef;
      url?: string;
      /** Base64-encoded bytes. Prefer artifact references for durable histories. */
      data?: string;
      name?: string;
      mediaType?: string;
    }
  | { type: "tool-call"; call: ToolCall }
  | { type: "tool-result"; result: ToolResult }
) & {
  /** Opaque application metadata. It is persisted but never interpreted by a model adapter. */
  metadata?: JsonObject;
  /** Provider-specific replay information forwarded by compatible model adapters. */
  providerOptions?: JsonObject;
};

export interface PromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
  /** Opaque application metadata. */
  metadata?: JsonObject;
  /** Provider-specific replay information forwarded by compatible model adapters. */
  providerOptions?: JsonObject;
}

// ─── Conversation messages ──────────────────────────────────────────────────

/**
 * The special variable through which steps read a run's conversation history.
 * It is reserved only in manifests that declare `messages`.
 */
export const MESSAGES_VARIABLE = "messages" as const;
export const MESSAGES_SIGNATURE_VERSION = "1" as const;
export const MESSAGES_SIGNATURE_ALGORITHM = "HMAC-SHA256" as const;

/** Content a conversation message may carry. Provider options are never accepted. */
export type ConversationContentPart = (
  | { type: "text"; text: string }
  | { type: "json"; value: JsonValue }
  | {
      type: "image";
      artifact?: ArtifactRef;
      url?: string;
      /** Base64-encoded bytes. Stored as an artifact when the run is created. */
      data?: string;
      mediaType?: string;
    }
  | {
      type: "file";
      artifact?: ArtifactRef;
      url?: string;
      /** Base64-encoded bytes. Stored as an artifact when the run is created. */
      data?: string;
      name?: string;
      mediaType?: string;
    }
) & {
  /** Opaque application metadata. Persisted and signed, never sent to a model. */
  metadata?: JsonObject;
};

/** One message of a conversation history supplied to, or returned by, a run. */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: ConversationContentPart[];
  /**
   * Opaque application metadata. `metadata.agentRuntime` is reserved for the
   * runtime's leading summary or note marker.
   */
  metadata?: JsonObject;
}

/** A conversation message as supplied: `content` may be a string shorthand for one text part. */
export interface ConversationMessageInput {
  role: "user" | "assistant";
  content: string | ConversationContentPart[];
  metadata?: JsonObject;
}

/** An HMAC over an exact prefix of a history and the host's scope. */
export interface MessagesSignature {
  version: typeof MESSAGES_SIGNATURE_VERSION;
  algorithm: typeof MESSAGES_SIGNATURE_ALGORITHM;
  /** Signing key identifier, for rotation. */
  keyId: string;
  /** Number of leading messages covered. */
  count: number;
  /** base64url MAC. */
  value: string;
}

/** What a leading runtime marker message stands for. */
export interface MessagesMarker {
  kind: "summary" | "note";
  /** Earlier messages it replaces, cumulative across compactions. */
  replaces: number;
  /**
   * Completed turns it covers, cumulative across compactions. A turn is one
   * exchange: the user's messages and the reply that completes them. Turn N
   * ends with the N-th assistant reply of the conversation.
   */
  turns?: number;
  /** Compactions in the conversation so far. */
  sequence: number;
  strategy: "summarize" | "prune";
}

/** The agent accepts a conversation history. Absent: no history is accepted. */
export interface AgentMessagesDeclaration {
  /** A run must supply a history. Default false. */
  required?: boolean;
  description?: string;
  /** Compaction trigger: message count, including a leading marker. */
  maxMessages?: number;
  /** Compaction trigger: UTF-8 bytes of the history JSON (media as references). */
  maxBytes?: number;
  /** Every message before the new turn must be covered by a valid signature. */
  requireSignature?: boolean;
  /** History-only overrides merged over the manifest's `policies.context`. */
  context?: ContextPolicy;
  /**
   * Wording of the leading marker a compaction writes. Templates over
   * `context.firstTurn`, `context.lastTurn`, `context.turns` (for example
   * "1–10"), and `context.messages` (messages replaced).
   */
  markers?: {
    /** Heading of a summary. */
    summary?: string;
    /** Text of a note that records removed messages. */
    note?: string;
  };
  metadata?: JsonObject;
}

/** How one step sees the history. */
export type StepHistory =
  | "all"
  | {
      /** Newest N messages. Absent: every message. */
      last?: number;
      /** Include a leading summary or note. Default: true without `last`, false with it. */
      summary?: boolean;
      /** Prompt steps: insert the selection as model turns. Default true. */
      insert?: boolean;
      /** Media handling for this step. Default include. */
      media?: "include" | "latest" | "omit";
    };

/** The effective history of a run, carried by every checkpoint. */
export interface RunMessagesState {
  history: ConversationMessage[];
  /** `pending` until run-level compaction has finished; it never runs again after `complete`. */
  compaction: "pending" | "complete";
  /** Leading messages covered by a verified signature when the run was created. */
  signedCount: number;
  /** Host scope bound into signatures. */
  scope?: string;
  /** Completed summarizer calls of an unfinished compaction. */
  journal?: JsonObject;
}

export interface TranscriptItem {
  id: string;
  type:
    | "message"
    | "reasoning"
    | "tool-call"
    | "tool-result"
    | "artifact"
    | "error";
  role?: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
  createdAt: string;
  model?: string;
  usage?: ModelUsage;
  metadata?: JsonObject;
  providerOptions?: JsonObject;
}

export type ModelReference =
  | {
      provider: string;
      model: string;
      options?: JsonObject;
    }
  | {
      /** Host-defined model profile. The resolved provider and model never contain credentials. */
      ref: string;
      options?: JsonObject;
    };

export interface AgentConnectionBinding {
  /** Host-defined connection name. */
  ref: string;
  /** Stable prefix used for tools exposed by this connection. Defaults to ref. */
  alias?: string;
  /** Optional per-agent narrowing of the connection's tool allowlist. */
  tools?: string[];
  /** An agent may request fewer privileges than the configured connection, never more. */
  mode?: "read" | "read_write";
  required?: boolean;
}

export const WORKSPACE_MODES = ["read", "read_write"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/**
 * Binds a host-defined workspace (a code base, document store, or other
 * durable file collection) to an agent. The host configuration defines the
 * workspace; the agent may only narrow what the host permits.
 */
export interface AgentWorkspaceBinding {
  /** Host-defined workspace name. */
  ref: string;
  /** Tool prefix and sandbox mount name. Defaults to ref. */
  alias?: string;
  /** Optional per-agent narrowing of the workspace tool set. */
  tools?: string[];
  /** An agent may request fewer privileges than the configured workspace, never more. */
  mode?: WorkspaceMode;
  required?: boolean;
}

/**
 * One command executed in the run sandbox on behalf of a tool call or a code
 * step. Attached to tool results, step results, and sandbox events so the
 * host has a complete durable record of what ran.
 */
export interface SandboxCommandRecord {
  id: string;
  runId: string;
  attempt: number;
  stepId: string;
  toolCallId?: string;
  workspace?: string;
  alias?: string;
  kind: "builtin" | "command" | "shell" | "code";
  name: string;
  policyEntry?: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  filesChanged: Array<{
    alias: string;
    path: string;
    action: "created" | "modified" | "deleted";
    size?: number;
    sha256?: string;
  }>;
  artifacts?: string[];
  ignoredPaths: Array<{ alias: string; path: string; reason: string }>;
  budget: {
    commandsUsed: number;
    commandsLimit: number;
    sandboxSecondsUsed: number;
    sandboxSecondsLimit: number;
  };
}

export interface AgentVariableDefinition {
  key: string;
  type: AgentVariableType;
  value?: JsonValue;
  requiresOverride?: boolean;
  description?: string;
  metadata?: JsonObject;
}

export interface AgentVariableOverride {
  key: string;
  value: JsonValue;
}

export const valueMatchesAgentVariableType = (
  value: JsonValue,
  type: AgentVariableType,
): boolean => {
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "json") return value !== null && typeof value === "object";
  return typeof value === type;
};

export const agentVariableDefinitionSchema: z.ZodType<AgentVariableDefinition> =
  z
    .strictObject({
      key: agentVariableKeySchema,
      type: z.enum(AGENT_VARIABLE_TYPES),
      value: jsonValueSchema.optional(),
      requiresOverride: z.boolean().optional(),
      description: z.string().optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .superRefine((definition, context) => {
      if (
        definition.value !== undefined &&
        !valueMatchesAgentVariableType(definition.value, definition.type)
      ) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: `Variable ${definition.key} default must be ${definition.type}.`,
        });
      }
    });

export const agentVariableOverrideSchema: z.ZodType<AgentVariableOverride> =
  z.strictObject({
    key: agentVariableKeySchema,
    value: jsonValueSchema,
  });

export const agentVariableOverridesSchema = z
  .array(agentVariableOverrideSchema)
  .superRefine((overrides, context) => {
    const keys = new Set<string>();
    overrides.forEach((override, index) => {
      const normalizedKey = override.key.toLowerCase();
      if (keys.has(normalizedKey)) {
        context.addIssue({
          code: "custom",
          path: [index, "key"],
          message: `Duplicate run variable override: ${override.key}`,
        });
      }
      keys.add(normalizedKey);
    });
  });

export const parseAgentVariableOverrides = (
  input: unknown,
): AgentVariableOverride[] => agentVariableOverridesSchema.parse(input);

/**
 * How a prompt step reduces model input that is, or would become, too large.
 *
 * - `summarize`: a summarizer model condenses oversized content; failure fails the step.
 * - `prune`: deterministic reduction without a model call (clip, stub, drop).
 * - `summarize-or-prune`: summarize, and prune when summarizing fails or is not enough.
 * - `fail`: never reduce; an oversized input fails the step.
 */
export const CONTEXT_STRATEGIES = [
  "summarize",
  "prune",
  "summarize-or-prune",
  "fail",
] as const;
export type ContextStrategy = (typeof CONTEXT_STRATEGIES)[number];

/** The model and instructions used when a context strategy summarizes. */
/** What the summarizer condenses. */
export const SUMMARY_KINDS = [
  "input",
  "transcript",
  "tool-result",
  "messages",
] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

export interface ContextSummarizer {
  /** Defaults to the step model, then the manifest model. */
  model?: ModelReference;
  /** Replaces the built-in summarizer system prompt. Templated over step variables and `context.*`. */
  systemPrompt?: string;
  /** Replaces the built-in instruction for every kind. Templated over step variables and `context.*`. */
  prompt?: string;
  /** Replaces the built-in instruction for one kind; takes precedence over `prompt`. */
  prompts?: {
    input?: string;
    transcript?: string;
    toolResult?: string;
    /** Conversation history compaction. */
    messages?: string;
  };
  /** Output-token limit for each summarizer call. Defaults from the target size. */
  maxOutputTokens?: number;
  /**
   * A transcript summary's target, as a share of the content it replaces
   * (default 0.25), bounded by `minSummaryBytes` and `maxSummaryBytes` and by
   * the room left under `reduceTo`.
   */
  summaryShare?: number;
  /** Smallest transcript summary to ask for, in bytes (default 1024). */
  minSummaryBytes?: number;
  /** Largest transcript summary to ask for, in bytes (default 16384). */
  maxSummaryBytes?: number;
  /**
   * Most material sent in one summarizer call, in bytes. Larger material is
   * split into chunks. Defaults to half the summarizer model's described input
   * window, else 48000. Chunks are reduced further so the full rendered
   * summarizer request fits `limits.maxInputBytes`.
   */
  chunkBytes?: number;
  /** Summarizer calls allowed per step execution (default 8 × maxCompactions, at least 16). */
  maxCalls?: number;
  /** Condensing passes over chunked material before giving up (default 4). */
  maxPasses?: number;
}

/** When a prompt step reduces its input. Any satisfied criterion triggers. */
export interface ContextTrigger {
  /** Model input JSON size, measured like `limits.maxInputBytes`. */
  inputBytes?: number;
  /** Estimated model input tokens, calibrated from reported usage. */
  inputTokens?: number;
  /** Fraction of the model's input window; requires an adapter that describes the model. */
  contextRatio?: number;
  /** Tool rounds completed since the step started or last compacted. */
  toolRounds?: number;
}

/** Per-variable overrides for reducing a step's interpolated opening prompt. */
export interface ContextVariablePolicy {
  /** Never shorten this variable. */
  keep?: boolean;
  strategy?: ContextStrategy;
  /** Always cap this variable's interpolated text at this size. */
  maxBytes?: number;
}

export interface ContextPolicy {
  strategy?: ContextStrategy;
  summarizer?: ContextSummarizer;
  trigger?: ContextTrigger;
  retain?: {
    /** Newest tool rounds kept verbatim when older rounds are compacted. */
    recentToolRounds?: number;
  };
  /**
   * Size a reduction aims for, as a fraction of the trigger (default 0.25).
   * Lower values reduce less often but cut deeper each time; higher values
   * reduce more often and keep more history.
   */
  reduceTo?: number;
  /**
   * Largest share of the trigger the opening prompt may use before its
   * interpolated variables are reduced. Defaults to 0.5 for a step with tools
   * (leaving room for the tool loop) and 0.9 for a step without tools.
   */
  openingShare?: number;
  /** Summarizing compactions per step execution; later reductions prune. */
  maxCompactions?: number;
  /** Reduce-and-retry attempts after a provider rejects a request as too long (default 3). */
  overflowRetries?: number;
  /** Cap for a single tool result as seen by the model. */
  maxToolResultBytes?: number;
  /**
   * Cap for a single tool result as a fraction of the trigger (default 0.4).
   * `maxToolResultBytes`, when set, takes precedence.
   */
  toolResultShare?: number;
  /** Keyed by variable path as written in templates, or by its root variable. */
  variables?: Record<string, ContextVariablePolicy>;
}

export interface ModelRetryPolicy {
  /** Total attempts for one model request, including the first. */
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface OutputRepairPolicy {
  /** Extra model turns allowed to repair invalid, empty, or truncated final output. */
  maxAttempts?: number;
}

/**
 * Execution policies. Hosts set defaults; a manifest's `policies` override the
 * host; a step's `policies` override the manifest. Prompt-only fields are
 * rejected on other step types.
 */
export interface ExecutionPolicies {
  context?: ContextPolicy;
  /** finalize: answer without tools once the tool-call limit is reached. */
  toolCallLimit?: "finalize" | "fail";
  modelRetry?: ModelRetryPolicy;
  outputRepair?: OutputRepairPolicy;
  /** continue: record the error as the step output and run the next step. */
  onError?: "fail" | "continue";
  /**
   * What a step failure that is not fatal does to the run. `pause` (default)
   * suspends it with kind `awaiting-host`, keeping its progress, resumable
   * once the cause is fixed; `fail` ends the attempt as failed. Run-level:
   * set it on the host or the manifest, not on a step.
   */
  onFailure?: "pause" | "fail";
}

export interface AgentStepBase {
  id: string;
  name?: string;
  description?: string;
  when?: string;
  /**
   * Which conversation messages this step sees. Requires a manifest
   * `messages` declaration. Narrows both the `messages` variable and, for
   * prompt steps, the turns inserted into the model input.
   */
  history?: StepHistory;
  outputVariable?: string;
  includeInFinalOutput?: boolean;
  policies?: ExecutionPolicies;
  metadata?: JsonObject;
  extensions?: JsonObject;
}

interface PromptStepDefinition extends AgentStepBase {
  type: "prompt";
  model?: ModelReference;
  outputSchema?: JsonObject;
  tools?: string[];
  maxOutputTokens?: number;
  completionPolicy?: {
    /** Truncated responses fail by default because they may contain only reasoning or partial data. */
    onTruncation?: "fail" | "accept";
    /** Require a non-empty string or a defined structured value after tool execution finishes. */
    requireOutput?: boolean;
  };
}

export type PromptStep = PromptStepDefinition &
  (
    | {
        /** Backward-compatible single-user-message shorthand. */
        prompt: string;
        systemPrompt?: string;
        messages?: never;
      }
    | {
        /** Complete ordered model history. */
        messages: PromptMessage[];
        prompt?: never;
        systemPrompt?: never;
      }
    | {
        /** System prompt plus the conversation history, with no extra user prompt. */
        history: StepHistory;
        systemPrompt?: string;
        prompt?: never;
        messages?: never;
      }
  );

export interface LoopDefinition {
  source?: string;
  delimiter?: string;
  itemVariable?: string;
  indexVariable?: string;
  condition?: string;
  goal?: string;
  outputMode?: "array" | "final";
  resultVariable?: string;
  maxIterations?: number;
}

export interface LoopStep extends AgentStepBase {
  type: "loop";
  loop: LoopDefinition;
  steps: AgentStep[];
}

export interface WebhookStep extends AgentStepBase {
  type: "webhook";
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: JsonValue;
  timeoutMs?: number;
  retries?: number;
  idempotencyKey?: string;
}

export interface ApprovalStep extends AgentStepBase {
  type: "approval";
  prompt: string;
  /** Informational; forwarded in events and on ApprovalRejectedError. */
  action?: "pause" | "complete" | "cancel";
  /**
   * What a rejection does. fail (default) fails the run; cancel cancels it;
   * complete ends the run successfully without running later steps; continue
   * records `{ approved: false }` and runs the next step.
   */
  onReject?: "fail" | "cancel" | "complete" | "continue";
}

export interface SubRunStep extends AgentStepBase {
  type: "sub-run";
  manifest?: AgentManifest;
  manifestRef?: string;
  variableMappings?: Record<string, string>;
}

export interface CodeStep extends AgentStepBase {
  type: "code";
  language: "python" | string;
  code: string;
  timeoutMs?: number;
  environment?: Record<string, string>;
  /** Bound workspace aliases available to the step. Implies sandbox: run. */
  workspaces?: string[];
  /** run: execute in the run sandbox; step: ephemeral per-step sandbox. */
  sandbox?: "run" | "step";
}

export type AgentStep =
  PromptStep | LoopStep | WebhookStep | ApprovalStep | SubRunStep | CodeStep;

const explicitModelReferenceSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  options: jsonObjectSchema.optional(),
});

const profileModelReferenceSchema = z.strictObject({
  ref: z.string().min(1),
  options: jsonObjectSchema.optional(),
});

const modelReferenceSchema: z.ZodType<ModelReference> = z.union([
  explicitModelReferenceSchema,
  profileModelReferenceSchema,
]);

const contextStrategySchema = z.enum(CONTEXT_STRATEGIES);

export const contextPolicySchema: z.ZodType<ContextPolicy> = z.strictObject({
  strategy: contextStrategySchema.optional(),
  summarizer: z
    .strictObject({
      model: modelReferenceSchema.optional(),
      systemPrompt: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      prompts: z
        .strictObject({
          input: z.string().min(1).optional(),
          transcript: z.string().min(1).optional(),
          toolResult: z.string().min(1).optional(),
          messages: z.string().min(1).optional(),
        })
        .optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      summaryShare: z.number().gt(0).max(1).optional(),
      minSummaryBytes: z.number().int().min(128).optional(),
      maxSummaryBytes: z.number().int().min(256).optional(),
      chunkBytes: z.number().int().min(1024).optional(),
      maxCalls: z.number().int().positive().optional(),
      maxPasses: z.number().int().min(1).max(10).optional(),
    })
    .refine(
      (summarizer) =>
        summarizer.minSummaryBytes == null ||
        summarizer.maxSummaryBytes == null ||
        summarizer.minSummaryBytes <= summarizer.maxSummaryBytes,
      "summarizer.minSummaryBytes cannot exceed maxSummaryBytes.",
    )
    .optional(),
  trigger: z
    .strictObject({
      inputBytes: z.number().int().positive().optional(),
      inputTokens: z.number().int().positive().optional(),
      contextRatio: z.number().gt(0).max(1).optional(),
      toolRounds: z.number().int().positive().optional(),
    })
    .optional(),
  retain: z
    .strictObject({
      recentToolRounds: z.number().int().nonnegative().optional(),
    })
    .optional(),
  reduceTo: z.number().min(0.05).max(0.95).optional(),
  openingShare: z.number().min(0.05).max(1).optional(),
  maxCompactions: z.number().int().nonnegative().optional(),
  overflowRetries: z.number().int().min(0).max(10).optional(),
  maxToolResultBytes: z.number().int().positive().optional(),
  toolResultShare: z.number().min(0.05).max(1).optional(),
  variables: z
    .record(
      variablePathSchema,
      z.strictObject({
        keep: z.boolean().optional(),
        strategy: contextStrategySchema.optional(),
        maxBytes: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

export const executionPoliciesSchema: z.ZodType<ExecutionPolicies> =
  z.strictObject({
    context: contextPolicySchema.optional(),
    toolCallLimit: z.enum(["finalize", "fail"]).optional(),
    modelRetry: z
      .strictObject({
        maxAttempts: z.number().int().min(1).max(10).optional(),
        initialDelayMs: z.number().int().nonnegative().optional(),
        maxDelayMs: z.number().int().nonnegative().optional(),
      })
      .optional(),
    outputRepair: z
      .strictObject({
        maxAttempts: z.number().int().min(0).max(5).optional(),
      })
      .optional(),
    onError: z.enum(["fail", "continue"]).optional(),
    onFailure: z.enum(["pause", "fail"]).optional(),
  });

/** Policy fields that only a prompt step can use. */
export const PROMPT_ONLY_POLICY_FIELDS = [
  "context",
  "toolCallLimit",
  "modelRetry",
  "outputRepair",
] as const;

export const stepHistorySchema: z.ZodType<StepHistory> = z.union([
  z.literal("all"),
  z.strictObject({
    last: z.number().int().positive().optional(),
    summary: z.boolean().optional(),
    insert: z.boolean().optional(),
    media: z.enum(["include", "latest", "omit"]).optional(),
  }),
]);

const stepBaseShape = {
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  when: z.string().optional(),
  history: stepHistorySchema.optional(),
  outputVariable: agentVariableKeySchema.optional(),
  includeInFinalOutput: z.boolean().optional(),
  policies: executionPoliciesSchema.optional(),
  metadata: jsonObjectSchema.optional(),
  extensions: jsonObjectSchema.optional(),
};

export const promptMessageSchema: z.ZodType<PromptMessage> = z.lazy(() =>
  z
    .strictObject({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.array(contentPartSchema).min(1),
      metadata: jsonObjectSchema.optional(),
      providerOptions: jsonObjectSchema.optional(),
    })
    .superRefine((message, context) => {
      if (message.role === "system") {
        message.content.forEach((part, index) => {
          if (part.type !== "text") {
            context.addIssue({
              code: "custom",
              path: ["content", index],
              message: "System messages may contain only text parts.",
            });
          }
        });
      }
      if (message.role === "tool") {
        message.content.forEach((part, index) => {
          if (part.type !== "tool-result") {
            context.addIssue({
              code: "custom",
              path: ["content", index],
              message: "Tool messages may contain only tool-result parts.",
            });
          }
        });
      }
      if (message.role === "user") {
        message.content.forEach((part, index) => {
          if (
            part.type === "reasoning" ||
            part.type === "tool-call" ||
            part.type === "tool-result"
          ) {
            context.addIssue({
              code: "custom",
              path: ["content", index],
              message: `User messages cannot contain ${part.type} parts.`,
            });
          }
        });
      }
      message.content.forEach((part, index) => {
        if (part.type !== "image" && part.type !== "file") return;
        const sourceCount = [part.artifact, part.url, part.data].filter(
          (value) => value !== undefined,
        ).length;
        if (sourceCount !== 1) {
          context.addIssue({
            code: "custom",
            path: ["content", index],
            message:
              "History media parts require exactly one of artifact, url, or data.",
          });
        }
        if (
          part.type === "file" &&
          part.artifact == null &&
          part.mediaType == null
        ) {
          context.addIssue({
            code: "custom",
            path: ["content", index, "mediaType"],
            message:
              "History file parts without an artifact reference require mediaType.",
          });
        }
      });
    }),
);

const bindingAliasSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/u)
  .optional();

const agentConnectionBindingSchema = z.strictObject({
  ref: z.string().min(1),
  alias: bindingAliasSchema,
  tools: z.array(z.string().min(1)).optional(),
  mode: z.enum(["read", "read_write"]).optional(),
  required: z.boolean().optional(),
});

export const agentWorkspaceBindingSchema: z.ZodType<AgentWorkspaceBinding> =
  z.strictObject({
    ref: z.string().min(1),
    alias: bindingAliasSchema,
    tools: z.array(z.string().min(1)).optional(),
    mode: z.enum(WORKSPACE_MODES).optional(),
    required: z.boolean().optional(),
  });

// The prompt refinement below enforces the PromptStep input union. Zod retains
// optional field inference after superRefine, so expose the refined output type.
export const agentStepSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .strictObject({
        ...stepBaseShape,
        type: z.literal("prompt"),
        prompt: z.string().optional(),
        systemPrompt: z.string().optional(),
        messages: z.array(promptMessageSchema).min(1).optional(),
        model: modelReferenceSchema.optional(),
        outputSchema: jsonObjectSchema.optional(),
        tools: z.array(z.string()).optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        completionPolicy: z
          .strictObject({
            onTruncation: z.enum(["fail", "accept"]).optional(),
            requireOutput: z.boolean().optional(),
          })
          .optional(),
      })
      .superRefine((step, context) => {
        const usesLegacyPrompt = step.prompt !== undefined;
        const usesMessages = step.messages !== undefined;
        const insertsHistory =
          step.history !== undefined &&
          (step.history === "all" || step.history.insert !== false);
        if (usesLegacyPrompt && usesMessages) {
          context.addIssue({
            code: "custom",
            message: "Prompt steps require exactly one of prompt or messages.",
          });
        } else if (!usesLegacyPrompt && !usesMessages && !insertsHistory) {
          context.addIssue({
            code: "custom",
            message:
              "Prompt steps require prompt, messages, or history that inserts conversation turns.",
          });
        }
        if (usesMessages && step.systemPrompt !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["systemPrompt"],
            message:
              "systemPrompt cannot be combined with a complete messages history.",
          });
        }

        const calls = new Map<string, string>();
        const results = new Set<string>();
        let sawNonSystemMessage = false;
        for (const [messageIndex, message] of (step.messages ?? []).entries()) {
          if (message.role === "system" && sawNonSystemMessage) {
            context.addIssue({
              code: "custom",
              path: ["messages", messageIndex, "role"],
              message:
                "System messages must precede user, assistant, and tool history.",
            });
          } else if (message.role !== "system") {
            sawNonSystemMessage = true;
          }
          for (const [partIndex, part] of message.content.entries()) {
            if (part.type === "tool-call") {
              if (calls.has(part.call.id)) {
                context.addIssue({
                  code: "custom",
                  path: ["messages", messageIndex, "content", partIndex],
                  message: `Duplicate historical tool-call id: ${part.call.id}`,
                });
              } else {
                calls.set(part.call.id, part.call.name);
              }
            }
            if (part.type === "tool-result") {
              const expectedName = calls.get(part.result.callId);
              if (expectedName == null) {
                context.addIssue({
                  code: "custom",
                  path: ["messages", messageIndex, "content", partIndex],
                  message: `Historical tool result ${part.result.callId} has no preceding tool call.`,
                });
              } else if (expectedName !== part.result.name) {
                context.addIssue({
                  code: "custom",
                  path: ["messages", messageIndex, "content", partIndex],
                  message: `Historical tool result ${part.result.callId} names ${part.result.name}; expected ${expectedName}.`,
                });
              } else if (results.has(part.result.callId)) {
                context.addIssue({
                  code: "custom",
                  path: ["messages", messageIndex, "content", partIndex],
                  message: `Duplicate historical tool result: ${part.result.callId}`,
                });
              } else {
                results.add(part.result.callId);
              }
            }
          }
        }
        for (const callId of calls.keys()) {
          if (!results.has(callId)) {
            context.addIssue({
              code: "custom",
              path: ["messages"],
              message: `Historical tool call ${callId} has no tool result.`,
            });
          }
        }
      }),
    z.strictObject({
      ...stepBaseShape,
      type: z.literal("loop"),
      loop: z.strictObject({
        source: z.string().optional(),
        delimiter: z.string().optional(),
        itemVariable: variablePathSchema.optional(),
        indexVariable: variablePathSchema.optional(),
        condition: z.string().optional(),
        goal: z.string().optional(),
        outputMode: z.enum(["array", "final"]).optional(),
        resultVariable: variablePathSchema.optional(),
        maxIterations: z.number().int().positive().optional(),
      }),
      steps: z.array(agentStepSchema),
    }),
    z.strictObject({
      ...stepBaseShape,
      type: z.literal("webhook"),
      url: z.url(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: jsonValueSchema.optional(),
      timeoutMs: z.number().int().positive().optional(),
      retries: z.number().int().nonnegative().optional(),
      idempotencyKey: z.string().optional(),
    }),
    z.strictObject({
      ...stepBaseShape,
      type: z.literal("approval"),
      prompt: z.string(),
      action: z.enum(["pause", "complete", "cancel"]).optional(),
      onReject: z.enum(["fail", "cancel", "complete", "continue"]).optional(),
    }),
    z
      .object({
        ...stepBaseShape,
        type: z.literal("sub-run"),
        manifest: z.lazy(() => agentManifestSchema).optional(),
        manifestRef: z.string().optional(),
        variableMappings: z
          .record(agentVariableKeySchema, z.string())
          .optional(),
      })
      .strict()
      .refine((value) => value.manifest != null || value.manifestRef != null, {
        message: "A sub-run step requires manifest or manifestRef.",
      }),
    z.strictObject({
      ...stepBaseShape,
      type: z.literal("code"),
      language: z.string().min(1),
      code: z.string(),
      timeoutMs: z.number().int().positive().optional(),
      environment: z.record(z.string(), z.string()).optional(),
      workspaces: z.array(z.string().min(1)).optional(),
      sandbox: z.enum(["run", "step"]).optional(),
    }),
  ]),
) as unknown as z.ZodType<AgentStep>;

export interface AgentManifest {
  schemaVersion: typeof AGENT_MANIFEST_SCHEMA_VERSION;
  id?: string;
  name?: string;
  description?: string;
  model?: ModelReference;
  variables?: AgentVariableDefinition[];
  connections?: AgentConnectionBinding[];
  /** Host-defined file collections available to workspace tools and code steps. */
  workspaces?: AgentWorkspaceBinding[];
  /** The agent accepts a conversation history from its runs. */
  messages?: AgentMessagesDeclaration;
  steps: AgentStep[];
  /** Manifest-wide execution policy defaults; steps may override them. */
  policies?: ExecutionPolicies;
  limits?: AgentManifestLimits;
  metadata?: JsonObject;
  extensions?: JsonObject;
}

/**
 * Sandbox usage for one run. A manifest or a resume request may set these;
 * the host's sandbox configuration is the ceiling and the default.
 */
export interface RunSandboxUsageLimits {
  maxCommands?: number;
  maxSeconds?: number;
  commandTimeoutMs?: number;
  maxCommandTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxOutputFiles?: number;
  maxOutputBytes?: number;
}

/**
 * Limits that stop a runaway run. `DEFAULT_RUN_LIMITS` applies to every run;
 * the host's defaults, the manifest, and `RunRequest.limits` replace values,
 * and the host's `enforcedLimits` cap them. Reaching one suspends the run
 * with kind `awaiting-host`; it resumes once a higher limit is granted.
 *
 * A step execution is one run of a step that does work: a top-level step, or
 * one loop iteration's child. A loop itself is bounded by the run's limits
 * and `maxLoopIterations`.
 */
export interface RunLimits {
  /** Model tokens reported across the run. */
  maxTotalTokens?: number;
  /** Model tokens reported by one step execution. */
  maxStepTokens?: number;
  /** Estimated cost adapters report (`ModelUsage.estimatedCost`) across the run. */
  maxEstimatedCost?: number;
  /** Active execution time across all attempts. */
  maxRunActiveMs?: number;
  /** Active execution time of one step execution, across attempts. */
  maxStepActiveMs?: number;
  /**
   * Recoveries: resumes after a failure, an interruption, a takeover, or an
   * error block. Resumes that answer an approval, a child run, a budget, a
   * granted limit, or a pause do not count.
   */
  maxRecoveries?: number;
  /** Consecutive recoveries that make no progress (no new checkpoint): a crash loop. */
  maxResumesWithoutProgress?: number;
  /** Model requests made by one prompt step execution. */
  maxTurnsPerPrompt?: number;
  /** Iterations of one loop step execution. */
  maxLoopIterations?: number;
  /** Artifacts recorded by the run. */
  maxArtifacts?: number;
  /** Bytes of artifacts recorded by the run. */
  maxArtifactBytes?: number;
  /** Serialized size of one checkpoint. */
  maxCheckpointBytes?: number;
  sandbox?: RunSandboxUsageLimits;
}

export interface AgentManifestLimits extends RunLimits {
  maxSteps?: number;
  maxMessagesPerPrompt?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  /** Total tool calls per prompt step execution, across model turns and resumes. */
  maxToolCallsPerIteration?: number;
  providerTimeoutMs?: number;
}

/**
 * Anti-runaway limits every run has unless its host or manifest sets others:
 * high enough to be irrelevant to normal runs. `maxStepTokens` and
 * `maxEstimatedCost` have no default.
 */
export const DEFAULT_RUN_LIMITS = {
  maxTotalTokens: 25_000_000,
  maxRunActiveMs: 24 * 60 * 60 * 1_000,
  maxStepActiveMs: 4 * 60 * 60 * 1_000,
  maxRecoveries: 100,
  maxResumesWithoutProgress: 10,
  maxTurnsPerPrompt: 500,
  maxLoopIterations: 10_000,
  maxArtifacts: 10_000,
  maxArtifactBytes: 10 * 1024 * 1024 * 1024,
  maxCheckpointBytes: 64 * 1024 * 1024,
} as const satisfies RunLimits;

const limitValue = z.number().int().positive().safe();

export const runSandboxUsageLimitsSchema: z.ZodType<RunSandboxUsageLimits> =
  z.strictObject({
    maxCommands: limitValue.optional(),
    maxSeconds: z.number().positive().optional(),
    commandTimeoutMs: limitValue.optional(),
    maxCommandTimeoutMs: limitValue.optional(),
    maxStdoutBytes: limitValue.optional(),
    maxStderrBytes: limitValue.optional(),
    maxOutputFiles: limitValue.optional(),
    maxOutputBytes: limitValue.optional(),
  });

const runLimitsShape = {
  maxTotalTokens: limitValue.optional(),
  maxStepTokens: limitValue.optional(),
  maxEstimatedCost: z.number().positive().optional(),
  maxRunActiveMs: limitValue.optional(),
  maxStepActiveMs: limitValue.optional(),
  maxRecoveries: limitValue.optional(),
  maxResumesWithoutProgress: limitValue.optional(),
  maxTurnsPerPrompt: limitValue.optional(),
  maxLoopIterations: limitValue.optional(),
  maxArtifacts: limitValue.optional(),
  maxArtifactBytes: limitValue.optional(),
  maxCheckpointBytes: limitValue.optional(),
  sandbox: runSandboxUsageLimitsSchema.optional(),
};

export const runLimitsSchema: z.ZodType<RunLimits> =
  z.strictObject(runLimitsShape);

/**
 * Durable usage of one run across its attempts, carried by every checkpoint.
 * Limits are checked against it.
 */
export interface RunLedger {
  /** Model tokens reported in the run's transcript, less inherited ones. */
  tokens: number;
  /** Active execution time summed across attempts. */
  activeMs: number;
  /** Estimated cost adapters reported, less inherited cost. */
  estimatedCost?: number;
  /** The step execution that is running, with its tokens and active time. */
  step?: { key: string; tokens: number; activeMs: number };
  /** Recoveries so far: resumes after a failure, interruption, takeover, or error block. */
  recoveries?: number;
  artifacts: { count: number; bytes: number };
  /** Cumulative run-sandbox usage. */
  sandbox?: { commands: number; seconds: number };
  /**
   * The sequence of the latest checkpoint that recorded progress. Copies the
   * runtime commits to make facts durable (a resume, a block) do not move it.
   */
  progress?: number;
  /** Consecutive resumes that made no progress, and the progress point they resumed. */
  stalledResumes?: { count: number; sequence: number };
  /** Limits granted through `RunRequest.limits`; they apply to later attempts too. */
  granted?: RunLimits;
  /**
   * For a run seeded from another run's checkpoint: the usage its inherited
   * transcript and artifacts represent, which does not count against this
   * run's limits.
   */
  inherited?: {
    tokens: number;
    estimatedCost?: number;
    artifacts: { count: number; bytes: number };
  };
  /**
   * Present on the checkpoint committed when the run was blocked (suspended
   * with kind `awaiting-host`): why, so a host can act on it.
   */
  blocked?: RunBlocked;
}

/** Why a run is waiting for its host: a limit was reached, or an error occurred. */
export interface RunBlocked {
  cause: "limit" | "error";
  /** The limit name (for example `maxTotalTokens`) or the error code. */
  code: string;
  message: string;
  /** For limits: usage and the limit value when the run was blocked. */
  used?: number;
  value?: number;
  /** For errors: whether retrying may succeed, and classified details. */
  retryable?: boolean;
  details?: JsonObject;
  stepId?: string;
  at: string;
}

export const runLedgerSchema: z.ZodType<RunLedger> = z.strictObject({
  tokens: z.number().int().nonnegative().safe(),
  activeMs: z.number().nonnegative(),
  estimatedCost: z.number().nonnegative().optional(),
  step: z
    .strictObject({
      key: z.string().min(1),
      tokens: z.number().int().nonnegative().safe(),
      activeMs: z.number().nonnegative(),
    })
    .optional(),
  recoveries: z.number().int().nonnegative().optional(),
  artifacts: z.strictObject({
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().safe(),
  }),
  sandbox: z
    .strictObject({
      commands: z.number().int().nonnegative(),
      seconds: z.number().nonnegative(),
    })
    .optional(),
  progress: z.number().int().positive().safe().optional(),
  stalledResumes: z
    .strictObject({
      count: z.number().int().nonnegative(),
      sequence: z.number().int().positive(),
    })
    .optional(),
  granted: z.lazy(() => runLimitsSchema).optional(),
  inherited: z
    .strictObject({
      tokens: z.number().int().nonnegative().safe(),
      estimatedCost: z.number().nonnegative().optional(),
      artifacts: z.strictObject({
        count: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative().safe(),
      }),
    })
    .optional(),
  blocked: z
    .strictObject({
      cause: z.enum(["limit", "error"]),
      code: z.string().min(1),
      message: z.string(),
      used: z.number().nonnegative().optional(),
      value: z.number().nonnegative().optional(),
      retryable: z.boolean().optional(),
      details: jsonObjectSchema.optional(),
      stepId: z.string().optional(),
      at: z.iso.datetime({ offset: true }),
    })
    .optional(),
});

const validateSiblingStepIds = (
  steps: AgentStep[],
  context: z.RefinementCtx,
  path: Array<string | number>,
): void => {
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    if (seen.has(step.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate sibling step id: ${step.id}`,
        path: [...path, index, "id"],
      });
    }
    seen.add(step.id);
    if (step.type === "loop") {
      validateSiblingStepIds(step.steps, context, [...path, index, "steps"]);
    }
  });
};

const validateCodeStepWorkspaces = (
  steps: AgentStep[],
  workspaceAliases: ReadonlySet<string>,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void => {
  steps.forEach((step, index) => {
    if (step.type === "loop") {
      validateCodeStepWorkspaces(step.steps, workspaceAliases, context, [
        ...path,
        index,
        "steps",
      ]);
      return;
    }
    if (step.type !== "code") return;
    if (step.sandbox === "step" && (step.workspaces?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        message: `Code step ${step.id} cannot mount workspaces in a per-step sandbox; use sandbox: run.`,
        path: [...path, index, "sandbox"],
      });
    }
    const seen = new Set<string>();
    (step.workspaces ?? []).forEach((alias, aliasIndex) => {
      if (!workspaceAliases.has(alias)) {
        context.addIssue({
          code: "custom",
          message: `Code step ${step.id} references an undeclared workspace alias: ${alias}`,
          path: [...path, index, "workspaces", aliasIndex],
        });
      }
      if (seen.has(alias)) {
        context.addIssue({
          code: "custom",
          message: `Code step ${step.id} lists workspace ${alias} more than once`,
          path: [...path, index, "workspaces", aliasIndex],
        });
      }
      seen.add(alias);
    });
  });
};

const validateStepPolicies = (
  steps: AgentStep[],
  context: z.RefinementCtx,
  path: Array<string | number>,
): void => {
  steps.forEach((step, index) => {
    if (step.type === "loop") {
      validateStepPolicies(step.steps, context, [...path, index, "steps"]);
    }
    if (step.policies?.onFailure !== undefined) {
      context.addIssue({
        code: "custom",
        message: `policies.onFailure applies to the whole run; set it in the manifest's policies, not on step ${step.id}.`,
        path: [...path, index, "policies", "onFailure"],
      });
    }
    if (step.type === "prompt" || !step.policies) return;
    for (const field of PROMPT_ONLY_POLICY_FIELDS) {
      if (step.policies[field] !== undefined) {
        context.addIssue({
          code: "custom",
          message: `policies.${field} applies only to prompt steps; ${step.type} step ${step.id} cannot set it.`,
          path: [...path, index, "policies", field],
        });
      }
    }
  });
};

export const agentMessagesDeclarationSchema: z.ZodType<AgentMessagesDeclaration> =
  z.strictObject({
    required: z.boolean().optional(),
    description: z.string().optional(),
    maxMessages: z.number().int().min(2).optional(),
    maxBytes: z.number().int().min(1024).optional(),
    requireSignature: z.boolean().optional(),
    context: contextPolicySchema
      .refine(
        (policy) => policy.trigger === undefined,
        "messages.context cannot set trigger; maxMessages and maxBytes are the history's compaction triggers.",
      )
      .optional(),
    markers: z
      .strictObject({
        summary: z.string().min(1).optional(),
        note: z.string().min(1).optional(),
      })
      .optional(),
    metadata: jsonObjectSchema.optional(),
  });

const isReservedMessagesName = (value: string | undefined): boolean =>
  value != null &&
  (value.split(".")[0] ?? "").trim().toLowerCase() === MESSAGES_VARIABLE;

/**
 * `history` requires a `messages` declaration, `history.insert` applies only
 * to prompt steps, and a declaring manifest reserves the `messages` name.
 */
const validateStepHistory = (
  steps: AgentStep[],
  declared: boolean,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void => {
  steps.forEach((step, index) => {
    const stepPath = [...path, index];
    if (step.history !== undefined && !declared) {
      context.addIssue({
        code: "custom",
        message: `Step ${step.id} sets history, but the manifest does not declare messages.`,
        path: [...stepPath, "history"],
      });
    }
    if (
      step.history !== undefined &&
      step.history !== "all" &&
      step.history.insert !== undefined &&
      step.type !== "prompt"
    ) {
      context.addIssue({
        code: "custom",
        message: `history.insert applies only to prompt steps; ${step.type} step ${step.id} cannot set it.`,
        path: [...stepPath, "history", "insert"],
      });
    }
    if (declared && isReservedMessagesName(step.outputVariable)) {
      context.addIssue({
        code: "custom",
        message: `Step ${step.id} cannot write the reserved messages variable.`,
        path: [...stepPath, "outputVariable"],
      });
    }
    if (step.type === "loop") {
      if (declared) {
        for (const field of [
          "itemVariable",
          "indexVariable",
          "resultVariable",
        ] as const) {
          if (isReservedMessagesName(step.loop[field])) {
            context.addIssue({
              code: "custom",
              message: `Loop step ${step.id} cannot write the reserved messages variable.`,
              path: [...stepPath, "loop", field],
            });
          }
        }
      }
      validateStepHistory(step.steps, declared, context, [
        ...stepPath,
        "steps",
      ]);
    }
  });
};

const MAXIMUM_AGENT_MANIFEST_STRUCTURE_DEPTH = 128;
const MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES = 100_000;

const agentManifestStructureIssue = (input: unknown): string | undefined => {
  const ancestors = new WeakSet<object>();
  const stack: Array<{
    value: unknown;
    depth: number;
    exiting: boolean;
  }> = [{ value: input, depth: 0, exiting: false }];
  let nodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exiting) {
      ancestors.delete(frame.value as object);
      continue;
    }

    nodes += 1;
    if (nodes > MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES) {
      return `Agent manifest exceeds the ${MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES}-node structure limit.`;
    }
    if (frame.depth > MAXIMUM_AGENT_MANIFEST_STRUCTURE_DEPTH) {
      return `Agent manifest exceeds the ${MAXIMUM_AGENT_MANIFEST_STRUCTURE_DEPTH}-level manifest structure depth limit.`;
    }
    if (frame.value == null || typeof frame.value !== "object") continue;
    if (ancestors.has(frame.value)) {
      return "Agent manifest cannot contain cyclic data.";
    }

    const children = Array.isArray(frame.value)
      ? frame.value
      : Object.values(frame.value);
    if (nodes + children.length > MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES) {
      return `Agent manifest exceeds the ${MAXIMUM_AGENT_MANIFEST_STRUCTURE_NODES}-node structure limit.`;
    }
    ancestors.add(frame.value);
    stack.push({ ...frame, exiting: true });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        value: children[index],
        depth: frame.depth + 1,
        exiting: false,
      });
    }
  }

  return undefined;
};

const agentManifestObjectSchema: z.ZodType<AgentManifest> = z
  .object({
    schemaVersion: z.literal(AGENT_MANIFEST_SCHEMA_VERSION),
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    model: modelReferenceSchema.optional(),
    variables: z.array(agentVariableDefinitionSchema).optional(),
    connections: z.array(agentConnectionBindingSchema).optional(),
    workspaces: z.array(agentWorkspaceBindingSchema).optional(),
    messages: agentMessagesDeclarationSchema.optional(),
    steps: z.array(agentStepSchema),
    policies: executionPoliciesSchema.optional(),
    limits: z
      .object({
        maxSteps: z.number().int().positive().optional(),
        maxMessagesPerPrompt: z.number().int().positive().optional(),
        maxInputBytes: z.number().int().positive().optional(),
        maxOutputBytes: z.number().int().positive().optional(),
        maxToolCallsPerIteration: z.number().int().positive().optional(),
        providerTimeoutMs: z.number().int().positive().optional(),
        ...runLimitsShape,
      })
      .strict()
      .optional(),
    metadata: jsonObjectSchema.optional(),
    extensions: jsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const connectionAliases = new Set<string>();
    manifest.connections?.forEach((connection, index) => {
      const alias = connection.alias ?? connection.ref;
      if (connectionAliases.has(alias)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate connection alias: ${alias}`,
          path: ["connections", index, "alias"],
        });
      }
      connectionAliases.add(alias);
    });
    const workspaceAliases = new Set<string>();
    manifest.workspaces?.forEach((workspace, index) => {
      const alias = workspace.alias ?? workspace.ref;
      if (workspaceAliases.has(alias)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate workspace alias: ${alias}`,
          path: ["workspaces", index, "alias"],
        });
      } else if (connectionAliases.has(alias)) {
        context.addIssue({
          code: "custom",
          message: `Workspace alias collides with a connection alias: ${alias}`,
          path: ["workspaces", index, "alias"],
        });
      }
      workspaceAliases.add(alias);
    });
    validateSiblingStepIds(manifest.steps, context, ["steps"]);
    validateStepPolicies(manifest.steps, context, ["steps"]);
    validateCodeStepWorkspaces(manifest.steps, workspaceAliases, context, [
      "steps",
    ]);
    validateStepHistory(manifest.steps, manifest.messages != null, context, [
      "steps",
    ]);

    const variableKeys = new Set<string>();
    manifest.variables?.forEach((definition, index) => {
      const normalizedKey = definition.key.toLowerCase();
      if (manifest.messages != null && normalizedKey === MESSAGES_VARIABLE) {
        context.addIssue({
          code: "custom",
          message:
            "The messages variable is reserved in a manifest that declares messages.",
          path: ["variables", index, "key"],
        });
      }
      if (variableKeys.has(normalizedKey)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate agent variable: ${definition.key}`,
          path: ["variables", index, "key"],
        });
      }
      variableKeys.add(normalizedKey);
    });
  });

export const agentManifestSchema: z.ZodType<AgentManifest> = z.preprocess(
  (input, context) => {
    const issue = agentManifestStructureIssue(input);
    if (issue) {
      context.addIssue({ code: "custom", message: issue, fatal: true });
    }
    return input;
  },
  agentManifestObjectSchema,
) as z.ZodType<AgentManifest>;

export interface AgentRunManifest {
  schemaVersion: typeof AGENT_RUN_MANIFEST_SCHEMA_VERSION;
  agent: {
    ref: string;
  };
  runId?: string;
  variables?: AgentVariableOverride[];
  execution?: AgentRunExecution;
  budget?: AgentRunBudget;
  /** Conversation history for an agent that declares `messages`. */
  messages?: ConversationMessageInput[];
  /** The runtime's signature over a leading prefix of `messages`. */
  messagesSignature?: MessagesSignature;
}

export interface AgentRunBudget {
  /** Cumulative reported model tokens allowed across all run attempts. */
  maxTotalTokens: number;
}

export interface RunBudgetState extends AgentRunBudget {
  consumedTokens: number;
}

export const agentRunBudgetSchema: z.ZodType<AgentRunBudget> = z.strictObject({
  maxTotalTokens: z.number().int().positive().safe(),
});

export const runBudgetStateSchema: z.ZodType<RunBudgetState> = z.strictObject({
  maxTotalTokens: z.number().int().positive().safe(),
  consumedTokens: z.number().int().nonnegative().safe(),
});

export const AGENT_RUN_EXECUTION_MODES = ["sequential", "parallel"] as const;
export type AgentRunExecutionMode = (typeof AGENT_RUN_EXECUTION_MODES)[number];

export interface AgentRunExecution {
  mode: AgentRunExecutionMode;
  maxConcurrency?: number;
}

export const agentRunExecutionSchema: z.ZodType<AgentRunExecution> =
  z.strictObject({
    mode: z.enum(AGENT_RUN_EXECUTION_MODES),
    maxConcurrency: z.number().int().min(1).max(64).optional(),
  });

export const agentRunManifestSchema: z.ZodType<AgentRunManifest> =
  z.strictObject({
    schemaVersion: z.literal(AGENT_RUN_MANIFEST_SCHEMA_VERSION),
    agent: z.strictObject({
      ref: z.string().trim().min(1),
    }),
    runId: z.string().trim().min(1).optional(),
    variables: agentVariableOverridesSchema.optional(),
    execution: agentRunExecutionSchema.optional(),
    budget: agentRunBudgetSchema.optional(),
    messages: z.lazy(() => conversationMessagesInputSchema).optional(),
    messagesSignature: z.lazy(() => messagesSignatureSchema).optional(),
  }) as unknown as z.ZodType<AgentRunManifest>;

export interface ExecutionCursor {
  stepIndex: number;
  stepId?: string;
  stepPath?: string;
  loopIteration?: number;
  childIndex?: number;
}

export interface StepResult {
  stepId: string;
  stepIndex: number;
  status: "completed";
  output?: JsonValue;
  variables?: VariableState;
  transcript?: TranscriptItem[];
  artifacts?: ArtifactRef[];
  usage?: ModelUsage;
  completedAt: string;
  metadata?: JsonObject;
}

export interface RunCheckpoint {
  id: string;
  runId: string;
  sequence: number;
  /** Execution attempt that produced this checkpoint. Defaults to 1 for legacy data. */
  attempt?: number;
  manifestHash: string;
  contractVersion: string;
  runtimeVersion: string;
  cursor: ExecutionCursor;
  state: VariableState;
  stepResults: StepResult[];
  transcript: TranscriptItem[];
  artifacts: ArtifactRef[];
  /** Cumulative content produced by the currently active nested step. */
  activeStepTranscript?: TranscriptItem[];
  activeStepArtifacts?: ArtifactRef[];
  /** Executor-owned, JSON-safe continuation data for an active nested step. */
  continuation?: JsonObject;
  /** Cumulative model-token usage and the effective limit for this run. */
  budget?: RunBudgetState;
  /** The run's effective conversation history, when the manifest declares messages. */
  messages?: RunMessagesState;
  /** Durable usage across attempts (contract 1.1). */
  ledger?: RunLedger;
  /**
   * Per workspace alias: the opaque token the workspace store returned at the
   * latest step commit point, handed back when a run restarts from here.
   */
  workspaces?: Record<string, RunCheckpointWorkspace>;
  /** Per read-only workspace alias: the input version token at run start. */
  inputs?: Record<string, { token: string }>;
  /** Fingerprints that decide which manifest changes a resume may accept. */
  fingerprints?: RunCheckpointFingerprints;
  /** Present on a checkpoint committed when a step completed: a restart point. */
  boundary?: RunCheckpointBoundary;
  createdAt: string;
  metadata?: JsonObject;
}

/** Checkpoint contract versions this release reads; it writes the latest. */
export const RUN_CHECKPOINT_CONTRACT_VERSIONS = ["1.0", "1.1"] as const;
export const RUN_CHECKPOINT_CONTRACT_VERSION = "1.1" as const;

/** One file change copied back to a workspace store. */
export interface WorkspaceChange {
  path: string;
  action: "created" | "modified" | "deleted";
  size?: number;
  sha256?: string;
}

export interface RunCheckpointWorkspace {
  /** The opaque token the store returned at the latest step commit point. */
  token?: string;
  /** The step whose completion produced the token. */
  stepPath?: string;
  /** The checkpoint that first recorded the token. */
  sequence?: number;
  /** Changes copied back since that commit point, for the next one. */
  pending?: WorkspaceChange[];
}

export interface RunCheckpointFingerprints {
  /** Manifest-wide fields that completed steps depend on. */
  global: string;
  /** One per top-level step, in manifest order. */
  steps: string[];
}

export interface RunCheckpointBoundary {
  /** The step that completed: a top-level step id, or a nested step path. */
  stepPath: string;
  stepIndex: number;
  /** The completed execution, for example `each[2]/fetch`. */
  executionKey?: string;
}

export interface RunError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
  stack?: string;
}

export const artifactRefSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  uri: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
  metadata: jsonObjectSchema.optional(),
});

export const modelUsageSchema = z.strictObject({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  estimatedCost: z.number().nonnegative().optional(),
  metadata: jsonObjectSchema.optional(),
});

export const runErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: jsonObjectSchema.optional(),
  stack: z.string().optional(),
});

const toolCallSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonObjectSchema,
  stepId: z.string().optional(),
  providerExecuted: z.boolean().optional(),
  metadata: jsonObjectSchema.optional(),
});

const toolResultSchema = z.strictObject({
  callId: z.string().min(1),
  name: z.string().min(1),
  output: jsonValueSchema.optional(),
  error: runErrorSchema.optional(),
  artifacts: z.array(artifactRefSchema).optional(),
  metadata: jsonObjectSchema.optional(),
});

const contentPartMetadataShape = {
  metadata: jsonObjectSchema.optional(),
  providerOptions: jsonObjectSchema.optional(),
};

const mediaSourceSchema = {
  artifact: artifactRefSchema.optional(),
  url: z.string().min(1).optional(),
  data: z.string().min(1).optional(),
};

const contentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: z.string(),
    ...contentPartMetadataShape,
  }),
  z.strictObject({
    type: z.literal("reasoning"),
    text: z.string().optional(),
    encrypted: z.string().optional(),
    ...contentPartMetadataShape,
  }),
  z.strictObject({
    type: z.literal("json"),
    value: jsonValueSchema,
    ...contentPartMetadataShape,
  }),
  z.strictObject({
    type: z.literal("image"),
    ...mediaSourceSchema,
    mediaType: z.string().min(1).optional(),
    ...contentPartMetadataShape,
  }),
  z.strictObject({
    type: z.literal("file"),
    ...mediaSourceSchema,
    name: z.string().min(1).optional(),
    mediaType: z.string().min(1).optional(),
    ...contentPartMetadataShape,
  }),
  z.strictObject({
    type: z.literal("tool-call"),
    call: toolCallSchema,
    ...contentPartMetadataShape,
  }),
  z.strictObject({
    type: z.literal("tool-result"),
    result: toolResultSchema,
    ...contentPartMetadataShape,
  }),
]);

const conversationContentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: z.string(),
    metadata: jsonObjectSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("json"),
    value: jsonValueSchema,
    metadata: jsonObjectSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("image"),
    ...mediaSourceSchema,
    mediaType: z.string().min(1).optional(),
    metadata: jsonObjectSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("file"),
    ...mediaSourceSchema,
    name: z.string().min(1).optional(),
    mediaType: z.string().min(1).optional(),
    metadata: jsonObjectSchema.optional(),
  }),
]);

const messagesMarkerSchema = z.strictObject({
  kind: z.enum(["summary", "note"]),
  replaces: z.number().int().nonnegative().safe(),
  turns: z.number().int().nonnegative().safe().optional(),
  sequence: z.number().int().positive().safe(),
  strategy: z.enum(["summarize", "prune"]),
});

/** Reads a leading marker from message metadata; undefined when there is none. */
export const messagesMarkerOf = (
  message: ConversationMessage | undefined,
): MessagesMarker | undefined => {
  const runtime = message?.metadata?.agentRuntime;
  if (runtime == null || typeof runtime !== "object" || Array.isArray(runtime))
    return undefined;
  const parsed = messagesMarkerSchema.safeParse(runtime.messages);
  return parsed.success ? parsed.data : undefined;
};

const conversationMessageObjectSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.array(conversationContentPartSchema).min(1),
  metadata: jsonObjectSchema.optional(),
});

const normalizeConversationMessage = (input: unknown): unknown =>
  input != null &&
  typeof input === "object" &&
  !Array.isArray(input) &&
  typeof (input as { content?: unknown }).content === "string"
    ? {
        ...input,
        content: [
          { type: "text", text: (input as { content: string }).content },
        ],
      }
    : input;

const validateConversationMessages = (
  messages: ConversationMessage[],
  context: z.RefinementCtx,
): void => {
  messages.forEach((message, messageIndex) => {
    const runtime = message.metadata?.agentRuntime;
    if (runtime !== undefined) {
      if (messageIndex > 0) {
        context.addIssue({
          code: "custom",
          path: [messageIndex, "metadata", "agentRuntime"],
          message:
            "metadata.agentRuntime is reserved for the runtime marker, which may only be the first message.",
        });
      } else if (
        runtime == null ||
        typeof runtime !== "object" ||
        Array.isArray(runtime) ||
        Object.keys(runtime).some((key) => key !== "messages") ||
        !messagesMarkerSchema.safeParse(runtime.messages).success
      ) {
        context.addIssue({
          code: "custom",
          path: [messageIndex, "metadata", "agentRuntime"],
          message: "metadata.agentRuntime is not a valid runtime marker.",
        });
      }
    }
    message.content.forEach((part, partIndex) => {
      if (part.type !== "image" && part.type !== "file") return;
      const sourceCount = [part.artifact, part.url, part.data].filter(
        (value) => value !== undefined,
      ).length;
      if (sourceCount !== 1) {
        context.addIssue({
          code: "custom",
          path: [messageIndex, "content", partIndex],
          message:
            "Message media parts require exactly one of artifact, url, or data.",
        });
      }
      if (
        part.type === "file" &&
        part.artifact == null &&
        part.mediaType == null
      ) {
        context.addIssue({
          code: "custom",
          path: [messageIndex, "content", partIndex, "mediaType"],
          message:
            "Message file parts without an artifact reference require mediaType.",
        });
      }
      if (part.data !== undefined && part.mediaType == null) {
        context.addIssue({
          code: "custom",
          path: [messageIndex, "content", partIndex, "mediaType"],
          message: "Message media parts with inline data require mediaType.",
        });
      }
    });
  });
};

/** A normalized conversation history: full content-part form only. */
export const conversationMessagesSchema: z.ZodType<ConversationMessage[]> = z
  .array(conversationMessageObjectSchema)
  .superRefine(validateConversationMessages) as z.ZodType<
  ConversationMessage[]
>;

/** A supplied conversation history; string content is normalized to one text part. */
export const conversationMessagesInputSchema: z.ZodType<ConversationMessage[]> =
  z
    .array(
      z.preprocess(
        normalizeConversationMessage,
        conversationMessageObjectSchema,
      ),
    )
    .superRefine(validateConversationMessages) as z.ZodType<
    ConversationMessage[]
  >;

export const messagesSignatureSchema: z.ZodType<MessagesSignature> =
  z.strictObject({
    version: z.literal(MESSAGES_SIGNATURE_VERSION),
    algorithm: z.literal(MESSAGES_SIGNATURE_ALGORITHM),
    keyId: z.string().min(1).max(200),
    count: z.number().int().nonnegative().safe(),
    value: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/u, "Signature value must be base64url."),
  });

export const runMessagesStateSchema: z.ZodType<RunMessagesState> =
  z.strictObject({
    history: conversationMessagesSchema,
    compaction: z.enum(["pending", "complete"]),
    signedCount: z.number().int().nonnegative().safe(),
    scope: z.string().optional(),
    journal: jsonObjectSchema.optional(),
  });

/** Parse and normalize a supplied conversation history. */
export const parseConversationMessages = (
  input: unknown,
): ConversationMessage[] => conversationMessagesInputSchema.parse(input);

export const transcriptItemSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum([
    "message",
    "reasoning",
    "tool-call",
    "tool-result",
    "artifact",
    "error",
  ]),
  role: z.enum(["system", "user", "assistant", "tool"]).optional(),
  content: z.array(contentPartSchema),
  createdAt: z.iso.datetime({ offset: true }),
  model: z.string().optional(),
  usage: modelUsageSchema.optional(),
  metadata: jsonObjectSchema.optional(),
  providerOptions: jsonObjectSchema.optional(),
});

const executionCursorSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  stepId: z.string().optional(),
  stepPath: z.string().optional(),
  loopIteration: z.number().int().nonnegative().optional(),
  childIndex: z.number().int().nonnegative().optional(),
});

export const stepResultSchema = z.strictObject({
  stepId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  status: z.literal("completed"),
  output: jsonValueSchema.optional(),
  variables: variableStateSchema.optional(),
  transcript: z.array(transcriptItemSchema).optional(),
  artifacts: z.array(artifactRefSchema).optional(),
  usage: modelUsageSchema.optional(),
  completedAt: z.iso.datetime({ offset: true }),
  metadata: jsonObjectSchema.optional(),
});

export const runCheckpointSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive().safe(),
  attempt: z.number().int().positive().safe().optional(),
  manifestHash: z.string().min(1),
  contractVersion: z.string().min(1),
  runtimeVersion: z.string().min(1),
  cursor: executionCursorSchema,
  state: variableStateSchema,
  stepResults: z.array(stepResultSchema),
  transcript: z.array(transcriptItemSchema),
  artifacts: z.array(artifactRefSchema),
  activeStepTranscript: z.array(transcriptItemSchema).optional(),
  activeStepArtifacts: z.array(artifactRefSchema).optional(),
  continuation: jsonObjectSchema.optional(),
  budget: runBudgetStateSchema.optional(),
  messages: z.lazy(() => runMessagesStateSchema).optional(),
  ledger: runLedgerSchema.optional(),
  workspaces: z
    .record(
      z.string().min(1),
      z.strictObject({
        token: z.string().min(1).optional(),
        stepPath: z.string().min(1).optional(),
        sequence: z.number().int().positive().safe().optional(),
        pending: z
          .array(
            z.strictObject({
              path: z.string().min(1),
              action: z.enum(["created", "modified", "deleted"]),
              size: z.number().int().nonnegative().optional(),
              sha256: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  inputs: z
    .record(z.string().min(1), z.strictObject({ token: z.string().min(1) }))
    .optional(),
  fingerprints: z
    .strictObject({
      global: z.string().min(1),
      steps: z.array(z.string().min(1)),
    })
    .optional(),
  boundary: z
    .strictObject({
      stepPath: z.string().min(1),
      stepIndex: z.number().int().nonnegative(),
      executionKey: z.string().min(1).optional(),
    })
    .optional(),
  createdAt: z.iso.datetime({ offset: true }),
  metadata: jsonObjectSchema.optional(),
});

export const parseRunCheckpoint = (input: unknown): RunCheckpoint =>
  runCheckpointSchema.parse(input) as RunCheckpoint;

export type RunEventType =
  | "run.started"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.suspended"
  | "run.interrupted"
  | "run.heartbeat"
  | "step.started"
  | "step.skipped"
  | "step.completed"
  | "step.failed"
  | "checkpoint.saved"
  | "loop.iteration.started"
  | "loop.iteration.completed"
  | "loop.iteration.skipped"
  | "loop.goal.met"
  | "approval.requested"
  | "approval.resolved"
  | "webhook.attempt.started"
  | "webhook.attempt.completed"
  | "webhook.retry.scheduled"
  | "code.execution.started"
  | "code.execution.completed"
  | "workspace.bound"
  | "sandbox.opened"
  | "sandbox.command.started"
  | "sandbox.command.completed"
  | "sandbox.closed"
  | "workspace.committed"
  | "sub-run.started"
  | "sub-run.completed"
  | "model.started"
  | "model.text.delta"
  | "model.reasoning.delta"
  | "model.tool.requested"
  | "model.tool.started"
  | "model.tool.completed"
  | "model.usage"
  | "model.completed"
  | "model.retry"
  | "context.reduced"
  | "artifact.created"
  | "diagnostic";

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  /** Sequence numbers are monotonic within this atomically reserved attempt. */
  attempt?: number;
  timestamp: string;
  type: RunEventType | (string & {});
  stepId?: string;
  stepPath?: string;
  data?: JsonObject;
  payload?: JsonObject;
}

export interface RunResult {
  runId: string;
  output?: JsonValue;
  state: VariableState;
  stepResults: StepResult[];
  transcript: TranscriptItem[];
  artifacts: ArtifactRef[];
  usage?: ModelUsage;
  /**
   * The effective conversation history plus one assistant message containing
   * the final output. Present when the manifest declares messages.
   */
  messages?: ConversationMessage[];
  /** Present when the host configured a signer. Covers every message. */
  messagesSignature?: MessagesSignature;
  startedAt: string;
  completedAt: string;
  metadata?: JsonObject;
}

export const parseAgentManifest = (input: unknown): AgentManifest =>
  agentManifestSchema.parse(input);
export const safeParseAgentManifest = (input: unknown) =>
  agentManifestSchema.safeParse(input);
export const parseAgentRunManifest = (input: unknown): AgentRunManifest =>
  agentRunManifestSchema.parse(input);
export const safeParseAgentRunManifest = (input: unknown) =>
  agentRunManifestSchema.safeParse(input);
