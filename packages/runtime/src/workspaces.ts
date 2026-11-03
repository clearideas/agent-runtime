import path from "node:path";

import type { AgentWorkspaceBinding } from "@clearideas/agent-runtime-contracts";
import type {
  WorkspaceProvider,
  WorkspaceStore,
} from "@clearideas/agent-runtime-core/ports";
import { LocalDirectoryWorkspace } from "@clearideas/agent-runtime-store-local";

import type { AgentRuntimeConfig, WorkspaceDefinition } from "./config.js";
import { resolveValueSource, type ValueResolutionContext } from "./values.js";

export interface ConfiguredWorkspaceProviderOptions {
  /** Base directory for relative roots from environment references. Defaults to the working directory. */
  baseDirectory?: string;
  /** Supply stores for `driver: host` workspaces or replace the local driver. */
  createWorkspace?: (
    name: string,
    definition: WorkspaceDefinition,
    context: ValueResolutionContext,
  ) => WorkspaceStore | undefined;
}

/** Hide provider-native attachment for definitions that require staged copies. */
const withoutAttachment = (store: WorkspaceStore): WorkspaceStore => {
  if (!store.attachable) return store;
  const { attachable: _attachable, ...rest } = store;
  return {
    ...rest,
    entries: (options) => store.entries(options),
    read: (path, options) => store.read(path, options),
    ...(store.write
      ? { write: (path, data, options) => store.write!(path, data, options) }
      : {}),
    ...(store.delete
      ? { delete: (path, options) => store.delete!(path, options) }
      : {}),
  };
};

/**
 * Resolves manifest bindings against the `workspaces` section of the runtime
 * configuration. Stores are created once per provider so the run sandbox and
 * the tool adapter share the same instance.
 */
export class ConfiguredWorkspaceProvider implements WorkspaceProvider {
  readonly #config: AgentRuntimeConfig;
  readonly #context: ValueResolutionContext;
  readonly #options: ConfiguredWorkspaceProviderOptions;
  readonly #stores = new Map<string, WorkspaceStore>();

  constructor(
    config: AgentRuntimeConfig,
    context: ValueResolutionContext = {},
    options: ConfiguredWorkspaceProviderOptions = {},
  ) {
    this.#config = config;
    this.#context = context;
    this.#options = options;
  }

  definition(ref: string): WorkspaceDefinition | undefined {
    return this.#config.workspaces?.[ref];
  }

  async resolveWorkspace(
    binding: AgentWorkspaceBinding,
  ): Promise<WorkspaceStore | undefined> {
    const definition = this.definition(binding.ref);
    if (!definition) return undefined;
    const existing = this.#stores.get(binding.ref);
    if (existing) return existing;
    const created =
      this.#options.createWorkspace?.(binding.ref, definition, this.#context) ??
      (definition.driver === "local"
        ? this.#createLocalWorkspace(binding.ref, definition)
        : undefined);
    if (!created) {
      throw new Error(
        `Workspace "${binding.ref}" uses driver host and requires a store from the host.`,
      );
    }
    if (created.mode === "read" && definition.mode === "read_write") {
      throw new Error(
        `Workspace "${binding.ref}" store is read-only but the configuration declares read_write.`,
      );
    }
    const store =
      definition.attach === "never" ? withoutAttachment(created) : created;
    this.#stores.set(binding.ref, store);
    return store;
  }

  #createLocalWorkspace(
    name: string,
    definition: Extract<WorkspaceDefinition, { driver: "local" }>,
  ): WorkspaceStore {
    const root = path.resolve(
      this.#options.baseDirectory ?? process.cwd(),
      resolveValueSource(
        definition.root,
        this.#context,
        `Workspace ${name} root`,
      ),
    );
    return new LocalDirectoryWorkspace({
      root,
      mode: definition.mode,
      ...(definition.include ? { include: definition.include } : {}),
      ...(definition.exclude ? { exclude: definition.exclude } : {}),
      ...(definition.maxFiles ? { maxFiles: definition.maxFiles } : {}),
      ...(definition.maxFileBytes
        ? { maxFileBytes: definition.maxFileBytes }
        : {}),
      ...(definition.maxTotalBytes
        ? { maxTotalBytes: definition.maxTotalBytes }
        : {}),
    });
  }
}

export const createConfiguredWorkspaceProvider = (
  config: AgentRuntimeConfig,
  context: ValueResolutionContext = {},
  options: ConfiguredWorkspaceProviderOptions = {},
): ConfiguredWorkspaceProvider | undefined => {
  if (Object.keys(config.workspaces ?? {}).length === 0) return undefined;
  return new ConfiguredWorkspaceProvider(config, context, options);
};
