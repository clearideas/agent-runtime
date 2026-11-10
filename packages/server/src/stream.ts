/**
 * Server-sent events for streamed chat completions.
 *
 * Only the reply is ever `delta.content`. Text from the answer step streams
 * live when that step is certain to be the reply; otherwise the committed
 * reply is sent when the run completes. Progress (step, tool, and command
 * names only) and, when enabled, the answer step's model reasoning go to a
 * separate reasoning field.
 */
import type { AgentStep, RunEvent } from "@clearideas/agent-runtime-contracts";
import type { EventSink } from "@clearideas/agent-runtime-core";

import { ServerError } from "./errors.js";
import {
  chatCompletionChunk,
  usageChunk,
  type ChunkDelta,
  type CompletionIdentity,
  type FinishReason,
  type OpenAiUsage,
} from "./openai.js";

/** An async iterable fed by pushes; ends when closed or when the consumer stops. */
export class PushStream implements AsyncIterable<string> {
  readonly #queue: string[] = [];
  #waiting: ((result: IteratorResult<string>) => void) | undefined;
  #closed = false;
  #onCancel: (() => void) | undefined;

  constructor(onCancel?: () => void) {
    this.#onCancel = onCancel;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(chunk: string): void {
    if (this.#closed) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = undefined;
      resolve({ value: chunk, done: false });
    } else {
      this.#queue.push(chunk);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#waiting && this.#queue.length === 0) {
      const resolve = this.#waiting;
      this.#waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const chunk = this.#queue.shift();
        if (chunk !== undefined)
          return Promise.resolve({ value: chunk, done: false });
        if (this.#closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        // The consumer stopped reading: the client went away.
        const wasOpen = !this.#closed;
        this.#closed = true;
        this.#queue.length = 0;
        if (wasOpen) this.#onCancel?.();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

export interface ChatStreamOptions {
  identity: CompletionIdentity;
  includeUsage: boolean;
  progress: "none" | "status";
  reasoning: "none" | "answer-step";
  progressField: "reasoning_content" | "reasoning";
  heartbeatMs: number;
  /** Step labels for progress: name when the manifest gives one, otherwise id. */
  stepLabels: ReadonlyMap<string, string>;
  onCancel?: () => void;
  onError?: (error: ServerError) => void;
}

/** Labels for every step, nested ones included. */
export const stepLabels = (
  steps: readonly AgentStep[],
): Map<string, string> => {
  const labels = new Map<string, string>();
  const visit = (list: readonly AgentStep[]): void => {
    for (const step of list) {
      labels.set(step.id, step.name ?? step.id);
      if (step.type === "loop") visit(step.steps);
    }
  };
  visit(steps);
  return labels;
};

export class ChatStream {
  readonly body: PushStream;
  readonly #options: ChatStreamOptions;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #lastWrite = Date.now();
  #started = false;
  #liveStep: string | undefined;
  #forwarded = "";
  #diverged = false;

  constructor(options: ChatStreamOptions) {
    this.#options = options;
    this.body = new PushStream(() => {
      this.#stopHeartbeat();
      options.onCancel?.();
    });
  }

  /** Text already sent as content. */
  get forwarded(): string {
    return this.#forwarded;
  }

  /** True when live text turned out not to be a prefix of the committed reply. */
  get diverged(): boolean {
    return this.#diverged;
  }

  /** Send the role chunk and begin heartbeats. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#write(
      chatCompletionChunk(this.#options.identity, {
        role: "assistant",
        content: "",
      }),
    );
    this.#heartbeat = setInterval(
      () => {
        if (Date.now() - this.#lastWrite >= this.#options.heartbeatMs) {
          this.body.push(": keep-alive\n\n");
          this.#lastWrite = Date.now();
        }
      },
      Math.max(250, Math.floor(this.#options.heartbeatMs / 3)),
    );
    this.#heartbeat.unref?.();
  }

  /** The step whose text may stream live as the reply. */
  setLiveStep(stepId: string): void {
    this.#liveStep = stepId;
  }

  readonly sink: EventSink = {
    emit: (event: RunEvent): void => this.#onEvent(event),
  };

  #onEvent(event: RunEvent): void {
    if (!this.#started || this.body.closed) return;
    const topLevelLive =
      this.#liveStep !== undefined &&
      event.stepId === this.#liveStep &&
      (event.stepPath === undefined || event.stepPath === this.#liveStep);
    if (event.type === "model.text.delta") {
      const delta =
        typeof event.data?.delta === "string" ? event.data.delta : "";
      if (topLevelLive && delta) {
        this.#forwarded += delta;
        this.#delta({ content: delta });
      }
      return;
    }
    if (event.type === "model.reasoning.delta") {
      const delta =
        typeof event.data?.delta === "string" ? event.data.delta : "";
      if (topLevelLive && delta && this.#options.reasoning === "answer-step")
        this.#progress(delta);
      return;
    }
    if (event.type === "model.retry" && topLevelLive && this.#forwarded) {
      this.#interrupt();
      return;
    }
    if (this.#options.progress === "status") {
      const line = this.#progressLine(event);
      if (line) this.#progress(`${line}\n`);
    }
  }

  #progressLine(event: RunEvent): string | undefined {
    const label = (): string =>
      (event.stepId && this.#options.stepLabels.get(event.stepId)) ||
      event.stepId ||
      "step";
    const name = (key: string): string =>
      typeof event.data?.[key] === "string" ? (event.data[key] as string) : "";
    switch (event.type) {
      case "step.started":
        return `Step: ${label()}`;
      case "model.tool.started":
        return name("toolName") ? `Tool: ${name("toolName")}` : undefined;
      case "sandbox.command.started":
        return name("name") ? `Command: ${name("name")}` : undefined;
      case "context.reduced":
        return event.data?.scope === "messages"
          ? "Compacting the earlier conversation"
          : undefined;
      case "model.retry":
        return "Retrying a model call";
      case "approval.requested":
        return "Waiting for approval";
      default:
        return undefined;
    }
  }

  #progress(text: string): void {
    this.#delta(
      this.#options.progressField === "reasoning"
        ? { reasoning: text }
        : { reasoning_content: text },
    );
  }

  #delta(delta: ChunkDelta): void {
    this.#write(chatCompletionChunk(this.#options.identity, delta));
  }

  #write(value: unknown): void {
    this.body.push(sse(value));
    this.#lastWrite = Date.now();
  }

  /**
   * Complete the stream with the committed reply. Live text that is a prefix
   * of the reply is completed with the remainder; otherwise the stream
   * ends with an error because emitted text cannot be withdrawn.
   */
  finish(input: {
    reply: string;
    finishReason: FinishReason;
    usage: OpenAiUsage;
  }): void {
    if (this.body.closed) return;
    this.start();
    if (this.#forwarded) {
      if (input.reply.startsWith(this.#forwarded)) {
        const rest = input.reply.slice(this.#forwarded.length);
        if (rest) this.#sendReply(rest);
      } else {
        this.#interrupt();
        return;
      }
    } else if (input.reply) {
      this.#sendReply(input.reply);
    }
    this.#write(
      chatCompletionChunk(this.#options.identity, {}, input.finishReason),
    );
    if (this.#options.includeUsage)
      this.#write(usageChunk(this.#options.identity, input.usage));
    this.#end();
  }

  /** Send the reply in chunks, so clients render it progressively. */
  #sendReply(text: string): void {
    const chunkSize = 256;
    let index = 0;
    while (index < text.length) {
      let end = Math.min(index + chunkSize, text.length);
      // Keep a surrogate pair in one chunk.
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end += 1;
      this.#delta({ content: text.slice(index, end) });
      index = end;
    }
  }

  /** End the stream with an error event. */
  fail(error: ServerError): void {
    if (this.body.closed) return;
    this.start();
    this.#write(error.toBody());
    this.#end();
  }

  #interrupt(): void {
    this.#diverged = true;
    const error = new ServerError(
      502,
      "stream_interrupted",
      "The answer changed after streaming began. Retry the request.",
    );
    this.fail(error);
    this.#options.onError?.(error);
  }

  #end(): void {
    this.body.push("data: [DONE]\n\n");
    this.#stopHeartbeat();
    this.body.close();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }
}
