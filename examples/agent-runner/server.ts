import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ModelAdapter } from "@clearideas/agent-runtime";
import { createAgentHost } from "./agent-host.ts";

const exampleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(exampleDirectory, "public");
const aceDirectory = path.join(
  exampleDirectory,
  "node_modules/ace-builds/src-min-noconflict",
);

// Everything in this file is HTTP transport wiring. Agent Runtime composition
// lives in agent-host.ts so it can be read without routing and header details.
const staticAssets: Record<string, readonly [string, string]> = {
  "/": [path.join(publicDirectory, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [
    path.join(publicDirectory, "app.js"),
    "text/javascript; charset=utf-8",
  ],
  "/styles.css": [
    path.join(publicDirectory, "styles.css"),
    "text/css; charset=utf-8",
  ],
  "/vendor/ace.js": [
    path.join(aceDirectory, "ace.js"),
    "text/javascript; charset=utf-8",
  ],
  "/vendor/mode-json.js": [
    path.join(aceDirectory, "mode-json.js"),
    "text/javascript; charset=utf-8",
  ],
  "/vendor/mode-yaml.js": [
    path.join(aceDirectory, "mode-yaml.js"),
    "text/javascript; charset=utf-8",
  ],
  "/vendor/theme-textmate.js": [
    path.join(aceDirectory, "theme-textmate.js"),
    "text/javascript; charset=utf-8",
  ],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
};

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

export interface AgentRunnerOptions {
  port?: number;
  dataDirectory?: string;
  modelAdapter?: ModelAdapter;
}

export interface AgentRunnerApp {
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export const createAgentRunnerApp = async (
  settings: AgentRunnerOptions = {},
): Promise<AgentRunnerApp> => {
  const port = settings.port ?? 4180;
  const dataDirectory =
    settings.dataDirectory ?? path.join(exampleDirectory, ".data");
  const agentHost = await createAgentHost(dataDirectory, settings.modelAdapter);

  const handleRun = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const browserSignal = new AbortController();
    response.once("close", () => browserSignal.abort());

    // The response is newline-delimited JSON: one accepted message, followed
    // by runtime events, and finally one terminal result or error.
    const write = (value: unknown): void => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`${JSON.stringify(value)}\n`);
      }
    };

    try {
      const body = await readBody(request);
      if (!isObject(body)) throw new Error("Request body must be an object.");
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      // The HTTP layer only translates the request and streams messages. The
      // host owns validation, execution, observation, and cancellation.
      if (body.runId !== undefined) {
        await agentHost.resume(body.runId, write, browserSignal.signal);
      } else {
        await agentHost.execute(
          body.manifestId,
          body.variables,
          write,
          browserSignal.signal,
        );
      }
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(400, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        });
      }
      write({
        kind: "error",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/manifests") {
        sendJson(response, 200, await agentHost.storage.listManifests());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/manifests") {
        const body = await readBody(request);
        if (!isObject(body)) throw new Error("Request body must be an object.");
        const saved = await agentHost.storage.saveManifest(
          body.source,
          body.id,
        );
        sendJson(response, body.id ? 200 : 201, saved);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        sendJson(response, 200, await agentHost.storage.listRuns());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        await handleRun(request, response);
        return;
      }

      const asset =
        request.method === "GET" ? staticAssets[url.pathname] : undefined;
      if (asset) {
        response.writeHead(200, {
          "content-type": asset[1],
          "cache-control": "no-store",
        });
        response.end(await readFile(asset[0]));
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });

  return {
    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const app = await createAgentRunnerApp();
  const address = await app.listen();
  process.stdout.write(`Agent Runner: http://127.0.0.1:${address.port}\n`);
}
