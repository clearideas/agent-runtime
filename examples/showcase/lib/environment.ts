/**
 * Decides which sandbox the showcase runs workspace commands in, and which
 * model modes are allowed with it.
 *
 *   bubblewrap  Linux namespaces, no daemon. Isolated.
 *   docker      A container per run. Isolated.
 *   unisolated  DEMO FALLBACK ONLY. Commands run as ordinary host processes in
 *               a temporary directory (the package's test-only provider). It is
 *               offered only with the scripted model on a loopback address so
 *               the demos work on any laptop, and the UI says so loudly.
 *
 * Production hosts choose a sandbox in their configuration file and never
 * fall back; this module exists because a demo should start everywhere.
 */
import { spawnSync } from "node:child_process";

import {
  BubblewrapSandboxProvider,
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
  type SandboxProvider,
} from "@clearideas/agent-runtime";
import { UnisolatedDemoProvider } from "./unisolated-provider.ts";

export type SandboxKind = "bubblewrap" | "docker" | "unisolated" | "none";
export type ModelMode = "scripted" | "live";

export interface SandboxChoice {
  kind: SandboxKind;
  /** Absolute interpreter path used by the unisolated fallback. */
  python?: string;
  /** Docker only: whether the sandbox image is already pulled. */
  imagePresent?: boolean;
  isolated: boolean;
  /** One-line explanation shown in the UI. */
  detail: string;
  /** Why better options were not used, for the setup hint. */
  notes: string[];
  image?: string;
}

export interface ShowcaseEnvironment {
  sandbox: SandboxChoice;
  python: string | undefined;
  live: {
    available: boolean;
    reason: string;
    provider: string;
    model: string;
  };
  loopback: boolean;
}

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 8000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

export const dockerImagePresent = (image: string) =>
  run("docker", ["image", "inspect", "--format", "{{.Id}}", image]) !==
  undefined;

/**
 * Pull the sandbox image, showing Docker's progress. The first pull of
 * python:3.12-slim is about 50 MB; afterwards sandboxes start in a second.
 */
export const pullDockerImage = (image: string): boolean =>
  spawnSync("docker", ["pull", image], { stdio: "inherit" }).status === 0;

const isLoopback = (host: string) =>
  host === "127.0.0.1" || host === "localhost" || host === "::1";

const providerKeys: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  cohere: "COHERE_API_KEY",
};

export const detectEnvironment = async (options: {
  host: string;
  preference?: string;
  dockerImage?: string;
  liveProvider?: string;
  liveModel?: string;
}): Promise<ShowcaseEnvironment> => {
  const preference = options.preference ?? "auto";
  const python = run("python3", ["--version"]);
  // The real interpreter behind `python3`. Shims (pyenv, asdf) and the macOS
  // developer-tools stub need variables such as HOME that sandboxes strip.
  const pythonExecutable = python
    ? run("python3", ["-c", "import sys; print(sys.executable)"])
    : undefined;
  const notes: string[] = [];
  let sandbox: SandboxChoice | undefined;

  if (preference === "auto" || preference === "bubblewrap") {
    if (process.platform !== "linux") {
      notes.push("bubblewrap requires Linux.");
    } else if (!python) {
      notes.push("bubblewrap needs python3 on the host for the file helper.");
    } else {
      try {
        await new BubblewrapSandboxProvider().probe();
        sandbox = {
          kind: "bubblewrap",
          isolated: true,
          detail:
            "bubblewrap: separate user, PID, IPC, and network namespaces; read-only system binds.",
          notes: [],
        };
      } catch (error) {
        notes.push(
          `bubblewrap unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (!sandbox && (preference === "auto" || preference === "docker")) {
    // `docker info` fails when the CLI is missing or the daemon (Docker
    // Desktop on Windows and macOS) is not running.
    const osType = run("docker", ["info", "--format", "{{.OSType}}"]);
    const image = options.dockerImage ?? "python:3.12-slim";
    if (!osType) {
      notes.push(
        "Docker is not reachable. Start Docker Desktop (or the Docker daemon) and wait until it reports that it is running, then restart the showcase.",
      );
    } else if (osType !== "linux") {
      notes.push(
        `Docker is running ${osType} containers. Switch Docker Desktop to Linux containers (right-click the Docker icon > Switch to Linux containers).`,
      );
    } else {
      sandbox = {
        kind: "docker",
        isolated: true,
        image,
        imagePresent: dockerImagePresent(image),
        detail: `Docker (${image}): no network, read-only root filesystem, resource limits.`,
        notes: [],
      };
    }
  }

  if (!sandbox && (preference === "auto" || preference === "unisolated")) {
    if (!python) {
      notes.push("The unisolated fallback also needs python3 on the host.");
    } else if (!isLoopback(options.host)) {
      notes.push(
        "The unisolated fallback is only offered on a loopback address.",
      );
    } else {
      sandbox = {
        kind: "unisolated",
        isolated: false,
        ...(pythonExecutable ? { python: pythonExecutable } : {}),
        detail:
          "NOT ISOLATED: commands run as ordinary host processes in a temporary directory.",
        notes: [],
      };
    }
  }

  sandbox ??= {
    kind: "none",
    isolated: false,
    detail: "No sandbox available; workspace demos cannot run.",
    notes: [],
  };
  sandbox.notes = notes;

  const provider = options.liveProvider ?? "openai";
  const model = options.liveModel ?? "gpt-6-luna";
  const keyName = providerKeys[provider];
  const hasKey = keyName ? Boolean(process.env[keyName]) : true;
  const live = !sandbox.isolated
    ? {
        available: false,
        reason:
          "Live models require an isolated sandbox (bubblewrap or Docker).",
      }
    : !hasKey
      ? {
          available: false,
          reason:
            process.platform === "win32"
              ? `Set ${keyName} to enable live models (PowerShell: $env:${keyName} = "…", then restart).`
              : `Set ${keyName} to enable live models (export ${keyName}="…", then restart).`,
        }
      : { available: true, reason: `${provider}/${model}` };

  return {
    sandbox,
    python,
    live: { ...live, provider, model },
    loopback: isLoopback(options.host),
  };
};

/**
 * Apply the detected sandbox to a configuration loaded from YAML. The YAML
 * files declare `driver: bubblewrap`, which is what a Linux host would ship;
 * this swaps in Docker or the demo fallback when bubblewrap is unavailable.
 */
export const applySandboxChoice = (
  config: AgentRuntimeConfig,
  choice: SandboxChoice,
): { config: AgentRuntimeConfig; sandboxProvider?: SandboxProvider } => {
  if (!config.sandbox || choice.kind === "bubblewrap") return { config };
  if (choice.kind === "docker") {
    return {
      config: parseAgentRuntimeConfig({
        ...config,
        sandbox: {
          ...config.sandbox,
          driver: "docker",
          image: choice.image,
          allowedImages: [choice.image],
        },
      }),
    };
  }
  if (choice.kind === "unisolated") {
    return {
      config: parseAgentRuntimeConfig({
        ...config,
        sandbox: { ...config.sandbox, driver: "host", image: "unisolated" },
      }),
      sandboxProvider: new UnisolatedDemoProvider(choice.python),
    };
  }
  throw new Error(choice.detail);
};

/** Enforce the mode policy for one run request. */
export const assertModeAllowed = (
  environment: ShowcaseEnvironment,
  mode: ModelMode,
): void => {
  if (environment.sandbox.kind === "none") {
    throw new Error(
      `No sandbox is available. ${environment.sandbox.notes.join(" ")}`,
    );
  }
  if (mode === "live" && !environment.live.available) {
    throw new Error(environment.live.reason);
  }
};
