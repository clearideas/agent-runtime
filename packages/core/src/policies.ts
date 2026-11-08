import type {
  AgentManifest,
  AgentStep,
  ContextPolicy,
  ExecutionPolicies,
} from "@clearideas/agent-runtime-contracts";

/** Context fields that merge as nested objects; every other field is a value. */
const NESTED_CONTEXT_FIELDS = new Set(["summarizer", "trigger", "retain"]);

const mergeContext = (
  base: ContextPolicy | undefined,
  override: ContextPolicy | undefined,
): ContextPolicy | undefined => {
  if (!base) return override ? structuredClone(override) : undefined;
  if (!override) return structuredClone(base);
  const merged: Record<string, unknown> = { ...structuredClone(base) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (key === "variables") {
      const variables = {
        ...((merged.variables as ContextPolicy["variables"]) ?? {}),
      };
      for (const [name, entry] of Object.entries(
        value as NonNullable<ContextPolicy["variables"]>,
      )) {
        variables[name] = {
          ...(variables[name] ?? {}),
          ...structuredClone(entry),
        };
      }
      merged.variables = variables;
    } else if (NESTED_CONTEXT_FIELDS.has(key)) {
      merged[key] = {
        ...((merged[key] as object | undefined) ?? {}),
        ...structuredClone(value as object),
      };
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged as ContextPolicy;
};

/** Merge policy layers; later layers override earlier ones field by field. */
export const mergeExecutionPolicies = (
  ...layers: Array<ExecutionPolicies | undefined>
): ExecutionPolicies => {
  let result: ExecutionPolicies = {};
  for (const layer of layers) {
    if (!layer) continue;
    const next: ExecutionPolicies = { ...result };
    const context = mergeContext(result.context, layer.context);
    if (context) next.context = context;
    if (layer.toolCallLimit !== undefined)
      next.toolCallLimit = layer.toolCallLimit;
    if (layer.onError !== undefined) next.onError = layer.onError;
    if (layer.modelRetry)
      next.modelRetry = {
        ...(result.modelRetry ?? {}),
        ...structuredClone(layer.modelRetry),
      };
    if (layer.outputRepair)
      next.outputRepair = {
        ...(result.outputRepair ?? {}),
        ...structuredClone(layer.outputRepair),
      };
    result = next;
  }
  return result;
};

/**
 * Effective policies for one step: host defaults, then the manifest's
 * `policies`, then the step's own `policies`, then the host's enforced
 * policies, which no manifest can override.
 */
export const resolveStepPolicies = (
  hostDefaults: ExecutionPolicies | undefined,
  manifest: AgentManifest,
  step: AgentStep,
  hostEnforced?: ExecutionPolicies,
): ExecutionPolicies =>
  mergeExecutionPolicies(
    hostDefaults,
    manifest.policies,
    step.policies,
    hostEnforced,
  );
