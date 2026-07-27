const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const messageText = (messages) =>
  messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const labelledValue = (prompt, label, fallback) =>
  prompt.match(new RegExp(`${label}:\\s*([^\\n]+)`, "i"))?.[1]?.trim() ||
  fallback;

const responseText = (request) => {
  const prompt = messageText(request.messages);
  if (prompt.includes("Gather the most useful context")) {
    return "The TypeScript MCP SDK provides StreamableHTTPClientTransport for remote connections.";
  }
  if (prompt.includes("Draft a brief")) {
    return "Use StreamableHTTPClientTransport to connect a TypeScript MCP client to a remote server.";
  }
  if (prompt.includes("Return three concise evidence points")) {
    return "- Remote transport is supported.\n- The SDK provides a TypeScript client.\n- Streamable HTTP is the current transport.";
  }
  if (prompt.includes("return two concise cautions")) {
    return "1. Confirm protocol compatibility.\n2. Keep credentials in server-side configuration.";
  }
  return (
    prompt
      .match(/Draft:\s*\n([\s\S]*?)\n\s*Optional risk review:/iu)?.[1]
      ?.trim() || "The brief is complete."
  );
};

const transcript = (text, usage) => ({
  id: crypto.randomUUID(),
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  createdAt: new Date().toISOString(),
  usage,
});

export class TestModelAdapter {
  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  async generate(request) {
    let completed;
    for await (const event of this.stream(request)) {
      if (event.type === "completed") completed = event.result;
    }
    return completed;
  }

  async *stream(request) {
    const hasToolResult = request.messages.some(
      (message) => message.role === "tool",
    );
    if (request.tools?.length && !hasToolResult) {
      const prompt = messageText(request.messages);
      const call = {
        id: crypto.randomUUID(),
        name: request.tools[0].name,
        input: {
          libraryId: labelledValue(
            prompt,
            "Context7 library ID",
            "/modelcontextprotocol/typescript-sdk",
          ),
          query: labelledValue(
            prompt,
            "Documentation question",
            "How should a TypeScript client connect using Streamable HTTP?",
          ),
        },
      };
      yield { type: "tool-call", call };
      yield {
        type: "completed",
        result: {
          toolCalls: [call],
          finishReason: "tool-calls",
          transcript: [
            {
              id: crypto.randomUUID(),
              type: "tool-call",
              role: "assistant",
              content: [{ type: "tool-call", call }],
              createdAt: new Date().toISOString(),
            },
          ],
        },
      };
      return;
    }

    const text = responseText(request);
    const pieces = text.match(/\S+\s*/g) ?? [text];
    for (const delta of pieces) {
      if (request.signal?.aborted)
        throw request.signal.reason ?? new Error("Run cancelled");
      if (this.delayMs > 0) await sleep(this.delayMs);
      yield { type: "text-delta", delta };
    }
    const inputTokens = Math.max(
      1,
      Math.round(messageText(request.messages).length / 4),
    );
    const usage = {
      inputTokens,
      outputTokens: pieces.length,
      totalTokens: inputTokens + pieces.length,
    };
    yield {
      type: "completed",
      result: {
        output: text,
        finishReason: "stop",
        transcript: [transcript(text, usage)],
      },
    };
  }
}

export class TestToolAdapter {
  async listTools() {
    return [
      {
        name: "context7__query-docs",
        description: "Return test documentation.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["libraryId", "query"],
          properties: {
            libraryId: { type: "string" },
            query: { type: "string" },
          },
        },
      },
    ];
  }

  async executeTool(call) {
    return {
      callId: call.id,
      name: call.name,
      output: {
        content: [
          {
            type: "text",
            text: "Use StreamableHTTPClientTransport for remote MCP server connections.",
          },
        ],
      },
    };
  }
}
