import type { RunResult } from "@clearideas/agent-runtime-contracts";
import {
  AesGcmWorkerInvocationCodec,
  InMemoryRemoteExecutionControlPlane,
} from "@clearideas/agent-runtime-execution";
import { describe, expect, it } from "vitest";

import {
  ModalSandboxExecutionEngine,
  type ModalSandboxSdkClientLike,
  ModalSandboxSdkGateway,
  resolveModalSandboxDomainAllowlist,
  resolveModalSandboxNetworkPolicy,
} from "./index.js";

const resultFor = (runId: string): RunResult => ({
  runId,
  state: {},
  stepResults: [],
  transcript: [],
  artifacts: [],
  output: "sandbox-ok",
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
});

describe("Modal Sandbox execution", () => {
  it("supports proxy-only CIDRs without resolving them in the runtime", () => {
    expect(
      resolveModalSandboxNetworkPolicy({
        mode: "proxy-only",
        proxyCidrs: ["203.0.113.10/32", "203.0.113.10/32"],
      }),
    ).toEqual({
      mode: "proxy-only",
      outboundCidrAllowlist: ["203.0.113.10/32"],
      outboundDomainAllowlist: [],
    });
    expect(() =>
      resolveModalSandboxNetworkPolicy({
        mode: "proxy-only",
        proxyCidrs: ["0.0.0.0/0"],
      }),
    ).toThrow("must identify exactly one");
    expect(
      resolveModalSandboxNetworkPolicy({
        mode: "proxy-only",
        proxyDomains: ["runner-egress.example.test"],
      }),
    ).toEqual({
      mode: "proxy-only",
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: ["runner-egress.example.test"],
    });
    expect(() =>
      resolveModalSandboxNetworkPolicy({
        mode: "proxy-only",
        proxyDomains: ["*.example.test"],
      }),
    ).toThrow("must be one exact hostname");
    expect(() =>
      resolveModalSandboxNetworkPolicy({
        mode: "proxy-only",
      }),
    ).toThrow("requires an exact proxy CIDR or domain");
    expect(resolveModalSandboxNetworkPolicy({ mode: "block" })).toEqual({
      mode: "block",
      blockNetwork: true,
    });
  });

  it("derives stable Modal domains from the host-resolved origin policy", () => {
    const egressPolicy = {
      mode: "enforce",
      allowedOrigins: [
        { type: "model", origin: "https://api.model.test/v1" },
        { type: "tool", origin: "https://regional.cdn.test/search" },
        { type: "tool", origin: "https://regional.cdn.test/retrieve" },
        { type: "connection", origin: "https://*.mcp.example.test" },
      ],
    } as const;

    expect(resolveModalSandboxDomainAllowlist(egressPolicy)).toEqual([
      "*.mcp.example.test",
      "api.model.test",
      "regional.cdn.test",
    ]);
    expect(
      resolveModalSandboxNetworkPolicy({
        mode: "direct-domains",
        egressPolicy,
      }),
    ).toEqual({
      mode: "direct-domains",
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: [
        "*.mcp.example.test",
        "api.model.test",
        "regional.cdn.test",
      ],
    });
    expect(() =>
      resolveModalSandboxDomainAllowlist({
        mode: "enforce",
        allowedOrigins: [
          {
            type: "webhook",
            origin: "https://hooks.example.test:8443",
          },
        ],
      }),
    ).toThrow("only HTTPS port 443");
    expect(() =>
      resolveModalSandboxDomainAllowlist({
        mode: "enforce",
        allowedOrigins: [{ type: "tool", origin: "https://203.0.113.20" }],
      }),
    ).toThrow("must be supplied by the host as a CIDR policy");
  });

  it("runs the worker protocol over Sandbox stdio with proxy-only networking", async () => {
    const created: Array<Record<string, unknown>> = [];
    const stdin: string[] = [];
    let terminated = 0;
    const runId = "sandbox-run";
    const readyMessage = `${JSON.stringify({
      protocolVersion: "1.0",
      type: "ready",
    })}\n`;
    const resultMessage = `${JSON.stringify({
      protocolVersion: "1.0",
      type: "result",
      result: resultFor(runId),
    })}\n`;
    const messages = [`${readyMessage.repeat(8)}${resultMessage}`];
    const sandbox = {
      sandboxId: "sb-1",
      stdin: {
        writeText: async (value: string) => {
          stdin.push(value);
        },
        close: async () => undefined,
      },
      stdout: {
        getReader: () => ({
          read: async () =>
            messages.length
              ? { done: false, value: messages.shift() }
              : { done: true },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
      wait: async () => 0,
      terminate: async () => {
        terminated += 1;
      },
    };
    const client: ModalSandboxSdkClientLike = {
      apps: {
        fromName: async (name, options) => ({ name, options }),
      },
      images: {
        fromName: async (name, options) => ({ name, options }),
      },
      sandboxes: {
        create: async (app, image, options) => {
          created.push({ app, image, options });
          return sandbox;
        },
        fromId: async () => sandbox,
      },
    };
    const gateway = new ModalSandboxSdkGateway(client, {
      imageName: "agent-runtime-worker:stable",
      command: ["agent-runtime-modal-worker"],
      baseEnvironment: { SAFE_BASE: "true" },
      maximumProtocolLineBytes: 512,
    });
    const codec = new AesGcmWorkerInvocationCodec({
      activeKeyId: "sandbox-key",
      keys: { "sandbox-key": new Uint8Array(32).fill(7) },
    });
    const controlPlane = new InMemoryRemoteExecutionControlPlane();
    const engine = new ModalSandboxExecutionEngine(gateway, controlPlane, {
      invocationCodec: codec,
      resolveSandbox: async (invocation) => {
        expect(invocation.request.manifest.schemaVersion).toBe("1.0");
        return {
          networkPolicy: resolveModalSandboxNetworkPolicy({
            mode: "proxy-only",
            proxyCidrs: ["203.0.113.10/32"],
          }),
          environment: {
            HTTPS_PROXY: "http://proxy.internal.test:3128",
          },
          metadata: { region: "us-east" },
        };
      },
    });

    const handle = await engine.submit({
      runId,
      manifest: { schemaVersion: "1.0", steps: [] },
      configuration: { providerApiKey: "test-only-provider-secret" },
    });

    await expect(engine.result(handle)).resolves.toMatchObject({
      output: "sandbox-ok",
    });
    expect(handle.providerData).toEqual({
      region: "us-east",
      sandboxId: "sb-1",
    });
    expect(created[0]).toMatchObject({
      options: {
        command: ["agent-runtime-modal-worker"],
        env: {
          SAFE_BASE: "true",
          HTTPS_PROXY: "http://proxy.internal.test:3128",
        },
        outboundCidrAllowlist: ["203.0.113.10/32"],
        outboundDomainAllowlist: [],
        tags: {
          "agent-runtime-run-id": runId,
        },
      },
    });
    expect(created[0]?.options).not.toHaveProperty("blockNetwork");
    expect(stdin).toHaveLength(1);
    expect(stdin[0]).toContain("invocationEnvelope");
    expect(stdin[0]).not.toContain("providerApiKey");
    expect(stdin[0]).not.toContain("outboundCidrAllowlist");
    expect(terminated).toBe(1);
  });
});
