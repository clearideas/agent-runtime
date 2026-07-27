import type {
  SandboxProcessEvent,
  SandboxSpec,
} from "@clearideas/agent-runtime-sandbox";
import { describe, expect, it } from "vitest";

import { ModalSandboxProvider, type ModalSandboxGateway } from "./index.js";

describe("ModalSandboxProvider", () => {
  it("maps the neutral lifecycle to an injected Modal gateway", async () => {
    const calls: string[] = [];
    const gateway: ModalSandboxGateway = {
      create: async () => ({ sandboxId: "sb-1", metadata: { region: "ca" } }),
      putFiles: async (id) => {
        calls.push(`put:${id}`);
      },
      execute: async function* (id): AsyncIterable<SandboxProcessEvent> {
        calls.push(`exec:${id}`);
        yield { type: "exit", exitCode: 0 };
      },
      listFiles: async (id) => {
        calls.push(`list:${id}`);
        return [];
      },
      readFile: async (id) => {
        calls.push(`read:${id}`);
        return new Uint8Array();
      },
      terminate: async (id) => {
        calls.push(`terminate:${id}`);
      },
    };
    const provider = new ModalSandboxProvider(gateway);
    const spec: SandboxSpec = {
      image: "python",
      workingDirectory: "/workspace",
      network: "none",
      limits: { timeoutMs: 1_000 },
    };
    const handle = await provider.create(spec);
    expect(handle.providerData).toEqual({ sandboxId: "sb-1", region: "ca" });
    await provider.putFiles(handle, []);
    for await (const _event of provider.execute(handle, {
      command: "python",
    })) {
      // Drain.
    }
    await provider.listFiles(handle, "/workspace/output");
    await provider.readFile(handle, "/workspace/output/result.txt");
    await provider.terminate(handle);
    expect(calls).toEqual([
      "put:sb-1",
      "exec:sb-1",
      "list:sb-1",
      "read:sb-1",
      "terminate:sb-1",
    ]);
    expect(() => provider.readFile(handle, "/tmp/secret")).toThrow(
      "normalized beneath /workspace",
    );
  });
});
