/**
 * The supported subset of the OpenAI Chat Completions API: request
 * validation and response construction. Unknown request fields are accepted
 * and ignored, as OpenAI-compatible servers conventionally do; fields that
 * would change what a run may do are refused.
 */
import type { ModelUsage } from "@clearideas/agent-runtime-contracts";
import { z } from "zod";

import { invalidRequest } from "./errors.js";

const textPartSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});
const imagePartSchema = z.looseObject({
  type: z.literal("image_url"),
  image_url: z.looseObject({ url: z.string().min(1) }),
});
const filePartSchema = z.looseObject({
  type: z.literal("file"),
  file: z.looseObject({
    file_data: z.string().min(1).optional(),
    file_id: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
  }),
});
const refusalPartSchema = z.looseObject({
  type: z.literal("refusal"),
  refusal: z.string(),
});
const otherPartSchema = z.looseObject({ type: z.string() });

export type OpenAiContentPart =
  | z.infer<typeof textPartSchema>
  | z.infer<typeof imagePartSchema>
  | z.infer<typeof filePartSchema>
  | z.infer<typeof refusalPartSchema>
  | z.infer<typeof otherPartSchema>;

const contentPartSchema: z.ZodType<OpenAiContentPart> = z.union([
  textPartSchema,
  imagePartSchema,
  filePartSchema,
  refusalPartSchema,
  otherPartSchema,
]);

export const chatMessageSchema = z.looseObject({
  role: z.enum([
    "system",
    "developer",
    "user",
    "assistant",
    "tool",
    "function",
  ]),
  content: z
    .union([z.string(), z.array(contentPartSchema), z.null()])
    .optional(),
  name: z.string().optional(),
  refusal: z.string().nullable().optional(),
  tool_calls: z.array(z.unknown()).nullable().optional(),
  function_call: z.unknown().optional(),
  tool_call_id: z.string().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

const responseFormatSchema = z.union([
  z.looseObject({ type: z.literal("text") }),
  z.looseObject({ type: z.literal("json_object") }),
  z.looseObject({
    type: z.literal("json_schema"),
    json_schema: z.looseObject({
      name: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

export const chatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().nullable().optional(),
  stream_options: z
    .looseObject({ include_usage: z.boolean().optional() })
    .nullable()
    .optional(),
  user: z.string().max(256).optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  response_format: responseFormatSchema.nullable().optional(),
  n: z.number().int().positive().nullable().optional(),
  tools: z.array(z.unknown()).nullable().optional(),
  functions: z.array(z.unknown()).nullable().optional(),
  tool_choice: z.unknown().optional(),
  logprobs: z.boolean().nullable().optional(),
  top_logprobs: z.number().int().nullable().optional(),
  audio: z.unknown().optional(),
  modalities: z.array(z.string()).nullable().optional(),
  /** Extension: values for variables the operator mapped with source `client`. */
  variables: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

/**
 * Validate a request body and refuse parameters the server does not honor.
 * Client tools are never used: with `ignore` they are dropped, with `reject`
 * they are refused.
 */
export const parseChatCompletionRequest = (
  body: unknown,
  clientTools: "ignore" | "reject" = "reject",
): ChatCompletionRequest => {
  const parsed = chatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidRequest(
      `Invalid request: ${issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "malformed body"}.`,
      issue?.path.length ? String(issue.path[0]) : undefined,
    );
  }
  const request = parsed.data;
  if (clientTools === "reject") {
    if (
      (request.tools?.length ?? 0) > 0 ||
      (request.functions?.length ?? 0) > 0
    )
      throw invalidRequest(
        "Client-defined tools are not supported. The served agent's tools are configured by the host.",
        request.tools?.length ? "tools" : "functions",
      );
    if (
      request.tool_choice != null &&
      request.tool_choice !== "none" &&
      request.tool_choice !== "auto"
    )
      throw invalidRequest(
        "tool_choice is not supported: the served agent's tools are configured by the host.",
        "tool_choice",
      );
  }
  if ((request.n ?? 1) > 1)
    throw invalidRequest("Only n = 1 is supported.", "n");
  if (request.logprobs === true)
    throw invalidRequest("logprobs are not supported.", "logprobs");
  if (request.audio != null || request.modalities?.includes("audio"))
    throw invalidRequest("Audio output is not supported.", "modalities");
  return request;
};

/** True when the request carries client tool definitions. */
export const hasClientTools = (request: ChatCompletionRequest): boolean =>
  (request.tools?.length ?? 0) > 0 || (request.functions?.length ?? 0) > 0;

/** OpenAI usage, from the run's aggregated model usage. */
export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

export const toOpenAiUsage = (usage: ModelUsage | undefined): OpenAiUsage => {
  const prompt = usage?.inputTokens ?? 0;
  const completion = usage?.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage?.totalTokens ?? prompt + completion,
    ...(usage?.cachedInputTokens != null
      ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
    ...(usage?.reasoningTokens != null
      ? {
          completion_tokens_details: {
            reasoning_tokens: usage.reasoningTokens,
          },
        }
      : {}),
  };
};

export type FinishReason = "stop" | "length";

export interface CompletionIdentity {
  id: string;
  created: number;
  model: string;
  systemFingerprint: string;
}

export const chatCompletion = (
  identity: CompletionIdentity,
  content: string,
  finishReason: FinishReason,
  usage: OpenAiUsage,
) => ({
  id: identity.id,
  object: "chat.completion" as const,
  created: identity.created,
  model: identity.model,
  system_fingerprint: identity.systemFingerprint,
  choices: [
    {
      index: 0,
      message: { role: "assistant" as const, content, refusal: null },
      logprobs: null,
      finish_reason: finishReason,
    },
  ],
  usage,
});

export interface ChunkDelta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
}

export const chatCompletionChunk = (
  identity: CompletionIdentity,
  delta: ChunkDelta,
  finishReason: FinishReason | null = null,
) => ({
  id: identity.id,
  object: "chat.completion.chunk" as const,
  created: identity.created,
  model: identity.model,
  system_fingerprint: identity.systemFingerprint,
  choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
});

export const usageChunk = (
  identity: CompletionIdentity,
  usage: OpenAiUsage,
) => ({
  id: identity.id,
  object: "chat.completion.chunk" as const,
  created: identity.created,
  model: identity.model,
  system_fingerprint: identity.systemFingerprint,
  choices: [],
  usage,
});

export const modelObject = (
  name: string,
  created: number,
  description?: string,
) => ({
  id: name,
  object: "model" as const,
  created,
  owned_by: "agent-runtime",
  ...(description ? { description } : {}),
});
