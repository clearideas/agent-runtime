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
export const SUMMARY_KINDS = ["input", "transcript", "tool-result"] as const;
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
}

export interface AgentStepBase {
  id: string;
  name?: string;
  description?: string;
  when?: string;
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
  });

/** Policy fields that only a prompt step can use. */
export const PROMPT_ONLY_POLICY_FIELDS = [
  "context",
  "toolCallLimit",
  "modelRetry",
  "outputRepair",
] as const;

const stepBaseShape = {
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  when: z.string().optional(),
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
        if (usesLegacyPrompt === usesMessages) {
          context.addIssue({
            code: "custom",
            message: "Prompt steps require exactly one of prompt or messages.",
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
  steps: AgentStep[];
  /** Manifest-wide execution policy defaults; steps may override them. */
  policies?: ExecutionPolicies;
  limits?: {
    maxSteps?: number;
    maxMessagesPerPrompt?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
    /** Total tool calls per prompt step execution, across model turns and resumes. */
    maxToolCallsPerIteration?: number;
    providerTimeoutMs?: number;
  };
  metadata?: JsonObject;
  extensions?: JsonObject;
}

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

    const variableKeys = new Set<string>();
    manifest.variables?.forEach((definition, index) => {
      const normalizedKey = definition.key.toLowerCase();
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
  });

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
  createdAt: string;
  metadata?: JsonObject;
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
