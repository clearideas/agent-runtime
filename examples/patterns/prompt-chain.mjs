import { createAgentRuntime, defineAgent } from "@clearideas/agent-runtime";

const manifest = defineAgent({
  schemaVersion: "1.0",
  model: { provider: "openai", model: "gpt-5.6" },
  variables: [{ key: "topic", type: "string", requiresOverride: true }],
  steps: [
    {
      id: "draft",
      type: "prompt",
      prompt: "Draft a short release note about {{ topic }}.",
      outputVariable: "draft",
    },
    {
      id: "structure",
      type: "prompt",
      prompt: "Turn this draft into a title and summary: {{ draft }}",
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" }, summary: { type: "string" } },
        required: ["title", "summary"],
        additionalProperties: false,
      },
      includeInFinalOutput: true,
    },
  ],
});
let call = 0;
const runtime = createAgentRuntime({
  manifest,
  ...(process.argv.includes("--demo")
    ? {
        model: {
          generate: async () => ({
            output:
              call++ === 0
                ? "Checkpoints preserve progress."
                : {
                    title: "Durable checkpoints",
                    summary: "Resume work after an interruption.",
                  },
            transcript: [],
          }),
        },
      }
    : {}),
});
const result = await runtime.run({
  variables: [{ key: "topic", value: "durable checkpoints" }],
});
console.log(JSON.stringify(result.output, null, 2));
