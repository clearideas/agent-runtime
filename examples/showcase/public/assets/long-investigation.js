/**
 * Long Investigation page: the shared stage, plus a context-window chart fed
 * by the host's per-request measurements and Agent Runtime's
 * `context.reduced` events.
 */
import {
  applyContextMessage,
  createContextState,
  describeReduction,
  kb,
  SEGMENT_KINDS,
} from "./lib/context-state.js";
import { createDemoPage } from "./lib/demo-page.js";
import { $, h, renderMarkdown } from "./lib/ui.js";

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attributes = {}, text) => {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
};

const chart = $("#context-chart");
const legend = $("#context-legend");
const stats = $("#context-stats");
const viewList = $("#view-list");
const viewCaption = $("#view-caption");
const log = $("#context-log");
const strategyChip = $("#context-strategy");
const resultBody = $("#result-body");

let context = createContextState();
let strategies = [];

const selectedStrategy = () =>
  document.querySelector('input[name="strategy"]:checked')?.value;
const strategyLabel = (value) =>
  strategies.find((entry) => entry.value === value)?.label ?? value;

// ─── Chart ───────────────────────────────────────────────────────────────────

const WIDTH = 1000;
const HEIGHT = 300;
const LEFT = 58;
const RIGHT = 16;
const TOP = 18;
const BOTTOM = 34;

/*
 * The chart has four layers. Only the bars layer keeps its elements between
 * renders: a bar is created once, when its request arrives, and animates once.
 * Later renders (a new request that changes the scale, a reduction marker, the
 * end of the run) update bars in place and rebuild only the static layers, so
 * nothing already drawn replays its animation.
 */
const gridLayer = svg("g", { class: "grid-layer" });
const barsLayer = svg("g", { class: "bars-layer" });
const markLayer = svg("g", { class: "mark-layer" });
const labelLayer = svg("g", { class: "label-layer" });
chart.replaceChildren(gridLayer, barsLayer, markLayer, labelLayer);

/** Bar views by request index: the group and one rect per segment. */
const bars = new Map();
let ghost;

const clearChart = () => {
  bars.clear();
  ghost = undefined;
  barsLayer.replaceChildren();
};

const setAttributes = (element, attributes) => {
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
};

const renderChart = () => {
  const limit = context.limit ?? 40_000;
  const reduceTo = page?.demo.reduceTo ?? 0.25;
  const failure = context.failure;
  const count = context.requests.length + (failure ? 1 : 0);
  const top =
    Math.max(limit * 1.15, context.peak * 1.05, (failure?.bytes ?? 0) * 1.05) ||
    1;
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const slots = Math.max(count, 18);
  const slot = plotWidth / slots;
  const barWidth = Math.min(34, slot * 0.68);
  const y = (bytes) => TOP + plotHeight - (bytes / top) * plotHeight;
  const x = (index) => LEFT + slot * index + (slot - barWidth) / 2;

  // ─── Grid, goal, and limit (static) ────────────────────────────────────────
  const grid = [];
  const labels = [];
  for (let bytes = 0; bytes <= top; bytes += 10_000) {
    grid.push(
      svg("line", {
        class: "grid",
        x1: LEFT,
        x2: WIDTH - RIGHT,
        y1: y(bytes),
        y2: y(bytes),
      }),
      svg(
        "text",
        { class: "axis", x: LEFT - 8, y: y(bytes) + 4, "text-anchor": "end" },
        `${bytes / 1000} KB`,
      ),
    );
  }
  if (selectedStrategy() !== "fail" && context.requests.length > 0) {
    grid.push(
      svg("line", {
        class: "goal-line",
        x1: LEFT,
        x2: WIDTH - RIGHT,
        y1: y(limit * reduceTo),
        y2: y(limit * reduceTo),
      }),
    );
    labels.push(
      svg(
        "text",
        {
          class: "goal-label",
          x: WIDTH - RIGHT - 4,
          y: y(limit * reduceTo) - 6,
          "text-anchor": "end",
        },
        `reductions aim for ${Math.round(reduceTo * 100)}%`,
      ),
    );
  }
  grid.push(
    svg("line", {
      class: "limit-line",
      x1: LEFT,
      x2: WIDTH - RIGHT,
      y1: y(limit),
      y2: y(limit),
    }),
  );
  labels.push(
    svg(
      "text",
      { class: "limit-label", x: LEFT + 4, y: y(limit) - 7 },
      `limits.maxInputBytes · ${kb(limit)}`,
    ),
  );

  // ─── Bars (persistent: created once, then updated in place) ─────────────────
  const marks = [];
  let previousStep;
  context.requests.forEach((request, index) => {
    let view = bars.get(request.index);
    if (!view) {
      const group = svg("g", { class: "bar" });
      const rects = request.segments.map((segment) => {
        const rect = svg("rect", { class: `segment seg-${segment.kind}` });
        group.append(rect);
        return rect;
      });
      const title = svg("title");
      group.append(title);
      barsLayer.append(group);
      view = { group, rects, title };
      bars.set(request.index, view);
    }
    let base = 0;
    request.segments.forEach((segment, position) => {
      const height = (segment.bytes / top) * plotHeight;
      setAttributes(view.rects[position], {
        x: x(index),
        y: y(base + segment.bytes),
        width: barWidth,
        height: Math.max(0, height - 0.6),
      });
      base += segment.bytes;
    });
    view.title.textContent = `Request ${request.index}: ${kb(request.bytes)}${
      request.reductions.length
        ? `\n${request.reductions.map((entry) => entry.text).join("\n")}`
        : ""
    }`;
    if (request.reductions.length > 0 || request.summarizerCalls > 0) {
      const summarized = request.reductions.some(
        (entry) => entry.strategy === "summarize",
      );
      marks.push(
        svg(
          "text",
          {
            class: `marker ${summarized ? "marker-summarize" : "marker-prune"}`,
            x: x(index) + barWidth / 2,
            y: y(request.bytes) - 7,
            "text-anchor": "middle",
          },
          summarized ? "Σ" : "✂",
        ),
      );
    }
    if (request.stepId !== previousStep) {
      labels.push(
        svg(
          "text",
          { class: "step-label", x: x(index), y: HEIGHT - 10 },
          request.stepId === "investigate" ? "Investigate" : "Report",
        ),
      );
      previousStep = request.stepId;
    }
  });

  // ─── The request that was never sent (strategy Off) ─────────────────────────
  if (failure) {
    const index = context.requests.length;
    if (!ghost) {
      ghost = svg("rect", { class: "ghost" });
      barsLayer.append(ghost);
    }
    setAttributes(ghost, {
      x: x(index),
      y: y(failure.bytes),
      width: barWidth,
      height: (failure.bytes / top) * plotHeight,
    });
    labels.push(
      svg(
        "text",
        {
          class: "ghost-label",
          x: x(index) + barWidth + 8,
          y: y(failure.bytes) + 30,
        },
        `${kb(failure.bytes)}: over the limit, never sent. The step failed.`,
      ),
    );
  }

  gridLayer.replaceChildren(...grid);
  markLayer.replaceChildren(...marks);
  labelLayer.replaceChildren(...labels);
};

const renderLegend = () =>
  legend.replaceChildren(
    ...SEGMENT_KINDS.map(({ kind, label }) =>
      h(
        "span.legend-item",
        {},
        h(`i.swatch.seg-${kind}`, { "aria-hidden": "true" }),
        label,
      ),
    ),
    h("span.legend-item", {}, h("b.marker-prune", { text: "✂" }), "pruned"),
    h(
      "span.legend-item",
      {},
      h("b.marker-summarize", { text: "Σ" }),
      "summarized",
    ),
  );

// ─── Stats, view, and log ────────────────────────────────────────────────────

const stat = (label, value, tone) =>
  h(
    "div.stat",
    tone ? { dataset: { tone } } : {},
    h("dt", { text: label }),
    h("dd", { text: value }),
  );

const renderStats = () => {
  const limit = context.limit ?? 40_000;
  stats.replaceChildren(
    stat("Requests", String(context.requests.length)),
    stat(
      "Largest request",
      context.peak ? kb(context.peak) : "—",
      context.peak > limit ? "bad" : undefined,
    ),
    stat("Limit", kb(limit)),
    stat("Reductions", String(context.reductions.length)),
    stat("Summarizer calls", String(context.summarizerCalls)),
    stat(
      "Kept out of the model's view",
      context.bytesKeptOut ? kb(context.bytesKeptOut) : "—",
    ),
  );
};

/** A bar whose width is set through CSSOM, which the page's CSP allows. */
const shareBar = (percent) => {
  const bar = h("span.view-bar");
  bar.style.setProperty("--share", `${percent}%`);
  return bar;
};

const renderView = () => {
  const latest = context.requests
    .filter((request) => request.stepId === "investigate")
    .at(-1);
  if (!latest) {
    viewCaption.textContent =
      "The messages of the latest request appear here, sized by bytes.";
    viewList.replaceChildren();
    return;
  }
  viewCaption.textContent = `Request ${latest.index} · ${latest.segments.length} messages · ${kb(latest.bytes)}`;
  const largest = Math.max(...latest.segments.map((segment) => segment.bytes));
  viewList.replaceChildren(
    ...latest.segments.map((segment) =>
      h(
        "li",
        { dataset: { kind: segment.kind } },
        h(`i.swatch.seg-${segment.kind}`, { "aria-hidden": "true" }),
        h("span.view-label", { text: segment.label }),
        h("span.view-size", { text: kb(segment.bytes) }),
        shareBar(Math.max(2, (segment.bytes / largest) * 100)),
      ),
    ),
  );
};

const addLogEntry = (reduction, source = "runtime") => {
  log.querySelector(".empty")?.remove();
  log.append(
    h(
      "li",
      { dataset: { strategy: reduction.strategy ?? "summarize", source } },
      h("span.log-when", { text: `Before request ${reduction.beforeRequest}` }),
      h("span.log-what", { text: reduction.text }),
    ),
  );
  log.scrollTop = log.scrollHeight;
};

const resetContext = () => {
  context = createContextState(page?.demo.limit ?? null);
  clearChart();
  strategyChip.textContent = strategyLabel(selectedStrategy());
  strategyChip.dataset.strategy = selectedStrategy();
  log.replaceChildren(
    h("li.empty", {
      text:
        selectedStrategy() === "fail"
          ? "The strategy is Off: nothing will be reduced."
          : "None yet.",
    }),
  );
  renderChart();
  renderStats();
  renderView();
};

// ─── Result ──────────────────────────────────────────────────────────────────

const renderResult = () => {
  const { result, error } = page.state;
  if (context.failure) {
    resultBody.replaceChildren(
      h(
        "div.failure-explainer",
        {},
        h("strong", { text: "The step failed at its input limit." }),
        h("p", {
          text: `Its next request would have been ${kb(context.failure.bytes)}, over the ${kb(context.failure.limit)} limit. With the strategy Off, Agent Runtime reduces nothing, as before context management existed. Choose Summarize or Prune and run it again.`,
        }),
      ),
    );
    return;
  }
  if (!result) {
    resultBody.replaceChildren(
      h("p.empty", {
        text: error ?? "Choose a context strategy and run the agent.",
      }),
    );
    return;
  }
  const markdown = h("div.markdown");
  renderMarkdown(markdown, result.output ?? "");
  resultBody.replaceChildren(markdown);
};

// ─── Page ────────────────────────────────────────────────────────────────────

let page;
page = await createDemoPage({
  demoId: "long-investigation",
  scrollTarget: "#context-card",
  buildRequest: () => ({ strategy: selectedStrategy() }),
  onReset: () => {
    resetContext();
    renderResult();
  },
  onMessage: (message) => {
    for (const effect of applyContextMessage(context, message)) {
      if (effect.type === "summary") addLogEntry(effect.summary, "summarizer");
      if (effect.type === "reduction") {
        addLogEntry(effect.reduction);
        if (effect.reduction.stepId)
          page.stage.setActivity(
            effect.reduction.stepId,
            describeReduction(effect.reduction),
          );
      }
      if (effect.type === "summarizer" && page.state.steps.size > 0) {
        const running = [...page.state.steps.values()].find(
          (step) => step.state === "running" || step.state === "streaming",
        );
        if (running)
          page.stage.setActivity(running.id, "Summarizer is condensing…");
      }
    }
    // Redraw only for what changes the chart: a new request or a reduction.
    // Text deltas and other events stream by without touching it.
    if (
      message.kind === "model-input" ||
      (message.kind === "event" && message.event?.type === "context.reduced")
    ) {
      renderChart();
      renderStats();
      renderView();
    }
  },
  onEffect: (effect) => {
    if (effect.type === "result" || effect.type === "error") {
      renderChart();
      renderStats();
      renderResult();
    }
  },
});

// An older installed runtime cannot run this demo; say why instead.
if (page.demo.unavailable) {
  const banner = $("#unavailable-banner");
  banner.replaceChildren(
    h("strong", { text: "This demo cannot run yet. " }),
    page.demo.unavailable,
  );
  banner.hidden = false;
  $("#run-button").disabled = true;
  page.stage.status("Needs a newer Agent Runtime");
}

strategies = page.demo.strategies;
const help = $("#strategy-help");
$("#strategies").replaceChildren(
  ...strategies.map((entry, index) =>
    h(
      "label",
      {},
      h("input", {
        type: "radio",
        name: "strategy",
        value: entry.value,
        checked: index === 0,
      }),
      ` ${entry.label}`,
    ),
  ),
);
const showHelp = () => {
  help.textContent =
    strategies.find((entry) => entry.value === selectedStrategy())?.help ?? "";
  if (page.state.status !== "running") resetContext();
};
$("#strategies").addEventListener("change", showHelp);
const material = page.demo.runbookBytes + page.demo.logBytes;
$("#material-size").textContent = `${kb(material)} of material, ${(
  material / page.demo.limit
).toFixed(1)} times the ${kb(page.demo.limit)}`;
renderLegend();
showHelp();
renderResult();
