import { createHash } from "node:crypto";

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
