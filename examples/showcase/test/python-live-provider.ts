/**
 * The Live path of the Python showcase, without an API key.
 *
 * The TypeScript showcase tests answer Live mode with an AI SDK mock model
 * (live-model.ts) that follows a demo script. The Python showcase runs in its
 * own process, so it cannot call that mock directly. Instead, this file
 * serves an OpenAI Responses API endpoint on 127.0.0.1: the Python server's
 * real OpenAI adapter sends its requests here, each request is turned back
 * into the AI SDK prompt the mock expects, and the mock's answer is sent back
 * as a Responses API body or event stream. The same demo scripts and the
 * same call log therefore drive both runtimes' Live paths.
 *
 * Requests arrive at /<demo id>/<model instance>/v1/responses; each instance
 * is one `liveModel(demoId)` call, as the TypeScript server makes per run.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  composeRuntime,
  parseAgentRuntimeConfig,
  type ModelAdapter,
} from "@clearideas/agent-runtime";

type Part = Record<string, any>;
type LanguageModel = {
  doStream(options: any): Promise<{ stream: ReadableStream<Part> }>;
  doGenerate(options: any): Promise<{
    content: Part[];
    finishReason: Part;
    usage: Part;
  }>;
};

export interface LiveProvider {
  url: string;
  /** Every request body received, in order, with the demo it came from. */
  requests: Array<{ demo: string; body: Part }>;
  close(): Promise<void>;
}

/**
 * The model a host configures for OpenAI, pointed at `baseURL`: the same
 * configuration the Python server builds for its Live tests, so both
 * runtimes' real OpenAI adapters talk to this stand-in.
 */
export const configuredOpenAiModel = (baseURL: string): ModelAdapter =>
  composeRuntime(
    {
      schemaVersion: "1.0",
      model: { ref: "default" },
      steps: [{ id: "s", type: "prompt", prompt: "p" }],
    },
    parseAgentRuntimeConfig({
      version: "1.0",
      providers: {
        openai: {
          driver: "openai",
          baseURL,
          apiKey: { env: "SHOWCASE_TEST_LIVE_KEY" },
        },
      },
      models: { default: { provider: "openai", model: "gpt-6-luna" } },
    }),
    { environment: { SHOWCASE_TEST_LIVE_KEY: "test" } },
    { tools: false, workspaces: false },
  ).model!;

const mediaTypeOf = (dataUrl: string) =>
  /^data:([^;,]+)/u.exec(dataUrl)?.[1] ?? "application/octet-stream";
const dataOf = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A Responses API tool output, as the AI SDK prompt's tool-result output. */
const toolOutput = (output: unknown): Part => {
  if (Array.isArray(output))
    return {
      type: "content",
      value: output.map((item: Part) =>
        item.type === "input_text"
          ? { type: "text", text: item.text }
          : item.type === "input_image"
            ? {
                type: "file",
                mediaType: mediaTypeOf(String(item.image_url)),
                data: dataOf(String(item.image_url)),
              }
            : {
                type: "file",
                mediaType: mediaTypeOf(String(item.file_data ?? "")),
                filename: item.filename,
                data: dataOf(String(item.file_data ?? "")),
              },
      ),
    };
  const value = parseJson(String(output));
  return typeof value === "string"
    ? { type: "text", value }
    : { type: "json", value };
};

/** The Responses API `input` as the AI SDK prompt (LanguageModelV4). */
const promptOf = (input: Part[], items: Map<string, Part>) => {
  const prompt: Array<{ role: string; content: any }> = [];
  const names = new Map<string, string>();
  const assistant = () => {
    const last = prompt.at(-1);
    if (last?.role === "assistant") return last.content as Part[];
    const content: Part[] = [];
    prompt.push({ role: "assistant", content });
    return content;
  };
  for (const raw of input) {
    const item =
      raw.type === "item_reference" ? (items.get(raw.id) ?? raw) : raw;
    if (item.role === "system" || item.role === "developer") {
      prompt.push({
        role: "system",
        content:
          typeof item.content === "string"
            ? item.content
            : item.content.map((part: Part) => part.text).join(""),
      });
    } else if (item.role === "user") {
      prompt.push({
        role: "user",
        content: (typeof item.content === "string"
          ? [{ type: "input_text", text: item.content }]
          : item.content
        ).map((part: Part) =>
          part.type === "input_text"
            ? { type: "text", text: part.text }
            : part.type === "input_image"
              ? {
                  type: "file",
                  mediaType: mediaTypeOf(String(part.image_url)),
                  data: dataOf(String(part.image_url)),
                }
              : {
                  type: "file",
                  mediaType: mediaTypeOf(String(part.file_data ?? "")),
                  filename: part.filename,
                  data: dataOf(String(part.file_data ?? "")),
                },
        ),
      });
    } else if (item.role === "assistant" || item.type === "message") {
      assistant().push(
        ...(typeof item.content === "string"
          ? [{ type: "text", text: item.content }]
          : item.content.map((part: Part) => ({
              type: "text",
              text: part.text,
            }))),
      );
    } else if (item.type === "function_call") {
      names.set(item.call_id, item.name);
      assistant().push({
        type: "tool-call",
        toolCallId: item.call_id,
        toolName: item.name,
        input: parseJson(item.arguments),
      });
    } else if (item.type === "function_call_output") {
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: item.call_id,
            toolName: names.get(item.call_id) ?? "",
            output: toolOutput(item.output),
          },
        ],
      });
    } else if (item.type !== "reasoning") {
      throw new Error(`Unexpected Responses input item ${JSON.stringify(raw)}`);
    }
  }
  return prompt;
};

/** The mock's answer as a Responses API body. */
const responseBody = (
  id: string,
  model: string,
  parts: Part[],
  items: Map<string, Part>,
) => {
  const output: Part[] = [];
  let text: Part | undefined;
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (const part of parts) {
    if (part.type === "text-delta") {
      if (!text) {
        text = {
          type: "message",
          id: `msg_${id}_${output.length}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "", annotations: [] }],
        };
        output.push(text);
      }
      text.content[0].text += part.delta;
    } else if (part.type === "text-end") {
      text = undefined;
    } else if (part.type === "tool-call") {
      output.push({
        type: "function_call",
        id: `fc_${id}_${output.length}`,
        call_id: part.toolCallId,
        name: part.toolName,
        arguments: part.input,
        status: "completed",
      });
    } else if (part.type === "finish") {
      usage = {
        input_tokens: part.usage.inputTokens.total,
        output_tokens: part.usage.outputTokens.total,
      };
    }
  }
  for (const item of output) items.set(item.id, item);
  return {
    id: `resp_${id}`,
    object: "response",
    created_at: 1767225600,
    status: "completed",
    model,
    output,
    incomplete_details: null,
    usage: {
      ...usage,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input_tokens + usage.output_tokens,
    },
  };
};

/** A Responses API body as the events the API streams. */
const responseEvents = (body: Part) => {
  const events: Part[] = [];
  const emit = (type: string, fields: Part) =>
    events.push({ type, sequence_number: events.length, ...fields });
  emit("response.created", {
    response: { ...body, status: "in_progress", output: [], usage: null },
  });
  body.output.forEach((item: Part, index: number) => {
    if (item.type === "message") {
      emit("response.output_item.added", {
        output_index: index,
        item: { ...item, status: "in_progress", content: [] },
      });
      const text = item.content[0].text as string;
      emit("response.content_part.added", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      emit("response.output_text.delta", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: text,
        logprobs: [],
      });
      emit("response.output_text.done", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        text,
        logprobs: [],
      });
      emit("response.content_part.done", {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: item.content[0],
      });
    } else {
      emit("response.output_item.added", {
        output_index: index,
        item: { ...item, status: "in_progress", arguments: "" },
      });
      emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      });
      emit("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      });
    }
    emit("response.output_item.done", { output_index: index, item });
  });
  emit("response.completed", { response: body });
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
};

const readAll = async (stream: ReadableStream<Part>) => {
  const parts: Part[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
};

/**
 * Serve the mocks behind `liveModel` (adapters from live-model.ts) as an
 * OpenAI Responses API endpoint.
 */
export const startLiveProvider = async (
  liveModel: (demoId: string) => unknown,
): Promise<LiveProvider> => {
  const models = new Map<string, LanguageModel>();
  const items = new Map<string, Part>();
  const requests: LiveProvider["requests"] = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    try {
      const match = /^\/([a-z-]+)\/([A-Za-z0-9-]+)\/v1\/responses$/u.exec(
        request.url ?? "",
      );
      if (!match || request.method !== "POST") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Not found" } }));
        return;
      }
      const key = `${match[1]}/${match[2]}`;
      let model = models.get(key);
      if (!model) {
        const adapter = liveModel(match[1]!) as {
          languageModel?: LanguageModel;
        };
        if (!adapter.languageModel)
          throw new Error(
            "The live model has no languageModel (live-model.ts).",
          );
        model = adapter.languageModel;
        models.set(key, model);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Part;
      requests.push({ demo: match[1]!, body });
      const options = {
        prompt: promptOf(body.input, items),
        tools: (body.tools ?? []).map((tool: Part) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
        responseFormat:
          body.text?.format?.type === "json_schema"
            ? { type: "json", schema: body.text.format.schema }
            : { type: "text" },
      };
      const id = String(++sequence);
      if (body.stream) {
        const { stream } = await model.doStream(options);
        const events = responseEvents(
          responseBody(id, body.model, await readAll(stream), items),
        );
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events);
        return;
      }
      const generated = await model.doGenerate(options);
      const parts: Part[] = generated.content.flatMap((part) =>
        part.type === "text"
          ? [{ type: "text-delta", delta: part.text }, { type: "text-end" }]
          : [part],
      );
      parts.push({ type: "finish", usage: generated.usage });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody(id, body.model, parts, items)));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
