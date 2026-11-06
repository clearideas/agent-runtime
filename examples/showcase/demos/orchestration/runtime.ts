/**
 * The runtime for the launch-plan agent. Both execution engines build it
 * the same way: in this process, or inside the remote worker process.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentRuntime,
  composeRuntime,
  FileAgentManifestSource,
  FileRunStore,
  JexlConditionEvaluator,
  loadAgentRuntimeConfig,
  LoopStepExecutor,
  PromptStepExecutor,
  type ModelAdapter,
  type RunEvent,
} from "@clearideas/agent-runtime";

import { withModelOverrides } from "../../lib/host-kit.ts";
import { ScriptedModelAdapter } from "../../lib/scripted-model.ts";
import { orchestrationScript } from "./script.ts";

const demoDirectory = path.dirname(fileURLToPath(import.meta.url));

export const manifest = await new FileAgentManifestSource(
  demoDirectory,
  "agent.yaml",
).loadManifest();
const config = withModelOverrides(
  await loadAgentRuntimeConfig(path.join(demoDirectory, "runtime.config.yaml")),
);

export interface LaunchRuntimeOptions {
  mode: "scripted" | "live";
  pace: number;
  storeDirectory: string;
  onEvent(event: RunEvent): void | Promise<void>;
  /** Tests only: replaces the configured live model. */
  liveModel?: ModelAdapter;
}

export const createLaunchRuntime = (options: LaunchRuntimeOptions) => {
  const composed =
    options.mode === "live" && !options.liveModel
      ? composeRuntime(manifest, config, { environment: process.env })
      : {};
  return new AgentRuntime({
    ...composed,
    model:
      options.mode === "live"
        ? (options.liveModel ?? composed.model!)
        : new ScriptedModelAdapter(orchestrationScript, { pace: options.pace }),
    runStore: new FileRunStore(options.storeDirectory),
    // Loops need the loop executor; `when` and loop goals need conditions.
    stepExecutors: [new PromptStepExecutor(), new LoopStepExecutor()],
    conditionEvaluator: new JexlConditionEvaluator(),
    eventSinks: [{ emit: (event) => options.onEvent(event) }],
    // Delivering events is part of the protocol here: a lost event is a failure.
    eventSinkFailurePolicy: "fail-run",
  });
};
