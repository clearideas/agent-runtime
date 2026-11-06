/**
 * Document Library: a read-only workspace with visibility globs, an image
 * returned as an artifact, and an MCP ticket tool beside the workspace tools.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  eventsOf,
  resultOf,
  runDemo,
  startShowcase,
  type Message,
  testEnvironment,
} from "./helpers.ts";

const environment = await testEnvironment();
const skip =
  environment.sandbox.kind === "none" ? "no sandbox available" : false;

const ask = (baseURL: string, question: string) =>
  runDemo(baseURL, "document-library", { options: { question } });

const toolCalls = (messages: Message[]) =>
  messages
    .filter((message) => message.kind === "tool-io")
    .map((message) =>
      `${message.name} ${message.input.path ?? message.input.query ?? ""}`.trim(),
    );

test(
  "answers from a published policy and never sees drafts or archives",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const messages = await ask(
      baseURL,
      "How many days of annual leave do I get?",
    );
    const result = resultOf(messages);
    // Only the four published policy files are staged.
    assert.equal(
      eventsOf(messages, "sandbox.opened")[0].data.mounts[0].fileCount,
      4,
    );
    assert.deepEqual(toolCalls(messages), [
      "library__search_files annual leave",
      "library__read_file policies/leave.md",
    ]);
    assert.match(result.output, /25 days/u);
    assert.doesNotMatch(result.output, /20 days/u);
    assert.deepEqual(result.state.research.sources, ["policies/leave.md"]);
  },
);

test(
  "passes a diagram to the model as an image artifact",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const messages = await ask(baseURL, "How does expense approval work?");
    const result = resultOf(messages);
    const image = messages.find(
      (message) =>
        message.kind === "tool-io" && message.input.path?.endsWith(".png"),
    );
    assert.equal(image?.output.encoding, "binary");
    assert.equal(
      image?.output.content,
      undefined,
      "no image bytes in the tool output",
    );
    const [artifact] = image!.artifacts;
    assert.equal(artifact.mediaType, "image/png");
    assert.deepEqual(result.state.research.sources, [
      "policies/expenses/approval-flow.md",
      "policies/expenses/approval-flow.png",
    ]);

    const response = await fetch(
      `${baseURL}/api/demos/document-library/artifacts/${artifact.id}`,
    );
    assert.equal(response.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(
      (
        await fetch(
          `${baseURL}/api/demos/document-library/artifacts/artifact_unknown`,
        )
      ).status,
      404,
    );
  },
);

test(
  "files a ticket over MCP when no published policy answers",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const messages = await ask(baseURL, "Is there a home-office stipend?");
    const result = resultOf(messages);
    assert.deepEqual(toolCalls(messages), [
      "library__search_files stipend",
      "library__search_files home-office",
      "tickets__create",
    ]);
    assert.equal(result.state.research.found, false);
    assert.match(result.state.research.ticket, /^PEOPLE-\d+$/u);
    assert.match(result.output, new RegExp(result.state.research.ticket, "u"));
    // The MCP call never became a sandbox command.
    assert.equal(eventsOf(messages, "sandbox.command.completed").length, 2);
  },
);

test(
  "the host view marks what the agent can and cannot see",
  { skip },
  async (context) => {
    const { baseURL } = await startShowcase(context);
    const state = await (
      await fetch(`${baseURL}/api/demos/document-library/state`)
    ).json();
    const visibility = Object.fromEntries(
      state.workspaces[0].files.map(
        (file: { path: string; visible: boolean }) => [file.path, file.visible],
      ),
    );
    assert.deepEqual(visibility, {
      ".git/HEAD": false,
      "README.md": false,
      "policies/archive/leave-2019.md": false,
      "policies/expenses/approval-flow.md": true,
      "policies/expenses/approval-flow.png": true,
      "policies/leave.md": true,
      "policies/remote-work-draft.md": false,
      "policies/travel.md": true,
    });
  },
);
