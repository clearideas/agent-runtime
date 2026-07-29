#!/usr/bin/env node

import { spawn } from "node:child_process";

import { AesGcmWorkerInvocationCodec } from "@clearideas/agent-runtime-execution";

import {
  DEFAULT_MODAL_WORKER_AUDIENCE,
  decodeModalWorkerInvocation,
  type ModalSpawnRequest,
} from "./index.js";

const ACTIVE_KEY_ID_ENV = "AGENT_RUNTIME_MODAL_INVOCATION_ACTIVE_KEY_ID";
const KEYRING_ENV = "AGENT_RUNTIME_MODAL_INVOCATION_KEYS";
const AUDIENCE_ENV = "AGENT_RUNTIME_MODAL_INVOCATION_AUDIENCE";
const EXECUTION_ID_ENV = "AGENT_RUNTIME_MODAL_EXECUTION_ID";
const RUN_ID_ENV = "AGENT_RUNTIME_MODAL_RUN_ID";
const COMMAND_ENV = "AGENT_RUNTIME_MODAL_WORKER_COMMAND";
const ARGS_ENV = "AGENT_RUNTIME_MODAL_WORKER_ARGS";
const ALLOW_PLAINTEXT_ENV =
  "AGENT_RUNTIME_MODAL_ALLOW_PLAINTEXT_FOR_DEVELOPMENT";
const MAXIMUM_INPUT_BYTES = 16 * 1024 * 1024;

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required environment ${name}.`);
  return value;
};

const readInput = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAXIMUM_INPUT_BYTES) {
      throw new Error("Modal Sandbox invocation exceeds the input limit.");
    }
  }
  if (!input.trim()) throw new Error("Modal Sandbox invocation is empty.");
  return input;
};

const parseStringArray = (value: string | undefined): string[] => {
  if (!value?.trim()) return ["worker"];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error(`${ARGS_ENV} must be a JSON string array.`);
  }
  return parsed;
};

const run = async (): Promise<number> => {
  const request = JSON.parse(await readInput()) as ModalSpawnRequest;
  const allowPlaintext =
    process.env[ALLOW_PLAINTEXT_ENV]?.toLowerCase() === "true";
  const codec = allowPlaintext
    ? undefined
    : new AesGcmWorkerInvocationCodec({
        activeKeyId: requiredEnvironment(ACTIVE_KEY_ID_ENV),
        keys: JSON.parse(requiredEnvironment(KEYRING_ENV)) as Record<
          string,
          string
        >,
      });
  const invocation = decodeModalWorkerInvocation(request, codec, {
    executionId: requiredEnvironment(EXECUTION_ID_ENV),
    runId: requiredEnvironment(RUN_ID_ENV),
    audience:
      process.env[AUDIENCE_ENV]?.trim() || DEFAULT_MODAL_WORKER_AUDIENCE,
    allowPlaintextInvocationForDevelopment: allowPlaintext,
  });

  const childEnvironment = { ...process.env };
  delete childEnvironment[ACTIVE_KEY_ID_ENV];
  delete childEnvironment[KEYRING_ENV];
  delete childEnvironment[ALLOW_PLAINTEXT_ENV];

  const child = spawn(
    process.env[COMMAND_ENV]?.trim() || "agent-runtime",
    parseStringArray(process.env[ARGS_ENV]),
    {
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.end(`${JSON.stringify(invocation)}\n`);

  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGTERM", forwardSignal);
  process.once("SIGINT", forwardSignal);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) reject(new Error(`Worker terminated by ${signal}.`));
        else resolve(code ?? 1);
      });
    });
  } finally {
    process.removeListener("SIGTERM", forwardSignal);
    process.removeListener("SIGINT", forwardSignal);
  }
};

void run().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Do not serialize raw errors: envelope, provider, or child failures may
    // contain secret-bearing details. The host observes a sanitized stream
    // failure and Modal retains stderr for trusted operational diagnostics.
    process.stderr.write("Modal Sandbox worker bootstrap failed.\n");
    process.exitCode = 1;
  },
);
