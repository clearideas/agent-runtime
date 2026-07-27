---
title: Sandboxes and artifacts
description: Execute code and generate bounded artifacts through interchangeable sandbox providers.
---

# Sandboxes and artifacts

Execution engines run an entire agent. Sandbox providers isolate individual
code and artifact-generation operations.

## Code steps

`ProviderSandboxAdapter` stages files, starts a sandbox, executes the requested
command, collects outputs, and terminates the sandbox. Its default Python
profile:

- stages source at `/workspace/main.py`;
- stages variables at `/workspace/variables.json`;
- exposes `AGENT_VARIABLES_FILE` and `AGENT_OUTPUT_DIRECTORY`;
- collects bounded files beneath `/workspace/output`;
- terminates the sandbox in `finally`.

Example local composition:

```ts
const provider = new DockerSandboxProvider({
  allowedImages: ["python:3.12-slim"],
});
const sandbox = new ProviderSandboxAdapter({
  provider,
  artifacts: new FileArtifactStore("./artifacts"),
  allowedEnvironment: ["SAFE_PUBLIC_SETTING"],
  memoryMb: 512,
  cpuCount: 1,
  processLimit: 64,
  maximumOutputFiles: 20,
  maximumOutputBytes: 25 * 1024 * 1024,
});
```

`DockerSandboxProvider` enforces no network, a read-only root filesystem, an
isolated `/workspace` tmpfs, image allowlisting, and resource limits.

## Other sandbox providers

Implement `SandboxProvider` for another service:

```ts
interface SandboxProvider {
  create(spec): Promise<SandboxHandle>;
  putFiles(handle, files): Promise<void>;
  execute(handle, command): AsyncIterable<SandboxProcessEvent>;
  listFiles(handle, directory): Promise<SandboxFileInfo[]>;
  readFile(handle, path): Promise<Uint8Array>;
  terminate(handle): Promise<void>;
}
```

Packaged and application-provided sandbox adapters implement the same
lifecycle. See the [adapter catalog](./adapters.md) for included
implementations.

## Artifact generation

`ArtifactGenerator` accepts a `SandboxProvider`. It stages inputs and
runtime files, invokes a generator in a fixed workspace, collects bounded
outputs, validates formats, and terminates the sandbox.

The included OpenXML validator can verify `.docx`, `.xlsx`, and `.pptx`
containers. The host application provides domain-specific validation, malware
scanning, content policy, storage, and signed download URLs.

## Security requirements

- Allowlist images and runtime profiles.
- Default network to `none`; implement restricted egress outside the manifest.
- Never copy the host environment wholesale.
- Allowlist environment variable names and treat values as secrets.
- Normalize every staged and collected path beneath `/workspace`.
- Bound time, memory, CPU, processes, stdout, stderr, file count, and bytes.
- Terminate on success, failure, timeout, and cancellation.
- Verify artifact hashes after crossing provider or storage boundaries.
