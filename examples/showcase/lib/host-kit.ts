/**
 * Small helpers shared by the demo hosts. Nothing here is specific to Agent
 * Runtime integration; it keeps each host.ts focused on the parts that are.
 */
import {
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
  type JsonValue,
  type RunResult,
  type ToolAdapter,
  type WorkspaceDefinition,
} from "@clearideas/agent-runtime";

import type { ShowcaseMessage } from "./demo.ts";
import { ObservedToolAdapter, truncateForDisplay } from "./observed-tools.ts";

export const toJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

/** Live mode may select another provider or model without editing YAML. */
export const withModelOverrides = (
  config: AgentRuntimeConfig,
): AgentRuntimeConfig => {
  const profile = config.models.default;
  if (!profile) return config;
  return parseAgentRuntimeConfig({
    ...config,
    models: {
      ...config.models,
      default: {
        ...profile,
        provider: process.env.SHOWCASE_PROVIDER ?? profile.provider,
        model: process.env.SHOWCASE_MODEL ?? profile.model,
      },
    },
  });
};

/** The include/exclude globs of a local workspace definition. */
export const visibilityOf = (definition: WorkspaceDefinition | undefined) =>
  definition?.driver === "local"
    ? {
        ...(definition.include ? { include: definition.include } : {}),
        ...(definition.exclude ? { exclude: definition.exclude } : {}),
      }
    : {};

/** The parts of a RunResult the browser shows. */
export const summarizeResult = (result: RunResult): JsonValue =>
  toJson({
    runId: result.runId,
    output: result.output ?? null,
    state: result.state,
    stepResults: result.stepResults.map((step) => ({
      stepId: step.stepId,
      status: step.status,
      output: step.output ?? null,
    })),
    usage: result.usage ?? null,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  });

/** Mirror tool inputs and outputs to the browser (events carry names only). */
export const mirrorTools = (
  tools: ToolAdapter,
  emit: (message: ShowcaseMessage) => void,
): ToolAdapter =>
  new ObservedToolAdapter(tools, ({ stepId, call, result }) =>
    emit({
      kind: "tool-io",
      stepId,
      toolCallId: call.id,
      name: call.name,
      input: truncateForDisplay(call.input),
      ...(result.error
        ? { error: { code: result.error.code, message: result.error.message } }
        : { output: truncateForDisplay(result.output) }),
      ...(result.artifacts?.length
        ? { artifacts: toJson(result.artifacts) }
        : {}),
    }),
  );
