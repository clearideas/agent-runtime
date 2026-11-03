import type { AgentManifest } from "@clearideas/agent-runtime-contracts";
import type {
  ConnectionCredentialProvider,
  ModelAdapter,
  RunSandboxProvider,
  ToolAdapter,
  WorkspaceProvider,
} from "@clearideas/agent-runtime-core/ports";
import {
  BUILTIN_READ_TOOLS,
  BUILTIN_WORKSPACE_TOOLS,
  SHELL_TOOL_NAME,
} from "@clearideas/agent-runtime-sandbox";

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
  resolveConfigurationPaths,
  type SandboxCommandDefinition,
  type SandboxDefinition,
  sandboxCommandDefinitionSchema,
  sandboxDefinitionSchema,
  sandboxLimitsSchema,
  type WorkspaceDefinition,
  workspaceDefinitionSchema,
} from "./config.js";
export { CompositeToolAdapter } from "./composite-tools.js";
export {
  type ConfiguredRunSandboxOptions,
  createConfiguredRunSandbox,
} from "./run-sandbox.js";
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
export {
  createConfiguredWorkspaceToolAdapter,
  WorkspaceToolAdapter,
  type WorkspaceToolAdapterOptions,
  workspaceToolName,
} from "./workspace-tools.js";
export {
  ConfiguredWorkspaceProvider,
  type ConfiguredWorkspaceProviderOptions,
  createConfiguredWorkspaceProvider,
} from "./workspaces.js";

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
import { CompositeToolAdapter } from "./composite-tools.js";
import {
  type ConfiguredRunSandboxOptions,
  createConfiguredRunSandbox,
} from "./run-sandbox.js";
import {
  createConfiguredWorkspaceToolAdapter,
  type WorkspaceToolAdapterOptions,
} from "./workspace-tools.js";
import {
  type ConfiguredWorkspaceProviderOptions,
  createConfiguredWorkspaceProvider,
} from "./workspaces.js";

export interface ComposedRuntime {
  model?: ModelAdapter;
  /** Remote MCP connections and workspace tools, routed by name. */
  tools?: ToolAdapter;
  /** Resolves manifest workspace bindings; pass to AgentRuntime as `workspaces`. */
  workspaces?: WorkspaceProvider;
  /** Opens the per-run sandbox; pass to AgentRuntime as `runSandbox`. */
  runSandbox?: RunSandboxProvider;
}

export interface WorkspaceCompositionOptions
  extends
    WorkspaceToolAdapterOptions,
    ConfiguredWorkspaceProviderOptions,
    ConfiguredRunSandboxOptions {
  /** Host-supplied provider used instead of the configuration's `workspaces` section. */
  provider?: WorkspaceProvider;
  /** Host-supplied run sandbox used instead of the configuration's `sandbox` section. */
  runSandbox?: RunSandboxProvider;
}

export interface ComposeRuntimeOptions {
  model?: boolean;
  tools?: boolean;
  /** Compose configured workspaces, the run sandbox, and workspace tools. Defaults to true. */
  workspaces?: boolean;
  modelPolicy?: ModelAuthorizationPolicy;
  toolOptions?: ConfiguredMcpToolAdapterOptions;
  workspaceOptions?: WorkspaceCompositionOptions;
  /** @deprecated Pass credentialProvider in toolOptions. */
  connectionCredentials?: ConnectionCredentialProvider;
}

/** Every tool name a workspace definition can expose under the configured sandbox policy. */
const hostWorkspaceToolNames = (config: AgentRuntimeConfig): Set<string> => {
  const names = new Set<string>(BUILTIN_WORKSPACE_TOOLS);
  for (const name of Object.keys(config.sandbox?.commands ?? {}))
    names.add(name);
  if (config.sandbox?.shell?.enabled) names.add(SHELL_TOOL_NAME);
  return names;
};

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
  const hostTools = hostWorkspaceToolNames(config);
  let bindsWorkspace = false;
  for (const binding of manifest.workspaces ?? []) {
    const workspace = config.workspaces?.[binding.ref];
    if (!workspace) {
      if (binding.required !== false)
        throw new Error(`Unknown workspace "${binding.ref}".`);
      continue;
    }
    bindsWorkspace = true;
    if (workspace.mode === "read" && binding.mode === "read_write") {
      throw new Error(
        `Workspace "${binding.ref}" is read-only and cannot be elevated by an agent.`,
      );
    }
    const mode = binding.mode ?? workspace.mode;
    for (const tool of binding.tools ?? []) {
      if (!hostTools.has(tool)) {
        throw new Error(
          `Workspace "${binding.ref}" binding names a tool the host does not expose: ${tool}.`,
        );
      }
      if (
        mode === "read" &&
        (BUILTIN_WORKSPACE_TOOLS as readonly string[]).includes(tool) &&
        !(BUILTIN_READ_TOOLS as readonly string[]).includes(tool)
      ) {
        throw new Error(
          `Workspace "${binding.ref}" binding names ${tool}, which requires read_write.`,
        );
      }
    }
  }
  if (bindsWorkspace && !config.sandbox) {
    throw new Error(
      "Workspace bindings require a sandbox section in the runtime configuration.",
    );
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
  const includeWorkspaces = options.workspaces ?? true;
  if (includeModel) validateRuntimeConfiguration(manifest, config);
  const model = includeModel
    ? createConfiguredModelAdapter(
        manifest,
        config,
        context,
        options.modelPolicy,
      )
    : undefined;
  const connectionTools = includeTools
    ? createConfiguredToolAdapter(manifest, config, context, {
        ...options.toolOptions,
        ...(options.connectionCredentials
          ? { credentialProvider: options.connectionCredentials }
          : {}),
      })
    : undefined;
  const {
    provider: hostWorkspaces,
    runSandbox: hostRunSandbox,
    sandboxProvider,
    baseDirectory,
    createWorkspace,
    authorizeSandbox,
    authorizeCommand,
    ...toolOptions
  } = options.workspaceOptions ?? {};
  const workspaces = includeWorkspaces
    ? (hostWorkspaces ??
      createConfiguredWorkspaceProvider(config, context, {
        ...(baseDirectory ? { baseDirectory } : {}),
        ...(createWorkspace ? { createWorkspace } : {}),
      }))
    : undefined;
  const runSandbox = includeWorkspaces
    ? (hostRunSandbox ??
      createConfiguredRunSandbox(config, context, {
        ...(sandboxProvider ? { sandboxProvider } : {}),
        ...(authorizeSandbox ? { authorizeSandbox } : {}),
        ...(authorizeCommand ? { authorizeCommand } : {}),
      }))
    : undefined;
  if (
    includeWorkspaces &&
    workspaces &&
    !runSandbox &&
    (manifest.workspaces ?? []).some((binding) => binding.required !== false)
  ) {
    throw new Error(
      "Workspace bindings require a sandbox section in the runtime configuration or a host-supplied run sandbox.",
    );
  }
  const workspaceTools =
    includeTools && includeWorkspaces
      ? createConfiguredWorkspaceToolAdapter(
          manifest,
          workspaces,
          runSandbox,
          toolOptions,
        )
      : undefined;
  const adapters = [connectionTools, workspaceTools].filter(
    (adapter): adapter is ToolAdapter => adapter != null,
  );
  const tools =
    adapters.length > 1 ? new CompositeToolAdapter(adapters) : adapters[0];
  return {
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
    ...(workspaces ? { workspaces } : {}),
    ...(runSandbox ? { runSandbox } : {}),
  };
};
