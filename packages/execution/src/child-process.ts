import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { RunError, RunResult } from "@clearideas/agent-runtime-contracts";

import { ExecutionEngineError, type ExecutionHandler } from "./contracts.js";
import { InProcessExecutionEngine } from "./in-process.js";
import {
  createWorkerInvocation,
  parseWorkerMessage,
  type WorkerMessage,
} from "./worker-protocol.js";

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

export interface ChildProcessExecutionEngineOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inheritEnvironment?: boolean;
  killGraceMs?: number;
  maximumStderrBytes?: number;
  name?: string;
  spawnProcess?: SpawnProcess;
}

const workerError = (error: RunError): ExecutionEngineError =>
  new ExecutionEngineError(error);

const createHandler =
  (options: ChildProcessExecutionEngineOptions): ExecutionHandler =>
  async (request, context): Promise<RunResult> => {
    const launch = options.spawnProcess ?? spawn;
    const child = launch(options.command, options.args ?? [], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: {
        ...(options.inheritEnvironment === false ? {} : process.env),
        ...(options.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const maximumStderrBytes = options.maximumStderrBytes ?? 16_384;
    let stderr = "";
    let result: RunResult | undefined;
    let reportedError: RunError | undefined;
    let parseError: Error | undefined;
    let pendingEmits = Promise.resolve();
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (): void => {
      if (child.exitCode != null || child.signalCode != null) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null)
          child.kill("SIGKILL");
      }, options.killGraceMs ?? 2_000);
      (forceKillTimer as unknown as { unref?: () => void }).unref?.();
    };
    const onAbort = (): void => terminate();
    context.signal.addEventListener("abort", onAbort, { once: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-maximumStderrBytes);
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim() || parseError) return;
      try {
        const message: WorkerMessage = parseWorkerMessage(line);
        if (message.type === "event") {
          pendingEmits = pendingEmits
            .then(() => context.emit(message.event))
            .catch((error) => {
              parseError =
                error instanceof Error ? error : new Error(String(error));
              terminate();
            });
        } else if (message.type === "result") {
          result = message.result;
        } else if (message.type === "error") {
          reportedError = message.error;
        }
      } catch (error) {
        parseError = error instanceof Error ? error : new Error(String(error));
        terminate();
      }
    });

    const invocation = createWorkerInvocation(request, context.mode);
    child.stdin.end(`${JSON.stringify(invocation)}\n`);

    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      context.signal.removeEventListener("abort", onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      lines.close();
    });
    await pendingEmits;

    if (context.signal.aborted) {
      throw context.signal.reason instanceof Error
        ? context.signal.reason
        : new Error("Child execution aborted.");
    }
    if (parseError) throw parseError;
    if (reportedError) throw workerError(reportedError);
    if (exit.code !== 0) {
      throw new ExecutionEngineError({
        code: "WORKER_PROCESS_FAILED",
        message: `Worker exited with ${exit.code ?? exit.signal ?? "an unknown status"}.${stderr ? ` ${stderr.trim()}` : ""}`,
        retryable: false,
      });
    }
    if (!result) {
      throw new ExecutionEngineError({
        code: "WORKER_RESULT_MISSING",
        message: `Worker exited without a result.${stderr ? ` ${stderr.trim()}` : ""}`,
        retryable: false,
      });
    }
    return result;
  };

/**
 * Reference out-of-process engine. The child speaks the portable NDJSON worker
 * protocol over stdin/stdout; provider-specific launchers can use the same
 * protocol over files, object storage, HTTP, or a managed job service.
 */
export class ChildProcessExecutionEngine extends InProcessExecutionEngine {
  constructor(options: ChildProcessExecutionEngineOptions) {
    if (!options.command.trim())
      throw new Error("Child process command is required.");
    super(createHandler(options), { name: options.name ?? "child-process" });
  }
}
