/**
 * Showcase HTTP server. Everything here is transport wiring: static files,
 * JSON endpoints, and one NDJSON stream per run. Agent Runtime composition
 * lives in each demo's host.ts.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { JsonValue, ModelAdapter } from "@clearideas/agent-runtime";

import { catalog, demos } from "./lib/catalog.ts";
import type { DemoContext, ShowcaseDemo, ShowcaseMessage } from "./lib/demo.ts";
import {
  detectEnvironment,
  pullDockerImage,
  type ModelMode,
  type ShowcaseEnvironment,
} from "./lib/environment.ts";

const showcaseDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(showcaseDirectory, "public");
const require = createRequire(import.meta.url);

const vendor: Record<string, readonly [string, string]> = {
  "/vendor/marked.js": [
    path.join(path.dirname(require.resolve("marked")), "marked.umd.js"),
    "text/javascript",
  ],
  "/vendor/purify.js": [
    path.join(path.dirname(require.resolve("dompurify")), "purify.min.js"),
    "text/javascript",
  ],
  "/vendor/highlight.js": [
    path.join(
      path.dirname(require.resolve("@highlightjs/cdn-assets/package.json")),
      "highlight.min.js",
    ),
    "text/javascript",
  ],
};

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const securityHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    ...securityHeaders,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

const readJson = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 32_768) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Request body must be a JSON object.");
  return parsed as Record<string, unknown>;
};

/** Serve files beneath public/ only, by known extension. */
const servePublic = async (response: ServerResponse, pathname: string) => {
  const file = path.resolve(publicDirectory, `.${pathname}`);
  const type = contentTypes[path.extname(file)];
  if (!file.startsWith(`${publicDirectory}${path.sep}`) || !type) return false;
  const content = await readFile(file).catch(() => undefined);
  if (!content) return false;
  response.writeHead(200, { ...securityHeaders, "content-type": type });
  response.end(content);
  return true;
};

/**
 * Print failed tool calls and files the host could not save to the server
 * console as well, so they are easy to copy into a bug report. Guardrails is
 * skipped: refusals are what that demo is about.
 */
const reportFailure = (demoId: string, message: ShowcaseMessage) => {
  if (demoId === "guardrails" || process.env.SHOWCASE_QUIET) return;
  if (message.kind === "tool-io" && message.error) {
    // File contents are long and rarely explain a failure; keep the rest.
    const { content: _content, ...input } =
      message.input && typeof message.input === "object"
        ? (message.input as Record<string, JsonValue>)
        : {};
    console.error(
      `[showcase] ${demoId}: ${message.name} ${JSON.stringify(input).slice(0, 300)} failed with ${message.error.code}: ${message.error.message}`,
    );
  }
  if (
    message.kind === "event" &&
    message.event.type === "sandbox.command.completed"
  ) {
    const ignored = (message.event.data?.ignoredPaths ?? []) as Array<{
      alias: string;
      path: string;
      reason: string;
    }>;
    for (const item of ignored.filter((entry) =>
      entry.reason.startsWith("store:"),
    ))
      console.error(
        `[showcase] ${demoId}: ${item.alias}/${item.path} was not saved to the host: ${item.reason}`,
      );
  }
};

export interface ShowcaseOptions {
  host?: string;
  port?: number;
  dataDirectory?: string;
  /** auto, bubblewrap, docker, or unisolated. */
  sandbox?: string;
  /** Default pace for runs that do not request one. */
  pace?: number;
  /** Tests only: replaces the live provider model for each demo. */
  liveModel?: (demoId: string) => ModelAdapter;
}

export interface ShowcaseApp {
  server: Server;
  environment: ShowcaseEnvironment;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export const createShowcaseApp = async (
  options: ShowcaseOptions = {},
): Promise<ShowcaseApp> => {
  const host = options.host ?? process.env.SHOWCASE_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.SHOWCASE_PORT ?? 4178);
  const dataDirectory =
    options.dataDirectory ??
    process.env.SHOWCASE_DATA ??
    path.join(showcaseDirectory, ".data");
  const preference = options.sandbox ?? process.env.SHOWCASE_SANDBOX;
  const environment = await detectEnvironment({
    host,
    ...(preference ? { preference } : {}),
    ...(process.env.SHOWCASE_DOCKER_IMAGE
      ? { dockerImage: process.env.SHOWCASE_DOCKER_IMAGE }
      : {}),
    ...(process.env.SHOWCASE_PROVIDER
      ? { liveProvider: process.env.SHOWCASE_PROVIDER }
      : {}),
    ...(process.env.SHOWCASE_MODEL
      ? { liveModel: process.env.SHOWCASE_MODEL }
      : {}),
  });

  // Live normally requires an isolated sandbox because a real model chooses
  // its own commands. A test model replays a demo script, so it may run on
  // any sandbox.
  if (options.liveModel)
    environment.live = {
      available: true,
      reason: "test model",
      provider: "test",
      model: "test",
    };
  let serverUrl = `http://${host}:${port}`;
  const contextFor = (demo: ShowcaseDemo): DemoContext => ({
    environment,
    dataDirectory: path.join(dataDirectory, demo.id),
    serverUrl: () => serverUrl,
    ...(options.liveModel
      ? { liveModel: () => options.liveModel!(demo.id) }
      : {}),
  });
  for (const demo of demos) {
    const context = contextFor(demo);
    if (!existsSync(context.dataDirectory)) {
      await mkdir(context.dataDirectory, { recursive: true });
      await demo.reset?.(context);
    }
  }
  const active = new Set<string>();

  const handleRun = async (
    demo: ShowcaseDemo,
    request: IncomingMessage,
    response: ServerResponse,
    resumeRunId?: string,
  ) => {
    const body = await readJson(request);
    if (active.has(demo.id)) {
      sendJson(response, 409, {
        error: "A run is already in progress for this demo.",
      });
      return;
    }
    const mode: ModelMode = body.mode === "live" ? "live" : "scripted";
    const requestedPace = Number(body.pace ?? options.pace ?? 1);
    const pace = Number.isFinite(requestedPace)
      ? Math.min(4, Math.max(0, requestedPace))
      : 1;
    const demoOptions =
      body.options && typeof body.options === "object"
        ? (body.options as Record<string, unknown>)
        : {};
    const runRequest = { mode, pace, options: demoOptions };
    if (resumeRunId && !demo.resume) {
      sendJson(response, 404, { error: "This demo does not resume runs." });
      return;
    }

    const controller = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) controller.abort(new Error("Browser disconnected."));
    });
    response.writeHead(200, {
      ...securityHeaders,
      "content-type": "application/x-ndjson; charset=utf-8",
    });
    const emit = (message: ShowcaseMessage) => {
      // Once the browser has gone, failures are just the cancellation.
      if (!controller.signal.aborted) reportFailure(demo.id, message);
      if (!response.destroyed && !response.writableEnded)
        response.write(`${JSON.stringify(message)}\n`);
    };
    active.add(demo.id);
    try {
      if (resumeRunId)
        await demo.resume!(
          contextFor(demo),
          resumeRunId,
          runRequest,
          emit,
          controller.signal,
        );
      else
        await demo.run(contextFor(demo), runRequest, emit, controller.signal);
    } catch (error) {
      emit({
        kind: "error",
        error: {
          message: error instanceof Error ? error.message : String(error),
          cancelled: controller.signal.aborted,
        },
      });
    } finally {
      finished = true;
      active.delete(demo.id);
      response.end();
    }
  };

  const route = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    // Browser pages may not start, resume or reset local runs from another
    // origin. Origin-less local clients and the authenticated worker callbacks
    // remain supported.
    const origin = request.headers.origin;
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      origin !== undefined &&
      origin !== serverUrl
    ) {
      return sendJson(response, 403, {
        error: "Cross-origin requests are not allowed.",
      });
    }
    for (const demo of demos)
      if (await demo.route?.(contextFor(demo), request, response, url)) return;

    if (method === "GET" && url.pathname === "/api/environment")
      return sendJson(response, 200, environment);
    if (method === "GET" && url.pathname === "/api/demos")
      return sendJson(response, 200, catalog());

    const resume =
      /^\/api\/demos\/([a-z-]+)\/runs\/([A-Za-z0-9_-]+)\/resume$/u.exec(
        url.pathname,
      );
    if (resume && method === "POST") {
      const demo = demos.find((entry) => entry.id === resume[1]);
      if (!demo) return sendJson(response, 404, { error: "Unknown demo." });
      return handleRun(demo, request, response, resume[2]);
    }

    const artifact =
      /^\/api\/demos\/([a-z-]+)\/artifacts\/([A-Za-z0-9_-]+)$/u.exec(
        url.pathname,
      );
    if (artifact && method === "GET") {
      const demo = demos.find((entry) => entry.id === artifact[1]);
      const found = demo?.artifact
        ? await demo.artifact(contextFor(demo), artifact[2]!)
        : undefined;
      if (!found || !/^image\/(png|jpeg|gif|webp)$/u.test(found.mediaType))
        return sendJson(response, 404, { error: "Unknown artifact." });
      response.writeHead(200, {
        ...securityHeaders,
        "content-type": found.mediaType,
      });
      response.end(Buffer.from(found.data));
      return;
    }

    const match = /^\/api\/demos\/([a-z-]+)(?:\/([a-z]+))?$/u.exec(
      url.pathname,
    );
    const demo = match
      ? demos.find((entry) => entry.id === match[1])
      : undefined;
    if (match && !demo)
      return sendJson(response, 404, { error: "Unknown demo." });
    if (demo && match) {
      const action = match[2];
      const context = contextFor(demo);
      if (method === "GET" && !action) {
        return sendJson(response, 200, {
          id: demo.id,
          title: demo.title,
          tagline: demo.tagline,
          features: demo.features,
          sources: demo.sources,
          ...((await demo.describe(context)) as object),
        });
      }
      if (method === "GET" && action === "source") {
        const source = demo.sources.find(
          (entry) => entry.path === url.searchParams.get("path"),
        );
        if (!source) return sendJson(response, 404, { error: "Unknown file." });
        const text = await readFile(
          path.join(showcaseDirectory, source.path),
          "utf8",
        );
        return sendJson(response, 200, { ...source, text });
      }
      if (method === "GET" && action === "state")
        return sendJson(response, 200, (await demo.state?.(context)) ?? {});
      if (method === "POST" && action === "reset") {
        if (active.has(demo.id))
          return sendJson(response, 409, { error: "A run is in progress." });
        await demo.reset?.(context);
        return sendJson(response, 200, { reset: true });
      }
      if (method === "POST" && action === "runs")
        return handleRun(demo, request, response);
      return sendJson(response, 404, { error: "Not found." });
    }

    if (method !== "GET")
      return sendJson(response, 405, { error: "Method not allowed." });
    const asset = vendor[url.pathname];
    if (asset) {
      response.writeHead(200, {
        ...securityHeaders,
        "content-type": `${asset[1]}; charset=utf-8`,
      });
      response.end(await readFile(asset[0]));
      return;
    }
    const page =
      url.pathname === "/"
        ? "/index.html"
        : /^\/demos\/[a-z-]+$/u.test(url.pathname)
          ? `${url.pathname}.html`
          : url.pathname;
    if (await servePublic(response, page)) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  };

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (!response.headersSent)
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      else response.end();
    });
  });

  return {
    server,
    environment,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo;
          // Callbacks come from this machine; wildcard addresses mean loopback.
          const reachable =
            host === "0.0.0.0" || host === "::"
              ? "127.0.0.1"
              : host.includes(":")
                ? `[${host}]`
                : host;
          serverUrl = `http://${reachable}:${address.port}`;
          resolve(address);
        });
      }),
    close: async () => {
      await Promise.all(demos.map((demo) => demo.close?.()));
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
};

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const app = await createShowcaseApp();
  const { sandbox, live } = app.environment;
  if (sandbox.kind === "docker" && !sandbox.imagePresent) {
    process.stdout.write(
      `Pulling the sandbox image ${sandbox.image} (first run only)…\n`,
    );
    if (!pullDockerImage(sandbox.image!))
      process.stdout.write(
        `Could not pull ${sandbox.image}. Check your connection, or run: docker pull ${sandbox.image}\n`,
      );
  }
  const address = await app.listen();
  const lines = [
    `Agent Runtime showcase: http://${address.address === "::" ? "localhost" : address.address}:${address.port}`,
    `Sandbox: ${sandbox.kind}${sandbox.isolated ? " (isolated)" : ""} — ${sandbox.detail}`,
    ...sandbox.notes.map((note) => `  note: ${note}`),
    `Live model: ${live.available ? live.reason : `unavailable — ${live.reason}`}`,
  ];
  if (sandbox.kind === "unisolated") {
    lines.push(
      "",
      "WARNING: no isolated sandbox was found. Workspace commands will run as",
      "ordinary processes on this machine (scripted model only). Start Docker",
      "(or install bubblewrap on Linux) for real isolation.",
    );
  }
  lines.push("", "Check this setup any time with: npm run doctor");
  process.stdout.write(`${lines.join("\n")}\n`);
  const shutdown = () => void app.close().finally(() => process.exit());
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
