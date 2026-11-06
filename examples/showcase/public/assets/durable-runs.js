/**
 * Durable Runs page. Adds an attempts timeline and a decision panel to the
 * shared stage. A paused run is resumed through the demo's resume endpoint,
 * which starts a new attempt on the server.
 */
import { createDemoPage } from "./lib/demo-page.js";
import { $, h, renderMarkdown } from "./lib/ui.js";

const resultBody = $("#result-body");
const attempts = h("ol.attempts");
const decision = h("div.decision", { hidden: true });
let runId;

// ─── Attempts timeline ───────────────────────────────────────────────────────

const attemptLabel = {
  running: "running",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const pauseLabel = (suspension) =>
  suspension?.reason === "approval"
    ? "paused for approval"
    : suspension?.reason === "token-budget"
      ? "paused: token budget used"
      : "paused";

const setAttempt = (number, status, suspension) => {
  let item = attempts.querySelector(`[data-attempt="${number}"]`);
  if (!item) {
    item = h(
      "li.attempt",
      { dataset: { attempt: number } },
      h("span.dot"),
      h("strong", { text: `Attempt ${number}` }),
      h("span.attempt-status"),
    );
    attempts.append(item);
  }
  item.dataset.status = status;
  item.querySelector(".attempt-status").textContent =
    status === "suspended" ? pauseLabel(suspension) : attemptLabel[status];
};

// ─── Decision panel ──────────────────────────────────────────────────────────

const draftPreview = () => {
  const reports = page.hostState.workspaces?.find(
    (entry) => entry.alias === "reports",
  );
  const draft = reports?.files.find((file) => file.path.endsWith("-draft.md"));
  if (!draft?.content) return null;
  const preview = h("div.markdown.draft-preview");
  renderMarkdown(preview, draft.content);
  return h(
    "div",
    {},
    h("div.caption", { text: `${draft.path}, in the host's reports folder` }),
    preview,
  );
};

const resume = (options) => {
  decision.hidden = true;
  page.stage.divider(`attempt ${(page.state.attempt ?? 1) + 1} · new sandbox`);
  return page.stream(
    `/api/demos/durable-runs/runs/${runId}/resume`,
    {
      pace: Number(document.querySelector('input[name="pace"]:checked').value),
      options,
    },
    { continueRun: true },
  );
};

const showDecision = (pending) => {
  runId = pending.runId;
  const saved = h("p.caption", {
    text: "The run is saved on disk and its sandbox is closed. Nothing is running; you could restart the server now and still continue.",
  });
  if (pending.reason === "approval") {
    decision.replaceChildren(
      h("h3", { text: "Waiting for your approval" }),
      h("p", { text: pending.details.prompt ?? "Approve this step?" }),
      draftPreview(),
      saved,
      h(
        "div.decision-actions",
        {},
        h("button.button.primary", {
          type: "button",
          text: "Approve and resume",
          onclick: () =>
            resume({ decision: "approve", reviewer: $("#reviewer").value }),
        }),
        h("button.button", {
          type: "button",
          text: "Reject",
          onclick: () =>
            resume({ decision: "reject", reviewer: $("#reviewer").value }),
        }),
      ),
    );
  } else if (pending.reason === "token-budget") {
    const used = Number(pending.details.consumedTokens ?? 0);
    const limit = Number(pending.details.maxTotalTokens ?? 0);
    const raised = Math.max(20_000, used * 10);
    decision.replaceChildren(
      h("h3", { text: "Paused: token budget used" }),
      h("p", {
        text: `${used.toLocaleString()} of ${limit.toLocaleString()} tokens used. The run stopped before its next model call; the conversation so far and every tool result are in the saved checkpoint.`,
      }),
      saved,
      h(
        "div.decision-actions",
        {},
        h("button.button.primary", {
          type: "button",
          text: `Raise the limit to ${raised.toLocaleString()} and resume`,
          onclick: () => resume({ maxTotalTokens: raised }),
        }),
      ),
    );
  }
  decision.hidden = false;
};

// ─── Result ──────────────────────────────────────────────────────────────────

const renderResult = () => {
  const { result, status, error } = page.state;
  if (result?.output) {
    const markdown = h("div.markdown");
    renderMarkdown(markdown, result.output);
    resultBody.replaceChildren(markdown);
    return;
  }
  resultBody.replaceChildren(
    h("p.empty", {
      text:
        status === "suspended"
          ? "Nothing is published yet. The run is waiting."
          : status === "failed"
            ? `Nothing was published. ${error ?? ""}`
            : "The published report appears here when the run finishes.",
    }),
  );
};

// ─── Page ────────────────────────────────────────────────────────────────────

const page = await createDemoPage({
  demoId: "durable-runs",
  buildRequest: () => ({ tokenBudget: $("#token-budget").checked }),
  onReset: () => {
    attempts.replaceChildren();
    decision.hidden = true;
    renderResult();
  },
  onEffect: async (effect, state, message) => {
    if (message.kind === "accepted") runId = message.runId;
    switch (effect.type) {
      case "run-started":
        setAttempt(state.attempt, "running");
        break;
      case "approval-requested":
        page.stage.setActivity(effect.stepId, "Asking for approval");
        break;
      case "approval-resolved":
        page.stage.setActivity(
          effect.stepId,
          effect.approved ? "Approved" : "Rejected",
        );
        break;
      case "run-finished":
        setAttempt(state.attempt, effect.status, state.suspension);
        if (effect.status === "suspended") {
          const stepId = state.suspension?.details?.stepId;
          page.stage.setActivity(
            stepId,
            state.suspension?.reason === "approval"
              ? "Waiting for you"
              : "Paused: token budget used",
          );
          const { pending } = await page.refreshHost();
          if (pending) showDecision(pending);
        }
        renderResult();
        break;
      case "result":
        page.refreshHost();
        renderResult();
        break;
      case "error":
        setAttempt(state.attempt, "failed");
        renderResult();
        break;
      default:
        break;
    }
  },
});

page.stage.top.append(attempts, decision);
$("#budget-help").textContent =
  `Also pause when the run has used ${page.demo.tokenBudget.toLocaleString()} tokens. You raise the limit to continue.`;
renderResult();

// A run paused earlier (even before a server restart) can still be resumed.
if (page.hostState.pending) {
  page.stage.status("A paused run was found on disk");
  showDecision(page.hostState.pending);
}
