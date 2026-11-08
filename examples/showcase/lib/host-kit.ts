/**
 * Small helpers shared by the demo hosts. Nothing here is specific to Agent
 * Runtime integration; it keeps each host.ts focused on the parts that are.
 */
import {
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
  type EventSink,
  type JsonValue,
  type ModelAdapter,
  type ModelEvent,
  type RunResult,
  type ToolAdapter,
  type ToolCall,
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

/**
 * Forward `ModelAdapter.describeModel` (model limits, used to size context
 * reduction) from a wrapped adapter. Written without naming the method on the
 * type, so the showcase also type-checks against runtimes that predate it.
 */
export const forwardDescribeModel = (
  model: ModelAdapter,
): Record<string, unknown> => {
  const describe = (model as { describeModel?: (name: string) => unknown })
    .describeModel;
  return describe
    ? { describeModel: (name: string) => describe.call(model, name) }
    : {};
};

/**
 * Agent Runtime answers a tool call the step does not allow (or one the model
 * adapter marked invalid) with an error and never runs it, so the ToolAdapter
 * mirror above never sees it. This mirrors those refused calls too: it
 * remembers each call the model requests and, when `model.tool.completed`
 * reports `rejected: true`, streams the call's input with the refusal.
 */
export const mirrorRefusedCalls = (
  model: ModelAdapter,
  emit: (message: ShowcaseMessage) => void,
): { model: ModelAdapter; eventSink: EventSink } => {
  const requested = new Map<string, ToolCall>();
  const remember = (calls: ToolCall[] | undefined) => {
    for (const call of calls ?? []) requested.set(call.id, call);
  };
  const observed: ModelAdapter = {
    generate: async (request) => {
      const result = await model.generate(request);
      remember(result.toolCalls);
      return result;
    },
    ...(model.stream
      ? {
          async *stream(request): AsyncIterable<ModelEvent> {
            for await (const event of model.stream!(request)) {
              if (event.type === "tool-call") remember([event.call]);
              if (event.type === "completed") remember(event.result.toolCalls);
              yield event;
            }
          },
        }
      : {}),
    ...forwardDescribeModel(model),
  };
  const eventSink: EventSink = {
    emit(event) {
      if (
        event.type !== "model.tool.completed" ||
        event.data?.rejected !== true
      )
        return;
      const call = requested.get(String(event.data.toolCallId));
      if (!call) return;
      emit({
        kind: "tool-io",
        stepId: event.stepId ?? "",
        toolCallId: call.id,
        name: call.name,
        input: truncateForDisplay(call.input),
        error: {
          code: String(event.data.errorCode ?? "tool_not_allowed"),
          message:
            "Agent Runtime refused the call: the step does not allow this tool.",
        },
      });
    },
  };
  return { model: observed, eventSink };
};
