/**
 * Document Chat page: a chat about a Word document.
 *
 * The browser keeps the conversation's history and signature, as in Data
 * Chat. The documents stay on the host, in a directory per conversation: the
 * page uploads an attachment with the message, then lists the conversation's
 * files and previews any version, with the changes from the version before.
 */
import { createDemoPage } from "./lib/demo-page.js";
import { diffLines } from "./lib/diff.js";
import { $, formatBytes, h, renderMarkdown } from "./lib/ui.js";

const STORAGE_KEY = "showcase.document-chat.conversation";
const transcript = $("#transcript");
const composer = $("#composer");
const input = $("#message");
const turnStatus = $("#turn-status");

// ─── The conversation the browser holds ──────────────────────────────────────

const emptyConversation = () => ({
  conversationId: null,
  messages: [],
  signature: null,
});
const load = () => {
  try {
    return {
      ...emptyConversation(),
      ...JSON.parse(localStorage.getItem(STORAGE_KEY)),
    };
  } catch {
    return emptyConversation();
  }
};
let conversation = load();
const save = () =>
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversation));

/** The conversation's documents on the host, oldest first. */
let files = [];
/** The version shown in the document panel. */
let selectedPath = null;
/** A document chosen for the next message: { name, size, data (base64) }. */
let attachment = null;

const textOf = (message) =>
  message.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
const markerOf = (message) => message.metadata?.agentRuntime?.messages;

/**
 * Turn numbers as Agent Runtime assigns them: a turn ends with a reply, and
 * a summary at the start covers `marker.turns` turns.
 */
const turnsOf = (messages) => {
  let turn = (messages[0] && markerOf(messages[0])?.turns) ?? 0;
  return messages.map((message) => {
    if (markerOf(message)) return null;
    if (message.role === "assistant") return (turn += 1);
    return turn + 1;
  });
};

const ATTACHED = /\n*\[Attached: (turns\/\S+)\]\s*$/u;
const REVISED = /\n*Revised document: (turns\/\S+)\s*$/u;

const fileUrl = (path) =>
  `/api/demos/document-chat/files?conversation=${encodeURIComponent(conversation.conversationId ?? "")}&path=${encodeURIComponent(path)}`;
const nameOf = (path) => path.split("/").at(-1);
const describeFile = (file) =>
  `Turn ${file.turn} · ${file.kind === "input" ? "upload" : "revision"}`;

// ─── Transcript ──────────────────────────────────────────────────────────────

let notices = [];
let pending = null;

const fileChip = (path, label) => {
  const file = files.find((entry) => entry.path === path);
  return h(
    "div.file-chip",
    {},
    h("span.file-icon", { text: "DOCX", "aria-hidden": "true" }),
    h(
      "span.file-chip-text",
      {},
      h("strong", { text: nameOf(path) }),
      h("small", {
        text: `${label}${file ? ` · ${formatBytes(file.size)}` : ""} · ${path}`,
      }),
    ),
    file
      ? h("button.button.small", {
          type: "button",
          text: "View",
          onclick: () => {
            select(path);
            $("#document").scrollIntoView({ behavior: "smooth" });
          },
        })
      : h("small.dim", { text: "not on the host" }),
    file
      ? h("a.button.small", {
          href: fileUrl(path),
          download: nameOf(path),
          text: "↓",
        })
      : null,
  );
};

/** Text with each conversation file path as a link to that version. */
const linkPaths = (text) =>
  text.split(/(turns\/\d{3}\/(?:input|output)\/\S+?\.docx)/u).map((piece) => {
    const file = files.find((entry) => entry.path === piece);
    return file
      ? h("button.path-link", {
          type: "button",
          text: piece,
          title: `View ${piece}`,
          onclick: () => {
            select(piece);
            $("#document").scrollIntoView({ behavior: "smooth" });
          },
        })
      : piece;
  });

const bubble = (message, turn) => {
  const marker = markerOf(message);
  if (marker) {
    const body = h(
      "p.summary-text",
      {},
      linkPaths(
        message.content
          .slice(1)
          .map((part) => part.text)
          .join("\n\n"),
      ),
    );
    return h(
      "li.summary-marker",
      {},
      h(
        "details",
        {},
        h(
          "summary",
          {},
          h("strong", {
            text:
              marker.kind === "summary"
                ? `Turns 1–${marker.turns} summarized by Agent Runtime`
                : `Turns 1–${marker.turns} removed by Agent Runtime`,
          }),
          h("small", {
            text: ` ${marker.replaces} messages · compaction ${marker.sequence}`,
          }),
        ),
        h("p.caption", { text: message.content[0]?.text ?? "" }),
        body,
      ),
    );
  }
  const text = textOf(message);
  if (message.role === "user") {
    const attached = ATTACHED.exec(text)?.[1];
    return h(
      "li.bubble.user",
      {},
      h("small.turn-label", { text: `Turn ${turn}` }),
      h("p", { text: text.replace(ATTACHED, "") }),
      attached ? fileChip(attached, `Turn ${turn} · upload`) : null,
    );
  }
  const revised = REVISED.exec(text)?.[1];
  const body = h("div.markdown");
  renderMarkdown(body, text.replace(REVISED, ""));
  // A path the reply mentions opens that version in the document panel.
  for (const code of body.querySelectorAll("code"))
    code.replaceWith(...linkPaths(code.textContent));
  return h(
    "li.bubble.assistant",
    {},
    body,
    revised ? fileChip(revised, `Turn ${turn} · revision`) : null,
  );
};

const noticeView = (notice) =>
  h(
    `li.chat-notice.${notice.tone}`,
    {},
    h("strong", { text: notice.title }),
    h("p", { text: notice.text }),
  );

const pendingView = () => [
  h(
    "li.bubble.user.pending",
    {},
    h("p", { text: pending.text }),
    pending.attachment
      ? h("small.dim", { text: `Attaching ${pending.attachment}` })
      : null,
  ),
  h(
    "li.bubble.assistant.pending",
    {},
    h("span.typing", { text: pending.status }),
  ),
];

const renderTranscript = () => {
  const turns = turnsOf(conversation.messages);
  const items = [
    ...conversation.messages.map((message, index) =>
      bubble(message, turns[index]),
    ),
    ...notices.map(noticeView),
    ...(pending ? pendingView() : []),
  ];
  transcript.replaceChildren(
    ...(items.length > 0
      ? items
      : [
          h("li.chat-empty", {
            text: "Pick a suggestion below to start with the sample proposal, or attach your own .docx and ask in Live mode.",
          }),
        ]),
  );
  transcript.scrollTop = transcript.scrollHeight;
};

// ─── The conversation's workspace ────────────────────────────────────────────

const row = (term, ...details) => [
  h("dt", { text: term }),
  h("dd", {}, ...details),
];

let limits = { maxMessages: 8, maxBytes: 24000 };
const renderWorkspace = () => {
  const byTurn = new Map();
  for (const file of files) {
    if (!byTurn.has(file.turn)) byTurn.set(file.turn, []);
    byTurn.get(file.turn).push(file);
  }
  $("#workspace-tree").replaceChildren(
    conversation.conversationId
      ? h("code.workspace-root", {
          text: `conversations/${conversation.conversationId}/`,
          title: `${page.demo.conversationsRoot}/${conversation.conversationId}`,
        })
      : h("p.dim", {
          text: "Created by the host with the first message.",
        }),
    ...[...byTurn].map(([turn, entries]) =>
      h(
        "div.workspace-turn",
        {},
        h("span.workspace-turn-label", {
          text: `turns/${String(turn).padStart(3, "0")}/ · turn ${turn}`,
        }),
        ...entries.map((file) =>
          h(
            "button.workspace-file",
            {
              type: "button",
              title: `View ${file.path}`,
              dataset: {
                selected: String(file.path === selectedPath),
                kind: file.kind,
              },
              onclick: () => select(file.path),
            },
            h("span", { text: `${file.kind}/${nameOf(file.path)}` }),
            h("small", { text: formatBytes(file.size) }),
          ),
        ),
      ),
    ),
  );
  const { messages, signature } = conversation;
  const marker = messages[0] ? markerOf(messages[0]) : undefined;
  $("#held").replaceChildren(
    ...row(
      "History",
      h("span", {
        text: `${messages.length} of ${limits.maxMessages} messages · ${formatBytes(new TextEncoder().encode(JSON.stringify(messages)).byteLength)}`,
      }),
    ),
    ...row(
      "Signature",
      signature
        ? h("span.sig-ok", {
            text: `HMAC-SHA256 · covers ${signature.count} messages`,
          })
        : h("span.dim", { text: "none yet" }),
    ),
    ...row(
      "Compacted",
      h("span", {
        text: marker
          ? `the ${marker.kind} covers turns 1–${marker.turns}`
          : "not yet",
      }),
    ),
  );
  $("#held-json code").textContent = JSON.stringify(
    {
      conversationId: conversation.conversationId,
      messages,
      signature,
    },
    null,
    2,
  );
};

// ─── The document panel ──────────────────────────────────────────────────────

const headingLevel = (style) => {
  if (/^title$/iu.test(style)) return 1;
  const match = /(?:heading|berschrift|titre)\s*(\d)/iu.exec(style);
  return match ? Math.min(4, Number(match[1]) + 1) : 0;
};

const blockView = (block, change) => {
  const dataset = change === "same" ? {} : { change };
  if (block.type === "table")
    return h(
      "table.doc-table",
      { dataset },
      h(
        "tbody",
        {},
        block.rows.map((cells) =>
          h(
            "tr",
            {},
            cells.map((cell) => h("td", { text: cell })),
          ),
        ),
      ),
    );
  const level = headingLevel(block.style);
  return h(level ? `h${level}` : "p", {
    text: block.text,
    dataset: { ...dataset, style: block.style },
  });
};

const select = (path) => {
  selectedPath = path;
  renderDocument();
  renderWorkspace();
};

const renderDocument = () => {
  const versions = $("#doc-version");
  const download = $("#doc-download");
  const pageView = $("#doc-page");
  const caption = $("#doc-caption");
  versions.replaceChildren(
    ...files.map((file) =>
      h("option", {
        value: file.path,
        text: `${describeFile(file)} · ${nameOf(file.path)}`,
        selected: file.path === selectedPath,
      }),
    ),
  );
  versions.hidden = files.length === 0;
  const index = files.findIndex((file) => file.path === selectedPath);
  const file = files[index];
  if (!file) {
    download.hidden = true;
    caption.textContent = "";
    pageView.replaceChildren(
      h("p.doc-empty", {
        text: "The document appears here once a message attaches one.",
      }),
    );
    return;
  }
  download.hidden = false;
  download.href = fileUrl(file.path);
  download.download = nameOf(file.path);
  if (!Array.isArray(file.blocks)) {
    caption.textContent = `${file.path} has no preview.`;
    pageView.replaceChildren();
    return;
  }
  const previous = index > 0 ? files[index - 1] : undefined;
  const showChanges =
    $("#doc-changes").checked && previous && Array.isArray(previous.blocks);
  const visible = (blocks) =>
    blocks.filter((block) => block.type === "table" || block.text.trim());
  caption.textContent = showChanges
    ? `${file.path} · changes from ${previous.path}`
    : file.path;
  const lines = showChanges
    ? diffLines(
        visible(previous.blocks)
          .map((block) => JSON.stringify(block))
          .join("\n"),
        visible(file.blocks)
          .map((block) => JSON.stringify(block))
          .join("\n"),
      )
    : visible(file.blocks).map((block) => ({
        type: "same",
        text: JSON.stringify(block),
      }));
  pageView.replaceChildren(
    ...lines.map((line) => blockView(JSON.parse(line.text), line.type)),
  );
};

$("#doc-version").addEventListener("change", (event) =>
  select(event.target.value),
);
$("#doc-changes").addEventListener("change", renderDocument);

const render = () => {
  renderTranscript();
  renderWorkspace();
  renderDocument();
};

// ─── Attachments ─────────────────────────────────────────────────────────────

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

const attach = (name, buffer) => {
  if (buffer.byteLength > page.demo.maxUploadBytes) {
    $("#attach-note").textContent =
      `${name} is larger than ${formatBytes(page.demo.maxUploadBytes)}.`;
    return;
  }
  attachment = { name, size: buffer.byteLength, data: toBase64(buffer) };
  $("#attach-note").textContent = "";
  renderAttachment();
  updateSendButton();
};

const attachSample = async () => {
  const response = await fetch(page.demo.sample.url);
  attach(page.demo.sample.name, await response.arrayBuffer());
};

const renderAttachment = () => {
  const chip = $("#attachment");
  chip.hidden = !attachment;
  if (!attachment) return;
  chip.replaceChildren(
    h("span", { text: `${attachment.name} · ${formatBytes(attachment.size)}` }),
    h("button", {
      type: "button",
      text: "×",
      title: "Remove the attachment",
      "aria-label": "Remove the attachment",
      onclick: () => {
        attachment = null;
        renderAttachment();
        updateSendButton();
      },
    }),
  );
};

$("#attach-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) attach(file.name, await file.arrayBuffer());
});
$("#attach-sample").addEventListener("click", attachSample);

// ─── Sending a message ───────────────────────────────────────────────────────

const STATUS = {
  read: "Reading the newest version in the sandbox…",
  revise: "Deciding the edits…",
  save: "Writing the revised .docx in the sandbox…",
};

const refreshFiles = async () => {
  const state = await page.refreshHost();
  files = state.files ?? [];
  if (!files.some((file) => file.path === selectedPath))
    selectedPath = files.at(-1)?.path ?? null;
};

const page = await createDemoPage({
  demoId: "document-chat",
  scrollTarget: "#chat",
  runLabels: { idle: "Send", running: "Stop" },
  stateQuery: () =>
    conversation.conversationId
      ? `?conversation=${encodeURIComponent(conversation.conversationId)}`
      : "",
  buildRequest: () => {
    const text = input.value.trim();
    input.value = "";
    pending = {
      text,
      attachment: attachment?.name,
      sent: attachment,
      status: "Sending…",
    };
    attachment = null;
    renderAttachment();
    updateSendButton();
    renderTranscript();
    return {
      text,
      messages: conversation.messages,
      ...(conversation.signature ? { signature: conversation.signature } : {}),
      ...(conversation.conversationId
        ? { conversationId: conversation.conversationId }
        : {}),
      ...(pending.sent
        ? { upload: { name: pending.sent.name, data: pending.sent.data } }
        : {}),
    };
  },
  onMessage: (message) => {
    if (!pending) return;
    if (message.kind === "event") {
      const { type, stepId, data } = message.event;
      if (type === "step.started" && STATUS[stepId]) {
        pending.status = STATUS[stepId];
        turnStatus.textContent = pending.status;
      }
      if (type === "context.reduced" && data?.scope === "messages") {
        pending.status = "Summarizing the earlier turns…";
        turnStatus.textContent = pending.status;
      }
      renderTranscript();
    }
    if (message.kind === "conversation") finishTurn(message);
    if (message.kind === "conversation-rejected") rejectTurn(message);
  },
  onEffect: (effect, state) => {
    if (effect.type === "command-completed") {
      const command = state.commands.get(effect.commandId);
      const line = page.stage.termLines.get(effect.commandId);
      if (command?.kind === "code" && line && command.exitCode === 0)
        line.result.textContent = command.filesChanged.length
          ? command.filesChanged
              .map((file) => `${file.action} ${nameOf(file.path)}`)
              .join(", ")
          : "read";
    }
    if (effect.type === "error" && pending) failTurn(state.error);
  },
});
limits = page.demo.limits ?? limits;

/** Put the message and its attachment back, so it can be sent again. */
const restorePending = () => {
  input.value = pending.text;
  attachment = pending.sent ?? attachment;
  pending = null;
  turnStatus.textContent = "";
  renderAttachment();
  updateSendButton();
};

const failTurn = (error) => {
  notices.push({
    tone: "error",
    title: "The run did not finish",
    text: error ?? "Unknown error.",
  });
  restorePending();
  render();
};

const finishTurn = async (message) => {
  pending = null;
  notices = [];
  $("#attach-note").textContent = "";
  turnStatus.textContent = "";
  conversation = {
    conversationId: message.conversationId,
    messages: message.messages,
    signature: message.signature,
  };
  save();
  files = message.files ?? [];
  selectedPath = files.at(-1)?.path ?? null;
  render();
  // The stage's host-files panel shows this conversation's directory.
  await page.refreshHost();
};

const rejectTurn = (message) => {
  restorePending();
  page.stage.handle({ type: "run-finished", status: "refused" });
  page.stage.status("Refused before the run started: no run was created");
  notices.push({
    tone: "error",
    title: `Refused before the run started · ${message.code}${message.reason ? ` (${message.reason})` : ""}`,
    text: `${message.message} No run was created and no model was called.`,
  });
  render();
};

const sendButton = $("#run-button");
const canRun =
  !page.demo.unavailable && page.environment.sandbox.kind !== "none";
const updateSendButton = () => {
  // The first message needs a document; suggestions attach the sample.
  const needsDocument = files.length === 0 && !attachment;
  sendButton.disabled =
    sendButton.dataset.state !== "running" &&
    (!canRun || input.value.trim() === "" || needsDocument);
  sendButton.title = needsDocument ? "Attach a .docx to start" : "";
};
new MutationObserver(updateSendButton).observe(sendButton, {
  attributes: true,
  attributeFilter: ["data-state"],
});
const send = async (text) => {
  if (pending || sendButton.dataset.state === "running") return;
  // A suggestion starts with the sample when there is no document yet.
  if (files.length === 0 && !attachment) {
    await attachSample();
    $("#attach-note").textContent = "Attached the sample proposal.";
  }
  input.value = text;
  updateSendButton();
  if (!sendButton.disabled) sendButton.click();
};
composer.addEventListener("submit", (event) => event.preventDefault());
input.addEventListener("input", updateSendButton);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!sendButton.disabled) sendButton.click();
  }
});

$("#suggestions").replaceChildren(
  ...(page.demo.suggestions ?? []).map((text) =>
    h("button.suggestion", { type: "button", text, onclick: () => send(text) }),
  ),
);

$("#new-conversation").addEventListener("click", async () => {
  if (pending) return;
  conversation = emptyConversation();
  notices = [];
  files = [];
  selectedPath = null;
  save();
  render();
  updateSendButton();
  await page.refreshHost();
});

if (page.demo.unavailable) {
  const banner = $("#unavailable-banner");
  banner.replaceChildren(
    h("strong", { text: "This demo cannot run yet. " }),
    page.demo.unavailable,
  );
  banner.hidden = false;
  sendButton.disabled = true;
  page.stage.status("Needs a newer Agent Runtime");
}

await refreshFiles();
updateSendButton();
render();
