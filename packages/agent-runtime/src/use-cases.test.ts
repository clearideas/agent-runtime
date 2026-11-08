/**
 * Scenario tests for the four workspace use cases from design/workspaces.md,
 * executed end to end through AgentRuntime, composeRuntime, and a real
 * bubblewrap sandbox. They skip themselves when bubblewrap or python3 is
 * unavailable (for example on macOS); every mechanism they rely on is also
 * covered by provider-independent unit tests.
 */
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CollectingEventSink } from "@clearideas/agent-runtime-core/testing";
import { describe, expect, it } from "vitest";

import {
  AgentRuntime,
  ApprovalStepExecutor,
  BubblewrapSandboxProvider,
  CodeStepExecutor,
  CompositeToolAdapter,
  FileArtifactStore,
  FileRunStore,
  JexlConditionEvaluator,
  LoopStepExecutor,
  MemoryRunStore,
  PromptStepExecutor,
  RunSuspendedError,
  composeRuntime,
  parseAgentRuntimeConfig,
  validateRuntimeConfiguration,
  type AgentManifest,
  type JsonValue,
  type ModelAdapter,
  type ModelRequest,
  type RunEvent,
  type SandboxCommandRecord,
  type ToolAdapter,
  type ToolCall,
  type ToolResult,
  type WorkspaceCompositionOptions,
} from "./index.js";

const available =
  process.platform === "linux" &&
  spawnSync("python3", ["--version"]).status === 0 &&
  (await new BubblewrapSandboxProvider().probe().then(
    () => true,
    () => false,
  ));

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

type Turn = (
  request: ModelRequest,
  results: ToolResult[],
) => { call: ToolCall } | { output: JsonValue };

const toolResults = (request: ModelRequest): ToolResult[] =>
  request.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "tool-result" ? [part.result] : [],
      ),
    );

/** A deterministic model: each turn either requests one tool call or finishes. */
const scripted = (turns: Turn[]): ModelAdapter & { turns: number } => {
  let index = 0;
  const model = {
    turns: 0,
    generate: async (request: ModelRequest) => {
      const turn = turns[index];
      index += 1;
      model.turns += 1;
      if (!turn) throw new Error(`Model script exhausted at turn ${index}`);
      const result = turn(request, toolResults(request));
      if ("call" in result) {
        return {
          transcript: [
            {
              id: `turn-${index}`,
              type: "tool-call" as const,
              role: "assistant" as const,
              content: [{ type: "tool-call" as const, call: result.call }],
              createdAt: new Date().toISOString(),
            },
          ],
          toolCalls: [result.call],
        };
      }
      return { output: result.output, transcript: [] };
    },
  };
  return model;
};

let callSequence = 0;
const call =
  (name: string, input: Record<string, JsonValue>): Turn =>
  () => {
    callSequence += 1;
    return { call: { id: `call-${callSequence}`, name, input } };
  };
const finish =
  (output: (request: ModelRequest, results: ToolResult[]) => JsonValue): Turn =>
  (request, results) => ({ output: output(request, results) });

const last = (results: ToolResult[]): ToolResult => results.at(-1)!;
const summary = (results: ToolResult[]) =>
  results.map((result) => ({
    name: result.name,
    ...(result.error ? { error: result.error.code } : { ok: true }),
  }));

const executors = () => [
  new PromptStepExecutor(),
  new LoopStepExecutor(),
  new ApprovalStepExecutor(),
  new CodeStepExecutor(),
];

const commandRecords = (events: RunEvent[]): SandboxCommandRecord[] =>
  events
    .filter((event) => event.type === "sandbox.command.completed")
    .map((event) => event.data as unknown as SandboxCommandRecord);

describe.skipIf(!available)(
  "workspace use cases under bubblewrap",
  { timeout: 120_000 },
  () => {
    it("A. Repo Mechanic: surveys, fixes, and tests a tenant's repository under host policy", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "usecase-a-"));
      try {
        const tenants = {
          "tenant-a": path.join(root, "a"),
          "tenant-b": path.join(root, "b"),
        };
        for (const directory of Object.values(tenants)) {
          await mkdir(path.join(directory, "src"), { recursive: true });
          await mkdir(path.join(directory, "tests"), { recursive: true });
          await writeFile(
            path.join(directory, "src", "calc.py"),
            "def add(a, b):\n    return a - b\n",
          );
          await writeFile(
            path.join(directory, "tests", "test_calc.py"),
            [
              "import os, sys, unittest",
              "sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))",
              "from src.calc import add",
              "class CalcTest(unittest.TestCase):",
              "    def test_add(self):",
              "        self.assertEqual(add(2, 2), 4)",
              "",
            ].join("\n"),
          );
        }
        // One configuration for every tenant: the root comes from the host's environment.
        const config = parseAgentRuntimeConfig({
          version: "1.0",
          workspaces: {
            repo: {
              driver: "local",
              root: { env: "TENANT_REPO_ROOT" },
              mode: "read_write",
              exclude: ["**/__pycache__/**"],
            },
          },
          sandbox: {
            driver: "bubblewrap",
            commands: {
              unittest: {
                description: "Run the unit tests.",
                program: "python3",
                args: {
                  maxCount: 8,
                  allowPatterns: ["^-m$"],
                  denyPatterns: ["^-c$"],
                },
              },
            },
          },
        });
        // One manifest for every tenant: it names the workspace, never a path.
        const manifest: AgentManifest = {
          schemaVersion: "1.0",
          model: { provider: "openai", model: "scripted" },
          workspaces: [
            {
              ref: "repo",
              alias: "code",
              mode: "read_write",
              tools: ["search_files", "read_file", "write_file", "unittest"],
            },
          ],
          steps: [
            {
              id: "survey",
              type: "prompt",
              prompt: "Find the bug.",
              tools: [
                "code__search_files",
                "code__read_file",
                "code__unittest",
              ],
              outputVariable: "survey",
            },
            {
              id: "fix",
              type: "prompt",
              prompt: "Fix it and rerun the tests.",
              tools: ["code__write_file", "code__unittest"],
              outputVariable: "fix",
            },
            {
              id: "verify",
              type: "code",
              language: "python",
              workspaces: ["code"],
              code: "import json\nprint(json.dumps({'source': open('/workspace/mounts/code/src/calc.py').read()}))",
              includeInFinalOutput: true,
            },
          ],
        };
        const unittestArgs = {
          args: ["-m", "unittest", "discover", "-s", "tests"],
        };
        const script = (): Turn[] => [
          call("code__search_files", { query: "def add" }),
          call("code__read_file", { path: "src/calc.py" }),
          call("code__unittest", unittestArgs),
          finish((_request, results) => ({
            match: (last(results.slice(0, 1)).output as { matches: unknown[] })
              .matches,
            testExit: (last(results).output as { exitCode: number }).exitCode,
          })),
          call("code__write_file", {
            path: "src/calc.py",
            content: "def add(a, b):\n    return a + b\n",
          }),
          call("code__unittest", unittestArgs),
          finish((_request, results) => ({
            testExit: (last(results).output as { exitCode: number }).exitCode,
          })),
        ];

        const runTenant = async (tenant: keyof typeof tenants) => {
          const events = new CollectingEventSink();
          const authorized: Array<{
            runId: string;
            name: string;
            cwd: string;
          }> = [];
          const hooks: WorkspaceCompositionOptions = {
            authorizeWorkspace: ({ binding }) => {
              if (binding.ref !== "repo")
                throw new Error("unexpected workspace");
            },
            authorizeCommand: ({ record }, context) => {
              // The host binds every command to the run's tenant and mount.
              if (!context.runId.startsWith(tenant))
                throw new Error("wrong tenant");
              const expectedCwd =
                record.kind === "code"
                  ? "/workspace/steps/"
                  : "/workspace/mounts/code";
              if (!record.cwd.startsWith(expectedCwd))
                throw new Error("wrong cwd");
              authorized.push({
                runId: context.runId,
                name: record.name,
                cwd: record.cwd,
              });
            },
          };
          const model = scripted(script());
          const composed = composeRuntime(
            manifest,
            config,
            { environment: { TENANT_REPO_ROOT: tenants[tenant] } },
            { model: false, workspaceOptions: hooks },
          );
          const runtime = new AgentRuntime({
            runStore: new MemoryRunStore(),
            stepExecutors: executors(),
            conditionEvaluator: new JexlConditionEvaluator(),
            eventSinks: [events],
            model,
            ...composed,
          });
          const result = await runtime.run({
            runId: `${tenant}-run`,
            manifest,
          });
          return { result, events: events.events, authorized, model };
        };

        const a = await runTenant("tenant-a");
        expect(a.result.state.survey).toEqual({
          match: [{ path: "src/calc.py", line: 1, text: "def add(a, b):" }],
          testExit: 1,
        });
        expect(a.result.state.fix).toEqual({ testExit: 0 });
        expect(JSON.parse(String(a.result.output))).toEqual({
          source: "def add(a, b):\n    return a + b\n",
        });
        expect(
          await readFile(
            path.join(tenants["tenant-a"], "src", "calc.py"),
            "utf8",
          ),
        ).toBe("def add(a, b):\n    return a + b\n");
        expect(
          await readFile(
            path.join(tenants["tenant-b"], "src", "calc.py"),
            "utf8",
          ),
        ).toBe("def add(a, b):\n    return a - b\n");
        expect(a.authorized.map((entry) => entry.name)).toEqual([
          "search_files",
          "read_file",
          "unittest",
          "write_file",
          "unittest",
          "verify",
        ]);
        expect(
          a.events.find((event) => event.type === "sandbox.opened")?.data,
        ).toMatchObject({
          provider: "bubblewrap",
          mounts: [
            {
              alias: "code",
              mode: "read_write",
              attached: false,
              fileCount: 2,
            },
          ],
        });
        const records = commandRecords(a.events);
        expect(
          records.map((record) => [
            record.id,
            record.kind,
            record.name,
            record.exitCode,
          ]),
        ).toEqual([
          ["cmd-1-1", "builtin", "search_files", 0],
          ["cmd-1-2", "builtin", "read_file", 0],
          ["cmd-1-3", "command", "unittest", 1],
          ["cmd-1-4", "builtin", "write_file", 0],
          ["cmd-1-5", "command", "unittest", 0],
          ["cmd-1-6", "code", "verify", 0],
        ]);
        expect(records[2]?.argv).toEqual([
          "python3",
          "-m",
          "unittest",
          "discover",
          "-s",
          "tests",
        ]);
        expect(records[3]?.filesChanged).toEqual([
          expect.objectContaining({
            alias: "code",
            path: "src/calc.py",
            action: "modified",
          }),
        ]);
        expect(a.events.at(-1)?.type).toBe("run.completed");
        expect(
          a.events.find((event) => event.type === "sandbox.closed")?.data,
        ).toMatchObject({
          reason: "completed",
          commandsUsed: 6,
        });
        // Every tool result carries its command record into the durable transcript.
        const transcriptRecords = a.result.transcript.flatMap((item) =>
          item.content.flatMap((part) =>
            part.type === "tool-result"
              ? [(part.result.metadata?.command as SandboxCommandRecord).id]
              : [],
          ),
        );
        expect(transcriptRecords).toEqual([
          "cmd-1-1",
          "cmd-1-2",
          "cmd-1-3",
          "cmd-1-4",
          "cmd-1-5",
        ]);

        // The same manifest for tenant B starts from B's unfixed clone: nothing leaked from A's sandbox.
        const b = await runTenant("tenant-b");
        expect(b.result.state.survey).toMatchObject({ testExit: 1 });
        expect(b.result.state.fix).toEqual({ testExit: 0 });
        expect(
          b.authorized.every((entry) => entry.runId === "tenant-b-run"),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("B. Policy Desk: answers from a read-only library with per-department authorization, multimodal files, and a remote tool", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "usecase-b-"));
      try {
        const library = path.join(root, "library");
        await mkdir(path.join(library, "policies", "hr"), { recursive: true });
        await mkdir(path.join(library, "policies", "_drafts"), {
          recursive: true,
        });
        await mkdir(path.join(library, ".git"), { recursive: true });
        await writeFile(
          path.join(library, "policies", "travel.md"),
          "# Travel\nMeals are reimbursed up to 50 USD per day.\n",
        );
        await writeFile(
          path.join(library, "policies", "hr", "leave.md"),
          "# Leave\nTwenty days.\n",
        );
        await writeFile(
          path.join(library, "policies", "_drafts", "secret.md"),
          "draft policy\n",
        );
        await writeFile(
          path.join(library, "policies", "notes.txt"),
          "not a policy\n",
        );
        await writeFile(path.join(library, "policies", "diagram.png"), PNG);
        await writeFile(path.join(library, ".git", "config"), "[remote]\n");
        const config = parseAgentRuntimeConfig({
          version: "1.0",
          workspaces: {
            "policy-library": {
              driver: "local",
              root: library,
              mode: "read",
              include: ["policies/**/*.md", "policies/**/*.png"],
              exclude: ["policies/_drafts/**"],
            },
          },
          sandbox: { driver: "bubblewrap" },
        });
        const manifest: AgentManifest = {
          schemaVersion: "1.0",
          model: { provider: "openai", model: "scripted" },
          connections: [],
          workspaces: [
            { ref: "policy-library", alias: "policies", mode: "read" },
          ],
          steps: [
            {
              id: "answer",
              type: "prompt",
              prompt:
                "Answer the question from the policy library; file a ticket if a policy is missing.",
              tools: [
                "policies__search_files",
                "policies__read_file",
                "policies__list_files",
                "tickets__create",
              ],
              includeInFinalOutput: true,
            },
          ],
        };
        // Stand-in for a remote MCP connection; it is routed through the same composite adapter.
        const tickets: string[] = [];
        const ticketing: ToolAdapter = {
          listTools: async () => [
            {
              name: "tickets__create",
              description: "Create a ticket.",
              inputSchema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
          ],
          executeTool: async (toolCall) => {
            tickets.push(String(toolCall.input.title));
            return {
              callId: toolCall.id,
              name: toolCall.name,
              output: { id: "T-1" },
            };
          },
        };

        const runAs = async (runId: string) => {
          const events = new CollectingEventSink();
          const model = scripted([
            call("policies__list_files", {}),
            call("policies__search_files", { query: "reimbursed" }),
            call("policies__read_file", { path: "policies/travel.md" }),
            call("policies__read_file", { path: "policies/hr/leave.md" }),
            call("policies__read_file", { path: "policies/_drafts/secret.md" }),
            call("policies__read_file", { path: ".git/config" }),
            call("policies__read_file", { path: "policies/notes.txt" }),
            call("policies__read_file", { path: "policies/diagram.png" }),
            call("tickets__create", { title: "Clarify hotel ceiling" }),
            finish((request, results) => {
              const diagram = request.messages
                .filter((message) => message.role === "tool")
                .flatMap((message) => message.content)
                .find(
                  (part) =>
                    part.type === "tool-result" &&
                    part.result.artifacts?.length,
                );
              return {
                offered: (request.tools ?? []).map((tool) => tool.name),
                results: summary(results),
                listed: (
                  results[0]?.output as { files: Array<{ path: string }> }
                ).files.map((file) => file.path),
                answer: (results[2]?.output as { content: string }).content,
                diagram:
                  diagram?.type === "tool-result"
                    ? {
                        artifactId: (
                          diagram.result.output as { artifactId: string }
                        ).artifactId,
                        mediaType: diagram.result.artifacts?.[0]?.mediaType,
                        inlined: diagram.result.artifacts?.[0]?.uri?.startsWith(
                          "data:image/png;base64,",
                        ),
                      }
                    : null,
              };
            }),
          ]);
          const composed = composeRuntime(
            manifest,
            config,
            {},
            {
              model: false,
              workspaceOptions: {
                authorizeTool: ({ toolName, call: toolCall }, context) => {
                  // Department policy enforced by the host per run, not per manifest.
                  const target = String(toolCall.input.path ?? "");
                  if (
                    toolName === "read_file" &&
                    target.startsWith("policies/hr/") &&
                    !context.runId.startsWith("hr-")
                  ) {
                    throw new Error("HR documents require an HR user");
                  }
                },
              },
            },
          );
          const runtime = new AgentRuntime({
            runStore: new MemoryRunStore(),
            stepExecutors: executors(),
            eventSinks: [events],
            model,
            artifacts: new FileArtifactStore(path.join(root, "artifacts")),
            ...composed,
            tools: new CompositeToolAdapter([ticketing, composed.tools!]),
          });
          return {
            result: await runtime.run({ runId, manifest }),
            events: events.events,
          };
        };

        const employee = await runAs("employee-7");
        const output = employee.result.output as {
          offered: string[];
          results: Array<{ name: string; ok?: boolean; error?: string }>;
          listed: string[];
          answer: string;
          diagram: {
            artifactId: string;
            mediaType: string;
            inlined: boolean;
          } | null;
        };
        expect(output.offered).toEqual([
          "policies__search_files",
          "policies__read_file",
          "policies__list_files",
          "tickets__create",
        ]);
        expect(output.listed).toEqual([
          "policies/diagram.png",
          "policies/hr/leave.md",
          "policies/travel.md",
        ]);
        expect(output.answer).toContain("reimbursed up to 50 USD");
        expect(output.results).toEqual([
          { name: "policies__list_files", ok: true },
          { name: "policies__search_files", ok: true },
          { name: "policies__read_file", ok: true },
          { name: "policies__read_file", error: "tool_not_authorized" },
          { name: "policies__read_file", error: "workspace_path_invalid" },
          { name: "policies__read_file", error: "workspace_path_invalid" },
          { name: "policies__read_file", error: "workspace_path_invalid" },
          { name: "policies__read_file", ok: true },
          { name: "tickets__create", ok: true },
        ]);
        expect(output.diagram).toEqual({
          artifactId: expect.stringMatching(/^artifact_/u),
          mediaType: "image/png",
          inlined: true,
        });
        // The artifact reference travels in the durable transcript with the tool result.
        const transcriptArtifacts = employee.result.transcript.flatMap((item) =>
          item.content.flatMap((part) =>
            part.type === "tool-result" ? (part.result.artifacts ?? []) : [],
          ),
        );
        expect(transcriptArtifacts).toEqual([
          expect.objectContaining({
            name: "diagram.png",
            mediaType: "image/png",
          }),
        ]);
        expect(tickets).toEqual(["Clarify hotel ceiling"]);
        // The run never exposed write tools and never synced anything back.
        const exposed = await composeRuntime(
          manifest,
          config,
          {},
          { model: false },
        ).tools!.listTools();
        expect(exposed.map((tool) => tool.name)).toEqual([
          "policies__list_files",
          "policies__read_file",
          "policies__search_files",
        ]);
        expect(
          commandRecords(employee.events).every(
            (record) => record.filesChanged.length === 0,
          ),
        ).toBe(true);
        expect(
          employee.events.find((event) => event.type === "sandbox.opened")
            ?.data,
        ).toMatchObject({
          mounts: [
            { alias: "policies", mode: "read", attached: false, fileCount: 3 },
          ],
        });

        const hr = await runAs("hr-2");
        expect((hr.result.output as typeof output).results[3]).toEqual({
          name: "policies__read_file",
          ok: true,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("C. Quarterly Pack: writes survive suspension and resume in a fresh process with a fresh sandbox", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "usecase-c-"));
      try {
        const data = path.join(root, "data");
        const scratch = path.join(root, "scratch");
        await mkdir(data, { recursive: true });
        await mkdir(scratch, { recursive: true });
        await writeFile(
          path.join(data, "q3.csv"),
          "region,revenue\nnorth,120\nsouth,80\n",
        );
        const config = parseAgentRuntimeConfig({
          version: "1.0",
          workspaces: {
            "source-data": { driver: "local", root: data, mode: "read" },
            scratch: { driver: "local", root: scratch, mode: "read_write" },
          },
          sandbox: { driver: "bubblewrap" },
        });
        const manifest: AgentManifest = {
          schemaVersion: "1.0",
          model: { provider: "openai", model: "scripted" },
          workspaces: [
            { ref: "source-data", alias: "data", mode: "read" },
            { ref: "scratch", mode: "read_write" },
            {
              ref: "prior-quarter",
              alias: "prior",
              mode: "read",
              required: false,
            },
          ],
          steps: [
            {
              id: "draft",
              type: "prompt",
              prompt: "Draft the report.",
              tools: ["data__read_file", "scratch__write_file"],
              outputVariable: "draft",
            },
            { id: "review", type: "approval", prompt: "Approve the draft?" },
            {
              id: "finalize",
              type: "prompt",
              prompt: "Finalize the report.",
              tools: ["scratch__read_file", "scratch__write_file"],
              includeInFinalOutput: true,
            },
          ],
        };
        const script: Turn[] = [
          call("data__read_file", { path: "q3.csv" }),
          (_request, results) => {
            const rows = String(
              (last(results).output as { content: string }).content,
            )
              .split("\n")
              .slice(1);
            const total = rows.reduce(
              (sum, row) => sum + Number(row.split(",")[1]),
              0,
            );
            callSequence += 1;
            return {
              call: {
                id: `call-${callSequence}`,
                name: "scratch__write_file",
                input: {
                  path: "draft.md",
                  content: `# Q3 draft\nTotal revenue: ${total}\n`,
                },
              },
            };
          },
          finish((_request, results) => ({
            drafted: (last(results).output as { path: string }).path,
          })),
          // Resumed attempt: the new process reads what the old one wrote.
          call("scratch__read_file", { path: "draft.md" }),
          (_request, results) => {
            callSequence += 1;
            return {
              call: {
                id: `call-${callSequence}`,
                name: "scratch__write_file",
                input: {
                  path: "final.md",
                  content: `${String((last(results).output as { content: string }).content)}\nStatus: approved\n`,
                },
              },
            };
          },
          finish((_request, results) => ({
            finalized: (last(results).output as { path: string }).path,
          })),
        ];
        const model = scripted(script);
        const storeDirectory = path.join(root, "store");

        // Each attempt composes everything anew, as a fresh process would.
        const attempt = async (approved: boolean) => {
          const events = new CollectingEventSink();
          const composed = composeRuntime(
            manifest,
            config,
            {},
            { model: false },
          );
          const runtime = new AgentRuntime({
            runStore: new FileRunStore(storeDirectory),
            stepExecutors: executors(),
            eventSinks: [events],
            model,
            approvals: {
              requestApproval: async () => {
                if (!approved) throw new RunSuspendedError("Approval required");
                return {
                  approved: true,
                  respondedAt: new Date().toISOString(),
                };
              },
            },
            ...composed,
          });
          return { runtime, events: events.events };
        };

        const first = await attempt(false);
        await expect(
          first.runtime.run({ runId: "q3-pack", manifest }),
        ).rejects.toBeInstanceOf(RunSuspendedError);
        expect(await readFile(path.join(scratch, "draft.md"), "utf8")).toBe(
          "# Q3 draft\nTotal revenue: 200\n",
        );
        const firstTypes = first.events.map((event) => event.type);
        expect(
          firstTypes.filter((type) => type === "workspace.bound"),
        ).toHaveLength(2);
        expect(firstTypes.indexOf("sandbox.closed")).toBeLessThan(
          firstTypes.indexOf("run.suspended"),
        );
        expect(
          first.events.find((event) => event.type === "sandbox.closed")?.data,
        ).toMatchObject({
          reason: "suspended",
          commandsUsed: 2,
        });
        const firstSandbox = first.events.find(
          (event) => event.type === "sandbox.opened",
        )?.data?.sandboxId;
        const suspendedStore = new FileRunStore(storeDirectory);
        expect((await suspendedStore.loadRun("q3-pack"))?.status).toBe(
          "suspended",
        );
        expect(
          (await suspendedStore.loadLatestCheckpoint("q3-pack"))?.metadata,
        ).toEqual({
          sandboxBudget: {
            commandsUsed: 2,
            sandboxSecondsUsed: expect.any(Number),
          },
        });

        const second = await attempt(true);
        const result = await second.runtime.run({
          runId: "q3-pack",
          resume: true,
        });
        expect(result.output).toEqual({ finalized: "final.md" });
        expect(result.state.draft).toEqual({ drafted: "draft.md" });
        expect(await readFile(path.join(scratch, "final.md"), "utf8")).toBe(
          "# Q3 draft\nTotal revenue: 200\nStatus: approved\n",
        );
        const secondSandbox = second.events.find(
          (event) => event.type === "sandbox.opened",
        )?.data?.sandboxId;
        expect(secondSandbox).toBeDefined();
        expect(secondSandbox).not.toBe(firstSandbox);
        expect(
          commandRecords(second.events).map((record) => [
            record.id,
            record.attempt,
            record.name,
          ]),
        ).toEqual([
          ["cmd-2-1", 2, "read_file"],
          ["cmd-2-2", 2, "write_file"],
        ]);
        expect(commandRecords(second.events)[0]?.budget).toMatchObject({
          commandsUsed: 3,
        });
        expect(model.turns).toBe(6);
        // The durable transcript spans both attempts.
        const recordIds = result.transcript.flatMap((item) =>
          item.content.flatMap((part) =>
            part.type === "tool-result"
              ? [(part.result.metadata?.command as SandboxCommandRecord).id]
              : [],
          ),
        );
        expect(recordIds).toEqual(["cmd-1-1", "cmd-1-2", "cmd-2-1", "cmd-2-2"]);
        expect(
          second.events.find((event) => event.type === "sandbox.closed")?.data,
        ).toMatchObject({
          reason: "completed",
          commandsUsed: 4,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("D. Marketplace: an untrusted manifest and model cannot escape the host's boundary", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "usecase-d-"));
      try {
        const publicRoot = path.join(root, "public");
        const scratch = path.join(root, "scratch");
        await mkdir(publicRoot, { recursive: true });
        await mkdir(scratch, { recursive: true });
        await writeFile(
          path.join(publicRoot, "readme.md"),
          "public (.*)+ text\n",
        );
        await writeFile(path.join(publicRoot, ".env"), "SECRET=1\n");
        await writeFile(
          path.join(publicRoot, "big.bin"),
          Buffer.alloc(2 * 1024 * 1024, 1),
        );
        await symlink("/etc/passwd", path.join(publicRoot, "passwd-link"));
        const config = parseAgentRuntimeConfig({
          version: "1.0",
          workspaces: {
            public: {
              driver: "local",
              root: publicRoot,
              mode: "read",
              // Staging fails closed on oversize inputs; keep this fixture
              // focused on command admission and the host filesystem boundary.
              exclude: ["big.bin"],
              maxFileBytes: 1_048_576,
            },
            scratch: {
              driver: "local",
              root: scratch,
              mode: "read_write",
              maxFileBytes: 1_048_576,
            },
          },
          sandbox: {
            driver: "bubblewrap",
            shell: { enabled: true, modes: ["read_write"], timeoutMs: 1_000 },
            // Eight commands actually execute below; attempts rejected at admission cost nothing.
            limits: { maxCommandsPerRun: 8 },
          },
        });
        const baseManifest = (
          workspaces: AgentManifest["workspaces"],
          tools: string[],
        ): AgentManifest => ({
          schemaVersion: "1.0",
          model: { provider: "openai", model: "scripted" },
          workspaces,
          extensions: { agentRuntime: { workspaceRoot: "/" } },
          steps: [
            {
              id: "attack",
              type: "prompt",
              prompt: "Try everything.",
              tools,
              includeInFinalOutput: true,
            },
          ],
        });
        const runWith = async (
          manifest: AgentManifest,
          model: ModelAdapter,
        ) => {
          const store = new MemoryRunStore();
          const events = new CollectingEventSink();
          const composed = composeRuntime(
            manifest,
            config,
            {},
            { model: false },
          );
          const runtime = new AgentRuntime({
            runStore: store,
            stepExecutors: executors(),
            eventSinks: [events],
            model,
            ...composed,
          });
          return {
            run: runtime.run({ runId: "marketplace", manifest }),
            store,
            events: events.events,
          };
        };

        // Manifest-level attacks fail before any run state exists.
        const unknown = await runWith(
          baseManifest([{ ref: "host-root" }], []),
          scripted([]),
        );
        await expect(unknown.run).rejects.toThrow(
          /Unknown workspace "host-root"/u,
        );
        expect(await unknown.store.loadRun("marketplace")).toBeNull();
        const elevate = await runWith(
          baseManifest([{ ref: "public", mode: "read_write" }], []),
          scripted([]),
        );
        await expect(elevate.run).rejects.toThrow(/cannot be elevated/u);
        expect(() =>
          validateRuntimeConfiguration(
            baseManifest([{ ref: "public", tools: ["write_file"] }], []),
            config,
          ),
        ).toThrow(/requires read_write/u);
        expect(() =>
          validateRuntimeConfiguration(
            baseManifest([{ ref: "public", tools: ["rm_rf"] }], []),
            config,
          ),
        ).toThrow(/does not expose: rm_rf/u);
        const shellOnRead = await runWith(
          baseManifest(
            [{ ref: "public", tools: ["shell"] }],
            ["public__shell"],
          ),
          scripted([]),
        );
        // Refused before the run starts, so no model call is spent.
        await expect(shellOnRead.run).rejects.toThrow(
          /names unknown tools: public__shell/u,
        );

        // Model-level attacks inside a run that legitimately holds a read-only public
        // workspace and a read-write scratch workspace with shell access.
        const manifest = baseManifest(
          [{ ref: "public" }, { ref: "scratch" }],
          [
            "public__read_file",
            "public__search_files",
            "scratch__read_file",
            "scratch__write_file",
            "scratch__delete_file",
            "scratch__shell",
          ],
        );
        const model = scripted([
          call("public__read_file", { path: "../../etc/passwd" }),
          call("public__read_file", { path: "passwd-link" }),
          call("public__read_file", { path: ".env" }),
          call("public__read_file", { path: "big.bin" }),
          call("public__search_files", { query: "(.*)+" }),
          call("scratch__shell", {
            command: [
              "ln -s /etc/passwd leak",
              "cat /etc/shadow >/dev/null 2>&1 && echo SHADOW || echo NO-SHADOW",
              "python3 -c \"import socket; s=socket.socket(); s.settimeout(1); s.connect(('1.1.1.1',80))\" >/dev/null 2>&1 && echo NET || echo NO-NET",
              "cat /workspace/mounts/public/.env >/dev/null 2>&1 && echo LEAK || echo NO-SECRET",
              // A staged read workspace is a disposable copy, never synced to the host.
              "echo pwn > /workspace/mounts/public/hack.txt 2>/dev/null && echo WROTE-COPY || echo COPY-READ-ONLY",
              "dd if=/dev/zero of=huge.bin bs=1M count=3 2>/dev/null; echo done",
            ].join("; "),
          }),
          call("scratch__read_file", { path: "leak" }),
          call("scratch__shell", { command: "sleep 5" }),
          call("scratch__write_file", { path: "../escape.md", content: "x" }),
          call("scratch__delete_file", { path: "missing.md" }),
          call("scratch__write_file", { path: "ok.md", content: "fine" }),
          call("scratch__write_file", { path: "over-budget.md", content: "x" }),
          finish((_request, results) => ({
            results: summary(results),
            search: results[4]?.output,
            shell: (results[5]?.output as { stdout: string }).stdout,
          })),
        ]);
        const { run, events } = await runWith(manifest, model);
        const result = await run;
        const output = result.output as {
          results: Array<{ name: string; ok?: boolean; error?: string }>;
          search: unknown;
          shell: string;
        };
        expect(output.results).toEqual([
          { name: "public__read_file", error: "workspace_path_invalid" }, // traversal
          { name: "public__read_file", error: "workspace_path_invalid" }, // symbolic link never staged
          { name: "public__read_file", error: "workspace_path_invalid" }, // hidden entry
          { name: "public__read_file", error: "workspace_path_invalid" }, // oversized input excluded from staging
          { name: "public__search_files", ok: true }, // regex metacharacters are literal
          { name: "scratch__shell", ok: true },
          { name: "scratch__read_file", error: "workspace_path_invalid" }, // symlink planted by the shell
          { name: "scratch__shell", error: "sandbox_command_timeout" },
          { name: "scratch__write_file", error: "workspace_path_invalid" },
          { name: "scratch__delete_file", error: "workspace_path_invalid" },
          { name: "scratch__write_file", ok: true },
          { name: "scratch__write_file", error: "sandbox_budget_exhausted" },
        ]);
        expect(output.search).toEqual({
          matches: [{ path: "readme.md", line: 1, text: "public (.*)+ text" }],
          truncated: false,
        });
        expect(output.shell.trim().split("\n")).toEqual([
          "NO-SHADOW",
          "NO-NET",
          "NO-SECRET",
          "WROTE-COPY",
          "done",
        ]);

        // Host-side state: only the legitimate write landed; nothing escaped or leaked.
        expect(await readFile(path.join(scratch, "ok.md"), "utf8")).toBe(
          "fine",
        );
        await expect(readFile(path.join(scratch, "leak"))).rejects.toThrow();
        await expect(
          readFile(path.join(scratch, "huge.bin")),
        ).rejects.toThrow();
        await expect(
          readFile(path.join(publicRoot, "hack.txt")),
        ).rejects.toThrow();
        await expect(readFile(path.join(root, "escape.md"))).rejects.toThrow();
        const shellRecord = commandRecords(events).find(
          (record) => record.kind === "shell",
        );
        expect(shellRecord?.ignoredPaths).toEqual(
          expect.arrayContaining([
            { alias: "scratch", path: "leak", reason: "symlink" },
            { alias: "scratch", path: "huge.bin", reason: "size" },
          ]),
        );
        expect(shellRecord?.filesChanged).toEqual([]);
        const timedOut = commandRecords(events).find(
          (record) => record.timedOut,
        );
        expect(timedOut).toMatchObject({
          kind: "shell",
          argv: ["/bin/sh", "-c", "sleep 5"],
        });
        expect(commandRecords(events)).toHaveLength(8);
        expect(
          events.find((event) => event.type === "sandbox.closed")?.data,
        ).toMatchObject({
          reason: "completed",
          commandsUsed: 8,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
