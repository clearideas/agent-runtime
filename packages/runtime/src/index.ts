import type { AgentManifest } from "@clearideas/agent-runtime-contracts";
import type {
  ConnectionCredentialProvider,
  ModelAdapter,
  ToolAdapter,
} from "@clearideas/agent-runtime-core/ports";

export {
  builtInProviderDefinition,
  emptyAgentRuntimeConfig,
  environmentReferenceSchema,
  isBuiltInProviderName,
  loadAgentRuntimeConfig,
  mcpConnectionAuthSchema,
  type McpConnectionDefinition,
  type McpConnectionAuth,
  type ModelCapabilities,
  parseAgentRuntimeConfig,
  type ProviderDefinition,
  AGENT_RUNTIME_CONFIG_SCHEMA_VERSION,
  type AgentRuntimeConfig,
  agentRuntimeConfigSchema,
  type ValueSource,
} from "./config.js";
export {
  ConfiguredMcpToolAdapter,
  type ConfiguredMcpToolAdapterOptions,
  ConnectionAuthorizationRequiredError,
  createConfiguredToolAdapter,
} from "./mcp-tools.js";
export {
  createConfiguredModelAdapter,
  type ModelAuthorizationPolicy,
  type ResolvedModelDefinition,
  resolveModelReference,
  validateModelCapabilities,
} from "./providers.js";
export {
  resolveEnvironmentReference,
  resolveHeaders,
  resolveValueSource,
  type ValueResolutionContext,
} from "./values.js";

import {
  builtInProviderDefinition,
  type AgentRuntimeConfig,
} from "./config.js";
import { createConfiguredToolAdapter } from "./mcp-tools.js";
import type { ConfiguredMcpToolAdapterOptions } from "./mcp-tools.js";
import {
  createConfiguredModelAdapter,
  type ModelAuthorizationPolicy,
  resolveModelReference,
  validateModelCapabilities,
} from "./providers.js";
import type { ValueResolutionContext } from "./values.js";

export interface ComposedRuntime {
  model?: ModelAdapter;
  tools?: ToolAdapter;
}

export interface ComposeRuntimeOptions {
  model?: boolean;
  tools?: boolean;
  modelPolicy?: ModelAuthorizationPolicy;
  toolOptions?: ConfiguredMcpToolAdapterOptions;
  /** @deprecated Pass credentialProvider in toolOptions. */
  connectionCredentials?: ConnectionCredentialProvider;
}

const stepModelReferences = (
  steps: AgentManifest["steps"],
): NonNullable<AgentManifest["model"]>[] =>
  steps.flatMap((step) => [
    ...(step.type === "prompt" && step.model ? [step.model] : []),
    ...(step.type === "loop" ? stepModelReferences(step.steps) : []),
  ]);

export const validateRuntimeConfiguration = (
  manifest: AgentManifest,
  config: AgentRuntimeConfig,
): void => {
  validateModelCapabilities(manifest, config);
  const references = [
    ...(manifest.model ? [manifest.model] : []),
    ...stepModelReferences(manifest.steps),
  ];
  for (const reference of references) {
    const resolved = resolveModelReference(reference, config);
    if (
      !config.providers[resolved.provider] &&
      !builtInProviderDefinition(resolved.provider)
    ) {
      throw new Error(`Unknown model provider "${resolved.provider}".`);
    }
  }
  for (const binding of manifest.connections ?? []) {
    const connection = config.connections[binding.ref];
    if (!connection && binding.required !== false) {
      throw new Error(`Unknown connection "${binding.ref}".`);
    }
    if (connection?.mode === "read" && binding.mode === "read_write") {
      throw new Error(
        `Connection "${binding.ref}" is read-only and cannot be elevated by an agent.`,
      );
    }
  }
};

export const composeRuntime = (
  manifest: AgentManifest,
  config: AgentRuntimeConfig,
  context: ValueResolutionContext = {},
  options: ComposeRuntimeOptions = {},
): ComposedRuntime => {
  const includeModel = options.model ?? true;
  const includeTools = options.tools ?? true;
  if (includeModel) validateRuntimeConfiguration(manifest, config);
  const model = includeModel
    ? createConfiguredModelAdapter(
        manifest,
        config,
        context,
        options.modelPolicy,
      )
    : undefined;
  const tools = includeTools
    ? createConfiguredToolAdapter(manifest, config, context, {
        ...options.toolOptions,
        ...(options.connectionCredentials
          ? { credentialProvider: options.connectionCredentials }
          : {}),
      })
    : undefined;
  return {
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
  };
};
