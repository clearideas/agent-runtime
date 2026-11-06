/**
 * Repo Mechanic page. The shared stage animates the run; this file adds the
 * options and the result (pull-request summary and file diff).
 */
import { diffLines, hunk } from "./lib/diff.js";
import { createDemoPage } from "./lib/demo-page.js";
import { $, h, renderMarkdown } from "./lib/ui.js";

let resultTab = "report";
const resultBody = $("#result-body");

const renderDiff = (workspaces) => {
  const changed = workspaces
    .flatMap((workspace) => workspace.files)
    .filter(
      (file) => file.baseline !== undefined && file.content !== undefined,
    );
  if (changed.length === 0)
    return h("p.empty", { text: "No files have changed." });
  return h(
    "div",
    {},
    ...changed.map((file) =>
      h(
        "div.diff",
        {},
        h("div.diff-file", { text: file.path }),
        ...hunk(diffLines(file.baseline, file.content)).map((line) =>
          h(
            `div.diff-line.${line.type}`,
            {},
            h("span.n", { text: line.number ?? "" }),
            h("span", {
              text:
                line.type === "add" ? "+" : line.type === "remove" ? "−" : " ",
            }),
            h("span", { text: line.text }),
          ),
        ),
      ),
    ),
  );
};

const renderResult = () => {
  for (const button of document.querySelectorAll("[data-result-tab]"))
    button.setAttribute(
      "aria-selected",
      String(button.dataset.resultTab === resultTab),
    );
  if (resultTab === "diff") {
    resultBody.replaceChildren(renderDiff(page.hostState.workspaces ?? []));
    return;
  }
  const { result, error } = page.state;
  if (!result) {
    resultBody.replaceChildren(
      h("p.empty", {
        text: error ?? "Run the agent to see its pull-request summary.",
      }),
    );
    return;
  }
  const markdown = h("div.markdown");
  renderMarkdown(markdown, result.output ?? "");
  resultBody.replaceChildren(markdown);
};

/** The Verify code step has no model text; show its test result instead. */
const showVerification = (state) => {
  const command = [...state.commands.values()].find(
    (entry) => entry.kind === "code",
  );
  try {
    const parsed = JSON.parse(state.result?.state?.verification ?? "");
    const text = parsed.passed
      ? `${parsed.testsRun} tests passed`
      : `${parsed.failed.length} of ${parsed.testsRun} tests failed`;
    const line = command ? page.stage.termLines.get(command.id) : undefined;
    if (line) line.result.textContent = text;
    const view = page.stage.stepViews.get("verify");
    if (view) {
      view.activity.textContent = `Done · ${text}`;
      view.card.dataset.outcome = parsed.passed ? "passed" : "failed";
    }
  } catch {
    // Verification did not run.
  }
};

const page = await createDemoPage({
  demoId: "repo-mechanic",
  stageOptions: { skippedText: () => "Skipped: nothing to fix" },
  buildRequest: () => ({
    issue: $("#issue").value,
    allowWrites: $("#allow-writes").checked,
    resetWorkspace: $("#reset-workspace").checked,
  }),
  onReset: () => {
    resultTab = "report";
    renderResult();
  },
  onEffect: (effect, state, message) => {
    if (message.kind === "accepted" && $("#reset-workspace").checked)
      page.refreshHost();
    if (effect.type === "result") {
      showVerification(state);
      page.refreshHost().then(renderResult);
    }
    if (effect.type === "error") {
      if (
        state.sandboxKind === "unisolated" &&
        /snapshot|helper/u.test(effect.message)
      )
        page.stage.status(
          `${effect.message} The terminal running npm start shows the details.`,
        );
      renderResult();
    }
  },
});

for (const button of document.querySelectorAll("[data-result-tab]")) {
  button.addEventListener("click", () => {
    resultTab = button.dataset.resultTab;
    renderResult();
  });
}
renderResult();
