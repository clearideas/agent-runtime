/**
 * A deterministic ModelAdapter for keyless demos and tests.
 *
 * Only the model's *decisions* are scripted. Every tool call it makes is
 * executed for real by Agent Runtime (workspace tools run in the real run
 * sandbox), and each decision is computed from the real tool results the
 * runtime sends back, so the script reacts to failing tests, host-policy
 * denials, and files that are already fixed.
 *
 * Text is streamed in small paced chunks so the browser can animate it; the
 * pace is a multiplier where 0 means "as fast as possible" (used by tests).
 */
import type {
  JsonValue,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelResult,
  ToolCall,
  ToolResult,
  TranscriptItem,
} from "@clearideas/agent-runtime";

/** What the script sees: the same request a real model receives, pre-digested. */
export interface ScriptRequest {
  /** Concatenated system message text. */
  system: string;
  /** Concatenated user message text (the interpolated step prompt). */
  prompt: string;
  /** Tool names offered to the model for this step. */
  tools: string[];
  /** Results of this step's earlier tool calls, in order. */
  results: ToolResult[];
  /** Zero-based model turn within the current step. */
  turn: number;
  /** True when the step requested structured output. */
  structured: boolean;
}

/** One model turn: narrate, then either call a tool or finish the step. */
export type ScriptTurn =
  | { say?: string; call: { name: string; input: Record<string, JsonValue> } }
  | { say?: string; output: JsonValue };

export type Script = (request: ScriptRequest) => ScriptTurn;

export interface ScriptedModelOptions {
  /** Pace multiplier: 1 is a comfortable reading speed, 0 disables delays. */
  pace?: number;
  /** Identifier reported in transcripts; shown as the model name. */
  modelName?: string;
  /**
   * Stop with an error when a tool reports that the sandbox could not run a
   * command. Defaults to true; adversarial scripts that expect refusals turn
   * it off.
   */
  stopOnSandboxFailure?: boolean;
}

const sleep = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted)
      return reject(signal.reason ?? new Error("Model call cancelled"));
    if (milliseconds <= 0) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Model call cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const textOf = (request: ModelRequest, role: string) =>
  request.messages
    .filter((message) => message.role === role)
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

const toolResultsOf = (request: ModelRequest): ToolResult[] =>
  request.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === "tool-result" ? [part.result] : []));

const estimateTokens = (text: string) =>
  Math.max(1, Math.ceil(text.length / 4));

/** Split text into word-sized chunks so streaming reads naturally. */
const chunks = (text: string): string[] => text.match(/\s*\S+\s*/gu) ?? [text];

export class ScriptedModelAdapter implements ModelAdapter {
  readonly #script: Script;
  readonly #pace: number;
  readonly #modelName: string;
  readonly #stopOnSandboxFailure: boolean;
  #callSequence = 0;

  constructor(script: Script, options: ScriptedModelOptions = {}) {
    this.#script = script;
    this.#pace = Math.max(0, options.pace ?? 1);
    this.#modelName = options.modelName ?? "scripted";
    this.#stopOnSandboxFailure = options.stopOnSandboxFailure ?? true;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    let completed: ModelResult | undefined;
    for await (const event of this.stream(request)) {
      if (event.type === "completed") completed = event.result;
    }
    if (!completed) throw new Error("Scripted model produced no result.");
    return completed;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const results = toolResultsOf(request);
    // A real model might keep going after the sandbox itself breaks; the
    // script stops so the failure is visible where it happened.
    const broken = !this.#stopOnSandboxFailure
      ? undefined
      : results.find((result) =>
          ["sandbox_command_failed", "sandbox_unavailable"].includes(
            result.error?.code ?? "",
          ),
        );
    if (broken?.error) {
      throw new Error(
        `The sandbox could not run ${broken.name} (${broken.error.code}): ${broken.error.message}`,
      );
    }
    const turn = this.#script({
      system: textOf(request, "system"),
      prompt: textOf(request, "user"),
      tools: (request.tools ?? []).map((tool) => tool.name),
      results,
      turn: request.messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.content.some((part) => part.type === "tool-call"),
      ).length,
      structured: request.outputSchema != null,
    });

    // A short "thinking" pause before the first token makes each model call
    // visible in the animation.
    await sleep(350 * this.#pace, request.signal);

    const narration =
      turn.say ??
      ("output" in turn
        ? typeof turn.output === "string"
          ? turn.output
          : JSON.stringify(turn.output, null, 2)
        : "");
    for (const delta of chunks(narration)) {
      if (request.signal?.aborted)
        throw request.signal.reason ?? new Error("Model call cancelled");
      await sleep(28 * this.#pace, request.signal);
      yield { type: "text-delta", delta };
    }

    const usage = {
      inputTokens: estimateTokens(
        request.messages
          .flatMap((message) => message.content)
          .map((part) => JSON.stringify(part))
          .join(""),
      ),
      outputTokens: estimateTokens(narration),
    };
    const item = (content: TranscriptItem["content"]): TranscriptItem => ({
      id: `scripted-${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
      usage: {
        ...usage,
        totalTokens: usage.inputTokens + usage.outputTokens,
      },
    });

    if ("call" in turn) {
      await sleep(250 * this.#pace, request.signal);
      this.#callSequence += 1;
      const call: ToolCall = {
        id: `call-${this.#callSequence}-${crypto.randomUUID().slice(0, 8)}`,
        name: turn.call.name,
        input: turn.call.input,
      };
      yield { type: "tool-call", call };
      yield {
        type: "completed",
        result: {
          toolCalls: [call],
          finishReason: "tool-calls",
          transcript: [
            {
              ...item([
                ...(narration
                  ? [{ type: "text" as const, text: narration }]
                  : []),
                { type: "tool-call" as const, call },
              ]),
              type: "tool-call",
            },
          ],
          providerMetadata: { model: this.#modelName },
        },
      };
      return;
    }

    yield {
      type: "completed",
      result: {
        output: turn.output,
        finishReason: "stop",
        transcript: [
          item([
            typeof turn.output === "string"
              ? { type: "text", text: turn.output }
              : { type: "json", value: turn.output },
          ]),
        ],
        providerMetadata: { model: this.#modelName },
      },
    };
  }
}

/** Helpers scripts use to read real tool results. */
export const lastResult = (request: ScriptRequest): ToolResult | undefined =>
  request.results.at(-1);

export const outputOf = <T = Record<string, unknown>>(
  result: ToolResult | undefined,
): T | undefined =>
  result && result.error == null ? (result.output as T) : undefined;
