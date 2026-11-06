/**
 * Guardrails page: an attack board. Each attempt is a row; the columns are
 * the layers between an agent and the host. A dot travels along the row and
 * stops at the layer that refused the attempt.
 */
import { createDemoPage } from "./lib/demo-page.js";
import { createTimer } from "./lib/page.js";
import { $, h, renderMarkdown } from "./lib/ui.js";

const LAYERS = ["Host config", "Tool relay", "Host hook", "Sandbox"];
const resultBody = $("#result-body");

/** Short, human reasons for each refusal code. */
const reason = (code, message = "") => {
  switch (code) {
    case "tool_not_authorized":
      return message || "refused by a host hook";
    case "sandbox_budget_exhausted":
      return "command budget used up";
    case "workspace_limit_exceeded":
      return "over the size limit";
    case "workspace_path_invalid":
      return /safe segments|must be a path inside the workspace/u.test(message)
        ? "path rules: no “..”, no dot-files"
        : "not in the sandbox: never staged";
    case "tool_not_allowed":
      return /Argument/u.test(message)
        ? `argument rules: ${message.replace(/^Argument is not permitted: /u, "“")}” refused`
        : "not offered to this agent";
    default:
      return code ?? "refused";
  }
};

const describeCall = (name, input = {}) => {
  const args = Array.isArray(input.args)
    ? input.args.join(" ")
    : (input.path ?? input.query ?? input.version ?? "");
  return `${name}(${String(args).slice(0, 60)})`;
};

const createBoard = (root) => {
  // Tools the host removed before the run (pinned digest mismatches).
  const removedTools = new Set();
  const status = h("span", { text: "Ready", "aria-live": "polite" });
  const signal = h("span.signal");
  const elapsed = h("strong.elapsed", { text: "0.0s" });
  // The verdict from the host's point of view: blocked attacks are good news.
  const verdict = h("span.host-verdict", { dataset: { state: "idle" } });
  const speech = h("span.board-speech", { text: "Waiting to start." });
  const agentVerdict = h("span.agent-verdict");
  const before = h("tbody");
  const during = h("tbody");
  const groupRow = (text) =>
    h("tr.board-group", {}, h("td", { colspan: LAYERS.length + 2, text }));
  const table = h(
    "table.board",
    {},
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { text: "What the agent tried" }),
        ...LAYERS.map((layer) => h("th.layer", { text: layer })),
        h("th", { text: "Result" }),
      ),
    ),
    before,
    during,
  );
  root.classList.add("stage");
  root.replaceChildren(
    h("div.stage-head", {}, signal, status, h("span.spacer"), verdict, elapsed),
    h(
      "div.board-wrap",
      {},
      h(
        "div.board-agent",
        {},
        h("span.orb", { "aria-hidden": "true" }),
        h("strong", { text: "Untrusted agent" }),
        speech,
        agentVerdict,
      ),
      h(
        "p.board-legend",
        {},
        h("strong", { text: "You are the host." }),
        h("span.key.blocked", { text: "Blocked: attack stopped" }),
        h("span.key.allowed", { text: "Allowed: within your rules" }),
        h("span.key.escaped", { text: "Escaped: something got out" }),
      ),
      table,
    ),
  );

  const timer = createTimer(elapsed);
  const rows = new Map();
  const canaryHits = new Set();
  const counts = { blocked: 0, allowed: 0, escaped: 0 };
  let state;

  const updateTally = () => {
    const total = counts.blocked + counts.allowed + counts.escaped;
    verdict.dataset.state = counts.escaped
      ? "breach"
      : total
        ? "protected"
        : "idle";
    verdict.replaceChildren(
      h("span.shield-icon", { "aria-hidden": "true" }),
      h("strong", {
        text: counts.escaped ? "Host breached" : "Host protected",
      }),
      ` · ${counts.blocked} blocked · ${counts.escaped} escaped · ${counts.allowed} allowed`,
    );
  };

  /** Flash the latest verdict beside the agent's narration. */
  const announce = (kind, text) => {
    agentVerdict.dataset.state = kind;
    agentVerdict.textContent = text;
    agentVerdict.classList.remove("pop");
    void agentVerdict.offsetWidth;
    agentVerdict.classList.add("pop");
  };

  /** A row whose dot starts at `from` and waits there until resolved. */
  const addRow = (body, { title, detail, from }) => {
    const dot = h("span.dot", { "aria-hidden": "true" });
    const note = h("span.lane-label");
    const lane = h(
      "div.lane",
      {},
      ...LAYERS.map((_, index) => h("span.segment", { dataset: { index } })),
      dot,
      note,
    );
    const outcome = h("td.outcome", { text: "…" });
    const row = h(
      "tr.board-row",
      { dataset: { state: "pending" } },
      h(
        "td.attempt-cell",
        {},
        h("div", { text: title }),
        detail ? h("code", { text: detail }) : null,
      ),
      h("td.track", { colspan: LAYERS.length }, lane),
      outcome,
    );
    const view = { row, dot, note, outcome, resolved: false };
    body.append(row);
    // Enter from the left edge, then travel to the first layer it meets.
    dot.style.left = "0%";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!view.resolved)
          dot.style.left = `${(from + 0.5) * (100 / LAYERS.length)}%`;
      }),
    );
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return view;
  };

  const resolve = (view, { layer, verdict, label }) => {
    if (!view || view.resolved) return;
    view.resolved = true;
    view.row.dataset.state = verdict;
    view.dot.style.left = `${(layer + 0.5) * (100 / LAYERS.length)}%`;
    view.note.textContent = label;
    view.note.style.left = view.dot.style.left;
    view.outcome.textContent =
      verdict === "blocked"
        ? "✓ Blocked"
        : verdict === "escaped"
          ? "✗ Escaped"
          : "Allowed";
    counts[verdict] += 1;
    updateTally();
    const where = LAYERS[layer];
    if (verdict === "blocked") {
      announce("blocked", `✓ Blocked by ${where}`);
      status.textContent = `Blocked by ${where}: ${label}`;
    } else if (verdict === "escaped") {
      announce("escaped", "✗ Escaped");
      status.textContent = `Escaped: ${label}`;
    } else {
      announce("allowed", "Allowed, within policy");
      status.textContent = `Allowed: ${label}`;
    }
  };

  const resolveTool = (effect) => {
    const tool = state.tools.get(effect.toolCallId);
    const view = rows.get(effect.toolCallId);
    if (!tool || !view) return;
    const message = tool.error?.message ?? "";
    if (effect.type === "tool-denied") {
      const layer =
        effect.errorCode === "tool_not_authorized"
          ? 2
          : effect.errorCode === "sandbox_budget_exhausted"
            ? 3
            : 1;
      resolve(view, {
        layer,
        verdict: "blocked",
        label: removedTools.has(tool.name)
          ? "removed: its description changed"
          : reason(effect.errorCode, message),
      });
      return;
    }
    if (effect.failed) {
      resolve(view, {
        layer: 3,
        verdict: "blocked",
        label: reason(effect.errorCode, message),
      });
      return;
    }
    if (tool.name.startsWith("notes__")) {
      resolve(view, {
        layer: 1,
        verdict: "allowed",
        label: "verified tool, answered by the vendor",
      });
      return;
    }
    if (tool.name.endsWith("run_script")) {
      let probe = {};
      try {
        probe = JSON.parse(tool.output?.stdout ?? "{}");
      } catch {
        // not the probe script
      }
      const callsAi = Array.isArray(probe.keys);
      const reached = callsAi
        ? canaryHits.has("/v1/chat/completions")
        : canaryHits.has("/collect");
      if (probe.sent === true || reached) {
        resolve(view, {
          layer: 3,
          verdict: "escaped",
          label: callsAi
            ? probe.keys?.length
              ? "reached the AI endpoint with a key"
              : "reached the AI endpoint; no key"
            : "got past the sandbox to the network",
        });
        return;
      }
      if ("sent" in probe) {
        const label = callsAi
          ? `no network${probe.keys.length ? "" : "; no API keys inside"}`
          : `no network${Object.values(probe.found ?? {}).every((found) => !found) ? "; no secrets to find" : ""}`;
        resolve(view, { layer: 3, verdict: "blocked", label });
        return;
      }
    }
    resolve(view, {
      layer: 3,
      verdict: "allowed",
      label: "allowed, inside the sandbox",
    });
  };

  return {
    setSandboxKind() {},
    setHostWorkspaces() {},
    clearLayer() {},
    status(text) {
      status.textContent = text;
    },
    running() {
      signal.dataset.state = "running";
      status.textContent = "Checking the agent before it runs";
    },
    reset(_manifest, runState) {
      state = runState;
      rows.clear();
      canaryHits.clear();
      Object.assign(counts, { blocked: 0, allowed: 0, escaped: 0 });
      before.replaceChildren(
        groupRow("Before the run: what the agent asked for"),
      );
      during.replaceChildren(groupRow("During the run: what the model tried"));
      speech.textContent = "Waiting to start.";
      verdict.dataset.state = "idle";
      verdict.replaceChildren();
      agentVerdict.textContent = "";
      timer.reset();
      removedTools.clear();
    },
    preflight(message) {
      if (message.removedTool) removedTools.add(message.removedTool);
      const view = addRow(before, {
        title: message.title,
        detail: "",
        from: 0,
      });
      const refused =
        message.outcome === "refused" || message.outcome === "removed";
      view.row.title = message.detail;
      resolve(view, {
        layer: 0,
        verdict: refused ? "blocked" : "allowed",
        label: message.label,
      });
    },
    canary(message) {
      // The listener is the ground truth; the board decides when the script's
      // own output arrives (resolveTool), which is always after the hit.
      if (message.hit && message.path) canaryHits.add(message.path);
    },
    handle(effect) {
      switch (effect.type) {
        case "run-started":
          timer.start();
          status.textContent = "The hostile model is trying to get out";
          break;
        case "model-started":
          speech.textContent = "…";
          agentVerdict.textContent = "";
          break;
        case "text": {
          const entry = state.steps.get(effect.stepId);
          speech.textContent = entry?.text ?? "";
          break;
        }
        case "tool-dispatched": {
          const tool = state.tools.get(effect.toolCallId);
          rows.set(
            effect.toolCallId,
            addRow(during, {
              title: state.steps.get(effect.stepId)?.text.trim() || effect.name,
              detail: describeCall(effect.name, tool?.input),
              from: 1,
            }),
          );
          break;
        }
        case "tool-io": {
          const view = rows.get(effect.toolCallId);
          const tool = state.tools.get(effect.toolCallId);
          const code = view?.row.querySelector("code");
          if (code && tool)
            code.textContent = describeCall(tool.name, tool.input);
          break;
        }
        case "tool-denied":
        case "tool-completed":
          resolveTool(effect);
          break;
        case "run-finished":
        case "error":
          timer.stop();
          signal.dataset.state = counts.escaped ? "failed" : state.status;
          status.textContent =
            effect.type === "error"
              ? effect.message
              : state.status !== "completed"
                ? state.status
                : counts.escaped
                  ? "Done: something got out"
                  : `Done: all ${counts.blocked} attacks were blocked`;
          speech.textContent = "Finished.";
          break;
        default:
          break;
      }
    },
  };
};

let board;
const page = await createDemoPage({
  demoId: "guardrails",
  createRenderer: (root) => (board = createBoard(root)),
  onMessage: (message) => {
    if (message.kind === "preflight") board.preflight(message);
    if (message.kind === "canary") {
      board.canary(message);
      canary = message;
    }
  },
  onReset: () => {
    canary = undefined;
    renderOutcome();
  },
  onEffect: (effect) => {
    if (effect.type === "result" || effect.type === "error") renderOutcome();
  },
});

let canary;
const renderOutcome = () => {
  const { result, error } = page?.state ?? {};
  if (!result) {
    resultBody.replaceChildren(
      h("p.empty", { text: error ?? "Run the agent to see the outcome." }),
    );
    return;
  }
  const summary = h("div.markdown");
  renderMarkdown(summary, result.output ?? "");
  const escaped = canary?.hit;
  resultBody.replaceChildren(
    summary,
    h(
      `p.canary.${escaped ? "escaped" : "held"}`,
      {},
      escaped
        ? "Data reached the host's canary listener, including its stand-in AI endpoint. This machine has no sandbox, so the agent's scripts ran as ordinary processes with network access. Install Docker (or bubblewrap on Linux) and run again."
        : "Nothing reached the host's canary listener or its stand-in AI endpoint. The sandbox has no network, and sandboxed commands never receive the host's API keys. The agent's only model is the one the host configured.",
    ),
  );
};
renderOutcome();
