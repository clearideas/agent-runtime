import type {
  SandboxCommand,
  SandboxFileInfo,
  SandboxHandle,
  SandboxInputFile,
  SandboxProcessEvent,
  SandboxProvider,
  SandboxSpec,
} from "@clearideas/agent-runtime-sandbox";
import { describe, expect, it } from "vitest";

import { ArtifactGenerator } from "./index.js";

class FakeSandbox implements SandboxProvider {
  readonly name = "fake-sandbox";
  staged: SandboxInputFile[] = [];
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
    this.staged = files;
  }

  async *execute(
    _handle: SandboxHandle,
    command: SandboxCommand,
  ): AsyncIterable<SandboxProcessEvent> {
    this.command = command;
    yield { type: "stdout", data: "generated" };
    yield { type: "exit", exitCode: 0 };
  }

  async listFiles(): Promise<SandboxFileInfo[]> {
    return [{ path: "/workspace/output/report.xlsx" }];
  }

  async readFile(): Promise<Uint8Array> {
    return Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

describe("ArtifactGenerator", () => {
  it("runs the same generation contract on any sandbox provider", async () => {
    const provider = new FakeSandbox();
    const runner = new ArtifactGenerator({
      provider,
      allowedEnvironment: ["PUBLIC_SETTING"],
    });
    const result = await runner.generate({
      artifactType: "xlsx",
      filename: "final.xlsx",
      code: "create_workbook()",
      runtime: {
        id: "artifact.xlsx",
        image: "artifact-python:latest",
        language: "python",
        extension: "py",
        command: "python",
        args: (source) => [source],
      },
      inputs: [{ filename: "source.csv", content: "a,b\n1,2" }],
      environment: { PUBLIC_SETTING: "yes", SECRET_SETTING: "no" },
      limits: { timeoutMs: 5_000 },
    });
    expect(result).toMatchObject({
      provider: "fake-sandbox",
      stdout: "generated",
      outputs: [
        {
          filename: "final.xlsx",
          mediaType: expect.stringContaining("spreadsheet"),
        },
      ],
    });
    expect(provider.spec).toMatchObject({
      network: "none",
      image: "artifact-python:latest",
    });
    expect(provider.command?.environment).toMatchObject({
      PUBLIC_SETTING: "yes",
    });
    expect(provider.command?.environment).not.toHaveProperty("SECRET_SETTING");
    expect(provider.staged.map((file) => file.path)).toEqual([
      "/workspace/main.py",
      "/workspace/input/source.csv",
    ]);
    expect(provider.terminated).toBe(true);
  });

  it("rejects unsafe filenames before creating a sandbox", async () => {
    const provider = new FakeSandbox();
    const runner = new ArtifactGenerator({ provider });
    await expect(
      runner.generate({
        artifactType: "xlsx",
        filename: "../escape.xlsx",
        code: "pass",
        runtime: {
          id: "artifact.xlsx",
          image: "image",
          language: "python",
          extension: "py",
          command: "python",
          args: (source) => [source],
        },
        limits: { timeoutMs: 1_000 },
      }),
    ).rejects.toThrow("must not contain a path");
    expect(provider.spec).toBeUndefined();
  });
});
