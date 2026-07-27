import { createAnthropic } from "@ai-sdk/anthropic";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type {
  AgentManifest,
  JsonObject,
  ModelReference,
  AgentStep,
} from "@clearideas/agent-runtime-contracts";
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelResult,
} from "@clearideas/agent-runtime-core/ports";
import {
  AiSdkModelAdapter,
  createProviderRegistryModelResolver,
  type ProviderModelFactory,
} from "@clearideas/agent-runtime-model-ai-sdk";

import {
  builtInProviderDefinition,
  type ConfiguredModelDefinition,
  type ProviderDefinition,
  type AgentRuntimeConfig,
} from "./config.js";
import {
  resolveEnvironmentReference,
  resolveHeaders,
  resolveValueSource,
  type ValueResolutionContext,
} from "./values.js";

const DEFAULT_API_KEY_ENV: Partial<
  Record<ProviderDefinition["driver"], string>
> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  cohere: "COHERE_API_KEY",
};

export interface ResolvedModelDefinition {
  provider: string;
  model: string;
  options?: JsonObject;
  capabilities?: ConfiguredModelDefinition["capabilities"];
  profile?: string;
}

export interface ModelAuthorizationPolicy {
  /** Require agent manifests to reference host-defined model profiles. */
  requireProfiles?: boolean;
  /** Host allowlist of provider configuration names. */
  allowedProviders?: readonly string[];
  /** Host allowlist of resolved provider/model pairs. */
  allowedModels?: readonly string[];
  /** Permit a manifest to add or override provider options. Defaults to true. */
  allowManifestOptions?: boolean;
  /** Additional host authorization hook. Throw to reject the model reference. */
  authorizeModel?: (input: {
    reference: ModelReference;
    resolved: ResolvedModelDefinition;
  }) => void;
}

const asJsonObject = (value: unknown): JsonObject | undefined => {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonObject;
};

const mergeOptions = (
  base?: JsonObject,
  override?: JsonObject,
): JsonObject | undefined => {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
};

const explicitReference = (
  reference: ModelReference,
): reference is Extract<ModelReference, { provider: string }> =>
  "provider" in reference;

export const resolveModelReference = (
  reference: ModelReference,
  config: AgentRuntimeConfig,
): ResolvedModelDefinition => {
  if (explicitReference(reference)) {
    return {
      provider: reference.provider,
      model: reference.model,
      ...(reference.options ? { options: reference.options } : {}),
    };
  }
  const definition = config.models[reference.ref];
  if (!definition) throw new Error(`Unknown model profile "${reference.ref}".`);
  const defaults = asJsonObject(definition.options);
  const options = mergeOptions(defaults, reference.options);
  return {
    provider: definition.provider,
    model: definition.model,
    ...(options ? { options } : {}),
    ...(definition.capabilities
      ? { capabilities: definition.capabilities }
      : {}),
    profile: reference.ref,
  };
};

const configuredProvider = (
  name: string,
  config: AgentRuntimeConfig,
): ProviderDefinition => {
  const definition = config.providers[name] ?? builtInProviderDefinition(name);
  if (!definition) throw new Error(`Unknown model provider "${name}".`);
  return definition;
};

const resolveProviderApiKey = (
  name: string,
  definition: ProviderDefinition,
  context: ValueResolutionContext,
): string | undefined => {
  if (definition.apiKey) {
    return resolveEnvironmentReference(
      definition.apiKey,
      context,
      `Provider ${name}`,
    );
  }
  const defaultEnvironmentName = DEFAULT_API_KEY_ENV[definition.driver];
  if (!defaultEnvironmentName) return undefined;
  return resolveEnvironmentReference(
    { env: defaultEnvironmentName },
    context,
    `Provider ${name}`,
  );
};

const validateProviderBaseURL = (
  value: string,
  providerName: string,
): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Provider "${providerName}" baseURL is invalid.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(
      `Provider "${providerName}" baseURL must use HTTP or HTTPS without URL credentials.`,
    );
  }
  return value;
};

const modelFactory = (
  name: string,
  definition: ProviderDefinition,
  context: ValueResolutionContext,
): ProviderModelFactory => {
  const apiKey = resolveProviderApiKey(name, definition, context);
  const baseURL = definition.baseURL
    ? validateProviderBaseURL(
        resolveValueSource(
          definition.baseURL,
          context,
          `Provider ${name} baseURL`,
        ),
        name,
      )
    : undefined;
  const headers = resolveHeaders(definition.headers, context);

  switch (definition.driver) {
    case "openai": {
      const provider = createOpenAI({
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
      });
      return provider as unknown as ProviderModelFactory;
    }
    case "anthropic": {
      const provider = createAnthropic({
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
      });
      return provider as unknown as ProviderModelFactory;
    }
    case "google": {
      const provider = createGoogleGenerativeAI({
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
      });
      return provider as unknown as ProviderModelFactory;
    }
    case "xai": {
      const provider = createXai({
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
      });
      return provider as unknown as ProviderModelFactory;
    }
    case "groq": {
      const provider = createGroq({
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
      });
      return provider as unknown as ProviderModelFactory;
    }
    case "cohere": {
      const provider = createCohere({
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
      });
      return provider as unknown as ProviderModelFactory;
    }
    case "openai-compatible": {
      if (!baseURL)
        throw new Error(
          `OpenAI-compatible provider "${name}" requires baseURL.`,
        );
      const provider = createOpenAICompatible({
        name,
        baseURL,
        ...(apiKey ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
        ...(definition.includeUsage != null
          ? { includeUsage: definition.includeUsage }
          : {}),
        ...(definition.supportsStructuredOutputs != null
          ? { supportsStructuredOutputs: definition.supportsStructuredOutputs }
          : {}),
      });
      return provider as unknown as ProviderModelFactory;
    }
  }
};

const walkSteps = (
  steps: AgentStep[],
  visit: (step: AgentStep) => void,
): void => {
  for (const step of steps) {
    visit(step);
    if (step.type === "loop") walkSteps(step.steps, visit);
  }
};

const manifestModelReferences = (manifest: AgentManifest): ModelReference[] => {
  const references: ModelReference[] = manifest.model ? [manifest.model] : [];
  walkSteps(manifest.steps, (step) => {
    if (step.type === "prompt" && step.model) references.push(step.model);
  });
  return references;
};

const authorizeModelReference = (
  reference: ModelReference,
  resolved: ResolvedModelDefinition,
  policy: ModelAuthorizationPolicy,
): void => {
  if (policy.requireProfiles === true && explicitReference(reference)) {
    throw new Error(
      "This host requires agent manifests to use configured model profiles.",
    );
  }
  if (
    policy.allowedProviders &&
    !policy.allowedProviders.includes(resolved.provider)
  ) {
    throw new Error(
      `Model provider "${resolved.provider}" is not authorized by this host.`,
    );
  }
  const qualifiedModel = `${resolved.provider}/${resolved.model}`;
  if (policy.allowedModels && !policy.allowedModels.includes(qualifiedModel)) {
    throw new Error(
      `Model "${qualifiedModel}" is not authorized by this host.`,
    );
  }
  if (policy.allowManifestOptions === false && reference.options) {
    throw new Error("Model option overrides are not authorized by this host.");
  }
  policy.authorizeModel?.({ reference, resolved });
};

const resolveRequestModel = (
  model: string,
  config: AgentRuntimeConfig,
): ResolvedModelDefinition => {
  if (model.startsWith("ref/")) {
    const profile = model.slice("ref/".length);
    return resolveModelReference({ ref: profile }, config);
  }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator >= model.length - 1) {
    throw new Error(
      `Model "${model}" must use provider/model format or a model profile.`,
    );
  }
  return {
    provider: model.slice(0, separator),
    model: model.slice(separator + 1),
  };
};

class ConfiguredModelAdapter implements ModelAdapter {
  readonly #delegate: ModelAdapter;
  readonly #config: AgentRuntimeConfig;
  readonly #policy: ModelAuthorizationPolicy;

  constructor(
    delegate: ModelAdapter,
    config: AgentRuntimeConfig,
    policy: ModelAuthorizationPolicy,
  ) {
    this.#delegate = delegate;
    this.#config = config;
    this.#policy = policy;
  }

  #request(request: ModelRequest): ModelRequest {
    const resolved = resolveRequestModel(request.model, this.#config);
    const reference: ModelReference = resolved.profile
      ? { ref: resolved.profile }
      : { provider: resolved.provider, model: resolved.model };
    authorizeModelReference(reference, resolved, this.#policy);
    if (
      this.#policy.allowManifestOptions === false &&
      request.providerOptions
    ) {
      throw new Error(
        "Model option overrides are not authorized by this host.",
      );
    }
    const providerOptions = mergeOptions(
      resolved.options,
      request.providerOptions,
    );
    return {
      ...request,
      model: `${resolved.provider}/${resolved.model}`,
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  generate(request: ModelRequest): Promise<ModelResult> {
    return this.#delegate.generate(this.#request(request));
  }

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const resolved = this.#request(request);
    return this.#delegate.stream
      ? this.#delegate.stream(resolved)
      : fallbackStream(this.#delegate, resolved);
  }
}

async function* fallbackStream(
  delegate: ModelAdapter,
  request: ModelRequest,
): AsyncIterable<ModelEvent> {
  yield { type: "completed", result: await delegate.generate(request) };
}

export const createConfiguredModelAdapter = (
  manifest: AgentManifest,
  config: AgentRuntimeConfig,
  context: ValueResolutionContext = {},
  policy: ModelAuthorizationPolicy = {},
): ModelAdapter | undefined => {
  const references = manifestModelReferences(manifest);
  const providers = new Set<string>();
  for (const reference of references) {
    const resolved = resolveModelReference(reference, config);
    authorizeModelReference(reference, resolved, policy);
    providers.add(resolved.provider);
  }
  if (providers.size === 0) return undefined;
  const registry: Record<string, ProviderModelFactory> = {};
  for (const name of providers) {
    registry[name] = modelFactory(
      name,
      configuredProvider(name, config),
      context,
    );
  }
  const adapter = new AiSdkModelAdapter({
    resolveModel: createProviderRegistryModelResolver(registry),
  });
  return new ConfiguredModelAdapter(adapter, config, policy);
};

export const validateModelCapabilities = (
  manifest: AgentManifest,
  config: AgentRuntimeConfig,
): void => {
  walkSteps(manifest.steps, (step) => {
    if (step.type !== "prompt") return;
    const reference = step.model ?? manifest.model;
    if (!reference) throw new Error(`Prompt step ${step.id} requires a model.`);
    const resolved = resolveModelReference(reference, config);
    if (step.tools?.length && resolved.capabilities?.tools === false) {
      throw new Error(
        `Model used by prompt step ${step.id} does not support tools.`,
      );
    }
    if (
      step.outputSchema &&
      resolved.capabilities?.structuredOutput === false
    ) {
      throw new Error(
        `Model used by prompt step ${step.id} does not support structured output.`,
      );
    }
    if (
      step.maxOutputTokens &&
      resolved.capabilities?.maxOutputTokens &&
      step.maxOutputTokens > resolved.capabilities.maxOutputTokens
    ) {
      throw new Error(
        `Prompt step ${step.id} requests ${step.maxOutputTokens} output tokens, exceeding the configured model limit of ${resolved.capabilities.maxOutputTokens}.`,
      );
    }
  });
};
