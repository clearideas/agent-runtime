import type {
  ArtifactInput,
  ArtifactStore,
} from "@clearideas/agent-runtime-core";
import { describe, expect, it } from "vitest";

import type {
  SandboxCommand,
  SandboxFileInfo,
  SandboxHandle,
  SandboxInputFile,
  SandboxProcessEvent,
  SandboxProvider,
  SandboxSpec,
} from "./contracts.js";
import { assertSandboxPath, assertSandboxResourceLimits } from "./contracts.js";
import { ProviderSandboxAdapter } from "./provider-adapter.js";

class FakeProvider implements SandboxProvider {
  readonly name = "fake";
  readonly staged: SandboxInputFile[] = [];
  terminated = false;
  spec?: SandboxSpec;
  command?: SandboxCommand;

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.spec = spec;
    return {
      id: "sandbox-1",
      provider: this.name,
      createdAt: new Date().toISOString(),
    };
  }

  async putFiles(
    _handle: SandboxHandle,
    files: SandboxInputFile[],
  ): Promise<void> {
    this.staged.push(...files);
  }

  async *execute(
    _handle: SandboxHandle,
    command: SandboxCommand,
  ): AsyncIterable<SandboxProcessEvent> {
    this.command = command;
    yield { type: "stdout", data: "ok" };
    yield { type: "exit", exitCode: 0 };
  }

  async listFiles(): Promise<SandboxFileInfo[]> {
    return [{ path: "/workspace/output/report.txt", size: 6 }];
  }

  async readFile(): Promise<Uint8Array> {
    return new TextEncoder().encode("report");
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

class MemoryArtifacts implements ArtifactStore {
  inputs: ArtifactInput[] = [];

  async put(input: ArtifactInput) {
    this.inputs.push(input);
    return { id: "artifact-1", name: input.name, mediaType: input.mediaType };
  }

  async get(): Promise<never> {
    throw new Error("not used");
  }
}

describe("ProviderSandboxAdapter", () => {
  it("rejects disabled or non-finite provider resource limits", () => {
    expect(() => assertSandboxResourceLimits({ timeoutMs: 0 })).toThrow(
      "timeoutMs",
    );
    expect(() =>
      assertSandboxResourceLimits({
        timeoutMs: 1_000,
        cpuCount: Number.POSITIVE_INFINITY,
      }),
    ).toThrow("cpuCount");
  });

  it("uses a provider-neutral workspace, filters environment, stores outputs, and cleans up", async () => {
    const provider = new FakeProvider();
    const artifacts = new MemoryArtifacts();
    const adapter = new ProviderSandboxAdapter({
      provider,
      artifacts,
      allowedEnvironment: ["PUBLIC_VALUE"],
    });
    const result = await adapter.execute({
      runId: "run-1",
      stepId: "code-1",
      language: "python",
      code: 'print("ok")',
      variables: { input: 42 },
      environment: { PUBLIC_VALUE: "yes", SECRET_VALUE: "no" },
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(result.artifacts).toHaveLength(1);
    expect(provider.spec).toMatchObject({
      network: "none",
      image: "python:3.12-slim",
    });
    expect(provider.command?.environment).toMatchObject({
      PUBLIC_VALUE: "yes",
      AGENT_VARIABLES_FILE: "/workspace/variables.json",
      AGENT_OUTPUT_DIRECTORY: "/workspace/output",
    });
    expect(provider.command?.environment).not.toHaveProperty("SECRET_VALUE");
    expect(provider.staged.map((file) => file.path)).toEqual([
      "/workspace/main.py",
      "/workspace/variables.json",
    ]);
    expect(artifacts.inputs[0]?.name).toBe("report.txt");
    expect(provider.terminated).toBe(true);
  });

  it("rejects traversal and always terminates after output failures", async () => {
    expect(() => assertSandboxPath("/workspace/../secret")).toThrow(
      "normalized",
    );
    const provider = new FakeProvider();
    provider.listFiles = async () => [{ path: "/workspace/variables.json" }];
    const adapter = new ProviderSandboxAdapter({ provider });
    await expect(
      adapter.execute({
        runId: "run-1",
        stepId: "code-1",
        language: "python",
        code: "pass",
        variables: {},
      }),
    ).rejects.toThrow("escaped /workspace/output");
    expect(provider.terminated).toBe(true);
  });

  it("passes the default timeout to both the sandbox specification and command", async () => {
    const provider = new FakeProvider();
    const adapter = new ProviderSandboxAdapter({ provider });

    await adapter.execute({
      runId: "run-1",
      stepId: "code-1",
      language: "python",
      code: "pass",
      variables: {},
    });

    expect(provider.spec?.limits.timeoutMs).toBe(60_000);
    expect(provider.command?.timeoutMs).toBe(60_000);
  });
});
