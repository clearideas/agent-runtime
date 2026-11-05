import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentManifest,
  RunEvent,
} from "@clearideas/agent-runtime-contracts";
import type {
  RunSandboxSession,
  ToolAdapter,
  ToolExecutionContext,
} from "@clearideas/agent-runtime-core/ports";
import { resolveAgentWorkspaces } from "@clearideas/agent-runtime-core";
import { HostProcessTestProvider } from "@clearideas/agent-runtime-sandbox/testing";
import { MemoryWorkspace } from "@clearideas/agent-runtime-store-local";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CompositeToolAdapter,
  ConfiguredWorkspaceProvider,
  composeRuntime,
  parseAgentRuntimeConfig,
  resolveConfigurationPaths,
  validateRuntimeConfiguration,
} from "./index.js";

/** The helper and the host-process test provider run POSIX commands; skip elsewhere. */
const hasPython =
  process.platform !== "win32" &&
  spawnSync("python3", ["--version"]).status === 0;

const baseContext = (
  session: RunSandboxSession | undefined,
): ToolExecutionContext => ({
  runId: "run-1",
  stepId: "answer",
  variables: {},
  idempotencyKey: "key-1",
  ...(session ? { runSandbox: async () => session } : {}),
});

describe("configuration schema", () => {
  it("parses workspaces and sandbox sections with defaults and rejects invalid policy", () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      workspaces: {
        docs: { driver: "local", root: "./knowledge" },
        code: {
          driver: "local",
          root: { env: "CODE_ROOT" },
          mode: "read_write",
          include: ["src/**"],
          exclude: ["**/node_modules/**"],
          maxFiles: 100,
          attach: "never",
        },
        app: { driver: "host", mode: "read" },
      },
      sandbox: {
        driver: "bubblewrap",
        commands: {
          extract_text: {
            argv: ["pdftotext", "{file}", "-"],
            inputs: ["**/*.pdf"],
            workspaces: ["docs"],
          },
          pytest: { program: "pytest", args: { maxCount: 8 } },
        },
        shell: { enabled: true, modes: ["read_write"] },
        limits: { maxCommandsPerRun: 50 },
      },
    });
    expect(config.workspaces.docs).toMatchObject({
      mode: "read",
      attach: "auto",
    });
    expect(config.sandbox).toMatchObject({
      driver: "bubblewrap",
      shell: { enabled: true },
    });

    const invalid = (input: Record<string, unknown>) =>
      (() =>
        parseAgentRuntimeConfig({ version: "1.0", ...input })) as () => unknown;
    expect(invalid({ sandbox: { driver: "docker" } })).toThrow(
      /require an image/u,
    );
    expect(
      invalid({
        sandbox: { driver: "docker", image: "a", allowedImages: ["b"] },
      }),
    ).toThrow(/allowedImages/u);
    expect(
      invalid({
        sandbox: {
          driver: "bubblewrap",
          commands: { read_file: { program: "x" } },
        },
      }),
    ).toThrow(/reserved/u);
    expect(
      invalid({
        sandbox: {
          driver: "bubblewrap",
          commands: { x: { program: "x", argv: ["y"] } },
        },
      }),
    ).toThrow();
    expect(
      invalid({
        sandbox: {
          driver: "bubblewrap",
          commands: { x: { program: "x", workspaces: ["missing"] } },
        },
      }),
    ).toThrow(/unknown workspace/u);
    expect(
      invalid({ workspaces: { bad: { driver: "s3", bucket: "x" } } }),
    ).toThrow();
    expect(
      invalid({ sandbox: { driver: "bubblewrap", limits: { maxArgs: 0 } } }),
    ).toThrow();

    const resolved = resolveConfigurationPaths(
      parseAgentRuntimeConfig({
        version: "1.0",
        workspaces: { docs: { driver: "local", root: "./knowledge" } },
        sandbox: {
          driver: "bubblewrap",
          helper: { source: { path: "./tools/agent-fs" } },
        },
      }),
      "/srv/agent",
    );
    expect(resolved.workspaces.docs).toMatchObject({
      root: path.resolve("/srv/agent", "knowledge"),
    });
    expect(resolved.sandbox?.helper?.source).toEqual({
      path: path.resolve("/srv/agent", "tools/agent-fs"),
    });
  });

  it("validates manifest bindings against the configuration", () => {
    const config = parseAgentRuntimeConfig({
      version: "1.0",
      workspaces: { docs: { driver: "local", root: "/srv/docs" } },
      sandbox: {
        driver: "bubblewrap",
        commands: { lint: { program: "eslint" } },
      },
    });
    const manifest = (
      binding: NonNullable<AgentManifest["workspaces"]>[number],
    ): AgentManifest => ({
      schemaVersion: "1.0",
      workspaces: [binding],
      steps: [],
    });
    expect(() =>
      validateRuntimeConfiguration(manifest({ ref: "docs" }), config),
    ).not.toThrow();
    expect(() =>
      validateRuntimeConfiguration(
        manifest({ ref: "docs", tools: ["read_file", "lint"] }),
        config,
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimeConfiguration(manifest({ ref: "missing" }), config),
    ).toThrow(/Unknown workspace "missing"/u);
    expect(() =>
      validateRuntimeConfiguration(
        manifest({ ref: "missing", required: false }),
        config,
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimeConfiguration(
        manifest({ ref: "docs", mode: "read_write" }),
        config,
      ),
    ).toThrow(/cannot be elevated/u);
    expect(() =>
      validateRuntimeConfiguration(
        manifest({ ref: "docs", tools: ["shell"] }),
        config,
      ),
    ).toThrow(/does not expose: shell/u);
    expect(() =>
      validateRuntimeConfiguration(
        manifest({ ref: "docs", tools: ["write_file"] }),
        config,
      ),
    ).toThrow(/requires read_write/u);
    expect(() =>
      validateRuntimeConfiguration(
        manifest({ ref: "docs" }),
        parseAgentRuntimeConfig({
          version: "1.0",
          workspaces: { docs: { driver: "local", root: "/srv/docs" } },
        }),
      ),
    ).toThrow(/require a sandbox section/u);
  });
});

describe.skipIf(!hasPython)(
  "workspace composition and tools",
  { timeout: 60_000 },
  () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "agent-runtime-config-ws-"));
      await writeFile(path.join(root, "README.md"), "# Configured\nhello\n");
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const compose = (
      manifest: AgentManifest,
      sandboxProvider = new HostProcessTestProvider(),
    ) => {
      const config = parseAgentRuntimeConfig({
        version: "1.0",
        workspaces: {
          docs: {
            driver: "local",
            root: { env: "DOCS_ROOT" },
            mode: "read_write",
          },
          memory: { driver: "host", mode: "read" },
        },
        sandbox: {
          driver: "host",
          commands: { wc: { argv: ["wc", "-c", "{file}"] } },
          shell: { enabled: true },
        },
      });
      const authorized: string[] = [];
      const composed = composeRuntime(
        manifest,
        config,
        { environment: { DOCS_ROOT: root } },
        {
          model: false,
          workspaceOptions: {
            sandboxProvider,
            createWorkspace: (name) =>
              name === "memory"
                ? new MemoryWorkspace({
                    files: { "facts.txt": "memory fact\n" },
                  })
                : undefined,
            authorizeCommand: ({ record }) => {
              authorized.push(record.name);
            },
          },
        },
      );
      return { composed, authorized, sandboxProvider };
    };

    const openSession = async (
      manifest: AgentManifest,
      composed: ReturnType<typeof composeRuntime>,
    ) => {
      const events: RunEvent[] = [];
      const workspaces = await resolveAgentWorkspaces(
        manifest,
        composed.workspaces,
      );
      const session = await composed.runSandbox!.open({
        runId: "run-1",
        attempt: 1,
        workspaces,
        emit: async (type, data) => {
          const event = {
            id: String(events.length),
            runId: "run-1",
            sequence: events.length + 1,
            timestamp: "",
            type,
            ...(data ? { data } : {}),
          } as RunEvent;
          events.push(event);
          return event;
        },
      });
      return { session, events };
    };

    it("composes providers, relays tool calls through MCP to the run sandbox, and records commands", async () => {
      const manifest: AgentManifest = {
        schemaVersion: "1.0",
        workspaces: [
          {
            ref: "docs",
            mode: "read_write",
            tools: ["read_file", "write_file", "wc", "shell"],
          },
          { ref: "memory", alias: "mem" },
        ],
        steps: [],
      };
      const { composed, authorized } = compose(manifest);
      expect(composed.workspaces).toBeInstanceOf(ConfiguredWorkspaceProvider);
      expect(composed.runSandbox).toBeDefined();
      const tools = await composed.tools!.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "docs__read_file",
        "docs__write_file",
        "docs__wc",
        "docs__shell",
        "mem__list_files",
        "mem__read_file",
        "mem__search_files",
        "mem__wc",
        "mem__shell",
      ]);
      expect(tools[0]).toMatchObject({
        description: expect.stringContaining("Read one file"),
        inputSchema: expect.objectContaining({
          type: "object",
          required: ["path"],
        }),
        metadata: {
          workspace: "docs",
          workspaceAlias: "docs",
          workspaceMode: "read_write",
          sourceTool: "read_file",
          kind: "builtin",
          readOnly: true,
          sandboxed: true,
        },
      });

      const { session, events } = await openSession(manifest, composed);
      const context = baseContext(session);
      const read = await composed.tools!.executeTool(
        {
          id: "call-1",
          name: "docs__read_file",
          input: { path: "README.md", startLine: 2 },
        },
        context,
      );
      expect(read).toMatchObject({
        callId: "call-1",
        output: { path: "README.md", content: "hello", encoding: "utf-8" },
        metadata: {
          workspace: "docs",
          sourceTool: "read_file",
          command: expect.objectContaining({
            kind: "builtin",
            name: "read_file",
            toolCallId: "call-1",
            exitCode: 0,
          }),
        },
      });
      expect(authorized).toEqual(["read_file"]);

      const write = await composed.tools!.executeTool(
        {
          id: "call-2",
          name: "docs__write_file",
          input: { path: "notes/new.md", content: "hi" },
        },
        context,
      );
      expect(write).toMatchObject({
        output: { path: "notes/new.md", size: 2 },
      });
      expect(await readFile(path.join(root, "notes", "new.md"), "utf8")).toBe(
        "hi",
      );

      const wc = await composed.tools!.executeTool(
        { id: "call-3", name: "mem__wc", input: { file: "facts.txt" } },
        context,
      );
      expect(wc).toMatchObject({
        output: { exitCode: 0, stdout: expect.stringContaining("12") },
      });

      await expect(
        composed.tools!.executeTool(
          {
            id: "call-4",
            name: "docs__read_file",
            input: { path: "../escape" },
          },
          context,
        ),
      ).resolves.toMatchObject({
        error: {
          code: "workspace_path_invalid",
          message: expect.stringContaining("safe segments"),
        },
      });
      await expect(
        composed.tools!.executeTool(
          {
            id: "call-5",
            name: "mem__write_file",
            input: { path: "x", content: "y" },
          },
          context,
        ),
      ).resolves.toMatchObject({ error: { code: "tool_not_allowed" } });
      await expect(
        composed.tools!.executeTool(
          {
            id: "call-6",
            name: "docs__shell",
            input: { command: "echo shell-ok" },
          },
          context,
        ),
      ).resolves.toMatchObject({ output: { stdout: "shell-ok\n" } });
      await expect(
        composed.tools!.executeTool(
          {
            id: "call-7",
            name: "docs__read_file",
            input: { path: "README.md" },
          },
          baseContext(undefined),
        ),
      ).resolves.toMatchObject({ error: { code: "sandbox_unavailable" } });
      await session.close("completed");
      expect(
        events.filter((event) => event.type === "sandbox.command.completed"),
      ).toHaveLength(4);
      await (
        composed.tools as ToolAdapter & { close(): Promise<void> }
      ).close();
    });

    it("applies tool authorization hooks and merges remote connections through the composite adapter", async () => {
      const manifest: AgentManifest = {
        schemaVersion: "1.0",
        workspaces: [{ ref: "memory", alias: "mem" }],
        steps: [],
      };
      const config = parseAgentRuntimeConfig({
        version: "1.0",
        workspaces: { memory: { driver: "host" } },
        sandbox: { driver: "host" },
      });
      const composed = composeRuntime(
        manifest,
        config,
        {},
        {
          model: false,
          workspaceOptions: {
            sandboxProvider: new HostProcessTestProvider(),
            createWorkspace: () =>
              new MemoryWorkspace({ files: { "a.txt": "a" } }),
            authorizeTool({ toolName }) {
              if (toolName === "list_files") throw new Error("denied");
            },
          },
        },
      );
      const { session } = await openSession(manifest, composed);
      await expect(
        composed.tools!.executeTool(
          { id: "1", name: "mem__list_files", input: {} },
          baseContext(session),
        ),
      ).resolves.toMatchObject({ error: { code: "tool_not_authorized" } });
      await expect(
        composed.tools!.executeTool(
          { id: "2", name: "mem__read_file", input: { path: "a.txt" } },
          baseContext(session),
        ),
      ).resolves.toMatchObject({ output: { content: "a" } });
      await session.close("completed");

      const remote: ToolAdapter = {
        listTools: async () => [
          { name: "tickets__create", inputSchema: { type: "object" } },
        ],
        executeTool: async (call) => ({
          callId: call.id,
          name: call.name,
          output: "remote",
        }),
      };
      const composite = new CompositeToolAdapter([remote, composed.tools!]);
      expect((await composite.listTools()).map((tool) => tool.name)).toEqual([
        "tickets__create",
        "mem__list_files",
        "mem__read_file",
        "mem__search_files",
      ]);
      await expect(
        composite.executeTool(
          { id: "3", name: "tickets__create", input: {} },
          baseContext(undefined),
        ),
      ).resolves.toMatchObject({ output: "remote" });
      await expect(
        new CompositeToolAdapter([remote, remote]).listTools(),
      ).rejects.toThrow(/collision/u);
    });

    it("prefers host-supplied providers and rejects bindings without a sandbox", () => {
      const manifest: AgentManifest = {
        schemaVersion: "1.0",
        workspaces: [{ ref: "docs" }],
        steps: [],
      };
      const config = parseAgentRuntimeConfig({
        version: "1.0",
        workspaces: { docs: { driver: "local", root } },
      });
      expect(() =>
        composeRuntime(manifest, config, {}, { model: false }),
      ).toThrow(/require a sandbox section/u);
      const provider = { resolveWorkspace: async () => new MemoryWorkspace() };
      const runSandbox = {
        tools: async () => [],
        validate: async () => undefined,
        open: async () => {
          throw new Error("unused");
        },
      };
      const composed = composeRuntime(
        manifest,
        config,
        {},
        {
          model: false,
          workspaceOptions: { provider, runSandbox },
        },
      );
      expect(composed.workspaces).toBe(provider);
      expect(composed.runSandbox).toBe(runSandbox);
      expect(
        composeRuntime(
          manifest,
          config,
          {},
          { model: false, workspaces: false },
        ),
      ).toEqual({});
      expect(() =>
        composeRuntime(
          manifest,
          parseAgentRuntimeConfig({
            version: "1.0",
            workspaces: { docs: { driver: "local", root } },
            sandbox: { driver: "host" },
          }),
          {},
          { model: false },
        ),
      ).toThrow(/requires a SandboxProvider/u);
    });
  },
);
