/**
 * A small real-provider check used by `npm run doctor -- --live`.
 *
 * A plain text reply only proves the key works. The demos also need the
 * model to call tools and to return structured output, so this runs a
 * two-step agent that does both and reports each capability separately.
 * It makes three short model calls.
 */
import {
  createAgentRuntime,
  defineAgent,
  parseAgentRuntimeConfig,
  type ModelAdapter,
} from "@clearideas/agent-runtime";

const CODE = "AR-0600-OK";

export interface LiveCheckResult {
  ok: boolean;
  /** One line per capability, for the doctor's report. */
  lines: Array<{ ok: boolean; text: string }>;
  totalTokens?: number;
  /** The error message when a call failed outright. */
  error?: string;
}

export const checkLiveModel = async (options: {
  provider: string;
  model: string;
  /** Tests only: replaces the provider model. */
  modelAdapter?: ModelAdapter;
}): Promise<LiveCheckResult> => {
  const manifest = defineAgent({
    schemaVersion: "1.0",
    model: { ref: "default" },
    steps: [
      {
        id: "tool",
        type: "prompt",
        prompt:
          "Call the lookup_code tool once. Then reply with the code it returned and nothing else.",
        tools: ["lookup_code"],
        outputVariable: "reply",
      },
      {
        id: "structured",
        type: "prompt",
        prompt: "Text: {{ reply }}\n\nExtract the code from the text.",
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: { code: { type: "string" } },
        },
        outputVariable: "extracted",
        includeInFinalOutput: true,
      },
    ],
  });
  const config = parseAgentRuntimeConfig({
    version: "1.0",
    models: { default: { provider: options.provider, model: options.model } },
  });
  let toolCalls = 0;
  const runtime = createAgentRuntime({
    manifest,
    config,
    ...(options.modelAdapter ? { model: options.modelAdapter } : {}),
    tools: {
      listTools: async () => [
        {
          name: "lookup_code",
          description: "Returns the connection-check code.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      executeTool: async (call) => {
        toolCalls += 1;
        return { callId: call.id, name: call.name, output: { code: CODE } };
      },
    },
  });
  try {
    const result = await runtime.run({});
    const reply = String(result.state?.reply ?? "");
    const extracted = result.state?.extracted as { code?: unknown } | null;
    const lines = [
      {
        ok: toolCalls > 0 && reply.includes(CODE),
        text:
          toolCalls > 0
            ? `tool calls: called lookup_code and replied “${reply.trim().slice(0, 40)}”`
            : "tool calls: the model answered without calling the tool",
      },
      {
        ok:
          typeof extracted?.code === "string" && extracted.code.includes(CODE),
        text: `structured output: ${JSON.stringify(extracted).slice(0, 60)}`,
      },
    ];
    return {
      ok: lines.every((line) => line.ok),
      lines,
      ...(result.usage?.totalTokens
        ? { totalTokens: result.usage.totalTokens }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
