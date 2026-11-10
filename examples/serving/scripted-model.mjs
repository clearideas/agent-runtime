// A deterministic stand-in for a model provider, for trying the server
// without an API key:
//
//   npx agent-runtime serve support-chat.agent.yaml --runtime-module scripted-model.mjs
//
// It streams its replies word by word. The screening step treats messages
// that mention a password, the weather, or a joke as out of scope.

const textOf = (message) =>
  (message?.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .trim();

const lastUserText = (request) =>
  textOf(
    [...request.messages].reverse().find((message) => message.role === "user"),
  );

const reply = (request) => {
  if (request.outputSchema) {
    // The screening step sees the newest user message, then its own prompt.
    const userText = request.messages
      .filter((message) => message.role === "user")
      .map(textOf)
      .join(" ");
    const inScope = !/password|weather|joke/iu.test(userText);
    return {
      inScope,
      reason: inScope ? "A product question." : "Not about the product.",
    };
  }
  const system = textOf(
    request.messages.find((message) => message.role === "system"),
  );
  const asked = lastUserText(request);
  if (/can only help/iu.test(system)) {
    return `(scripted) I can only help with questions about the product. Try asking how to share a folder.`;
  }
  if (/briefs/iu.test(system)) {
    return `(scripted) Brief: ${asked.slice(0, 200)}`;
  }
  const earlier =
    request.messages.filter((message) => message.role !== "system").length - 1;
  return `(scripted) You asked: "${asked}". I can see ${earlier} earlier message(s) of this conversation.`;
};

const result = (output) => ({
  output,
  finishReason: "stop",
  transcript: [
    {
      id: crypto.randomUUID(),
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: typeof output === "string" ? output : JSON.stringify(output),
        },
      ],
      createdAt: new Date().toISOString(),
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    },
  ],
});

export const model = {
  generate: async (request) => result(reply(request)),
  async *stream(request) {
    const output = reply(request);
    if (typeof output === "string") {
      for (const word of output.split(/(?<= )/u)) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { type: "text-delta", delta: word };
      }
    }
    yield { type: "completed", result: result(output) };
  },
};
