import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentRuntime,
  createConfiguredModelAdapter,
  FileRunStore,
  JexlConditionEvaluator,
  parseAgentRunManifest,
  parseAgentRuntimeConfig,
  PromptStepExecutor,
  type AgentManifest,
  type ModelAdapter,
  type RunEvent,
  type RunResult,
} from "@clearideas/agent-runtime";

import { AgentRunnerStorage } from "./storage.ts";

const exampleDirectory = path.dirname(fileURLToPath(import.meta.url));

export type AgentRunnerMessage =
  | { kind: "accepted"; runId: string }
  | { kind: "event"; event: RunEvent }
  | { kind: "result"; result: RunResult };

export interface AgentRunnerHost {
  storage: AgentRunnerStorage;
  execute(
    manifestId: unknown,
    variables: unknown,
    onMessage: (message: AgentRunnerMessage) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  resume(
    runId: unknown,
    onMessage: (message: AgentRunnerMessage) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export const createAgentHost = async (
  dataDirectory: string,
  modelAdapter?: ModelAdapter,
): Promise<AgentRunnerHost> => {
  // The app stores editable manifests separately from Agent Runtime's run data.
  const storage = new AgentRunnerStorage(
    dataDirectory,
    path.join(exampleDirectory, "hello.agent.yaml"),
  );
  await storage.initialize();

  // Agents use `model.ref: default`; the host owns the actual provider, model,
  // and credentials behind that profile.
  const runtimeConfig = parseAgentRuntimeConfig({
    version: "1.0",
    models: {
      default: {
        provider: "openai",
        model: "gpt-5.6-luna",
      },
    },
  });
  const runStore = new FileRunStore(path.join(dataDirectory, "runtime"));
  const stepExecutors = [new PromptStepExecutor()];
  const conditionEvaluator = new JexlConditionEvaluator();

  const createRuntime = (
    manifest: AgentManifest,
    onMessage: (message: AgentRunnerMessage) => void | Promise<void>,
  ): AgentRuntime => {
    const configuredModel =
      modelAdapter ?? createConfiguredModelAdapter(manifest, runtimeConfig);

    return new AgentRuntime({
      runStore,
      // Executors are the behavior this host permits. Registering only the
      // prompt executor means this example intentionally supports prompt steps.
      stepExecutors,
      // The evaluator gives `when` expressions access to the current variables.
      conditionEvaluator,
      ...(configuredModel ? { model: configuredModel } : {}),
      eventSinks: [{ emit: (event) => onMessage({ kind: "event", event }) }],
    });
  };

  const execute: AgentRunnerHost["execute"] = async (
    manifestId,
    variables,
    onMessage,
    signal,
  ) => {
    const saved = await storage.loadManifest(manifestId);
    const runId = `run-${randomUUID()}`;

    // Validate the browser's values against the portable run contract before
    // creating a run or calling a model.
    const runManifest = parseAgentRunManifest({
      schemaVersion: "1.0",
      agent: { ref: saved.manifest.id ?? saved.id },
      runId,
      variables: variables ?? [],
    });
    await onMessage({ kind: "accepted", runId });

    const result = await createRuntime(saved.manifest, onMessage).run({
      manifest: saved.manifest,
      runId,
      ...(runManifest.variables ? { variables: runManifest.variables } : {}),
      ...(signal ? { signal } : {}),
    });
    await onMessage({ kind: "result", result });
  };

  const resume: AgentRunnerHost["resume"] = async (
    runId,
    onMessage,
    signal,
  ) => {
    if (typeof runId !== "string") throw new Error("Run id is required.");
    const record = await runStore.loadRun(runId);
    if (!record) throw new Error("Run not found.");

    await onMessage({ kind: "accepted", runId });
    const result = await createRuntime(record.manifest, onMessage).run({
      runId,
      resume: true,
      ...(signal ? { signal } : {}),
    });
    await onMessage({ kind: "result", result });
  };

  return { storage, execute, resume };
};
