/**
 * The OpenAI-compatible agent service: transport-neutral request handling
 * over served agent manifests. `http.ts` adapts it to node:http and to
 * fetch-style handlers.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from "@clearideas/agent-runtime-config";
import type {
  AgentManifest,
  AgentRunBudget,
  AgentVariableOverride,
  ArtifactRef,
  ConversationMessage,
  MessagesSignature,
  RunEvent,
  RunResult,
} from "@clearideas/agent-runtime-contracts";
import {
  AgentRuntime,
  conversationTurns,
  declaresMessages,
  defaultManifestHasher,
  isRunInterruptedError,
  isRunSuspendedError,
  resolveAgentVariables,
  RunInterruptedError,
  type ArtifactAuthorizationContext,
  type ArtifactStore,
  type EventSink,
  type RunStore,
  type StepExecutor,
  type ToolAdapter,
} from "@clearideas/agent-runtime-core";
import { JexlConditionEvaluator } from "@clearideas/agent-runtime-condition-jexl";
import {
  FileAgentManifestSource,
  FileArtifactStore,
  MemoryRunStore,
} from "@clearideas/agent-runtime-store-local";

import { AdmissionController } from "./admission.js";
import {
  canStreamLive,
  observeStepStarts,
  planAnswer,
  type AnswerPlan,
} from "./answer.js";
import {
  Authenticator,
  principalCanUse,
  type AuthenticateHook,
  type Principal,
} from "./auth.js";
import {
  normalizeInputMapping,
  type InputMapping,
  type LoadedServerConfig,
  type ServedModelConfig,
  type ServerConfig,
} from "./config.js";
import {
  convertChatMessages,
  mapInputVariables,
  splitNewTurn,
  type ConvertedChat,
} from "./convert.js";
import { fromRunError, invalidRequest, ServerError } from "./errors.js";
import {
  composeHostRuntime,
  hostRuntimeDependencies,
  loadHostRunStore,
  loadHostRuntime,
  resolveAgentRuntimeConfig,
  type HostRuntime,
  type HostRuntimeContext,
} from "./host.js";
import {
  MemoryKeyValueStore,
  openKeyValueStore,
  type KeyValueStore,
} from "./kv.js";
import { ConversationLedger, type LedgerEntry } from "./ledger.js";
import { MediaIngestor } from "./media.js";
import {
  chatCompletion,
  hasClientTools,
  modelObject,
  parseChatCompletionRequest,
  toOpenAiUsage,
  type ChatCompletionRequest,
  type CompletionIdentity,
  type FinishReason,
} from "./openai.js";
import { ChatStream, stepLabels } from "./stream.js";

// ─── Transport-neutral request and response ────────────────────────────────

export interface ServiceRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Read the body; rejects with 413 beyond `limit` bytes. */
  readBody(limit: number, signal?: AbortSignal): Promise<Buffer>;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
}

export interface ServiceResponse {
  status: number;
  headers: Record<string, string>;
  body?: string | AsyncIterable<string>;
}

// ─── Logging ───────────────────────────────────────────────────────────────

/** Structured log records. Records never contain prompts, messages, or outputs. */
export interface ServerLogger {
  info(record: Record<string, unknown>): void;
  warn(record: Record<string, unknown>): void;
  error(record: Record<string, unknown>): void;
}

export const jsonLogger = (
  write: (line: string) => void = (line) => process.stderr.write(line),
): ServerLogger => {
  const log =
    (level: string) =>
    (record: Record<string, unknown>): void =>
      write(
        `${JSON.stringify({ time: new Date().toISOString(), level, ...record })}\n`,
      );
  return { info: log("info"), warn: log("warn"), error: log("error") };
};

export const silentLogger: ServerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ─── Served models ─────────────────────────────────────────────────────────

/** A manifest the server exposes as a model, validated at startup. */
export interface ServedModel {
  name: string;
  description?: string;
  config: ServedModelConfig;
  manifestFile: string;
  manifest: AgentManifest;
  manifestHash: string;
  /** Unix seconds, for /v1/models. */
  created: number;
  mode: "conversation" | "variable";
  input: InputMapping[];
  /** Where client system messages go. */
  instructionsVariable: string | undefined;
  answer: AnswerPlan;
  labels: ReadonlyMap<string, string>;
  /** Signatures are required by the manifest or the host. */
  signaturesRequired: boolean;
  onUnrecognized: "unsigned" | "reject" | "restart";
}

export interface AgentServerOptions {
  loaded: LoadedServerConfig;
  /**
   * Adapters supplied in code, with the highest precedence: for example a
   * model adapter when embedding, or a scripted model in tests.
   */
  runtime?: HostRuntime;
  /** Host authentication hook; overrides one exported by the runtime module. */
  authenticate?: AuthenticateHook;
  /** Environment for API key references. Defaults to the process environment. */
  environment?: Readonly<Record<string, string | undefined>>;
  logger?: ServerLogger;
  /** Run MCP tool discovery at startup so pinned tool metadata is verified before traffic. */
  warmup?: boolean;
}

const RETENTION_NAMESPACE = "retention:v1";

const packageVersion = async (): Promise<string> => {
  try {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    return (JSON.parse(await readFile(file, "utf8")) as { version: string })
      .version;
  } catch {
    return "unknown";
  }
};

/**
 * A tool adapter for startup checks that defers discovery to the first
 * request: tool names are reported as not yet checked rather than unknown.
 */
const deferredTools = (): ToolAdapter => ({
  listTools: async () => [],
  executeTool: async () => {
    throw new Error("Tools are not available during startup checks.");
  },
  unavailableToolReason: () => "checked when a request runs",
});

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "localhost" ||
  host.startsWith("127.");

export class AgentServer {
  readonly config: ServerConfig;
  readonly version: string;
  readonly #loaded: LoadedServerConfig;
  readonly #options: AgentServerOptions;
  readonly #logger: ServerLogger;
  readonly #models: Map<string, ServedModel>;
  readonly #runtimeConfig: AgentRuntimeConfig;
  readonly #auth: Authenticator;
  readonly #admission: AdmissionController;
  readonly #runStore: RunStore;
  readonly #artifacts: ArtifactStore;
  readonly #stores: Map<string, KeyValueStore>;
  readonly #ledger: ConversationLedger;
  readonly #media: MediaIngestor;
  /** Runs awaiting deletion. Never evicted, or a run would be kept forever. */
  readonly #retention: KeyValueStore;
  readonly #active = new Map<string, AbortController>();
  readonly #settled = new Set<Promise<unknown>>();
  readonly #cleanup: Array<() => void | Promise<void>>;
  #retentionTimer: ReturnType<typeof setInterval> | undefined;
  #draining = false;

  private constructor(init: {
    loaded: LoadedServerConfig;
    options: AgentServerOptions;
    logger: ServerLogger;
    models: Map<string, ServedModel>;
    runtimeConfig: AgentRuntimeConfig;
    auth: Authenticator;
    runStore: RunStore;
    artifacts: ArtifactStore;
    stores: Map<string, KeyValueStore>;
    version: string;
    cleanup: Array<() => void | Promise<void>>;
  }) {
    this.#loaded = init.loaded;
    this.config = init.loaded.config;
    this.#options = init.options;
    this.#logger = init.logger;
    this.#models = init.models;
    this.#runtimeConfig = init.runtimeConfig;
    this.#auth = init.auth;
    this.#runStore = init.runStore;
    this.#artifacts = init.artifacts;
    this.#stores = init.stores;
    this.version = init.version;
    this.#cleanup = init.cleanup;
    const server = this.config.server;
    this.#admission = new AdmissionController({
      maxConcurrentRuns: server.maxConcurrentRuns,
      maxQueuedRequests: server.maxQueuedRequests,
      queueTimeoutMs: server.queueTimeoutMs,
    });
    const conversations = this.config.conversations;
    const ledgerStore = this.#store(conversations.ledger.store);
    this.#ledger = new ConversationLedger(ledgerStore, {
      ttlMs: conversations.ledger.ttl,
      match: conversations.match,
    });
    this.#retention =
      this.config.stores.default?.driver === "sqlite"
        ? this.#store("default")
        : new MemoryKeyValueStore({ maxEntries: Number.MAX_SAFE_INTEGER });
    this.#media = new MediaIngestor(ledgerStore, {
      maxInlineBytes:
        this.#runtimeConfig.messages?.media?.maxInlineBytes ?? 10 * 1024 * 1024,
      urls: conversations.media.urls,
      allowOrigins: conversations.media.allowOrigins,
      ttlMs: conversations.ledger.ttl,
    });
    this.#retentionTimer = setInterval(() => {
      void this.sweepRetention().catch((error: unknown) =>
        this.#logger.warn({
          event: "retention.failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, 60_000);
    this.#retentionTimer.unref?.();
  }

  /**
   * Load the runtime configuration and every served manifest, validate
   * them, and run preflight. Any problem stops startup.
   */
  static async create(options: AgentServerOptions): Promise<AgentServer> {
    const { loaded } = options;
    const config = loaded.config;
    const logger = options.logger ?? jsonLogger();
    const cleanup: Array<() => void | Promise<void>> = [];
    try {
      const runtimeConfig = config.runtimeConfig
        ? await loadAgentRuntimeConfig(config.runtimeConfig)
        : await resolveAgentRuntimeConfig(undefined, loaded.baseDirectory);

      const stores = new Map<string, KeyValueStore>();
      for (const [name, storeConfig] of Object.entries(config.stores)) {
        const store = await openKeyValueStore(storeConfig);
        stores.set(name, store);
        cleanup.push(() => store.close?.());
      }
      if (!stores.has("default")) {
        const store = await openKeyValueStore({
          driver: "memory",
          maxEntries: 100_000,
        });
        stores.set("default", store);
      }

      const storeDirectory = config.store.path
        ? path.dirname(config.store.path)
        : loaded.baseDirectory;
      let runStore: RunStore;
      if (config.store.driver === "sqlite") {
        const { SqliteRunStore } =
          await import("@clearideas/agent-runtime-store-sqlite");
        const sqlite = new SqliteRunStore(config.store.path!);
        runStore = sqlite;
        cleanup.push(() => sqlite.close());
      } else if (config.store.driver === "module") {
        const moduleStore = await loadHostRunStore(config.runtimeModule, {
          storeDirectory,
          storeDriver: "module",
        });
        if (!moduleStore)
          throw new Error(
            "store.driver: module requires a runtime module that exports runStore or createRunStore.",
          );
        runStore = moduleStore;
      } else {
        runStore = new MemoryRunStore();
      }

      let artifactDirectory = config.artifacts.path;
      if (!artifactDirectory) {
        // Without a configured location, artifacts live for the process.
        const temporary = await mkdtemp(
          path.join(tmpdir(), "agent-runtime-serve-"),
        );
        cleanup.push(() => rm(temporary, { recursive: true, force: true }));
        artifactDirectory = temporary;
      }
      const artifacts = new FileArtifactStore(artifactDirectory);

      const moduleHook = config.runtimeModule
        ? await loadAuthenticateHook(config.runtimeModule)
        : undefined;
      const hook = options.authenticate ?? moduleHook;
      const auth = new Authenticator({
        keys: config.auth.apiKeys,
        ...(options.environment ? { environment: options.environment } : {}),
        ...(hook ? { hook } : {}),
        allowAnonymous: true,
      });
      if (
        auth.anonymous &&
        !isLoopback(config.server.host) &&
        !config.server.allowUnauthenticated
      ) {
        throw new Error(
          `Refusing to serve without authentication on ${config.server.host}. Configure API keys (auth.apiKeys or --api-key-env), bind to 127.0.0.1, or set allowUnauthenticated.`,
        );
      }

      const created = Math.floor(Date.now() / 1000);
      const models = new Map<string, ServedModel>();
      for (const modelConfig of config.models) {
        models.set(
          modelConfig.name,
          await loadServedModel({
            modelConfig,
            config,
            runtimeConfig,
            storeDirectory,
            artifacts,
            created,
            ...(options.runtime ? { programmatic: options.runtime } : {}),
            warmup: options.warmup === true,
          }),
        );
      }

      return new AgentServer({
        loaded,
        options,
        logger,
        models,
        runtimeConfig,
        auth,
        runStore,
        artifacts,
        stores,
        version: await packageVersion(),
        cleanup,
      });
    } catch (error) {
      for (const close of cleanup.reverse()) await close();
      throw error;
    }
  }

  #store(name: string): KeyValueStore {
    const store = this.#stores.get(name);
    if (!store) throw new Error(`Unknown store ${name}.`);
    return store;
  }

  get ready(): boolean {
    return !this.#draining;
  }

  get authenticated(): boolean {
    return !this.#auth.anonymous;
  }

  get models(): readonly ServedModel[] {
    return [...this.#models.values()];
  }

  // ─── Request handling ────────────────────────────────────────────────────

  async handle(request: ServiceRequest): Promise<ServiceResponse> {
    const started = Date.now();
    const requestId = requestIdFrom(request.headers);
    const log: Record<string, unknown> = {
      event: "request",
      requestId,
      method: request.method,
      path: request.path,
    };
    const cors = this.#cors(request.headers);
    const finish = (response: ServiceResponse): ServiceResponse => {
      const headers = {
        ...cors,
        "x-request-id": requestId,
        ...response.headers,
      };
      const done = (): void =>
        this.#logger.info({
          ...log,
          status: response.status,
          durationMs: Date.now() - started,
        });
      if (response.body && typeof response.body !== "string") {
        return { ...response, headers, body: logOnEnd(response.body, done) };
      }
      done();
      return { ...response, headers };
    };
    try {
      if (request.method === "OPTIONS") {
        return finish({ status: 204, headers: {} });
      }
      return finish(await this.#route(request, log));
    } catch (caught) {
      const error =
        caught instanceof ServerError
          ? caught
          : fromRunError(caught, {
              exposeErrors: this.config.server.exposeErrors,
            });
      if (error.status >= 500) {
        log.errorCode = error.code;
        log.cause =
          caught instanceof Error && this.config.server.exposeErrors
            ? caught.message
            : undefined;
      }
      return finish(errorResponse(error));
    }
  }

  #cors(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Record<string, string> {
    const origin = header(headers, "origin");
    const allowed = this.config.server.cors.origins;
    if (!origin || !(allowed.includes("*") || allowed.includes(origin)))
      return {};
    return {
      "access-control-allow-origin": allowed.includes("*") ? "*" : origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        "authorization, content-type, x-request-id",
      "access-control-max-age": "600",
      vary: "origin",
    };
  }

  async #route(
    request: ServiceRequest,
    log: Record<string, unknown>,
  ): Promise<ServiceResponse> {
    const { method } = request;
    const route = request.path.replace(/\/+$/u, "") || "/";
    if (route === "/health" && method === "GET")
      return json(200, { status: "ok" });
    if (route === "/ready" && method === "GET")
      return this.ready
        ? json(200, { status: "ready" })
        : json(503, { status: "draining" });
    if (route === "/version" && method === "GET")
      return json(200, { version: this.version });
    if (!route.startsWith("/v1/"))
      throw new ServerError(
        404,
        "not_found",
        `No route for ${method} ${route}.`,
      );

    const principal = await this.#auth.authenticate({
      method,
      path: route,
      headers: request.headers,
    });
    log.principal = principal.id;

    if (route === "/v1/models" && method === "GET") {
      return json(200, {
        object: "list",
        data: this.models
          .filter((model) => principalCanUse(principal, model.name))
          .map((model) =>
            modelObject(model.name, model.created, model.description),
          ),
      });
    }
    if (route.startsWith("/v1/models/") && method === "GET") {
      const name = decodeURIComponent(route.slice("/v1/models/".length));
      const model = this.#models.get(name);
      if (!model || !principalCanUse(principal, name))
        throw modelNotFound(name);
      return json(
        200,
        modelObject(model.name, model.created, model.description),
      );
    }
    if (route === "/v1/chat/completions" && method === "POST") {
      return this.#chatCompletion(request, principal, log);
    }
    throw new ServerError(404, "not_found", `No route for ${method} ${route}.`);
  }

  // ─── Chat completions ────────────────────────────────────────────────────

  async #chatCompletion(
    request: ServiceRequest,
    principal: Principal,
    log: Record<string, unknown>,
  ): Promise<ServiceResponse> {
    if (this.#draining)
      throw new ServerError(
        503,
        "service_unavailable",
        "The server is shutting down.",
      );
    const server = this.config.server;
    const runId = `run_${randomUUID()}`;
    const controller = new AbortController();
    let model: ServedModel | undefined;
    const onDisconnect = (): void => {
      if (
        model?.config.onDisconnect !== "continue" &&
        !controller.signal.aborted
      )
        controller.abort(
          new ServerError(
            499,
            "client_closed_request",
            "The client disconnected.",
          ),
        );
    };
    request.signal.addEventListener("abort", onDisconnect, { once: true });
    if (request.signal.aborted) onDisconnect();
    const timer = setTimeout(() => {
      controller.abort(
        new ServerError(504, "timeout", "The request timed out."),
      );
    }, server.requestTimeoutMs);
    timer.unref?.();

    // Track the entire request, including body ingestion, queueing and setup.
    let settle!: () => void;
    const tracked = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#settled.add(tracked);
    this.#active.set(runId, controller);
    let release: (() => void) | undefined;
    let cleaned = false;
    let executing = false;
    let prepared: PreparedRun | undefined;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onDisconnect);
      this.#active.delete(runId);
      release?.();
      this.#settled.delete(tracked);
      settle();
    };
    try {
      const body = await abortable(
        request.readBody(server.maxRequestBytes, controller.signal),
        controller.signal,
      );
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body.toString("utf8"));
      } catch {
        throw invalidRequest("The request body must be JSON.");
      }
      const requested = modelName(parsedBody);
      model = requested ? this.#models.get(requested) : undefined;
      const chat = parseChatCompletionRequest(
        parsedBody,
        model?.config.clientTools ?? "reject",
      );
      if (!model || !principalCanUse(principal, chat.model))
        throw modelNotFound(chat.model);
      log.model = model.name;
      if (hasClientTools(chat)) log.clientTools = "ignored";
      checkResponseFormat(model, chat);
      if (this.#draining)
        throw new ServerError(
          503,
          "service_unavailable",
          "The server is shutting down.",
        );

      log.runId = runId;
      const stream = chat.stream === true;
      log.stream = stream;
      const identity: CompletionIdentity = {
        id: `chatcmpl-${runId}`,
        created: Math.floor(Date.now() / 1000),
        model: model.name,
        systemFingerprint: `ar_${this.version}_${model.manifestHash.replace(/^[^:]*:/u, "").slice(0, 12)}`,
      };

      release = await this.#admission.acquire(
        principal.id,
        principal.maxConcurrentRuns,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      prepared = await this.#prepareRun({
        model,
        chat,
        principal,
        runId,
        log,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      const execution = this.#execute({
        model,
        prepared,
        runId,
        signal: controller.signal,
        stream: stream
          ? new ChatStream({
              identity,
              includeUsage: chat.stream_options?.include_usage === true,
              progress: model.config.stream.progress,
              reasoning: model.config.stream.reasoning,
              progressField: model.config.stream.progressField,
              heartbeatMs: server.heartbeatMs,
              stepLabels: model.labels,
              onCancel: onDisconnect,
              onError: (error) => controller.abort(error),
            })
          : undefined,
        log,
      });
      executing = true;
      void execution.done.then(cleanup, cleanup);

      if (!stream) {
        const outcome = await execution.done;
        return json(
          200,
          chatCompletion(
            identity,
            outcome.reply,
            outcome.finishReason,
            toOpenAiUsage(outcome.result?.usage),
          ),
          outcome.headers,
        );
      }

      // Streamed: respond once the run has started, so errors found while
      // creating the run (invalid history, signatures) keep their status.
      const startedStream = await execution.started;
      return {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...startedStream.headers,
        },
        body: startedStream.body,
      };
    } catch (error) {
      if (!executing) {
        try {
          await prepared?.moduleRuntime.shutdown?.();
        } finally {
          cleanup();
        }
      }
      throw abortError(controller.signal) ?? error;
    }
  }

  /** Build the run input: history or variables, scope, budget. */
  async #prepareRun(input: {
    model: ServedModel;
    chat: ChatCompletionRequest;
    principal: Principal;
    runId: string;
    log: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<PreparedRun> {
    const { model, chat, principal } = input;
    const conversations = this.config.conversations;
    const scope =
      principal.scope ??
      `key:${principal.id}${
        conversations.scope.includeUser && chat.user ? `/user:${chat.user}` : ""
      }`;

    const moduleContext: HostRuntimeContext = {
      manifest: model.manifest,
      runId: input.runId,
      storeDirectory: this.config.store.path
        ? path.dirname(this.config.store.path)
        : this.#loaded.baseDirectory,
      storeDriver: this.config.store.driver,
      ...(this.config.store.path
        ? { storeLocation: this.config.store.path }
        : {}),
    };
    // The runtime module is loaded for every request, as the CLI loads it
    // for every run; the server owns the run store.
    const moduleRuntime = await abortable(
      loadHostRuntime(this.config.runtimeModule, moduleContext, {
        createRunStore: false,
      }),
      input.signal,
      (late) => late.shutdown?.(),
    );
    try {
      const moduleAuthorize = moduleRuntime.messages?.authorizeArtifact;
      const overlay = modelOverlay(model.config, this.#options.runtime, {
        authorizeArtifact: async (
          ref: ArtifactRef,
          context: ArtifactAuthorizationContext,
        ) =>
          (await this.#media.authorize(ref, context.scope)) ||
          (moduleAuthorize
            ? (await moduleAuthorize(ref, context)) === true
            : false),
      });
      const runtime = composeHostRuntime(model.manifest, this.#runtimeConfig, [
        moduleRuntime,
        overlay,
      ]);
      const artifacts = runtime.artifactStore ?? this.#artifacts;

      const converted = await abortable(
        convertChatMessages(chat.messages, {
          allowMedia: model.mode === "conversation",
          clientTools: model.config.clientTools,
          media: this.#media,
          scope,
          artifacts,
        }),
        input.signal,
      );
      const variables: AgentVariableOverride[] = mapInputVariables({
        mappings: model.input,
        chat: converted,
        request: chat,
      });
      if (model.instructionsVariable && converted.instructions) {
        variables.push({
          key: model.instructionsVariable,
          value: converted.instructions,
        });
      }
      try {
        resolveAgentVariables(model.manifest, variables);
      } catch (error) {
        throw invalidRequest(
          error instanceof Error ? error.message : String(error),
          "messages",
        );
      }

      let history: Pick<PreparedRun, "messages" | "signature" | "ledger"> = {
        ledger: "not-applicable",
      };
      if (model.mode === "conversation") {
        history = await abortable(
          this.#resolveHistory(model, converted, scope),
          input.signal,
        );
        input.log.ledger = history.ledger;
      }

      const budget = runBudget(model, chat, principal);
      return {
        runtime,
        moduleRuntime,
        artifacts,
        scope,
        converted,
        variables,
        ...history,
        ...(budget ? { budget } : {}),
      };
    } catch (error) {
      await moduleRuntime.shutdown?.();
      throw error;
    }
  }

  /** Continue from the runtime's own history when the ledger recognizes the conversation. */
  async #resolveHistory(
    model: ServedModel,
    converted: ConvertedChat,
    scope: string,
  ): Promise<Pick<PreparedRun, "messages" | "signature" | "ledger">> {
    const { prefix, newTurn } = splitNewTurn(converted.messages);
    if (prefix.length === 0)
      return { messages: converted.messages, ledger: "first-turn" };
    const entry = await this.#ledger.lookup({
      scope,
      model: model.name,
      messages: prefix,
    });
    if (entry) {
      if (
        entry.manifestHash !== model.manifestHash &&
        this.config.conversations.onManifestChange === "restart"
      ) {
        return { messages: newTurn, ledger: "restarted" };
      }
      return {
        messages: [...entry.history, ...newTurn],
        ...(entry.signature ? { signature: entry.signature } : {}),
        ledger: "hit",
      };
    }
    switch (model.onUnrecognized) {
      case "reject":
        throw new ServerError(
          409,
          "conversation_not_recognized",
          "This conversation was not issued by this server or has changed. Start a new conversation.",
          { type: "invalid_request_error", param: "messages" },
        );
      case "restart":
        return { messages: newTurn, ledger: "restarted" };
      default:
        return { messages: converted.messages, ledger: "unsigned" };
    }
  }

  /**
   * Execute a prepared run. `started` resolves when the run has been created
   * (streaming responses start then); `done` settles with the outcome.
   */
  #execute(input: {
    model: ServedModel;
    prepared: PreparedRun;
    runId: string;
    signal: AbortSignal;
    stream: ChatStream | undefined;
    log: Record<string, unknown>;
  }): {
    started: Promise<{
      body: AsyncIterable<string>;
      headers: Record<string, string>;
    }>;
    done: Promise<RunOutcome>;
  } {
    const { model, prepared, runId, stream } = input;
    const headers: Record<string, string> = {
      "x-agent-runtime-run-id": runId,
      ...(prepared.messages
        ? {
            "x-agent-runtime-turn": String(
              conversationTurns(prepared.messages).currentTurn,
            ),
          }
        : {}),
      ...(prepared.ledger === "restarted"
        ? { "x-agent-runtime-conversation": "restarted" }
        : {}),
    };
    let resolveStarted!: (value: {
      body: AsyncIterable<string>;
      headers: Record<string, string>;
    }) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<{
      body: AsyncIterable<string>;
      headers: Record<string, string>;
    }>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    void started.catch(() => undefined);
    let runStarted = false;

    const completedCandidates = new Set<string>();
    const candidateIds = new Set(
      model.answer.candidates.map((candidate) => candidate.stepId),
    );
    const evaluator = new JexlConditionEvaluator();
    const requestSink: EventSink = {
      emit: (event: RunEvent): void => {
        if (event.type === "run.started" && !runStarted) {
          runStarted = true;
          if (stream) {
            stream.start();
            resolveStarted({ body: stream.body, headers });
          }
        }
        if (
          event.type === "step.completed" &&
          event.stepId &&
          candidateIds.has(event.stepId) &&
          (event.stepPath === undefined || event.stepPath === event.stepId)
        ) {
          completedCandidates.add(event.stepId);
        }
        if (
          event.type === "context.reduced" &&
          event.data?.scope === "messages"
        )
          input.log.compacted = true;
      },
    };

    const dependencies = hostRuntimeDependencies(prepared.runtime, {
      trust: "untrusted-request",
      runStore: this.#runStore,
      artifacts: prepared.artifacts,
      eventSinks: [requestSink, ...(stream ? [stream.sink] : [])],
    });
    dependencies.stepExecutors = [...dependencies.stepExecutors].map(
      (executor): StepExecutor =>
        executor.type !== "prompt" || !stream
          ? executor
          : observeStepStarts(executor, async (step, variables) => {
              if (
                !candidateIds.has(step.id) ||
                model.config.output.from !== "final"
              )
                return;
              if (
                await canStreamLive({
                  manifest: model.manifest,
                  plan: model.answer,
                  mode: model.config.stream.mode,
                  step,
                  variables,
                  completedCandidates,
                  evaluator,
                })
              ) {
                stream.setLiveStep(step.id);
                input.log.live = step.id;
              }
            }),
    );
    const agentRuntime = new AgentRuntime(dependencies);

    const done = (async (): Promise<RunOutcome> => {
      try {
        let result: RunResult | undefined;
        let finishReason: FinishReason = "stop";
        try {
          result = await agentRuntime.run({
            manifest: model.manifest,
            runId,
            ...(prepared.variables.length > 0
              ? { variables: prepared.variables }
              : {}),
            ...(model.config.execution
              ? { execution: model.config.execution }
              : {}),
            ...(prepared.budget ? { budget: prepared.budget } : {}),
            ...(prepared.messages ? { messages: prepared.messages } : {}),
            ...(prepared.signature
              ? { messagesSignature: prepared.signature }
              : {}),
            ...(model.mode === "conversation"
              ? { messagesScope: prepared.scope }
              : {}),
            signal: input.signal,
          });
        } catch (error) {
          if (!(isRunSuspendedError(error) && error.reason === "token-budget"))
            throw error;
          finishReason = "length";
        } finally {
          // Requests refused before the run was created leave nothing to keep.
          if (runStarted)
            await this.#scheduleRetention(
              runId,
              result ? "completed" : "failed",
            );
        }

        let reply = "";
        if (result) {
          reply = replyText(model, result);
          if (model.mode === "conversation") {
            await this.#recordConversation(
              model,
              prepared,
              result,
              reply,
              runId,
            );
          }
        } else if (stream) {
          reply = stream.forwarded;
        }
        if (result?.usage) {
          input.log.tokens =
            result.usage.totalTokens ??
            (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
        }
        if (stream) {
          stream.finish({
            reply,
            finishReason,
            usage: toOpenAiUsage(result?.usage),
          });
          if (stream.diverged) {
            input.log.diverged = true;
            this.#logger.warn({ event: "stream.diverged", runId });
          }
          if (!runStarted) resolveStarted({ body: stream.body, headers });
        }
        return {
          reply,
          finishReason,
          ...(result ? { result } : {}),
          headers,
        };
      } catch (caught) {
        const error =
          abortError(input.signal) ??
          fromRunError(caught, {
            exposeErrors: this.config.server.exposeErrors,
          });
        input.log.errorCode = error.code;
        if (stream && runStarted) {
          stream.fail(error);
          return { reply: "", finishReason: "stop", headers, failed: error };
        }
        rejectStarted(error);
        throw error;
      } finally {
        await prepared.moduleRuntime.shutdown?.();
      }
    })();
    void done.catch(() => undefined);
    return { started, done };
  }

  async #recordConversation(
    model: ServedModel,
    prepared: PreparedRun,
    result: RunResult,
    reply: string,
    runId: string,
  ): Promise<void> {
    if (!result.messages) return;
    const entry: LedgerEntry = {
      history: result.messages,
      ...(result.messagesSignature
        ? { signature: result.messagesSignature }
        : {}),
      scope: prepared.scope,
      runId,
      model: model.name,
      manifestHash: model.manifestHash,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.#ledger.record({
        messages: [
          ...prepared.converted.messages,
          { role: "assistant", content: [{ type: "text", text: reply }] },
        ],
        entry,
      });
    } catch (error) {
      // The reply is still delivered; the next turn is handled by
      // onUnrecognized.
      this.#logger.warn({
        event: "ledger.record-failed",
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ─── Retention ───────────────────────────────────────────────────────────

  async #scheduleRetention(
    runId: string,
    outcome: "completed" | "failed",
  ): Promise<void> {
    const retention = this.config.store.retention;
    await this.#retention.set(
      RETENTION_NAMESPACE,
      runId,
      outcome,
      outcome === "completed" ? retention.completed : retention.failed,
    );
  }

  /** Delete runs whose retention period has passed. */
  async sweepRetention(): Promise<number> {
    await this.#ledger.sweepExpired();
    await this.#media.sweepExpired();
    if (!this.#runStore.deleteRun) return 0;
    let deleted = 0;
    while (true) {
      const due = await this.#retention.takeExpired(RETENTION_NAMESPACE, 100);
      for (const { key } of due) {
        try {
          if (await this.#runStore.deleteRun(key)) deleted += 1;
        } catch {
          // Still running (a resumed run): look again later.
          await this.#retention.set(
            RETENTION_NAMESPACE,
            key,
            "retry",
            3_600_000,
          );
        }
      }
      if (due.length < 100) return deleted;
    }
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────

  /**
   * Stop admitting requests, let runs finish within the grace period, then
   * interrupt the rest (they stay resumable), and release resources.
   */
  async shutdown(graceMs = this.config.server.shutdownGraceMs): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    const pending = Promise.allSettled([...this.#settled]);
    const graceful = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), graceMs);
        timer.unref?.();
      }),
    ]);
    if (!graceful) {
      for (const controller of this.#active.values()) {
        controller.abort(new RunInterruptedError("server shutdown"));
      }
      await Promise.allSettled([...this.#settled]);
    }
    for (const close of this.#cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        this.#logger.warn({
          event: "shutdown.cleanup-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

interface PreparedRun {
  runtime: HostRuntime;
  moduleRuntime: HostRuntime;
  artifacts: ArtifactStore;
  scope: string;
  converted: ConvertedChat;
  variables: AgentVariableOverride[];
  messages?: ConversationMessage[];
  signature?: MessagesSignature;
  ledger: "not-applicable" | "first-turn" | "hit" | "unsigned" | "restarted";
  budget?: AgentRunBudget;
}

interface RunOutcome {
  reply: string;
  finishReason: FinishReason;
  result?: RunResult;
  headers: Record<string, string>;
  failed?: ServerError;
}

const header = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const requestIdFrom = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string => {
  const supplied = header(headers, "x-request-id");
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied)
    ? supplied
    : `req_${randomUUID()}`;
};

const json = (
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): ServiceResponse => ({
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  },
  body: JSON.stringify(value),
});

const errorResponse = (error: ServerError): ServiceResponse =>
  json(
    error.status,
    error.toBody(),
    error.retryAfter !== undefined
      ? { "retry-after": String(error.retryAfter) }
      : {},
  );

/** The error an aborted run reports: timeout, disconnect, or shutdown. */
const abortError = (signal: AbortSignal): ServerError | undefined => {
  if (!signal.aborted) return undefined;
  if (signal.reason instanceof ServerError) return signal.reason;
  if (isRunInterruptedError(signal.reason))
    return new ServerError(
      503,
      "service_unavailable",
      "The server is shutting down; retry the request.",
      { retryAfter: 5 },
    );
  return undefined;
};

/** The requested model name, read before full validation selects its policy. */
const modelName = (body: unknown): string | undefined =>
  body != null &&
  typeof body === "object" &&
  typeof (body as { model?: unknown }).model === "string"
    ? (body as { model: string }).model
    : undefined;

const modelNotFound = (name: string): ServerError =>
  new ServerError(
    404,
    "model_not_found",
    `The model ${JSON.stringify(name)} does not exist or you do not have access to it.`,
    { type: "invalid_request_error", param: "model" },
  );

async function* logOnEnd(
  body: AsyncIterable<string>,
  done: () => void,
): AsyncIterable<string> {
  try {
    yield* body;
  } finally {
    done();
  }
}

/** The reply text: the appended history message, or the selected output. */
const replyText = (model: ServedModel, result: RunResult): string => {
  if (model.mode === "conversation") {
    if (result.output === undefined) {
      throw new ServerError(
        500,
        "agent_no_reply",
        "The agent completed without a reply.",
      );
    }
    const last = result.messages?.at(-1);
    const text =
      last?.role === "assistant"
        ? last.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
        : undefined;
    return text ?? stringify(result.output);
  }
  const from = model.config.output.from;
  const value = from.startsWith("step:")
    ? result.stepResults.find((entry) => entry.stepId === from.slice(5))?.output
    : from.startsWith("variable:")
      ? result.state[from.slice(9)]
      : result.output;
  return value === undefined ? "" : stringify(value);
};

const stringify = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const runBudget = (
  model: ServedModel,
  chat: ChatCompletionRequest,
  principal: Principal,
): AgentRunBudget | undefined => {
  const limits = [
    model.config.budget?.maxTotalTokens,
    principal.maxTotalTokensPerRequest,
    model.config.maxTokens === "budget"
      ? (chat.max_completion_tokens ?? chat.max_tokens ?? undefined)
      : undefined,
  ].filter((value): value is number => typeof value === "number");
  return limits.length > 0
    ? { maxTotalTokens: Math.min(...limits) }
    : undefined;
};

const checkResponseFormat = (
  model: ServedModel,
  chat: ChatCompletionRequest,
): void => {
  const format = chat.response_format;
  if (!format || format.type === "text") return;
  const steps = model.answer.candidates.map(
    (candidate) => model.manifest.steps[candidate.index]!,
  );
  const schemas = steps.map((step) =>
    step.type === "prompt" ? step.outputSchema : undefined,
  );
  const structured = schemas.length > 0 && schemas.every(Boolean);
  if (format.type === "json_object" && structured) return;
  if (
    format.type === "json_schema" &&
    structured &&
    schemas.every(
      (schema) =>
        JSON.stringify(schema) ===
        JSON.stringify(
          (format as { json_schema: { schema?: unknown } }).json_schema.schema,
        ),
    )
  )
    return;
  throw invalidRequest(
    "response_format is fixed by the served agent's manifest and does not match this request.",
    "response_format",
  );
};

/** Server-configured and programmatic adapters, applied over the runtime module. */
const modelOverlay = (
  config: ServedModelConfig,
  programmatic: HostRuntime | undefined,
  messages: Pick<NonNullable<HostRuntime["messages"]>, "authorizeArtifact">,
): HostRuntime => ({
  ...programmatic,
  ...(config.policies ? { policies: config.policies } : {}),
  ...(config.enforcedPolicies
    ? { enforcedPolicies: config.enforcedPolicies }
    : {}),
  messages: { ...programmatic?.messages, ...messages },
});

const loadAuthenticateHook = async (
  modulePath: string,
): Promise<AuthenticateHook | undefined> => {
  const imported = (await import(
    pathToFileURL(path.resolve(modulePath)).href
  )) as { authenticate?: unknown; default?: { authenticate?: unknown } };
  const hook = imported.authenticate ?? imported.default?.authenticate;
  if (hook === undefined) return undefined;
  if (typeof hook !== "function")
    throw new Error(
      "The runtime module's authenticate export must be a function.",
    );
  return hook as AuthenticateHook;
};

/** Load, validate, and preflight one served manifest. */
const loadServedModel = async (options: {
  modelConfig: ServedModelConfig;
  config: ServerConfig;
  runtimeConfig: AgentRuntimeConfig;
  storeDirectory: string;
  artifacts: ArtifactStore;
  created: number;
  programmatic?: HostRuntime;
  warmup: boolean;
}): Promise<ServedModel> => {
  const { modelConfig, config } = options;
  const prefix = `Served model ${modelConfig.name}`;
  const manifestFile = modelConfig.manifest;
  let manifest: AgentManifest;
  try {
    manifest = await new FileAgentManifestSource(
      path.dirname(manifestFile),
      path.basename(manifestFile),
    ).loadManifest();
  } catch (error) {
    throw new Error(
      `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const declared = new Map(
    (manifest.variables ?? []).map((variable) => [variable.key, variable]),
  );
  const mode = declaresMessages(manifest) ? "conversation" : "variable";

  // Input mappings: explicit, or inferred for a single required string variable.
  let mappings: InputMapping[];
  if (modelConfig.input) {
    mappings = Object.entries(modelConfig.input).map(([variable, source]) =>
      normalizeInputMapping(variable, source),
    );
  } else if (mode === "conversation") {
    mappings = [];
  } else {
    const required = [...declared.values()].filter(
      (variable) => variable.requiresOverride === true,
    );
    const only = required[0];
    if (required.length === 1 && only?.type === "string") {
      mappings = [{ variable: only.key, source: "last-user" }];
    } else {
      const names = [...declared.keys()];
      throw new Error(
        `${prefix}: cannot tell which variable receives the chat. The manifest does not declare messages, and ${
          required.length === 0
            ? "declares no required string variable"
            : `requires ${required.map((variable) => variable.key).join(", ")}`
        }. Map inputs explicitly, for example --input ${names[0] ?? "question"}=last-user (sources: last-user, transcript, system, json, client).`,
      );
    }
  }
  for (const mapping of mappings) {
    const variable = declared.get(mapping.variable);
    if (!variable) {
      throw new Error(
        `${prefix}: input maps undeclared variable ${mapping.variable}. Declared: ${[...declared.keys()].join(", ") || "none"}.`,
      );
    }
    if (
      (mapping.source === "last-user" ||
        mapping.source === "transcript" ||
        mapping.source === "system") &&
      variable.type !== "string"
    ) {
      throw new Error(
        `${prefix}: variable ${mapping.variable} has type ${variable.type}; source ${mapping.source} supplies a string.`,
      );
    }
  }
  const instructionsVariable = modelConfig.clientInstructions.startsWith(
    "variable:",
  )
    ? modelConfig.clientInstructions.slice("variable:".length)
    : undefined;
  if (
    instructionsVariable &&
    declared.get(instructionsVariable)?.type !== "string"
  ) {
    throw new Error(
      `${prefix}: clientInstructions names ${instructionsVariable}, which must be a declared string variable.`,
    );
  }
  const supplied = new Set([
    ...mappings.map((mapping) => mapping.variable),
    ...(instructionsVariable ? [instructionsVariable] : []),
  ]);
  const unmapped = [...declared.values()].filter(
    (variable) =>
      variable.requiresOverride === true && !supplied.has(variable.key),
  );
  if (unmapped.length > 0) {
    throw new Error(
      `${prefix}: required variables ${unmapped.map((variable) => variable.key).join(", ")} are not mapped from the request.`,
    );
  }
  if (mode === "conversation" && modelConfig.output.from !== "final") {
    throw new Error(
      `${prefix}: the manifest declares messages, so its reply is the run's final output; output.from cannot be changed.`,
    );
  }
  if (modelConfig.output.from.startsWith("step:")) {
    const stepId = modelConfig.output.from.slice(5);
    if (!manifest.steps.some((step) => step.id === stepId))
      throw new Error(`${prefix}: output.from names unknown step ${stepId}.`);
  }

  // Compose once and preflight, with the same composition requests use.
  const moduleRuntime = await loadHostRuntime(
    config.runtimeModule,
    {
      manifest,
      storeDirectory: options.storeDirectory,
      storeDriver: config.store.driver,
    },
    { createRunStore: false },
  );
  let signaturesRequired = manifest.messages?.requireSignature === true;
  try {
    let runtime: HostRuntime;
    try {
      runtime = composeHostRuntime(manifest, options.runtimeConfig, [
        moduleRuntime,
        modelOverlay(modelConfig, options.programmatic, {
          authorizeArtifact: () => false,
        }),
      ]);
    } catch (error) {
      throw new Error(
        `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    signaturesRequired ||= runtime.messages?.requireSignature === true;
    const dependencies = hostRuntimeDependencies(runtime, {
      trust: "untrusted-request",
      runStore: new MemoryRunStore(),
      artifacts: runtime.artifactStore ?? options.artifacts,
    });
    if (!options.warmup && dependencies.tools)
      dependencies.tools = deferredTools();
    try {
      await new AgentRuntime(dependencies).preflight(manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const webhookHint = /no webhook step executor/u.test(message)
        ? " Webhook steps need a WebhookStepExecutor with authorizeDestination from the runtime module's stepExecutors."
        : "";
      throw new Error(`${prefix}: ${message}${webhookHint}`);
    }
  } finally {
    await moduleRuntime.shutdown?.();
  }

  const configured = config.conversations.onUnrecognized;
  if (
    mode === "conversation" &&
    signaturesRequired &&
    configured === "unsigned"
  ) {
    throw new Error(
      `${prefix}: conversations.onUnrecognized is unsigned, but signatures are required; use reject or restart.`,
    );
  }
  const manifestHash = await defaultManifestHasher.hash(manifest);
  return {
    name: modelConfig.name,
    ...((modelConfig.description ?? manifest.description)
      ? { description: modelConfig.description ?? manifest.description! }
      : {}),
    config: modelConfig,
    manifestFile,
    manifest,
    manifestHash,
    created: options.created,
    mode,
    input: mappings,
    instructionsVariable,
    answer: planAnswer(manifest),
    labels: stepLabels(manifest.steps),
    signaturesRequired,
    onUnrecognized: configured ?? (signaturesRequired ? "reject" : "unsigned"),
  };
};

/** Bound a host operation and clean up resources returned after cancellation. */
const abortable = <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => void | Promise<void>,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let aborted = signal.aborted;
    const onAbort = (): void => {
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    if (aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) {
          void Promise.resolve()
            .then(() => disposeLate?.(value))
            .catch(() => undefined);
        } else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
