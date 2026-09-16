import { createAgentRuntime, defineAgent } from "@clearideas/agent-runtime";

const manifest = defineAgent({
  schemaVersion: "1.0",
  model: { provider: "openai", model: "gpt-5.6" },
  steps: [
    {
      id: "lookup",
      type: "prompt",
      prompt:
        "Use lookup_release to find the current release. If it fails temporarily, try once more, then summarize the result.",
      includeInFinalOutput: true,
    },
  ],
});
let attempts = 0;
let modelCalls = 0;
const runtime = createAgentRuntime({
  manifest,
  // --demo substitutes only model decisions. The runtime executes real local tools.
  ...(process.argv.includes("--demo")
    ? {
        model: {
          generate: async () =>
            modelCalls++ < 2
              ? {
                  output: "",
                  transcript: [],
                  toolCalls: [
                    {
                      id: `lookup-${modelCalls}`,
                      name: "lookup_release",
                      input: {},
                    },
                  ],
                  finishReason: "tool-calls",
                }
              : {
                  output: "Release found after one temporary lookup failure.",
                  transcript: [],
                },
        },
      }
    : {}),
  tools: {
    listTools: async () => [
      {
        name: "lookup_release",
        description: "Look up the release announcement.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
    executeTool: async (call) => {
      // Simulate a transient read failure. Do not blindly repeat writes.
      if (attempts++ === 0)
        return {
          callId: call.id,
          name: call.name,
          error: {
            code: "LOOKUP_UNAVAILABLE",
            message: "Temporary failure; retry this read once.",
            retryable: true,
          },
        };
      return {
        callId: call.id,
        name: call.name,
        output: { title: "Durable checkpoints", status: "available" },
      };
    },
  },
  eventSinks: [
    {
      emit(event) {
        if (event.type.startsWith("model.tool."))
          console.error(event.type, event.stepId);
      },
    },
  ],
});
console.log((await runtime.run({})).output);
