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

export interface AgentStepBase {
  id: string;
  name?: string;
  description?: string;
  when?: string;
  outputVariable?: string;
  includeInFinalOutput?: boolean;
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
  action?: "pause" | "complete" | "cancel";
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
}

export type AgentStep =
  PromptStep | LoopStep | WebhookStep | ApprovalStep | SubRunStep | CodeStep;

const stepBaseShape = {
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  when: z.string().optional(),
  outputVariable: agentVariableKeySchema.optional(),
  includeInFinalOutput: z.boolean().optional(),
  metadata: jsonObjectSchema.optional(),
  extensions: jsonObjectSchema.optional(),
};

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

const agentConnectionBindingSchema = z.strictObject({
  ref: z.string().min(1),
  alias: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/u)
    .optional(),
  tools: z.array(z.string().min(1)).optional(),
  mode: z.enum(["read", "read_write"]).optional(),
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
  steps: AgentStep[];
  limits?: {
    maxSteps?: number;
    maxMessagesPerPrompt?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
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

export const agentManifestSchema: z.ZodType<AgentManifest> = z
  .object({
    schemaVersion: z.literal(AGENT_MANIFEST_SCHEMA_VERSION),
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    model: modelReferenceSchema.optional(),
    variables: z.array(agentVariableDefinitionSchema).optional(),
    connections: z.array(agentConnectionBindingSchema).optional(),
    steps: z.array(agentStepSchema),
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
    validateSiblingStepIds(manifest.steps, context, ["steps"]);

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

export interface AgentRunManifest {
  schemaVersion: typeof AGENT_RUN_MANIFEST_SCHEMA_VERSION;
  agent: {
    ref: string;
  };
  runId?: string;
  variables?: AgentVariableOverride[];
  execution?: AgentRunExecution;
}

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
