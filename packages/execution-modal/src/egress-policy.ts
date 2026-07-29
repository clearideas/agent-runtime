import type {
  AgentConnectionBinding,
  AgentManifest,
  AgentStep,
  ModelReference,
} from "@clearideas/agent-runtime-contracts";
import { parseAgentManifest } from "@clearideas/agent-runtime-contracts";

export type AgentRunnerEgressOriginType =
  "control_plane" | "model" | "connection" | "webhook" | "tool";

export interface AgentRunnerEgressOrigin {
  type: AgentRunnerEgressOriginType;
  origin: string;
  provider?: string;
  step?: string;
  connectionRef?: string;
  tool?: string;
}

export interface AgentRunnerEgressPolicy {
  mode: "enforce";
  allowedOrigins: AgentRunnerEgressOrigin[];
}

export interface AgentRunnerEgressPolicyDecision {
  allowed: boolean;
  reason: string;
  policyId?: string;
}

export type ResolvedAgentRunnerEgressOrigin =
  string | Omit<AgentRunnerEgressOrigin, "type"> | AgentRunnerEgressOrigin;

interface AgentRunnerEgressResolutionContext {
  manifest: AgentManifest;
  path: string[];
}

export interface AgentRunnerEgressPolicyResolver {
  /** Trusted control-plane endpoints required by the worker. */
  controlPlaneOrigins?: readonly ResolvedAgentRunnerEgressOrigin[];
  /** Host default used when a prompt and its manifest omit a model. */
  defaultModel?: ModelReference;
  /**
   * Resolves a credential-free model reference through the host's model
   * catalog. The manifest never supplies provider endpoint URLs.
   */
  resolveModelOrigins?: (
    model: ModelReference,
    context: AgentRunnerEgressResolutionContext & { step: string },
  ) =>
    | readonly ResolvedAgentRunnerEgressOrigin[]
    | Promise<readonly ResolvedAgentRunnerEgressOrigin[]>;
  /**
   * Resolves a connection ref through the host's connection registry. The
   * manifest may narrow a binding but cannot provide its endpoint.
   */
  resolveConnectionOrigins?: (
    binding: AgentConnectionBinding,
    context: AgentRunnerEgressResolutionContext,
  ) =>
    | readonly ResolvedAgentRunnerEgressOrigin[]
    | Promise<readonly ResolvedAgentRunnerEgressOrigin[]>;
  /** Resolves host-registered tools such as managed web search/retrieval. */
  resolveToolOrigins?: (
    tool: string,
    context: AgentRunnerEgressResolutionContext & { step: string },
  ) =>
    | readonly ResolvedAgentRunnerEgressOrigin[]
    | Promise<readonly ResolvedAgentRunnerEgressOrigin[]>;
  /** Resolves host-owned sub-run references before recursively inspecting them. */
  resolveManifestRef?: (
    ref: string,
    context: AgentRunnerEgressResolutionContext & { step: string },
  ) => AgentManifest | null | Promise<AgentManifest | null>;
  /** Additional host-owned grants, for example a configured retrieval service. */
  additionalOrigins?: readonly ResolvedAgentRunnerEgressOrigin[];
  /** Invalid origins are omitted (fail closed) and may be reported by the host. */
  onInvalidOrigin?: (origin: string) => void;
}

const normalizeEgressOrigin = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
};

const normalizeEgressHost = (value: unknown): string =>
  typeof value === "string"
    ? value.trim().toLowerCase().replace(/\.$/u, "")
    : "";

const getOriginPort = (url: URL): number =>
  url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

const originKey = (item: AgentRunnerEgressOrigin): string =>
  [
    item.type,
    item.provider ?? "",
    item.connectionRef ?? "",
    item.tool ?? "",
    item.step ?? "",
    item.origin,
  ].join(":");

const addOrigin = (
  origins: Map<string, AgentRunnerEgressOrigin>,
  item: AgentRunnerEgressOrigin,
  onInvalidOrigin?: (origin: string) => void,
): void => {
  const origin = normalizeEgressOrigin(item.origin);
  if (!origin) {
    onInvalidOrigin?.(item.origin);
    return;
  }
  const normalized = { ...item, origin };
  origins.set(originKey(normalized), normalized);
};

const addResolvedOrigins = (
  origins: Map<string, AgentRunnerEgressOrigin>,
  items: readonly ResolvedAgentRunnerEgressOrigin[],
  defaults: Omit<AgentRunnerEgressOrigin, "origin">,
  onInvalidOrigin?: (origin: string) => void,
): void => {
  for (const item of items) {
    addOrigin(
      origins,
      typeof item === "string"
        ? { ...defaults, origin: item }
        : { ...defaults, ...item },
      onInvalidOrigin,
    );
  }
};

const stepLabel = (step: AgentStep): string => step.name ?? step.id;

/**
 * Builds a run egress policy using host-owned endpoint resolvers.
 *
 * This deliberately does not add egress fields to AgentManifest. Model,
 * connection, tool, and referenced-manifest endpoints are resolved by the
 * trusted host. Only an explicit webhook URL is read directly from a manifest
 * because it is already an endpoint-bearing step.
 */
export const resolveAgentRunnerEgressPolicy = async (
  manifestInput: AgentManifest,
  resolver: AgentRunnerEgressPolicyResolver,
): Promise<AgentRunnerEgressPolicy> => {
  const origins = new Map<string, AgentRunnerEgressOrigin>();
  const rootManifest = parseAgentManifest(manifestInput);

  addResolvedOrigins(
    origins,
    resolver.controlPlaneOrigins ?? [],
    { type: "control_plane" },
    resolver.onInvalidOrigin,
  );
  addResolvedOrigins(
    origins,
    resolver.additionalOrigins ?? [],
    { type: "tool" },
    resolver.onInvalidOrigin,
  );

  const visitManifest = async (
    manifest: AgentManifest,
    path: string[],
  ): Promise<void> => {
    const context = { manifest, path };

    for (const binding of manifest.connections ?? []) {
      const resolved =
        (await resolver.resolveConnectionOrigins?.(binding, context)) ?? [];
      addResolvedOrigins(
        origins,
        resolved,
        { type: "connection", connectionRef: binding.ref },
        resolver.onInvalidOrigin,
      );
    }

    const visitSteps = async (
      steps: AgentStep[],
      inheritedModel: ModelReference | undefined,
    ): Promise<void> => {
      for (const step of steps) {
        const label = stepLabel(step);
        const stepPath = [...path, step.id];
        const stepContext = { manifest, path: stepPath, step: label };

        if (step.type === "prompt") {
          const model = step.model ?? inheritedModel ?? resolver.defaultModel;
          if (model && resolver.resolveModelOrigins) {
            const resolved = await resolver.resolveModelOrigins(
              model,
              stepContext,
            );
            addResolvedOrigins(
              origins,
              resolved,
              {
                type: "model",
                ...("provider" in model ? { provider: model.provider } : {}),
              },
              resolver.onInvalidOrigin,
            );
          }
          for (const tool of step.tools ?? []) {
            const resolved =
              (await resolver.resolveToolOrigins?.(tool, stepContext)) ?? [];
            addResolvedOrigins(
              origins,
              resolved,
              { type: "tool", tool },
              resolver.onInvalidOrigin,
            );
          }
          continue;
        }

        if (step.type === "webhook") {
          addOrigin(
            origins,
            { type: "webhook", origin: step.url, step: label },
            resolver.onInvalidOrigin,
          );
          continue;
        }

        if (step.type === "loop") {
          await visitSteps(step.steps, inheritedModel);
          continue;
        }

        if (step.type === "sub-run") {
          const resolved = step.manifest
            ? step.manifest
            : step.manifestRef && resolver.resolveManifestRef
              ? await resolver.resolveManifestRef(step.manifestRef, stepContext)
              : undefined;
          const nested = resolved ? parseAgentManifest(resolved) : resolved;
          if (!nested && step.manifestRef) {
            if (nested === null) continue;
            throw new Error(
              `Cannot resolve egress for sub-run manifest ref ${step.manifestRef}.`,
            );
          }
          if (nested) await visitManifest(nested, stepPath);
        }
      }
    };

    await visitSteps(manifest.steps, manifest.model);
  };

  await visitManifest(rootManifest, []);
  return { mode: "enforce", allowedOrigins: [...origins.values()] };
};

/** Proxy-side exact host-and-port evaluator for the resolved portable policy. */
export const evaluateAgentRunnerEgressPolicyDestination = (
  policy: AgentRunnerEgressPolicy | undefined,
  targetHost: string,
  targetPort: number,
  options: { onInvalidOrigin?: (origin: string) => void } = {},
): AgentRunnerEgressPolicyDecision => {
  const normalizedTargetHost = normalizeEgressHost(targetHost);
  if (!policy || !Array.isArray(policy.allowedOrigins)) {
    return { allowed: false, reason: "agent runner egress policy is missing" };
  }
  if (
    !normalizedTargetHost ||
    !Number.isSafeInteger(targetPort) ||
    targetPort < 1 ||
    targetPort > 65_535
  ) {
    return { allowed: false, reason: "agent runner egress target is invalid" };
  }

  for (const item of policy.allowedOrigins) {
    try {
      const origin = new URL(item.origin);
      const allowedHost = normalizeEgressHost(origin.hostname);
      const isWildcardHost = allowedHost.startsWith("*.");
      const wildcardSuffix = isWildcardHost ? allowedHost.slice(2) : "";
      if (
        (allowedHost === normalizedTargetHost ||
          (isWildcardHost &&
            (normalizedTargetHost === wildcardSuffix ||
              normalizedTargetHost.endsWith(`.${wildcardSuffix}`)))) &&
        getOriginPort(origin) === targetPort
      ) {
        return {
          allowed: true,
          reason: `agent runner egress policy allows ${item.type}`,
          policyId: `${item.type}:${item.provider ?? item.connectionRef ?? item.tool ?? item.step ?? origin.origin}`,
        };
      }
    } catch {
      options.onInvalidOrigin?.(item.origin);
    }
  }

  return {
    allowed: false,
    reason: `agent runner egress policy does not allow ${normalizedTargetHost}:${targetPort}`,
  };
};
