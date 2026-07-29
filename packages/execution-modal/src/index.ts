import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type { JsonObject, RunError } from "@clearideas/agent-runtime-contracts";
import {
  type ExecutionHandle,
  type OpenWorkerInvocationOptions,
  type RemoteComputeLauncher,
  type RemoteExecutionControlPlane,
  type RemoteExecutionReporter,
  RemoteExecutionEngine,
  type SecureInvocationEnvelope,
  type WorkerInvocation,
  type WorkerInvocationEnvelopeCodec,
  type WorkerMessage,
  parseWorkerInvocation,
  parseWorkerMessage,
} from "@clearideas/agent-runtime-execution";
import type { AgentRunnerEgressPolicy } from "./egress-policy.js";

export * from "./egress-policy.js";

interface ModalSpawnRequestBase {
  executionId: string;
  runId: string;
}

export type ModalSpawnRequest =
  | (ModalSpawnRequestBase & {
      invocationEnvelope: SecureInvocationEnvelope;
      invocation?: never;
    })
  | (ModalSpawnRequestBase & {
      /** Plaintext is only permitted by an explicit trusted-development option. */
      invocation: WorkerInvocation;
      invocationEnvelope?: never;
    });

export interface ModalSpawnResult {
  functionCallId: string;
  metadata?: JsonObject;
}

export const DEFAULT_MODAL_WORKER_AUDIENCE = "agent-runtime-modal-worker";

export interface ModalComputeLauncherOptions {
  name?: string;
  invocationCodec?: WorkerInvocationEnvelopeCodec;
  audience?: string;
  envelopeTtlMs?: number;
  /**
   * Sends secret-bearing invocations in plaintext. This must only be enabled
   * for a trusted, isolated development worker.
   */
  allowPlaintextInvocationForDevelopment?: boolean;
}

export interface DecodeModalWorkerInvocationOptions extends OpenWorkerInvocationOptions {
  allowPlaintextInvocationForDevelopment?: boolean;
}

const modalSpawnPayloadKind = (
  request: ModalSpawnRequest,
): "envelope" | "plaintext" => {
  if (
    typeof request.executionId !== "string" ||
    !request.executionId.trim() ||
    typeof request.runId !== "string" ||
    !request.runId.trim()
  ) {
    throw new Error("Modal invocation requires an execution ID and run ID.");
  }
  const hasEnvelope = request.invocationEnvelope != null;
  const hasPlaintext = request.invocation != null;
  if (hasEnvelope === hasPlaintext) {
    throw new Error(
      "Modal invocation requires exactly one envelope or plaintext payload.",
    );
  }
  return hasEnvelope ? "envelope" : "plaintext";
};

/**
 * Worker-side counterpart to ModalComputeLauncher. The expected execution,
 * run, and audience values must come from the worker's trusted transport
 * context, not from the encrypted envelope itself.
 */
export const decodeModalWorkerInvocation = (
  request: ModalSpawnRequest,
  codec: WorkerInvocationEnvelopeCodec | undefined,
  options: DecodeModalWorkerInvocationOptions,
): WorkerInvocation => {
  if (modalSpawnPayloadKind(request) === "envelope") {
    if (!codec) {
      throw new Error(
        "An invocation envelope codec is required to decode this Modal request.",
      );
    }
    return codec.open(request.invocationEnvelope, {
      executionId: options.executionId,
      runId: options.runId,
      audience: options.audience,
    });
  }
  if (!options.allowPlaintextInvocationForDevelopment) {
    throw new Error("Plaintext Modal invocation is disabled.");
  }
  const invocation = parseWorkerInvocation(request.invocation);
  if (
    options.executionId !== request.executionId ||
    options.runId !== request.runId ||
    (invocation.request.runId != null &&
      invocation.request.runId !== options.runId)
  ) {
    throw new Error(
      "Plaintext Modal invocation does not match its execution binding.",
    );
  }
  return invocation;
};

/** Minimal Modal SDK boundary; no Modal types escape this package contract. */
export interface ModalGateway {
  spawn(request: ModalSpawnRequest): Promise<ModalSpawnResult>;
  cancel(
    functionCallId: string,
    context?: { queueName?: string; deleteQueue?: boolean },
  ): Promise<void>;
}

export interface ModalStreamingGateway extends ModalGateway {
  messages(
    handle: ExecutionHandle,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<WorkerMessage>;
}

export interface ModalSdkFunctionCallLike {
  functionCallId: string;
  get(options?: { timeoutMs?: number }): Promise<unknown>;
  cancel(options?: { terminateContainers?: boolean }): Promise<void>;
}

export interface ModalSdkFunctionLike {
  spawn(
    args?: unknown[],
    kwargs?: Record<string, unknown>,
  ): Promise<ModalSdkFunctionCallLike>;
}

export interface ModalSdkQueueLike {
  get(options?: { timeoutMs?: number }): Promise<unknown>;
}

export interface ModalSdkClientLike {
  functions: {
    fromName(
      appName: string,
      functionName: string,
      options?: { environment?: string },
    ): Promise<ModalSdkFunctionLike>;
  };
  functionCalls: {
    fromId(functionCallId: string): Promise<ModalSdkFunctionCallLike>;
  };
  queues: {
    fromName(
      queueName: string,
      options?: { environment?: string; createIfMissing?: boolean },
    ): Promise<ModalSdkQueueLike>;
    delete(
      queueName: string,
      options?: { environment?: string; allowMissing?: boolean },
    ): Promise<void>;
  };
}

export interface ModalSdkGatewayOptions {
  appName?: string;
  functionName?: string;
  environment?: string;
  queuePollTimeoutMs?: number;
  startupTimeoutMs?: number;
  deleteQueueOnExit?: boolean;
  /** @deprecated Use deleteQueueOnExit. */
  deleteQueueOnTerminal?: boolean;
  allowPlaintextInvocationForDevelopment?: boolean;
  now?: () => number;
}

export type ModalSandboxNetworkPolicy =
  | {
      mode: "block";
      blockNetwork: true;
    }
  | {
      mode: "proxy-only";
      outboundCidrAllowlist: string[];
      /**
       * Exact TLS proxy hostnames only. Never include downstream model, tool,
       * connection, webhook, or control-plane domains.
       */
      outboundDomainAllowlist: string[];
    }
  | {
      /**
       * Direct domain egress derived from the host-resolved origin policy.
       * Modal enforces domain entries for TLS traffic on port 443.
       */
      mode: "direct-domains";
      outboundCidrAllowlist: [];
      outboundDomainAllowlist: string[];
    };

const normalizeExactProxyCidr = (value: string): string => {
  const candidate = value.trim();
  const separator = candidate.lastIndexOf("/");
  if (separator <= 0) {
    throw new Error(`Modal proxy address must be an exact CIDR: ${candidate}`);
  }
  const address = candidate.slice(0, separator);
  const prefix = Number(candidate.slice(separator + 1));
  const family = isIP(address);
  if (
    (family === 4 && prefix !== 32) ||
    (family === 6 && prefix !== 128) ||
    family === 0
  ) {
    throw new Error(
      `Modal proxy CIDR must identify exactly one IPv4 or IPv6 address: ${candidate}`,
    );
  }
  return `${address}/${prefix}`;
};

const normalizeExactProxyDomain = (value: string): string => {
  const candidate = value.trim().toLowerCase().replace(/\.$/u, "");
  if (
    !candidate ||
    candidate.startsWith("*.") ||
    isIP(candidate) !== 0 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(candidate)
  ) {
    throw new Error(`Modal proxy domain must be one exact hostname: ${value}`);
  }
  return candidate;
};

/**
 * Converts the host-resolved HTTPS origin policy to Modal's stable domain
 * allowlist. It intentionally performs no DNS or CIDR resolution.
 */
export const resolveModalSandboxDomainAllowlist = (
  egressPolicy: AgentRunnerEgressPolicy,
): string[] => {
  const domains = new Set<string>();
  for (const item of egressPolicy.allowedOrigins) {
    const url = new URL(item.origin);
    const port = url.port ? Number(url.port) : 443;
    if (url.protocol !== "https:" || port !== 443) {
      throw new Error(
        `Modal domain egress can express only HTTPS port 443 origins: ${item.origin}`,
      );
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (isIP(hostname)) {
      throw new Error(
        `IP origin ${item.origin} must be supplied by the host as a CIDR policy.`,
      );
    }
    if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname)) {
      throw new Error(`Invalid Modal egress domain: ${hostname}`);
    }
    domains.add(hostname);
  }
  return [...domains].sort();
};

/**
 * Resolves hardened Modal networking from host-owned policy: no network,
 * proxy-only endpoints, or direct HTTPS domains derived from resolved origins.
 */
export const resolveModalSandboxNetworkPolicy = (
  input:
    | { mode: "block" }
    | {
        mode: "proxy-only";
        proxyCidrs?: readonly string[];
        proxyDomains?: readonly string[];
      }
    | {
        mode: "direct-domains";
        egressPolicy: AgentRunnerEgressPolicy;
      },
): ModalSandboxNetworkPolicy => {
  if (input.mode === "block") return { mode: "block", blockNetwork: true };
  if (input.mode === "proxy-only") {
    const cidrs = [
      ...new Set((input.proxyCidrs ?? []).map(normalizeExactProxyCidr)),
    ].sort();
    const domains = [
      ...new Set((input.proxyDomains ?? []).map(normalizeExactProxyDomain)),
    ].sort();
    if (cidrs.length === 0 && domains.length === 0) {
      throw new Error(
        "Proxy-only Modal networking requires an exact proxy CIDR or domain.",
      );
    }
    return {
      mode: "proxy-only",
      outboundCidrAllowlist: cidrs,
      outboundDomainAllowlist: domains,
    };
  }

  return {
    mode: "direct-domains",
    outboundCidrAllowlist: [],
    outboundDomainAllowlist: resolveModalSandboxDomainAllowlist(
      input.egressPolicy,
    ),
  };
};

const normalizeModalSandboxNetworkPolicy = (
  policy: ModalSandboxNetworkPolicy,
): ModalSandboxNetworkPolicy => {
  if (policy.mode === "block") {
    return resolveModalSandboxNetworkPolicy({ mode: "block" });
  }
  if (policy.mode === "proxy-only") {
    return resolveModalSandboxNetworkPolicy({
      mode: "proxy-only",
      proxyCidrs: policy.outboundCidrAllowlist,
      proxyDomains: policy.outboundDomainAllowlist,
    });
  }
  return {
    mode: "direct-domains",
    outboundCidrAllowlist: [],
    outboundDomainAllowlist: resolveModalSandboxDomainAllowlist({
      mode: "enforce",
      allowedOrigins: policy.outboundDomainAllowlist.map((domain) => ({
        type: "tool",
        origin: `https://${domain}`,
      })),
    }),
  };
};

export interface ModalSandboxLaunchConfig {
  networkPolicy: ModalSandboxNetworkPolicy;
  /** Entrypoint that reads one ModalSpawnRequest from stdin and emits NDJSON. */
  command?: string[];
  /** Trusted per-run environment. It is never persisted in providerData. */
  environment?: Record<string, string>;
  /**
   * Opaque Modal Secret handles injected as environment variables. `any` is
   * intentional here because Modal Secret uses a private nominal SDK type.
   */
  secrets?: any[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  workdir?: string;
  cpu?: number;
  cpuLimit?: number;
  memoryMiB?: number;
  memoryLimitMiB?: number;
  regions?: string[];
  cloud?: string;
  metadata?: JsonObject;
}

export type ResolveModalSandboxLaunchConfig = (
  invocation: WorkerInvocation,
  context: { executionId: string; runId: string },
) => ModalSandboxLaunchConfig | Promise<ModalSandboxLaunchConfig>;

export type ModalSandboxSpawnRequest = ModalSpawnRequest & {
  sandbox: ModalSandboxLaunchConfig;
};

export interface ModalSandboxSpawnResult {
  sandboxId: string;
  metadata?: JsonObject;
}

export interface ModalSandboxGateway {
  spawn(request: ModalSandboxSpawnRequest): Promise<ModalSandboxSpawnResult>;
  cancel(sandboxId: string): Promise<void>;
}

export interface ModalSandboxStreamingGateway extends ModalSandboxGateway {
  messages(
    handle: ExecutionHandle,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<WorkerMessage>;
}

export interface ModalSdkSandboxReaderLike {
  read(): Promise<{ done: boolean; value?: string }>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

export interface ModalSdkSandboxLike {
  sandboxId: string;
  stdin: {
    writeText(text: string): Promise<void>;
    close(): Promise<void>;
  };
  stdout: {
    getReader(): ModalSdkSandboxReaderLike;
  };
  wait(): Promise<number>;
  terminate(): Promise<void>;
}

/** Structural boundary matching the Modal TypeScript SDK Sandbox services. */
export interface ModalSandboxSdkClientLike {
  apps: {
    fromName(
      name: string,
      options?: { environment?: string; createIfMissing?: boolean },
    ): Promise<any>;
  };
  images: {
    fromName(name: string, options?: { environment?: string }): Promise<any>;
  };
  sandboxes: {
    create(
      app: any,
      image: any,
      options: {
        command: string[];
        env?: Record<string, string>;
        secrets?: any[];
        timeoutMs?: number;
        idleTimeoutMs?: number;
        workdir?: string;
        cpu?: number;
        cpuLimit?: number;
        memoryMiB?: number;
        memoryLimitMiB?: number;
        regions?: string[];
        cloud?: string;
        blockNetwork?: boolean;
        outboundCidrAllowlist?: string[];
        outboundDomainAllowlist?: string[];
        tags?: Record<string, string>;
      },
    ): Promise<ModalSdkSandboxLike>;
    fromId(sandboxId: string): Promise<ModalSdkSandboxLike>;
  };
}

export interface ModalSandboxSdkGatewayOptions {
  appName?: string;
  imageName: string;
  environment?: string;
  command?: string[];
  baseEnvironment?: Record<string, string>;
  startupTimeoutMs?: number;
  maximumProtocolLineBytes?: number;
  allowPlaintextInvocationForDevelopment?: boolean;
}

interface ModalTransportClosed {
  transport: "closed";
  exitCode?: number;
  stderr?: string;
}

const isTransportClosed = (value: unknown): value is ModalTransportClosed =>
  value != null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as { transport?: unknown }).transport === "closed";

const queueNameForExecution = (executionId: string): string =>
  `agent-runtime-${createHash("sha256").update(executionId).digest("hex").slice(0, 32)}`;

/** Concrete Modal SDK transport using a per-execution named Queue. */
export class ModalSdkGateway implements ModalStreamingGateway {
  readonly #client: ModalSdkClientLike;
  readonly #appName: string;
  readonly #functionName: string;
  readonly #environment: string | undefined;
  readonly #queuePollTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #deleteQueueOnExit: boolean;
  readonly #allowPlaintextInvocationForDevelopment: boolean;
  readonly #now: () => number;

  constructor(
    client: ModalSdkClientLike,
    options: ModalSdkGatewayOptions = {},
  ) {
    this.#client = client;
    this.#appName = options.appName ?? "agent-runtime-dev";
    this.#functionName = options.functionName ?? "run_worker";
    this.#environment = options.environment;
    this.#queuePollTimeoutMs = options.queuePollTimeoutMs ?? 1_000;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.#deleteQueueOnExit =
      options.deleteQueueOnExit ?? options.deleteQueueOnTerminal ?? true;
    this.#allowPlaintextInvocationForDevelopment =
      options.allowPlaintextInvocationForDevelopment ?? false;
    this.#now = options.now ?? Date.now;
  }

  async spawn(request: ModalSpawnRequest): Promise<ModalSpawnResult> {
    const payloadKind = modalSpawnPayloadKind(request);
    if (
      payloadKind === "plaintext" &&
      !this.#allowPlaintextInvocationForDevelopment
    ) {
      throw new Error("Plaintext Modal invocation is disabled.");
    }
    const queueName = queueNameForExecution(request.executionId);
    await this.#client.queues.fromName(queueName, {
      createIfMissing: true,
      ...(this.#environment ? { environment: this.#environment } : {}),
    });
    const remoteFunction = await this.#client.functions.fromName(
      this.#appName,
      this.#functionName,
      this.#environment ? { environment: this.#environment } : undefined,
    );
    const call = await remoteFunction.spawn(
      [],
      payloadKind === "envelope"
        ? {
            invocation_envelope: request.invocationEnvelope,
            execution_id: request.executionId,
            run_id: request.runId,
            queue_name: queueName,
          }
        : {
            invocation: request.invocation,
            execution_id: request.executionId,
            run_id: request.runId,
            queue_name: queueName,
          },
    );
    return { functionCallId: call.functionCallId, metadata: { queueName } };
  }

  async cancel(
    functionCallId: string,
    context: { queueName?: string; deleteQueue?: boolean } = {},
  ): Promise<void> {
    const call = await this.#client.functionCalls.fromId(functionCallId);
    try {
      await call.cancel({ terminateContainers: true });
    } finally {
      if (
        this.#deleteQueueOnExit &&
        context.deleteQueue !== false &&
        context.queueName
      ) {
        await this.#deleteQueue(context.queueName);
      }
    }
  }

  async *messages(
    handle: ExecutionHandle,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<WorkerMessage> {
    const queueName = handle.providerData?.queueName;
    if (typeof queueName !== "string" || !queueName.trim()) {
      throw new Error("Modal execution handle is missing its queue name.");
    }
    const functionCallId = handle.providerData?.functionCallId;
    if (typeof functionCallId !== "string" || !functionCallId.trim()) {
      throw new Error(
        "Modal execution handle is missing its function call ID.",
      );
    }
    const startedAt = this.#now();
    let receivedMessage = false;
    let terminal = false;
    try {
      const queue = await this.#client.queues.fromName(queueName, {
        ...(this.#environment ? { environment: this.#environment } : {}),
      });
      const functionCall =
        await this.#client.functionCalls.fromId(functionCallId);
      while (!options.signal?.aborted) {
        let value: unknown;
        try {
          value = await queue.get({ timeoutMs: this.#queuePollTimeoutMs });
        } catch (error) {
          if (error instanceof Error && error.name === "QueueEmptyError") {
            if (
              !receivedMessage &&
              this.#now() - startedAt >= this.#startupTimeoutMs
            ) {
              await functionCall
                .cancel({ terminateContainers: true })
                .catch(() => undefined);
              throw new Error(
                `Modal worker did not produce a protocol message within ${this.#startupTimeoutMs}ms.`,
              );
            }
            try {
              await functionCall.get({ timeoutMs: 1 });
            } catch (callError) {
              if (
                callError instanceof Error &&
                (callError.name === "FunctionTimeoutError" ||
                  callError.name === "TimeoutError")
              ) {
                continue;
              }
              throw new Error(
                "Modal function failed before producing a terminal worker message.",
              );
            }
            throw new Error(
              "Modal function completed without a terminal worker message.",
            );
          }
          throw error;
        }
        if (value == null) continue;
        receivedMessage = true;
        if (isTransportClosed(value)) {
          if (!terminal) {
            throw new Error(
              `Modal worker transport closed without a terminal message (exit ${String(value.exitCode ?? "unknown")}).`,
            );
          }
          return;
        }
        const message = parseWorkerMessage(value);
        if (message.type === "result" || message.type === "error")
          terminal = true;
        yield message;
        if (terminal) return;
      }
    } finally {
      if (this.#deleteQueueOnExit) await this.#deleteQueue(queueName);
    }
  }

  async #deleteQueue(queueName: string): Promise<void> {
    await this.#client.queues.delete(queueName, {
      allowMissing: true,
      ...(this.#environment ? { environment: this.#environment } : {}),
    });
  }
}

const sandboxSupportsMessages = (
  gateway: ModalSandboxGateway,
): gateway is ModalSandboxStreamingGateway =>
  typeof (gateway as Partial<ModalSandboxStreamingGateway>).messages ===
  "function";

const readSandboxChunk = async (
  reader: ModalSdkSandboxReaderLike,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{ done: boolean; value?: string }> => {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted.");
  if (timeoutMs == null && !signal) return reader.read();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      action: () => void,
      timeout: ReturnType<typeof setTimeout> | undefined,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void =>
      finish(
        () => reject(signal?.reason ?? new Error("Operation aborted.")),
        timeout,
      );
    const timeout =
      timeoutMs == null
        ? undefined
        : setTimeout(
            () =>
              finish(
                () =>
                  reject(
                    new Error(
                      `Modal Sandbox worker did not produce a protocol message within ${timeoutMs}ms.`,
                    ),
                  ),
                timeout,
              ),
            timeoutMs,
          );
    signal?.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (value) => finish(() => resolve(value), timeout),
      (error: unknown) => finish(() => reject(error), timeout),
    );
  });
};

/**
 * Concrete Modal SDK transport that runs the entire worker in a Sandbox and
 * carries the portable worker protocol over stdin/stdout.
 */
export class ModalSandboxSdkGateway implements ModalSandboxStreamingGateway {
  readonly #client: ModalSandboxSdkClientLike;
  readonly #appName: string;
  readonly #imageName: string;
  readonly #environment: string | undefined;
  readonly #command: string[];
  readonly #baseEnvironment: Record<string, string>;
  readonly #startupTimeoutMs: number;
  readonly #maximumProtocolLineBytes: number;
  readonly #allowPlaintextInvocationForDevelopment: boolean;

  constructor(
    client: ModalSandboxSdkClientLike,
    options: ModalSandboxSdkGatewayOptions,
  ) {
    if (!options.imageName.trim()) {
      throw new Error("Modal Sandbox imageName must be a non-empty string.");
    }
    this.#client = client;
    this.#appName = options.appName ?? "agent-runtime-dev";
    this.#imageName = options.imageName;
    this.#environment = options.environment;
    this.#command = options.command ?? ["agent-runtime-modal-worker"];
    if (
      this.#command.length === 0 ||
      this.#command.some((part) => !part.trim())
    ) {
      throw new Error(
        "Modal Sandbox command must contain non-empty arguments.",
      );
    }
    this.#baseEnvironment = { ...(options.baseEnvironment ?? {}) };
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.#maximumProtocolLineBytes =
      options.maximumProtocolLineBytes ?? 4 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maximumProtocolLineBytes) ||
      this.#maximumProtocolLineBytes < 1
    ) {
      throw new Error(
        "Modal Sandbox maximumProtocolLineBytes must be a positive integer.",
      );
    }
    this.#allowPlaintextInvocationForDevelopment =
      options.allowPlaintextInvocationForDevelopment ?? false;
  }

  async spawn(
    request: ModalSandboxSpawnRequest,
  ): Promise<ModalSandboxSpawnResult> {
    const payloadKind = modalSpawnPayloadKind(request);
    if (
      payloadKind === "plaintext" &&
      !this.#allowPlaintextInvocationForDevelopment
    ) {
      throw new Error("Plaintext Modal invocation is disabled.");
    }
    const network = normalizeModalSandboxNetworkPolicy(
      request.sandbox.networkPolicy,
    );

    const app = await this.#client.apps.fromName(this.#appName, {
      createIfMissing: true,
      ...(this.#environment ? { environment: this.#environment } : {}),
    });
    const image = await this.#client.images.fromName(this.#imageName, {
      ...(this.#environment ? { environment: this.#environment } : {}),
    });
    const sandbox = await this.#client.sandboxes.create(app, image, {
      command: request.sandbox.command ?? this.#command,
      env: {
        ...this.#baseEnvironment,
        ...(request.sandbox.environment ?? {}),
        AGENT_RUNTIME_MODAL_EXECUTION_ID: request.executionId,
        AGENT_RUNTIME_MODAL_RUN_ID: request.runId,
      },
      ...(request.sandbox.secrets == null
        ? {}
        : { secrets: request.sandbox.secrets }),
      ...(request.sandbox.timeoutMs == null
        ? {}
        : { timeoutMs: request.sandbox.timeoutMs }),
      ...(request.sandbox.idleTimeoutMs == null
        ? {}
        : { idleTimeoutMs: request.sandbox.idleTimeoutMs }),
      ...(request.sandbox.workdir == null
        ? {}
        : { workdir: request.sandbox.workdir }),
      ...(request.sandbox.cpu == null ? {} : { cpu: request.sandbox.cpu }),
      ...(request.sandbox.cpuLimit == null
        ? {}
        : { cpuLimit: request.sandbox.cpuLimit }),
      ...(request.sandbox.memoryMiB == null
        ? {}
        : { memoryMiB: request.sandbox.memoryMiB }),
      ...(request.sandbox.memoryLimitMiB == null
        ? {}
        : { memoryLimitMiB: request.sandbox.memoryLimitMiB }),
      ...(request.sandbox.regions == null
        ? {}
        : { regions: request.sandbox.regions }),
      ...(request.sandbox.cloud == null
        ? {}
        : { cloud: request.sandbox.cloud }),
      ...(network.mode === "block"
        ? { blockNetwork: true }
        : {
            outboundCidrAllowlist: network.outboundCidrAllowlist,
            outboundDomainAllowlist: network.outboundDomainAllowlist,
          }),
      tags: {
        "agent-runtime-execution-id": request.executionId,
        "agent-runtime-run-id": request.runId,
      },
    });

    const workerRequest: ModalSpawnRequest =
      "invocationEnvelope" in request && request.invocationEnvelope != null
        ? {
            executionId: request.executionId,
            runId: request.runId,
            invocationEnvelope: request.invocationEnvelope,
          }
        : {
            executionId: request.executionId,
            runId: request.runId,
            invocation: request.invocation,
          };
    try {
      await sandbox.stdin.writeText(`${JSON.stringify(workerRequest)}\n`);
      await sandbox.stdin.close();
    } catch (error) {
      await sandbox.terminate().catch(() => undefined);
      throw new Error("Failed to deliver the Modal Sandbox invocation.", {
        cause: error,
      });
    }

    return {
      sandboxId: sandbox.sandboxId,
      ...(request.sandbox.metadata
        ? { metadata: request.sandbox.metadata }
        : {}),
    };
  }

  async cancel(sandboxId: string): Promise<void> {
    const sandbox = await this.#client.sandboxes.fromId(sandboxId);
    await sandbox.terminate();
  }

  async *messages(
    handle: ExecutionHandle,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<WorkerMessage> {
    const sandboxId = handle.providerData?.sandboxId;
    if (typeof sandboxId !== "string" || !sandboxId.trim()) {
      throw new Error("Modal execution handle is missing its sandbox ID.");
    }
    const sandbox = await this.#client.sandboxes.fromId(sandboxId);
    const reader = sandbox.stdout.getReader();
    let buffer = "";
    let receivedMessage = false;
    let terminal = false;
    const startupStartedAt = Date.now();
    try {
      while (!options.signal?.aborted) {
        const startupTimeoutMs = receivedMessage
          ? undefined
          : Math.max(
              1,
              this.#startupTimeoutMs - (Date.now() - startupStartedAt),
            );
        const chunk = await readSandboxChunk(
          reader,
          startupTimeoutMs,
          options.signal,
        );
        if (chunk.value) buffer += chunk.value;

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const rawLine = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (
            Buffer.byteLength(rawLine, "utf8") > this.#maximumProtocolLineBytes
          ) {
            throw new Error("Modal Sandbox worker protocol line is too large.");
          }
          const line = rawLine.trim();
          if (!line) continue;
          const message = parseWorkerMessage(line);
          receivedMessage = true;
          if (message.type === "result" || message.type === "error") {
            terminal = true;
            await sandbox.terminate().catch(() => undefined);
          }
          yield message;
          if (terminal) return;
        }
        if (
          Buffer.byteLength(buffer, "utf8") > this.#maximumProtocolLineBytes
        ) {
          throw new Error("Modal Sandbox worker protocol line is too large.");
        }
        if (!chunk.done) continue;

        const finalLine = buffer.trim();
        if (finalLine) {
          const message = parseWorkerMessage(finalLine);
          receivedMessage = true;
          if (message.type === "result" || message.type === "error") {
            terminal = true;
            await sandbox.terminate().catch(() => undefined);
          }
          yield message;
          if (terminal) return;
        }
        const exitCode = await sandbox.wait();
        throw new Error(
          `Modal Sandbox worker exited with code ${exitCode} without a terminal protocol message.`,
        );
      }
    } catch (error) {
      await reader.cancel?.(error).catch(() => undefined);
      await sandbox.terminate().catch(() => undefined);
      throw error;
    } finally {
      if (options.signal?.aborted) {
        await reader.cancel?.(options.signal.reason).catch(() => undefined);
      }
      reader.releaseLock?.();
    }
  }
}

const supportsMessages = (
  gateway: ModalGateway,
): gateway is ModalStreamingGateway =>
  typeof (gateway as Partial<ModalStreamingGateway>).messages === "function";

const supportsReporting = (
  controlPlane: RemoteExecutionControlPlane,
): controlPlane is RemoteExecutionControlPlane & RemoteExecutionReporter => {
  const candidate = controlPlane as Partial<RemoteExecutionReporter>;
  return (
    typeof candidate.acceptEvent === "function" &&
    typeof candidate.complete === "function" &&
    typeof candidate.fail === "function"
  );
};

export class ModalComputeLauncher implements RemoteComputeLauncher {
  readonly name: string;
  readonly #gateway: ModalGateway;
  readonly #reporter: RemoteExecutionReporter | undefined;
  readonly #invocationCodec: WorkerInvocationEnvelopeCodec | undefined;
  readonly #audience: string;
  readonly #envelopeTtlMs: number | undefined;
  readonly #allowPlaintextInvocationForDevelopment: boolean;
  readonly #observers = new Map<string, AbortController>();

  constructor(
    gateway: ModalGateway,
    options: ModalComputeLauncherOptions = {},
    reporter?: RemoteExecutionReporter,
  ) {
    this.#gateway = gateway;
    this.name = options.name ?? "modal";
    this.#reporter = reporter;
    this.#invocationCodec = options.invocationCodec;
    this.#audience = options.audience ?? DEFAULT_MODAL_WORKER_AUDIENCE;
    this.#envelopeTtlMs = options.envelopeTtlMs;
    this.#allowPlaintextInvocationForDevelopment =
      options.allowPlaintextInvocationForDevelopment ?? false;
    if (
      !this.#invocationCodec &&
      !this.#allowPlaintextInvocationForDevelopment
    ) {
      throw new Error(
        "Modal remote execution requires an invocation envelope codec. Plaintext invocation is available only through allowPlaintextInvocationForDevelopment.",
      );
    }
  }

  async launch(
    invocation: WorkerInvocation,
    context: { handle: ExecutionHandle },
  ): Promise<JsonObject> {
    const boundInvocation: WorkerInvocation =
      invocation.request.runId == null
        ? {
            ...invocation,
            request: {
              ...invocation.request,
              runId: context.handle.runId,
            },
          }
        : invocation;
    const protectedInvocation = this.#invocationCodec
      ? {
          invocationEnvelope: this.#invocationCodec.seal(boundInvocation, {
            executionId: context.handle.id,
            runId: context.handle.runId,
            audience: this.#audience,
            ...(this.#envelopeTtlMs == null
              ? {}
              : { ttlMs: this.#envelopeTtlMs }),
          }),
        }
      : { invocation: boundInvocation };
    let spawned: ModalSpawnResult;
    try {
      spawned = await this.#gateway.spawn({
        ...protectedInvocation,
        executionId: context.handle.id,
        runId: context.handle.runId,
      } as ModalSpawnRequest);
    } catch (error) {
      throw new Error("Modal failed to start the remote execution.", {
        cause: error,
      });
    }
    if (!spawned.functionCallId.trim())
      throw new Error("Modal returned an empty function call ID.");
    return {
      functionCallId: spawned.functionCallId,
      ...(spawned.metadata ?? {}),
    };
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const observer = this.#observers.get(handle.id);
    observer?.abort(new Error("Modal execution cancelled."));
    const functionCallId = handle.providerData?.functionCallId;
    if (typeof functionCallId !== "string" || !functionCallId.trim()) return;
    const queueName =
      typeof handle.providerData?.queueName === "string"
        ? handle.providerData.queueName
        : undefined;
    await this.#gateway.cancel(
      functionCallId,
      queueName ? { queueName, deleteQueue: observer == null } : undefined,
    );
  }

  async observe(handle: ExecutionHandle): Promise<void> {
    if (!supportsMessages(this.#gateway) || !this.#reporter) return;
    const controller = new AbortController();
    this.#observers.set(handle.id, controller);
    let terminal = false;
    try {
      for await (const message of this.#gateway.messages(handle, {
        signal: controller.signal,
      })) {
        if (message.type === "event") {
          await this.#reporter.acceptEvent(handle, message.event);
        } else if (message.type === "result") {
          terminal = true;
          await this.#reporter.complete(handle, message.result);
          return;
        } else if (message.type === "error") {
          terminal = true;
          await this.#reporter.fail(handle, {
            code: message.error.code,
            message: "Modal worker reported an execution failure.",
            ...(message.error.retryable == null
              ? {}
              : { retryable: message.error.retryable }),
          });
          return;
        }
      }
      if (!terminal) {
        await this.#reporter.fail(handle, {
          code: "MODAL_MESSAGE_STREAM_ENDED",
          message:
            "Modal worker message stream ended without a terminal result.",
          retryable: true,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const normalized: RunError = {
        code: "MODAL_MESSAGE_STREAM_FAILED",
        message: "Modal worker message delivery failed.",
        retryable: true,
      };
      await this.#reporter.fail(handle, normalized);
    } finally {
      this.#observers.delete(handle.id);
    }
  }
}

export interface ModalSandboxComputeLauncherOptions extends ModalComputeLauncherOptions {
  /**
   * Trusted host callback. It may inspect the invocation to resolve host-owned
   * policy, but only the resulting sandbox configuration crosses into Modal.
   */
  resolveSandbox: ResolveModalSandboxLaunchConfig;
}

export class ModalSandboxComputeLauncher implements RemoteComputeLauncher {
  readonly name: string;
  readonly #gateway: ModalSandboxGateway;
  readonly #reporter: RemoteExecutionReporter | undefined;
  readonly #invocationCodec: WorkerInvocationEnvelopeCodec | undefined;
  readonly #audience: string;
  readonly #envelopeTtlMs: number | undefined;
  readonly #allowPlaintextInvocationForDevelopment: boolean;
  readonly #resolveSandbox: ResolveModalSandboxLaunchConfig;
  readonly #observers = new Map<string, AbortController>();

  constructor(
    gateway: ModalSandboxGateway,
    options: ModalSandboxComputeLauncherOptions,
    reporter?: RemoteExecutionReporter,
  ) {
    this.#gateway = gateway;
    this.name = options.name ?? "modal-sandbox";
    this.#reporter = reporter;
    this.#invocationCodec = options.invocationCodec;
    this.#audience = options.audience ?? DEFAULT_MODAL_WORKER_AUDIENCE;
    this.#envelopeTtlMs = options.envelopeTtlMs;
    this.#allowPlaintextInvocationForDevelopment =
      options.allowPlaintextInvocationForDevelopment ?? false;
    this.#resolveSandbox = options.resolveSandbox;
    if (
      !this.#invocationCodec &&
      !this.#allowPlaintextInvocationForDevelopment
    ) {
      throw new Error(
        "Modal Sandbox remote execution requires an invocation envelope codec. Plaintext invocation is available only through allowPlaintextInvocationForDevelopment.",
      );
    }
  }

  async launch(
    invocation: WorkerInvocation,
    context: { handle: ExecutionHandle },
  ): Promise<JsonObject> {
    const boundInvocation: WorkerInvocation =
      invocation.request.runId == null
        ? {
            ...invocation,
            request: {
              ...invocation.request,
              runId: context.handle.runId,
            },
          }
        : invocation;
    const sandbox = await this.#resolveSandbox(boundInvocation, {
      executionId: context.handle.id,
      runId: context.handle.runId,
    });
    const networkPolicy = normalizeModalSandboxNetworkPolicy(
      sandbox.networkPolicy,
    );
    const protectedInvocation = this.#invocationCodec
      ? {
          invocationEnvelope: this.#invocationCodec.seal(boundInvocation, {
            executionId: context.handle.id,
            runId: context.handle.runId,
            audience: this.#audience,
            ...(this.#envelopeTtlMs == null
              ? {}
              : { ttlMs: this.#envelopeTtlMs }),
          }),
        }
      : { invocation: boundInvocation };

    let spawned: ModalSandboxSpawnResult;
    try {
      spawned = await this.#gateway.spawn({
        ...protectedInvocation,
        executionId: context.handle.id,
        runId: context.handle.runId,
        sandbox: { ...sandbox, networkPolicy },
      } as ModalSandboxSpawnRequest);
    } catch (error) {
      throw new Error("Modal failed to start the Sandbox execution.", {
        cause: error,
      });
    }
    if (!spawned.sandboxId.trim()) {
      throw new Error("Modal returned an empty sandbox ID.");
    }
    return {
      ...(spawned.metadata ?? {}),
      sandboxId: spawned.sandboxId,
    };
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const observer = this.#observers.get(handle.id);
    observer?.abort(new Error("Modal Sandbox execution cancelled."));
    const sandboxId = handle.providerData?.sandboxId;
    if (typeof sandboxId !== "string" || !sandboxId.trim()) return;
    await this.#gateway.cancel(sandboxId);
  }

  async observe(handle: ExecutionHandle): Promise<void> {
    if (!sandboxSupportsMessages(this.#gateway) || !this.#reporter) return;
    const controller = new AbortController();
    this.#observers.set(handle.id, controller);
    let terminal = false;
    try {
      for await (const message of this.#gateway.messages(handle, {
        signal: controller.signal,
      })) {
        if (message.type === "event") {
          await this.#reporter.acceptEvent(handle, message.event);
        } else if (message.type === "result") {
          terminal = true;
          await this.#reporter.complete(handle, message.result);
          return;
        } else if (message.type === "error") {
          terminal = true;
          await this.#reporter.fail(handle, {
            code: message.error.code,
            message: "Modal Sandbox worker reported an execution failure.",
            ...(message.error.retryable == null
              ? {}
              : { retryable: message.error.retryable }),
          });
          return;
        }
      }
      if (!terminal) {
        await this.#reporter.fail(handle, {
          code: "MODAL_SANDBOX_MESSAGE_STREAM_ENDED",
          message:
            "Modal Sandbox worker message stream ended without a terminal result.",
          retryable: true,
        });
      }
    } catch {
      if (controller.signal.aborted) return;
      await this.#reporter.fail(handle, {
        code: "MODAL_SANDBOX_MESSAGE_STREAM_FAILED",
        message: "Modal Sandbox worker message delivery failed.",
        retryable: true,
      });
    } finally {
      this.#observers.delete(handle.id);
    }
  }
}

export class ModalExecutionEngine extends RemoteExecutionEngine {
  constructor(
    gateway: ModalGateway,
    controlPlane: RemoteExecutionControlPlane,
    options: ModalComputeLauncherOptions = {},
  ) {
    super(
      new ModalComputeLauncher(
        gateway,
        options,
        supportsReporting(controlPlane) ? controlPlane : undefined,
      ),
      controlPlane,
    );
  }
}

export class ModalSandboxExecutionEngine extends RemoteExecutionEngine {
  constructor(
    gateway: ModalSandboxGateway,
    controlPlane: RemoteExecutionControlPlane,
    options: ModalSandboxComputeLauncherOptions,
  ) {
    super(
      new ModalSandboxComputeLauncher(
        gateway,
        options,
        supportsReporting(controlPlane) ? controlPlane : undefined,
      ),
      controlPlane,
    );
  }
}
