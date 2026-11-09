/**
 * Document Chat: one run per chat turn about a Word document. Uploads and
 * revisions are real .docx files in a workspace per conversation, filed by
 * turn; the history names them and is compacted once, keeping the paths.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { documentChat } from "../demos/document-chat/host.ts";
import { readDocx, type DocxBlock } from "../lib/docx.ts";
import {
  eventsOf,
  resultOf,
  runDemo,
  startShowcase,
  type Message,
  testEnvironment,
} from "./helpers.ts";

const environment = await testEnvironment();
const skip = documentChat.unavailable
  ? "the installed Agent Runtime has no conversation messages"
  : environment.sandbox.kind === "none"
    ? "no sandbox available"
    : false;

const sample = await readFile(
  new URL("../demos/document-chat/fixture/proposal.docx", import.meta.url),
);

interface Conversation {
  conversationId?: string;
  messages: Array<{
    role: string;
    content: Array<{ text?: string }>;
    metadata?: {
      agentRuntime?: { messages?: { kind: string; turns?: number } };
    };
  }>;
  signature?: unknown;
}

const send = (
  baseURL: string,
  conversation: Conversation,
  text: string,
  upload?: { name: string; data: Buffer },
) =>
  runDemo(baseURL, "document-chat", {
    options: {
      text,
      messages: conversation.messages,
      ...(conversation.signature ? { signature: conversation.signature } : {}),
      ...(conversation.conversationId
        ? { conversationId: conversation.conversationId }
        : {}),
      ...(upload
        ? {
            upload: { name: upload.name, data: upload.data.toString("base64") },
          }
        : {}),
    },
  });

const keep = (messages: Message[]): Conversation => {
  const returned = messages.find((entry) => entry.kind === "conversation");
  assert.ok(returned, "the turn returned a conversation");
  return {
    conversationId: returned.conversationId,
    messages: returned.messages,
    signature: returned.signature,
  };
};

const replyOf = (conversation: Conversation) =>
  conversation.messages
    .at(-1)!
    .content.map((part) => part.text)
    .join("");

const textOf = (blocks: DocxBlock[]) =>
  blocks
    .map((block) =>
      block.type === "paragraph"
        ? `${block.style}: ${block.text}`
        : block.rows.map((row) => row.join(" | ")).join("\n"),
    )
    .join("\n");

test(
  "edits a .docx over six turns, filing every file by turn, and compacts once",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory } = await startShowcase(context);
    const read = async (conversation: Conversation, file: string) =>
      textOf(
        readDocx(
          await readFile(
            path.join(
              dataDirectory,
              "document-chat",
              "conversations",
              conversation.conversationId!,
              file,
            ),
          ),
        ),
      );

    // A first message needs a document.
    let turn = await send(
      baseURL,
      { messages: [] },
      "Tighten the introduction.",
    );
    assert.match(
      turn.find((message) => message.kind === "error")?.error.message ?? "",
      /Attach a Word document/u,
    );

    // Turn 1: the upload is filed under turn 1 and named in the message.
    turn = await send(baseURL, { messages: [] }, "Tighten the introduction.", {
      name: "Q2 proposal (draft).docx",
      data: sample,
    });
    resultOf(turn);
    let conversation = keep(turn);
    assert.match(
      conversation.messages[0]!.content[0]!.text!,
      /\[Attached: turns\/001\/input\/Q2-proposal-draft\.docx\]$/u,
    );
    assert.match(
      replyOf(conversation),
      /Revised document: turns\/001\/output\/Q2-proposal-draft\.docx$/u,
    );
    const first = await read(
      conversation,
      "turns/001/output/Q2-proposal-draft.docx",
    );
    assert.match(first, /Normal: This proposal moves document reviews/u);
    assert.doesNotMatch(first, /considerable amount of discussion/u);
    // Untouched parts survive: the table and the title.
    assert.match(first, /Setup \| Two days of one administrator/u);
    assert.match(first, /Title: Proposal: one shared review workspace/u);
    // The code steps ran in the run sandbox, with the workspace mounted.
    assert.deepEqual(
      eventsOf(turn, "code.execution.completed").map(
        (event) => event.data.sandbox,
      ),
      ["run", "run"],
    );

    // Turn 2 builds on turn 1's revision.
    turn = await send(
      baseURL,
      conversation,
      "Add a short timeline after the plan.",
    );
    conversation = keep(turn);
    const second = await read(
      conversation,
      "turns/002/output/Q2-proposal-draft.docx",
    );
    assert.match(second, /This proposal moves document reviews/u);
    assert.match(second, /Plan\n.*\nHeading1: Timeline\nNormal: Week 1/u);

    // Turn 3 edits a table cell; turn 4 adds a section.
    turn = await send(
      baseURL,
      conversation,
      "Change the setup estimate to three days.",
    );
    conversation = keep(turn);
    assert.match(
      await read(conversation, "turns/003/output/Q2-proposal-draft.docx"),
      /Setup \| Three days of one administrator/u,
    );
    turn = await send(
      baseURL,
      conversation,
      "Add a risks section before the cost.",
    );
    conversation = keep(turn);
    assert.match(
      await read(conversation, "turns/004/output/Q2-proposal-draft.docx"),
      /Heading1: Risks\nNormal: Reviewers may keep commenting.*\nHeading1: Cost/u,
    );
    assert.equal(conversation.messages.length, 8);

    // Turn 5 crosses maxMessages: turns 1–3 are summarized, the summary keeps
    // each revision's path, and the answer lists all four from it and turn 4.
    turn = await send(baseURL, conversation, "What have we changed so far?");
    const [reduced] = eventsOf(turn, "context.reduced");
    assert.equal(reduced.data.scope, "messages");
    assert.equal(reduced.data.strategy, "summarize");
    conversation = keep(turn);
    const marker = conversation.messages[0]!;
    assert.equal(marker.metadata?.agentRuntime?.messages?.turns, 3);
    assert.match(
      marker.content[0]!.text!,
      /^\[Turns 1–3 of this conversation, summarized by Agent Runtime\./u,
    );
    assert.match(
      marker.content[1]!.text!,
      /Turn 2: I added a Timeline section after the plan → turns\/002\/output\/Q2-proposal-draft\.docx/u,
    );
    const answer = replyOf(conversation);
    for (const file of ["001", "002", "003", "004"])
      assert.match(
        answer,
        new RegExp(`turns/${file}/output/Q2-proposal-draft\\.docx`, "u"),
      );
    assert.doesNotMatch(answer, /Revised document/u);

    // Turn 6 continues after the summary: the revision is filed as turn 6.
    turn = await send(
      baseURL,
      conversation,
      "Rename it to “One review workspace”.",
    );
    conversation = keep(turn);
    const sixth = await read(
      conversation,
      "turns/006/output/Q2-proposal-draft.docx",
    );
    assert.match(sixth, /^Title: One review workspace/u);
    assert.match(sixth, /Heading1: Risks/u);

    // The workspace holds the upload and five revisions; the history, none.
    const root = path.join(
      dataDirectory,
      "document-chat",
      "conversations",
      conversation.conversationId!,
    );
    const files = (await readdir(root, { recursive: true }))
      .map((entry) => String(entry).split(path.sep).join("/"))
      .filter((entry) => entry.endsWith(".docx"))
      .sort();
    assert.deepEqual(files, [
      "turns/001/input/Q2-proposal-draft.docx",
      "turns/001/output/Q2-proposal-draft.docx",
      "turns/002/output/Q2-proposal-draft.docx",
      "turns/003/output/Q2-proposal-draft.docx",
      "turns/004/output/Q2-proposal-draft.docx",
      "turns/006/output/Q2-proposal-draft.docx",
    ]);
    assert.doesNotMatch(JSON.stringify(conversation.messages), /UEsDB/u);

    // The page lists and downloads them.
    const state = (await (
      await fetch(
        `${baseURL}/api/demos/document-chat/state?conversation=${conversation.conversationId}`,
      )
    ).json()) as { files: Array<{ path: string; blocks: unknown }> };
    assert.equal(state.files.length, 6);
    const download = await fetch(
      `${baseURL}/api/demos/document-chat/files?conversation=${conversation.conversationId}&path=turns/006/output/Q2-proposal-draft.docx`,
    );
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /attachment; filename="Q2-proposal-draft\.docx"/u,
    );
    assert.match(
      textOf(readDocx(Buffer.from(await download.arrayBuffer()))),
      /^Title: One review workspace/u,
    );
  },
);

test(
  "refuses a replayed history before touching any conversation's files",
  { skip },
  async (context) => {
    const { baseURL, dataDirectory } = await startShowcase(context);
    const first = keep(
      await send(baseURL, { messages: [] }, "Tighten the introduction.", {
        name: "proposal.docx",
        data: sample,
      }),
    );
    const conversations = path.join(
      dataDirectory,
      "document-chat",
      "conversations",
    );
    const before = await readdir(conversations);

    // The same signed history, presented as another conversation, with a
    // document to plant there.
    const turn = await send(
      baseURL,
      { ...first, conversationId: `c-${crypto.randomUUID()}` },
      "Add a risks section before the cost.",
      { name: "planted.docx", data: sample },
    );
    const rejected = turn.find(
      (message) => message.kind === "conversation-rejected",
    );
    assert.equal(rejected?.code, "MESSAGES_SIGNATURE_INVALID");
    assert.equal(eventsOf(turn, "run.started").length, 0);
    assert.deepEqual(await readdir(conversations), before);

    // Not a Word document.
    const invalid = await send(baseURL, first, "Use this instead.", {
      name: "notes.docx",
      data: Buffer.from("plain text"),
    });
    assert.match(
      invalid.find((message) => message.kind === "error")?.error.message ?? "",
      /not a Word document/u,
    );
  },
);
