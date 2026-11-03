import type { RunSandboxProvider } from "@clearideas/agent-runtime-core/ports";
import {
  BubblewrapSandboxProvider,
  DockerSandboxProvider,
  ProviderRunSandbox,
  type RunSandboxHostHooks,
  type SandboxProvider,
} from "@clearideas/agent-runtime-sandbox";

import type { AgentRuntimeConfig } from "./config.js";
import type { ValueResolutionContext } from "./values.js";

export interface ConfiguredRunSandboxOptions extends RunSandboxHostHooks {
  /** Required for `sandbox.driver: host`; ignored for docker and bubblewrap. */
  sandboxProvider?: SandboxProvider;
}

/** Create the run sandbox provider declared by the `sandbox` configuration section. */
export const createConfiguredRunSandbox = (
  config: AgentRuntimeConfig,
  _context: ValueResolutionContext = {},
  options: ConfiguredRunSandboxOptions = {},
): RunSandboxProvider | undefined => {
  const definition = config.sandbox;
  if (!definition) return undefined;
  let provider: SandboxProvider;
  let image: string;
  if (definition.driver === "docker") {
    image = definition.image!;
    provider = new DockerSandboxProvider({
      allowedImages: definition.allowedImages ?? [image],
    });
  } else if (definition.driver === "bubblewrap") {
    image = definition.image ?? "bubblewrap";
    provider = new BubblewrapSandboxProvider({
      ...(definition.binds ? { binds: definition.binds } : {}),
    });
  } else {
    if (!options.sandboxProvider) {
      throw new Error(
        "Sandbox driver host requires a SandboxProvider supplied through workspaceOptions.sandboxProvider.",
      );
    }
    provider = options.sandboxProvider;
    image = definition.image ?? "host";
  }
  const helperSource = definition.helper?.source;
  return new ProviderRunSandbox({
    provider,
    image,
    ...(definition.helper?.command ||
    (helperSource && typeof helperSource === "object")
      ? {
          helper: {
            ...(definition.helper?.command
              ? { command: definition.helper.command }
              : {}),
            ...(helperSource && typeof helperSource === "object"
              ? { source: helperSource.path }
              : {}),
          },
        }
      : {}),
    commands: definition.commands,
    shell: definition.shell,
    ...(definition.limits ? { limits: definition.limits } : {}),
    ...(definition.allowedEnvironment
      ? { allowedEnvironment: definition.allowedEnvironment }
      : {}),
    ...(options.authorizeSandbox
      ? { authorizeSandbox: options.authorizeSandbox }
      : {}),
    ...(options.authorizeCommand
      ? { authorizeCommand: options.authorizeCommand }
      : {}),
  });
};
