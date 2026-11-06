/**
 * End-to-end tests for Repo Mechanic through the HTTP API, with the scripted
 * model and the real run sandbox this machine provides (bubblewrap, Docker,
 * or the unisolated demo fallback). They are skipped only when no sandbox
 * and no python3 are available.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  eventsOf,
  resultOf,
  runDemo,
  startShowcase,
  testEnvironment,
} from "./helpers.ts";

const environment = await testEnvironment();
const skip =
  environment.sandbox.kind === "none"
    ? `no sandbox available: ${environment.sandbox.notes.join(" ")}`
    : false;

const commandNames = (messages: Awaited<ReturnType<typeof runDemo>>) =>
  eventsOf(messages, "sandbox.command.completed").map(
    (event) => `${event.data.name}:${event.data.exitCode}`,
  );

test(
  "reproduces, fixes, and verifies the bug inside the run sandbox",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory } = await startShowcase(context);
    const messages = await runDemo(baseURL, "repo-mechanic");
    const result = resultOf(messages);

    const bound = eventsOf(messages, "workspace.bound")[0];
    assert.deepEqual(bound.data, {
      workspace: "invoice-service",
      alias: "repo",
      mode: "read_write",
      tools: [
        "list_files",
        "search_files",
        "read_file",
        "write_file",
        "run_tests",
      ],
      attachable: false,
    });
    const opened = eventsOf(messages, "sandbox.opened")[0];
    // .env.example is a dot-file and never staged; four files are visible.
    assert.equal(opened.data.mounts[0].fileCount, 4);

    assert.deepEqual(commandNames(messages), [
      "list_files:0",
      "run_tests:1",
      "search_files:0",
      "read_file:0",
      "read_file:0",
      "write_file:0",
      "run_tests:0",
      "verify:0",
    ]);
    const write = eventsOf(messages, "sandbox.command.completed").find(
      (event) => event.data.name === "write_file",
    );
    assert.deepEqual(
      write.data.filesChanged.map((file: { path: string; action: string }) => [
        file.path,
        file.action,
      ]),
      [["src/invoice.py", "modified"]],
    );

    // The fix landed in the host's workspace store through sync-back.
    const source = await readFile(
      path.join(
        dataDirectory,
        "repo-mechanic",
        "invoice-service",
        "src",
        "invoice.py",
      ),
      "utf8",
    );
    assert.match(source, /discounted = subtotal \* \(1 - discount_rate\)/u);

    assert.equal(result.state.diagnosis.status, "bug");
    assert.deepEqual(result.state.diagnosis.failingTests, [
      "test_discount_is_a_percentage",
      "test_tax_applies_after_discount",
    ]);
    assert.deepEqual(JSON.parse(result.state.verification), {
      testsRun: 4,
      failed: [],
      passed: true,
    });
    assert.match(
      result.output,
      /## Fix: apply invoice discounts as a percentage/u,
    );
    assert.match(result.output, /4 tests run, 0 failed/u);

    const closed = eventsOf(messages, "sandbox.closed")[0];
    assert.equal(closed.data.reason, "completed");
    assert.equal(closed.data.commandsUsed, 8);
    assert.equal(eventsOf(messages, "run.completed").length, 1);

    // Tool payloads are mirrored by the host, not carried in events.
    const toolIo = messages.filter((message) => message.kind === "tool-io");
    assert.equal(toolIo.length, 7);
    assert.equal(
      eventsOf(messages, "model.tool.completed").every(
        (event) => !("output" in event.data) && !("input" in event.data),
      ),
      true,
    );
  },
);

test(
  "authorizeCommand vetoes writes and the agent reports an unapplied patch",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory } = await startShowcase(context);
    const messages = await runDemo(baseURL, "repo-mechanic", {
      options: { allowWrites: false },
    });
    const result = resultOf(messages);
    const denied = eventsOf(messages, "model.tool.completed").find(
      (event) => event.data.toolName === "repo__write_file",
    );
    assert.equal(denied.data.failed, true);
    assert.equal(denied.data.errorCode, "tool_not_authorized");
    // A denied call never reaches the sandbox.
    assert.equal(
      commandNames(messages).some((name) => name.startsWith("write_file")),
      false,
    );
    assert.equal(JSON.parse(result.state.verification).passed, false);
    assert.match(result.output, /not applied/u);
    const source = await readFile(
      path.join(
        dataDirectory,
        "repo-mechanic",
        "invoice-service",
        "src",
        "invoice.py",
      ),
      "utf8",
    );
    assert.match(source, /discounted = subtotal - discount_rate/u);
  },
);

test(
  "a workspace outlives its run: a second run finds it healthy and skips the fix",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    resultOf(await runDemo(baseURL, "repo-mechanic"));
    const messages = await runDemo(baseURL, "repo-mechanic", {
      options: { resetWorkspace: false },
    });
    const result = resultOf(messages);
    assert.deepEqual(
      eventsOf(messages, "step.skipped").map((event) => event.stepId),
      ["fix"],
    );
    assert.equal(result.state.diagnosis.status, "healthy");
    assert.match(result.output, /No change needed/u);
  },
);

test(
  "the host state endpoint shows hidden files and the synced diff",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const before = await (
      await fetch(`${baseURL}/api/demos/repo-mechanic/state`)
    ).json();
    const hidden = before.workspaces[0].files.find(
      (file: { path: string }) => file.path === ".env.example",
    );
    assert.equal(hidden.visible, false);
    assert.match(hidden.hiddenReason, /dot-files/u);

    resultOf(await runDemo(baseURL, "repo-mechanic"));
    const after = await (
      await fetch(`${baseURL}/api/demos/repo-mechanic/state`)
    ).json();
    const changed = after.workspaces[0].files.find(
      (file: { path: string }) => file.path === "src/invoice.py",
    );
    assert.equal(changed.status, "modified");
    assert.match(changed.baseline, /subtotal - discount_rate/u);
    assert.match(changed.content, /subtotal \* \(1 - discount_rate\)/u);
    // Exactly one line changed; the file keeps its trailing newline.
    assert.equal(
      changed.content,
      changed.baseline.replace(
        "subtotal - discount_rate",
        "subtotal * (1 - discount_rate)",
      ),
    );

    const reset = await fetch(`${baseURL}/api/demos/repo-mechanic/reset`, {
      method: "POST",
    });
    assert.equal(reset.status, 200);
    const restored = await (
      await fetch(`${baseURL}/api/demos/repo-mechanic/state`)
    ).json();
    assert.equal(
      restored.workspaces[0].files.find(
        (file: { path: string }) => file.path === "src/invoice.py",
      ).status,
      "unchanged",
    );
  },
);

test(
  "failed tool calls are also printed to the server console",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const lines: string[] = [];
    const original = console.error;
    delete process.env.SHOWCASE_QUIET;
    console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
    try {
      resultOf(
        await runDemo(baseURL, "repo-mechanic", {
          options: { allowWrites: false },
        }),
      );
    } finally {
      console.error = original;
      process.env.SHOWCASE_QUIET = "1";
    }
    assert.ok(
      lines.some((line) =>
        /^\[showcase\] repo-mechanic: repo__write_file \{"path":"src\/invoice\.py".* failed with tool_not_authorized: /u.test(
          line,
        ),
      ),
      lines.join("\n"),
    );
  },
);
