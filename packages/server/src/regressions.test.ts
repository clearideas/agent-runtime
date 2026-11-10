import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type { AgentManifest } from "@clearideas/agent-runtime-contracts";
import type { ModelAdapter } from "@clearideas/agent-runtime-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseServerConfig,
  resolveServerConfigPaths,
  type ServerConfigInput,
} from "./config.js";
import { createFetchHandler, listen } from "./http.js";
import { SqliteKeyValueStore } from "./kv.js";
import { AgentServer, silentLogger } from "./service.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const manifest: AgentManifest = {
  schemaVersion: "1.0",
  model: { provider: "test", model: "local" },
  variables: [{ key: "question", type: "string", requiresOverride: true }],
  steps: [
    {
      id: "public",
      type: "prompt",
      prompt: "public step",
      outputVariable: "publicResult",
    },
    { id: "internal", type: "prompt", prompt: "internal step" },
  ],
};
const model: ModelAdapter = {
  async generate(request) {
    return {
      output: JSON.stringify(request.messages).includes("public step")
        ? "PUBLIC"
        : "INTERNAL",
      transcript: [],
    };
  },
  async *stream(request) {
    const result = await this.generate(request);
    yield { type: "text-delta", delta: String(result.output) };
    yield { type: "completed", result };
  },
};
const body = (stream = false) =>
  JSON.stringify({
    model: "test",
    messages: [{ role: "user", content: "Hi" }],
    stream,
  });
const request = (stream = false) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    body: body(stream),
  });
const events = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
const content = (text: string) =>
  events(text)
    .flatMap((event) => event.choices ?? [])
    .map((choice) => choice.delta?.content ?? "")
    .join("");
const create = async (
  options: {
    manifest?: AgentManifest;
    config?: Omit<ServerConfigInput, "version">;
    model?: ModelAdapter;
    module?: string;
  } = {},
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "serve-regression-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "agent.json"),
    JSON.stringify(options.manifest ?? manifest),
  );
  if (options.module)
    await writeFile(path.join(directory, "runtime.mjs"), options.module);
  const config = resolveServerConfigPaths(
    parseServerConfig({
      version: "1.0",
      models: [{ name: "test", manifest: "agent.json" }],
      ...(options.module ? { runtimeModule: "runtime.mjs" } : {}),
      ...options.config,
    }),
    directory,
  );
  const server = await AgentServer.create({
    loaded: { config, baseDirectory: directory },
    logger: silentLogger,
    ...(!options.module ? { runtime: { model: options.model ?? model } } : {}),
  });
  cleanups.push(() => server.shutdown(0));
  return { server, directory, handle: createFetchHandler(server) };
};

describe("selected replies and streaming recovery", () => {
  for (const from of ["step:public", "variable:publicResult"]) {
    for (const mode of ["auto", "live"] as const) {
      it(`streams only ${from} with mode ${mode}`, async () => {
        const { handle } = await create({
          config: {
            models: [
              {
                name: "test",
                manifest: "agent.json",
                output: { from },
                stream: { mode },
              },
            ],
          },
        });
        expect(
          (await (await handle(request())).json()).choices[0].message.content,
        ).toBe("PUBLIC");
        expect(content(await (await handle(request(true))).text())).toBe(
          "PUBLIC",
        );
      });
    }
  }

  it.each([false, true])(
    "handles retry after partial text=%s without mixing attempts",
    async (partial) => {
      let attempts = 0;
      let aborted = false;
      const retryModel: ModelAdapter = {
        generate: async () => ({ output: "GOOD", transcript: [] }),
        async *stream(input) {
          input.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
          attempts += 1;
          if (attempts === 1) {
            if (partial) yield { type: "text-delta", delta: "BAD " };
            throw Object.assign(new Error("transient"), { statusCode: 503 });
          }
          yield { type: "text-delta", delta: "GOOD" };
          yield {
            type: "completed",
            result: { output: "GOOD", transcript: [] },
          };
        },
      };
      const { handle } = await create({
        manifest: { ...manifest, steps: [manifest.steps[0]!] },
        model: retryModel,
        config: {
          models: [
            {
              name: "test",
              manifest: "agent.json",
              policies: {
                modelRetry: {
                  maxAttempts: 2,
                  initialDelayMs: 1,
                  maxDelayMs: 1,
                },
              },
            },
          ],
        },
      });
      const text = await (await handle(request(true))).text();
      if (partial) {
        expect(content(text)).toBe("BAD ");
        expect(events(text).find((event) => event.error)?.error.code).toBe(
          "stream_interrupted",
        );
        expect(
          events(text)
            .flatMap((event) => event.choices ?? [])
            .some((choice) => choice.finish_reason === "stop"),
        ).toBe(false);
        expect(attempts).toBe(1);
        expect(aborted).toBe(true);
      } else {
        expect(content(text)).toBe("GOOD");
        expect(events(text).some((event) => event.error)).toBe(false);
        expect(attempts).toBe(2);
      }
    },
  );

  it("reports divergent committed text as a stream error", async () => {
    const { handle } = await create({
      manifest: { ...manifest, steps: [manifest.steps[0]!] },
      model: {
        generate: async () => ({ output: "GOOD", transcript: [] }),
        async *stream() {
          yield { type: "text-delta", delta: "BAD" };
          yield {
            type: "completed",
            result: { output: "GOOD", transcript: [] },
          };
        },
      },
    });
    const text = await (await handle(request(true))).text();
    expect(content(text)).toBe("BAD");
    expect(events(text).find((event) => event.error)?.error.code).toBe(
      "stream_interrupted",
    );
  });
});

describe("request deadlines and shutdown", () => {
  it("cancels a stalled fetch upload at its request deadline", async () => {
    const { handle } = await create({
      config: { server: { requestTimeoutMs: 25 } },
    });
    let cancelled = false;
    const upload = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = await handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: upload,
        ...{ duplex: "half" },
      }),
    );
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("timeout");
    expect(cancelled).toBe(true);
  });

  it("returns 504 and closes a stalled native HTTP upload", async () => {
    const { server } = await create({
      config: { server: { requestTimeoutMs: 25 } },
    });
    const listening = await listen(server, { port: 0 });
    cleanups.push(() => listening.close(0));
    const response = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const upload = httpRequest(
          `${listening.url}/v1/chat/completions`,
          { method: "POST" },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("end", () => {
              upload.destroy();
              resolve({ status: response.statusCode!, text });
            });
            response.on("error", reject);
          },
        );
        upload.on("error", reject);
        upload.write("{");
      },
    );
    expect(response.status).toBe(504);
    expect(JSON.parse(response.text).error.code).toBe("timeout");
  });

  const module = `
let calls = 0;
export let closed = 0;
export let release;
let enter;
export const entered = new Promise(resolve => { enter = resolve; });
const gate = new Promise(resolve => { release = resolve; });
export async function createRuntime() {
  calls++;
  if (calls > 1) { enter(); await gate; }
  return { model: { generate: async () => ({output:'PUBLIC',transcript:[]}) }, shutdown() { closed++; } };
}`;
  it.each(["shutdown", "timeout"])(
    "bounds runtime setup during %s and disposes late resources",
    async (reason) => {
      const { handle, server, directory } = await create({
        module,
        config: {
          store: { driver: "sqlite", path: "runs.sqlite" },
          server: { requestTimeoutMs: reason === "timeout" ? 50 : 5_000 },
        },
      });
      const runtime = await import(
        pathToFileURL(path.join(directory, "runtime.mjs")).href
      );
      const pending = handle(request());
      await runtime.entered;
      if (reason === "shutdown") await server.shutdown(5);
      const response = await pending;
      expect(response.status).toBe(reason === "shutdown" ? 503 : 504);
      runtime.release();
      await expect.poll(() => runtime.closed).toBe(2);
    },
  );

  it("drains a preparing request before closing its SQLite store", async () => {
    const { handle, server, directory } = await create({
      module,
      config: { store: { driver: "sqlite", path: "runs.sqlite" } },
    });
    const runtime = await import(
      pathToFileURL(path.join(directory, "runtime.mjs")).href
    );
    const pending = handle(request());
    await runtime.entered;
    const closing = server.shutdown(5_000);
    runtime.release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("PUBLIC");
    await closing;
  });

  it("interrupts queued work without starting another model call", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const { handle, server } = await create({
      config: { server: { maxConcurrentRuns: 1 } },
      model: {
        generate: async (input) => {
          calls += 1;
          entered();
          return new Promise((_, reject) =>
            input.signal?.addEventListener(
              "abort",
              () => reject(input.signal?.reason),
              { once: true },
            ),
          );
        },
      },
    });
    const first = handle(request());
    await started;
    const queued = handle(request());
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.shutdown(5);
    expect((await first).status).toBe(503);
    expect((await queued).status).toBe(503);
    expect(calls).toBe(1);
  });
});

it("physically removes bounded batches of expired unread SQLite histories and media indexes", async () => {
  const { server, directory } = await create({
    config: { stores: { default: { driver: "sqlite", path: "state.sqlite" } } },
  });
  const filename = path.join(directory, "state.sqlite");
  const store = await SqliteKeyValueStore.open(filename, { now: () => 0 });
  for (let index = 0; index < 1_001; index += 1)
    await store.set("ledger:v1", String(index), "history", 1);
  await store.set("media:v1", "expired", "media", 1);
  await store.set("ledger:v1", "live", "live", Date.now() + 60_000);
  await store.set("retention:v1", "live", "completed", Date.now() + 60_000);
  store.close();
  const database = new DatabaseSync(filename);
  try {
    await server.sweepRetention();
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_runtime_server_kv WHERE expires_at <= ?",
        )
        .get(Date.now()),
    ).toEqual({ count: 1 });
    await server.sweepRetention();
    expect(
      database
        .prepare("SELECT key FROM agent_runtime_server_kv ORDER BY namespace")
        .all(),
    ).toEqual([{ key: "live" }, { key: "live" }]);
  } finally {
    database.close();
  }
});
