import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { RunEvent } from "@clearideas/agent-runtime-contracts";
import type { EventSink } from "@clearideas/agent-runtime-core";

const serializeEvent = (event: RunEvent): string =>
  `${JSON.stringify(event)}\n`;

/** Emits structured one-event-per-line output to stdout or an injected writer. */
export class ConsoleEventSink implements EventSink {
  readonly #write: (line: string) => void;

  constructor(
    write: (line: string) => void = (line) => process.stdout.write(line),
  ) {
    this.#write = write;
  }

  emit(event: RunEvent): void {
    this.#write(serializeEvent(event));
  }
}

/** Appends events in invocation order to a replayable JSONL file. */
export class JsonlEventSink implements EventSink {
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (!filePath.trim())
      throw new Error("JsonlEventSink requires a file path.");
    this.#filePath = path.resolve(filePath);
  }

  emit(event: RunEvent): Promise<void> {
    const operation = this.#queue.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      await appendFile(this.#filePath, serializeEvent(event), {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.#queue;
  }
}
