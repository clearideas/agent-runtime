/**
 * Durable Runs page. Adds an attempts timeline, a decision panel, agent
 * edits, and restart points to the shared stage. A paused run is resumed
 * through the demo's resume endpoint, which starts a new attempt on the
 * server; a restart starts a new run from a step's checkpoint.
 */
import { createDemoPage } from "./lib/demo-page.js";
import { selectedValue } from "./lib/page.js";
import { $, h, renderMarkdown } from "./lib/ui.js";

const resultBody = $("#result-body");
const historyBody = $("#history-body");
const editSelect = $("#edit");
const attempts = h("ol.attempts");
const decision = h("div.decision", { hidden: true });
let runId;
let busy = false;

const stepName = (stepId) =>
  page.demo.manifest.steps.find((step) => step.id === stepId)?.name ?? stepId;
const shortId = (id) => `${String(id).slice(0, 13)}…`;
const selectedEdit = () => editSelect.value || undefined;
const editLabel = () =>
  page.demo.edits.find((edit) => edit.id === editSelect.value)?.label;

// ─── Attempts timeline ───────────────────────────────────────────────────────

const attemptLabel = {
  running: "running",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const pauseLabel = (suspension) => {
  if (suspension?.reason === "approval") return "paused for approval";
  if (suspension?.reason === "blocked")
    return suspension.details?.cause === "limit"
      ? "blocked: token limit"
      : "blocked: provider error";
  return "paused";
};

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

// ─── What an edit does ───────────────────────────────────────────────────────

const outcomeText = {
  unchanged: "No change",
  accepted: "Accepted",
  "restarts-step": "Step runs again",
  refused: "Refused",
};

const outcomeBadge = (assessment) =>
  h("span.outcome-badge", {
    dataset: { outcome: assessment.outcome },
    text: outcomeText[assessment.outcome] ?? assessment.outcome,
  });

/**
 * Whether the agent as selected differs from the one a checkpoint was written
 * with. Going back to "As written" after resuming with an edit is a change too.
 */
const differs = (assessment) =>
  Boolean(assessment) &&
  (Boolean(selectedEdit()) || assessment.outcome !== "unchanged");

/** The selected agent's consequence for a resume or restart, in one line. */
const assessmentLine = (assessment) =>
  differs(assessment)
    ? h(
        "p.assessment",
        {},
        outcomeBadge(assessment),
        h("span", { text: assessment.reason }),
      )
    : null;

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

const streamBody = (options) => ({
  mode: selectedValue("mode") ?? "scripted",
  pace: Number(selectedValue("pace") ?? 2),
  options: { ...options, ...(selectedEdit() ? { edit: selectedEdit() } : {}) },
});

const resume = (options) => {
  decision.hidden = true;
  page.stage.divider(`attempt ${(page.state.attempt ?? 1) + 1} · new sandbox`);
  return page.stream(
    `/api/demos/durable-runs/runs/${runId}/resume`,
    streamBody(options),
    { continueRun: true },
  );
};

const ledgerCaption = () => {
  const ledger = page.hostState.history?.ledger;
  if (!ledger) return null;
  return h("p.caption", {
    text: `Saved with the run: ${ledger.tokens.toLocaleString()} tokens used${ledger.recoveries ? `, ${ledger.recoveries} recover${ledger.recoveries === 1 ? "y" : "ies"} so far` : ""}.`,
  });
};

const showDecision = (pending) => {
  runId = pending.runId;
  const assessment = page.hostState.resumeAssessment;
  const refused = assessment?.outcome === "refused";
  const saved = h("p.caption", {
    text: "The run is saved on disk and its sandbox is closed. Nothing is running; you could restart the server now and still continue.",
  });
  const action = (text, options, primary = true) =>
    h(`button.button${primary ? ".primary" : ""}`, {
      type: "button",
      text,
      disabled: refused,
      onclick: () => resume(options),
    });
  const edited = differs(assessment)
    ? h(
        "div.edit-note",
        {},
        h("strong", {
          text: selectedEdit()
            ? `With your edit: ${editLabel()}`
            : "With the agent as written",
        }),
        assessmentLine(assessment),
        refused
          ? h("p.caption", {
              text: page.hostState.history?.restartPoints.some(
                (point) => point.assessment.outcome !== "refused",
              )
                ? "Restart from a step before the change, below, or run the agent again with this edit."
                : "Run the agent again to use this edit: a new run starts from the edited agent.",
            })
          : null,
      )
    : null;
  const reviewer = () => $("#reviewer").value;
  let heading;
  let body;
  let actions;
  if (pending.reason === "approval") {
    heading = "Waiting for your approval";
    body = [
      h("p", { text: pending.details.prompt ?? "Approve this step?" }),
      draftPreview(),
    ];
    actions = [
      action("Approve and resume", {
        decision: "approve",
        reviewer: reviewer(),
      }),
      action("Reject", { decision: "reject", reviewer: reviewer() }, false),
    ];
  } else if (pending.details.cause === "limit") {
    const used = Number(pending.details.used ?? 0);
    const limit = Number(pending.details.value ?? 0);
    const raised = Math.max(20_000, used * 10);
    heading = "Blocked: token limit reached";
    body = [
      h("p", {
        text: `${used.toLocaleString()} of ${limit.toLocaleString()} tokens used. The run stopped before its next model call; the conversation so far and every tool result are in the saved checkpoint.`,
      }),
    ];
    actions = [
      action(`Raise the limit to ${raised.toLocaleString()} and resume`, {
        maxTotalTokens: raised,
      }),
    ];
  } else {
    const error = pending.details.error ?? {};
    heading = `Blocked: ${stepName(pending.details.stepId)} failed`;
    body = [
      h("p", {
        text: `${error.message ?? "The step failed."} ${error.retryable ? "The step retried, then the run" : "The run"} was saved instead of failed. Resuming runs the step again; nothing before it is repeated.`,
      }),
    ];
    actions = [
      action(
        error.code === "MODEL_PROVIDER_UNAVAILABLE"
          ? "The provider is back: resume"
          : "Resume",
        {},
      ),
    ];
  }
  decision.replaceChildren(
    ...[
      h("h3", { text: heading }),
      ...body,
      saved,
      pending.details.cause === "limit" ? null : ledgerCaption(),
      edited,
      h("div.decision-actions", {}, ...actions),
    ].filter(Boolean),
  );
  decision.hidden = false;
};

// ─── Restart points ──────────────────────────────────────────────────────────

/** Run options a new run or a restart takes from the toggles. */
const runOptions = () => ({
  tokenLimit: $("#token-limit").checked,
  outage: $("#outage").checked,
});

const restart = (point) =>
  page.stream(
    "/api/demos/durable-runs/runs",
    streamBody({
      ...runOptions(),
      restartFrom: {
        runId: page.hostState.history.runId,
        sequence: point.sequence,
      },
    }),
  );

const renderHistory = () => {
  const history = page.hostState.history;
  if (!history) {
    historyBody.replaceChildren(
      h("p.empty", {
        text: "Each step that completes is a restart point. Run the agent to create some.",
      }),
    );
    return;
  }
  const seeded = history.seededFrom
    ? ` · restarted from ${shortId(history.seededFrom.runId)} after ${stepName(history.seededFrom.stepPath)}`
    : "";
  const points = history.restartPoints.map((point) => {
    const refused = point.assessment.outcome === "refused";
    return h(
      "li.restart-point",
      {},
      h(
        "div.restart-head",
        {},
        h("strong", { text: `After ${stepName(point.stepId)}` }),
        h("span.caption-inline", { text: `checkpoint ${point.sequence}` }),
        h("span.spacer"),
        h("button.button", {
          type: "button",
          text: "Restart from here",
          disabled: busy || refused,
          onclick: () => restart(point),
        }),
      ),
      h(
        "p.snapshot",
        {},
        point.snapshot
          ? `reports folder snapshot: ${point.snapshot.files.join(", ")}`
          : "no workspace snapshot",
      ),
      assessmentLine(point.assessment),
    );
  });
  historyBody.replaceChildren(
    h("p.caption", {
      text: `Run ${shortId(history.runId)} · ${history.status} · ${history.attempts} attempt${history.attempts === 1 ? "" : "s"}${history.ledger ? ` · ${history.ledger.tokens.toLocaleString()} tokens` : ""}${seeded}`,
    }),
    ...(points.length
      ? [
          h("ol.restart-points", {}, ...points),
          h("p.caption", {
            text: "A restart is a new run from the step's checkpoint: completed steps are not repeated, usage starts at zero, and the reports folder is put back as it was when the step completed.",
          }),
        ]
      : [h("p.empty", { text: "No step has completed yet." })]),
  );
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
  stateQuery: () =>
    editSelect.value ? `?edit=${encodeURIComponent(editSelect.value)}` : "",
  buildRequest: () => ({
    ...runOptions(),
    ...(selectedEdit() ? { edit: selectedEdit() } : {}),
  }),
  onReset: () => {
    attempts.replaceChildren();
    decision.hidden = true;
    renderResult();
  },
  onEffect: async (effect, state, message) => {
    if (message.kind === "accepted") {
      runId = message.runId;
      busy = true;
      renderHistory();
    }
    if (
      effect.type === "event" &&
      effect.event.type === "diagnostic" &&
      effect.event.data?.code === "STEP_RESTARTED_AFTER_MANIFEST_CHANGE"
    )
      page.stage.divider(
        `${stepName(effect.event.stepId)} changed · it runs again from its start`,
      );
    switch (effect.type) {
      case "run-started": {
        const seededFrom = message.event?.data?.seededFrom;
        if (seededFrom) {
          // The new run starts after the restart point's step; the steps
          // before it completed in the earlier run.
          attempts.append(
            h(
              "li.attempt",
              { dataset: { status: "restored" } },
              h("span.dot"),
              h("strong", { text: `From ${shortId(seededFrom.runId)}` }),
              h("span.attempt-status", {
                text: `restarted after ${stepName(seededFrom.stepPath)}`,
              }),
            ),
          );
          const startAt = Number(message.event.data.startStepIndex ?? 0);
          for (const step of page.demo.manifest.steps.slice(0, startAt)) {
            state.steps.set(step.id, {
              id: step.id,
              state: "complete",
              text: "",
              modelCalls: 0,
            });
            page.stage.setActivity(step.id, "Done in the earlier run");
          }
        }
        setAttempt(state.attempt, "running");
        break;
      }
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
        busy = false;
        setAttempt(state.attempt, effect.status, state.suspension);
        if (effect.status === "suspended") {
          // Run-wide limits name no step; the step that was running paused.
          const stepId =
            state.suspension?.details?.stepId ??
            [...state.steps.values()].find((entry) => entry.state === "paused")
              ?.id;
          page.stage.setActivity(
            stepId,
            state.suspension?.reason === "approval"
              ? "Waiting for you"
              : pauseLabel(state.suspension).replace(/^./u, (first) =>
                  first.toUpperCase(),
                ),
          );
          await page.refreshHost();
          if (page.hostState.pending) showDecision(page.hostState.pending);
        } else {
          await page.refreshHost();
        }
        renderHistory();
        renderResult();
        break;
      case "result":
        busy = false;
        await page.refreshHost();
        renderHistory();
        renderResult();
        break;
      case "error":
        busy = false;
        await page.refreshHost();
        renderHistory();
        // A refused resume leaves the run paused: offer the decision again.
        if (page.hostState.pending?.runId === runId)
          showDecision(page.hostState.pending);
        else setAttempt(state.attempt, "failed");
        renderResult();
        break;
      default:
        break;
    }
  },
});

// ─── Controls ────────────────────────────────────────────────────────────────

for (const edit of page.demo.edits)
  editSelect.append(h("option", { value: edit.id, text: edit.label }));
const showEditHelp = () => {
  const edit = page.demo.edits.find((entry) => entry.id === editSelect.value);
  $("#edit-help").textContent = edit
    ? `Changes ${edit.detail}. Applies to the next run, resume, or restart.`
    : "The agent as written in agent.yaml.";
};
editSelect.addEventListener("change", async () => {
  showEditHelp();
  await page.refreshHost();
  renderHistory();
  if (page.hostState.pending && !decision.hidden)
    showDecision(page.hostState.pending);
});
showEditHelp();

page.stage.top.append(attempts, decision);
$("#limit-help").textContent =
  `Grant only ${page.demo.tokenLimit.toLocaleString()} tokens: the run is blocked while drafting until you raise the limit.`;
renderResult();
renderHistory();

// A run paused earlier (even before a server restart) can still be resumed.
if (page.hostState.pending) {
  page.stage.status("A paused run was found on disk");
  showDecision(page.hostState.pending);
}
