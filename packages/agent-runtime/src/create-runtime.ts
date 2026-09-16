import {
  AgentRuntime,
  type AgentRuntimeDependencies,
} from "@clearideas/agent-runtime-core";
import {
  parseAgentManifest,
  type AgentManifest,
} from "@clearideas/agent-runtime-contracts";
import {
  composeRuntime,
  emptyAgentRuntimeConfig,
  type AgentRuntimeConfig,
  type ComposeRuntimeOptions,
} from "@clearideas/agent-runtime-config";
import { MemoryRunStore } from "@clearideas/agent-runtime-store-local";
import { JexlConditionEvaluator } from "@clearideas/agent-runtime-condition-jexl";
import { PromptStepExecutor } from "@clearideas/agent-runtime-step-prompt";
import { LoopStepExecutor } from "@clearideas/agent-runtime-step-loop";
import {
  ApprovalStepExecutor,
  CodeStepExecutor,
  SubRunStepExecutor,
} from "@clearideas/agent-runtime-step-standard";

export interface CreateAgentRuntimeOptions extends Partial<AgentRuntimeDependencies> {
  manifest: AgentManifest;
  config?: AgentRuntimeConfig;
  composition?: ComposeRuntimeOptions;
}

/** Validate an agent definition while providing TypeScript completion at the call site. */
export const defineAgent = (manifest: AgentManifest): AgentManifest =>
  parseAgentManifest(manifest);

/** Standard composition with in-memory persistence. Supply a durable runStore for resume across processes. */
export const createAgentRuntime = (
  options: CreateAgentRuntimeOptions,
): AgentRuntime => {
  const {
    manifest: input,
    config = emptyAgentRuntimeConfig(),
    composition,
    ...overrides
  } = options;
  const manifest = parseAgentManifest(input);
  const adapters = composeRuntime(
    manifest,
    config,
    {},
    {
      ...composition,
      model: overrides.model ? false : (composition?.model ?? true),
      tools: overrides.tools ? false : (composition?.tools ?? true),
    },
  );
  return new AgentRuntime({
    runStore: new MemoryRunStore(),
    agentManifestSource: { loadManifest: async () => manifest },
    stepExecutors: [
      new PromptStepExecutor(),
      new LoopStepExecutor(),
      new ApprovalStepExecutor(),
      new CodeStepExecutor(),
      new SubRunStepExecutor(),
    ],
    conditionEvaluator: new JexlConditionEvaluator(),
    ...adapters,
    ...overrides,
  });
};
