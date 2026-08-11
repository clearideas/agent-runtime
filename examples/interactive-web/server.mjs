import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JexlConditionEvaluator } from "@clearideas/agent-runtime-condition-jexl";
import { parseAgentRunManifest } from "@clearideas/agent-runtime-contracts";
import { AgentRuntime } from "@clearideas/agent-runtime-core";
import {
  ExecutionClient,
  InProcessExecutionEngine,
} from "@clearideas/agent-runtime-execution";
import {
  createConfiguredModelAdapter,
  createConfiguredToolAdapter,
  parseAgentRuntimeConfig,
} from "@clearideas/agent-runtime-config";
import { PromptStepExecutor } from "@clearideas/agent-runtime-step-prompt";
import {
  FileAgentManifestSource,
  FileRunStore,
} from "@clearideas/agent-runtime-store-local";

import { createRemoteExecution } from "./remote-execution.mjs";
import { createExampleTelemetry } from "./telemetry.mjs";

const exampleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(exampleDirectory, "public");
const require = createRequire(import.meta.url);
const markedDirectory = path.dirname(require.resolve("marked"));
const domPurifyDirectory = path.dirname(require.resolve("dompurify"));
const highlightDirectory = path.dirname(
  require.resolve("@highlightjs/cdn-assets/package.json"),
);
const agentReference = "interactive-brief.agent.yaml";
const runtimeConfigReference = "interactive-web-runtime";
const context7Endpoint = "https://mcp.context7.com/mcp";

const builtInProviderDrivers = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  xai: "xai",
  grok: "xai",
  groq: "groq",
  cohere: "cohere",
};

const builtInProviderEnvironment = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
  grok: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  cohere: "COHERE_API_KEY",
};

const json = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) =>
  value != null && typeof value === "object" && !Array.isArray(value);

const context7ConnectionConfig = (options) => ({
  driver: "mcp",
  transport: "streamable-http",
  url: context7Endpoint,
  mode: "read",
  tools: ["query-docs"],
  readTools: ["query-docs"],
  required: true,
  connectTimeoutMs: 15_000,
  toolTimeoutMs: 30_000,
  ...(options.context7ApiKeyEnvironment
    ? {
        headers: {
          CONTEXT7_API_KEY: { env: options.context7ApiKeyEnvironment },
        },
      }
    : {}),
});

const providerConfig = (options) => {
  const provider = options.provider;
  const builtInDriver = builtInProviderDrivers[provider];
  const driver = options.driver || builtInDriver || "openai-compatible";
  const needsDefinition =
    !builtInDriver ||
    options.baseURL != null ||
    options.apiKeyEnvironment != null;
  if (!needsDefinition) return {};
  if (driver === "openai-compatible" && !options.baseURL) {
    throw new Error(
      `Provider "${provider}" is openai-compatible and requires AGENT_EXAMPLE_BASE_URL.`,
    );
  }
  return {
    [provider]: {
      driver,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.apiKeyEnvironment
        ? { apiKey: { env: options.apiKeyEnvironment } }
        : {}),
      ...(driver === "openai-compatible" ? { includeUsage: true } : {}),
    },
  };
};

const readBody = async (request, maximumBytes = 32_768) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const runtimeInput = (body) => {
  if (!isObject(body)) throw new Error("Request body must be a JSON object.");
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const audience =
    typeof body.audience === "string" ? body.audience.trim() : "";
  const tone = typeof body.tone === "string" ? body.tone.trim() : "";
  const libraryId =
    typeof body.libraryId === "string" ? body.libraryId.trim() : "";
  const documentationQuestion =
    typeof body.documentationQuestion === "string"
      ? body.documentationQuestion.trim()
      : "";
  const maxWords = Number(body.maxWords);
  if (!topic) throw new Error("Topic is required.");
  if (!audience) throw new Error("Audience is required.");
  if (!tone) throw new Error("Tone is required.");
  if (!/^\/[^/\s]+\/[^/\s]+(?:\/[^/\s]+)?$/u.test(libraryId)) {
    throw new Error(
      "Context7 library ID must use /organization/project format.",
    );
  }
  if (!documentationQuestion)
    throw new Error("Documentation question is required.");
  if (documentationQuestion.length > 500) {
    throw new Error("Documentation question must be 500 characters or fewer.");
  }
  if (!Number.isInteger(maxWords) || maxWords < 80 || maxWords > 500) {
    throw new Error("Maximum words must be an integer from 80 to 500.");
  }
  return {
    execution: body.execution === "remote" ? "remote" : "local",
    scheduling: body.scheduling === "sequential" ? "sequential" : "parallel",
    variables: {
      topic,
      audience,
      libraryId,
      documentationQuestion,
      includeRisks: body.includeRisks !== false,
      style: { tone, maxWords },
    },
  };
};

const staticAssets = {
  "/": [path.join(publicDirectory, "index.html"), "text/html; charset=utf-8"],
  "/visualizer": [
    path.join(publicDirectory, "visualizer.html"),
    "text/html; charset=utf-8",
  ],
  "/visualizer.html": [
    path.join(publicDirectory, "visualizer.html"),
    "text/html; charset=utf-8",
  ],
  "/app.js": [
    path.join(publicDirectory, "app.js"),
    "text/javascript; charset=utf-8",
  ],
  "/styles.css": [
    path.join(publicDirectory, "styles.css"),
    "text/css; charset=utf-8",
  ],
  "/clearideas-logo.svg": [
    path.resolve(exampleDirectory, "../../docs/public/clearideas-logo.svg"),
    "image/svg+xml",
  ],
  "/vendor/marked.js": [
    path.join(markedDirectory, "marked.umd.js"),
    "text/javascript; charset=utf-8",
  ],
  "/vendor/purify.js": [
    path.join(domPurifyDirectory, "purify.min.js"),
    "text/javascript; charset=utf-8",
  ],
  "/vendor/highlight.js": [
    path.join(highlightDirectory, "highlight.min.js"),
    "text/javascript; charset=utf-8",
  ],
  "/vendor/highlight.css": [
    path.join(highlightDirectory, "styles/github-dark.min.css"),
    "text/css; charset=utf-8",
  ],
};

export const createExampleApp = async (overrides = {}) => {
  const options = {
    host: overrides.host ?? process.env.AGENT_EXAMPLE_HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? process.env.AGENT_EXAMPLE_PORT ?? 4178),
    provider:
      overrides.provider ?? process.env.AGENT_EXAMPLE_PROVIDER ?? "openai",
    model: overrides.model ?? process.env.AGENT_EXAMPLE_MODEL ?? "gpt-5.6-luna",
    driver: overrides.driver ?? process.env.AGENT_EXAMPLE_DRIVER,
    baseURL: overrides.baseURL ?? process.env.AGENT_EXAMPLE_BASE_URL,
    apiKeyEnvironment:
      overrides.apiKeyEnvironment ?? process.env.AGENT_EXAMPLE_API_KEY_ENV,
    context7ApiKeyEnvironment:
      overrides.context7ApiKeyEnvironment ??
      (process.env.CONTEXT7_API_KEY ? "CONTEXT7_API_KEY" : undefined),
    dataDirectory:
      overrides.dataDirectory ?? path.join(exampleDirectory, ".data"),
  };
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  ) {
    throw new Error("AGENT_EXAMPLE_PORT must be a valid TCP port.");
  }
  await mkdir(options.dataDirectory, { recursive: true });

  const agentManifestSource = new FileAgentManifestSource(
    exampleDirectory,
    agentReference,
  );
  const agentManifest = await agentManifestSource.loadManifest();
  const agentRuntimeConfig = parseAgentRuntimeConfig({
    version: "1.0",
    providers: providerConfig(options),
    models: {
      default: {
        provider: options.provider,
        model: options.model,
        capabilities: { streaming: true, tools: true },
      },
    },
    connections: {
      context7: context7ConnectionConfig(options),
    },
  });
  const model =
    overrides.modelAdapter ??
    createConfiguredModelAdapter(agentManifest, agentRuntimeConfig);
  if (!model) throw new Error("The example agent requires a model adapter.");

  const runStore = new FileRunStore(path.join(options.dataDirectory, "local"));
  const toolAdapter =
    overrides.toolAdapter ??
    createConfiguredToolAdapter(agentManifest, agentRuntimeConfig);
  const telemetry = await createExampleTelemetry({
    ...(overrides.telemetrySink ? { sink: overrides.telemetrySink } : {}),
    ...(overrides.telemetryExporter
      ? { exporter: overrides.telemetryExporter }
      : {}),
    ...(overrides.telemetryShutdown
      ? { shutdown: overrides.telemetryShutdown }
      : {}),
  });

  const localEngine = new InProcessExecutionEngine(async (request, context) => {
    const agentRuntime = new AgentRuntime({
      runStore,
      stepExecutors: [new PromptStepExecutor()],
      conditionEvaluator: new JexlConditionEvaluator(),
      model,
      tools: toolAdapter,
      eventSinks: [{ emit: context.emit }, telemetry.sink],
    });
    return agentRuntime.run({
      manifest: request.manifest,
      runId: context.handle.runId,
      ...(request.variables ? { variables: request.variables } : {}),
      ...(request.execution ? { execution: request.execution } : {}),
      signal: context.signal,
      ...(context.mode === "resume" ? { resume: true } : {}),
    });
  });
  const localClient = new ExecutionClient(localEngine);

  let server;
  const serverBaseUrl = () => {
    const address = server?.address();
    if (!address || typeof address === "string")
      throw new Error("Example server is not listening.");
    const host = address.address === "::" ? "127.0.0.1" : address.address;
    return `http://${host}:${address.port}`;
  };
  const remoteExecution = createRemoteExecution({
    baseUrl: serverBaseUrl,
    workerToken: crypto.randomUUID(),
    callbackToken: crypto.randomUUID(),
    dataDirectory: path.join(options.dataDirectory, "remote"),
    resolveConfigReference(reference) {
      if (reference !== runtimeConfigReference) {
        throw new Error("Runtime configuration is not authorized.");
      }
      return agentRuntimeConfig;
    },
    environment: Object.fromEntries(
      [
        options.apiKeyEnvironment ??
          builtInProviderEnvironment[options.provider],
        options.context7ApiKeyEnvironment,
      ]
        .filter(Boolean)
        .flatMap((name) =>
          process.env[name] ? [[name, process.env[name]]] : [],
        ),
    ),
    modelPolicy: {
      requireProfiles: true,
      allowedProviders: [options.provider],
      allowedModels: [`${options.provider}/${options.model}`],
      allowManifestOptions: false,
    },
    toolOptions: {
      authorizeConnection({ binding }) {
        if (binding.ref !== "context7")
          throw new Error("Connection is not authorized.");
      },
      authorizeTool({ toolName }) {
        if (toolName !== "query-docs")
          throw new Error("Tool is not authorized.");
      },
    },
    runtime: {
      ...(overrides.modelAdapter ? { model } : {}),
      ...(overrides.toolAdapter ? { tools: toolAdapter } : {}),
      eventSinks: [telemetry.sink],
    },
  });
  const remoteClient = new ExecutionClient(remoteExecution.engine);

  const handleRun = async (request, response) => {
    let ended = false;
    let activeExecution;
    const abortController = new AbortController();
    const onClose = () => {
      if (ended) return;
      abortController.abort(new Error("Browser disconnected"));
      if (activeExecution) {
        void activeExecution.client
          .cancel(activeExecution.handle)
          .catch(() => undefined);
      }
    };
    response.on("close", onClose);

    const write = (payload) => {
      if (response.destroyed || response.writableEnded) return;
      response.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      const input = runtimeInput(await readBody(request));
      const runId = `run-${crypto.randomUUID()}`;
      const agentRunManifest = parseAgentRunManifest({
        schemaVersion: "1.0",
        agent: { ref: agentReference },
        runId,
        variables: Object.entries(input.variables).map(([key, value]) => ({
          key,
          value,
        })),
        execution: {
          mode: input.scheduling,
          ...(input.scheduling === "parallel" ? { maxConcurrency: 4 } : {}),
        },
      });

      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      write({
        kind: "accepted",
        runId,
        execution: input.execution,
        agentRunManifest,
      });

      const client = input.execution === "remote" ? remoteClient : localClient;
      const handle = await client.submit({
        manifest: agentManifest,
        runId,
        variables: agentRunManifest.variables,
        execution: agentRunManifest.execution,
        configReference: runtimeConfigReference,
      });
      activeExecution = { client, handle };
      if (abortController.signal.aborted) await client.cancel(handle);
      const completed = await client.follow(handle, {
        signal: abortController.signal,
        onEvent: (event) => write({ kind: "event", event }),
      });
      const result = completed.result;
      if (!result) {
        throw new Error(
          completed.status.error?.message ??
            `Execution ${completed.status.status}.`,
        );
      }
      write({
        kind: "result",
        result: {
          runId: result.runId,
          output: result.output ?? null,
          state: result.state,
          stepResults: result.stepResults.map((stepResult) => ({
            stepId: stepResult.stepId,
            stepIndex: stepResult.stepIndex,
            status: stepResult.status,
            ...(stepResult.output === undefined
              ? {}
              : { output: stepResult.output }),
          })),
          usage: result.usage ?? null,
          startedAt: result.startedAt,
          completedAt: result.completedAt,
        },
      });
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(400, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
      }
      write({
        kind: "error",
        error: {
          message: error instanceof Error ? error.message : String(error),
          cancelled: abortController.signal.aborted,
        },
      });
    } finally {
      ended = true;
      response.off("close", onClose);
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  };

  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (await remoteExecution.route(request, response, url)) return;
      if (request.method === "GET" && url.pathname === "/api/config") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(
          JSON.stringify({
            execution: ["local", "remote"],
            streaming: "ndjson",
            provider: options.provider,
            model: options.model,
            mcp: "Context7",
            telemetry: `OpenTelemetry / ${telemetry.exporter}`,
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/agent") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(JSON.stringify(agentManifest));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        await handleRun(request, response);
        return;
      }
      const asset =
        request.method === "GET" ? staticAssets[url.pathname] : undefined;
      if (asset) {
        const content = await readFile(asset[0]);
        response.writeHead(200, {
          "content-type": asset[1],
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(content);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
        });
      }
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  return {
    options,
    server,
    agentManifest: json(agentManifest),
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      }),
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await telemetry.shutdown();
    },
  };
};

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const app = await createExampleApp();
  const address = await app.listen();
  const host =
    typeof address === "object" && address ? address.address : app.options.host;
  const port =
    typeof address === "object" && address ? address.port : app.options.port;
  const displayHost = host === "::" ? "localhost" : host;
  process.stdout.write(
    `Interactive agent example: http://${displayHost}:${port}\n` +
      `Model: ${app.options.provider}/${app.options.model}\n` +
      "Execution: local or remote HTTP\n" +
      "MCP: Context7 public endpoint\n",
  );
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().finally(() => process.exit());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
