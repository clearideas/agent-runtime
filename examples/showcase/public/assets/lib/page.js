/** Building blocks shared by every demo page. */
import "./analytics.js";
import { h, highlight } from "./ui.js";
import { isolationBanner } from "./environment-view.js";

export const getJson = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

/** Reflect server capabilities in the top bar and the model selector. */
export const applyEnvironment = (environment) => {
  const { sandbox, live } = environment;
  const chip = document.getElementById("sandbox-chip");
  chip.className = `chip ${sandbox.isolated ? "ok" : "danger"}`;
  chip.replaceChildren(
    h("i"),
    sandbox.isolated
      ? `Sandbox: ${sandbox.kind}`
      : sandbox.kind === "unisolated"
        ? "Not isolated"
        : "No sandbox",
  );
  chip.title = sandbox.detail;
  isolationBanner(document.getElementById("isolation-banner"), environment);

  const liveInput = document.querySelector('input[name="mode"][value="live"]');
  const help = document.getElementById("mode-help");
  if (!liveInput || !help) return;
  if (!live.available) liveInput.disabled = true;
  else {
    // A live model is ready: make the choice visible, not tucked away.
    const field = liveInput.closest(".field");
    document.querySelector(".run-options")?.prepend(field);
    if (localStorage.getItem("showcase.mode") === "live")
      liveInput.checked = true;
  }
  for (const input of document.querySelectorAll('input[name="mode"]'))
    input.addEventListener("change", () =>
      localStorage.setItem("showcase.mode", selectedValue("mode")),
    );
  const describe = () => {
    help.textContent =
      selectedValue("mode") === "live"
        ? `Real model calls to ${live.provider}/${live.model}.`
        : live.available
          ? "Scripted decisions; everything else is real."
          : `Scripted decisions; everything else is real. Live is off: ${live.reason}`;
  };
  for (const input of document.querySelectorAll('input[name="mode"]'))
    input.addEventListener("change", describe);
  describe();
};

/** Tabs that show one panel at a time. */
export const setupTabs = (key, panelAttribute) => {
  const buttons = [...document.querySelectorAll(`[data-${key}]`)];
  const show = (name) => {
    for (const button of buttons)
      button.setAttribute(
        "aria-selected",
        String(button.dataset[key] === name),
      );
    for (const panel of document.querySelectorAll(`[${panelAttribute}]`))
      panel.hidden = panel.getAttribute(panelAttribute) !== name;
  };
  for (const button of buttons)
    button.addEventListener("click", () => show(button.dataset[key]));
};

export const selectedValue = (name) =>
  document.querySelector(`input[name="${name}"]:checked`)?.value;

/** Elapsed-time display. */
export const createTimer = (element) => {
  let started = 0;
  let frame = 0;
  const tick = () => {
    element.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
    frame = requestAnimationFrame(tick);
  };
  return {
    start() {
      cancelAnimationFrame(frame);
      started = performance.now();
      tick();
    },
    stop() {
      cancelAnimationFrame(frame);
    },
    reset() {
      cancelAnimationFrame(frame);
      element.textContent = "0.0s";
    },
  };
};

const family = (type) =>
  type.startsWith("model.tool") ? "tool" : type.split(".")[0];

/** Ordered event log that folds consecutive text deltas into one line. */
export const createEventLog = (list) => {
  let lastDelta;
  return {
    reset() {
      lastDelta = undefined;
      list.replaceChildren();
    },
    add(event) {
      if (
        event.type === "model.text.delta" &&
        lastDelta?.stepId === event.stepId
      ) {
        lastDelta.count += 1;
        lastDelta.type.textContent = `model.text.delta ×${lastDelta.count}`;
        return;
      }
      const type = h(`span.type.${family(event.type)}`, { text: event.type });
      list.append(
        h(
          "li",
          {},
          h("span.seq", { text: event.sequence }),
          type,
          h("span.step-id", { text: event.stepId ?? "" }),
        ),
      );
      lastDelta =
        event.type === "model.text.delta"
          ? { stepId: event.stepId, count: 1, type }
          : undefined;
      while (list.children.length > 500) list.firstElementChild.remove();
    },
  };
};

/** Tabs that show the demo's real source files. */
export const createSourceViewer = async (demoId, sources) => {
  const tabs = document.getElementById("source-tabs");
  const caption = document.getElementById("source-caption");
  const pre = document.getElementById("source");
  const cache = new Map();
  const show = async (source) => {
    for (const button of tabs.children)
      button.setAttribute(
        "aria-selected",
        String(button.dataset.path === source.path),
      );
    caption.textContent = source.caption;
    if (!cache.has(source.path)) {
      const file = await getJson(
        `/api/demos/${demoId}/source?path=${encodeURIComponent(source.path)}`,
      );
      cache.set(source.path, file.text);
    }
    pre.replaceChildren(highlight(cache.get(source.path), source.language));
    pre.scrollTop = 0;
  };
  tabs.replaceChildren(
    ...sources.map((source) =>
      h("button", {
        type: "button",
        role: "tab",
        dataset: { path: source.path },
        text: source.path.split("/").pop(),
        onclick: () => show(source),
      }),
    ),
  );
  const initial =
    sources.find((source) => source.path.endsWith("host.ts")) ?? sources[0];
  if (initial) await show(initial);
};

/** Run button that becomes a cancel button while a run is active. */
export const createRunButton = (
  button,
  label,
  { onRun, onCancel, labels = { idle: "Run agent", running: "Cancel run" } },
) => {
  let running = false;
  button.addEventListener("click", () => (running ? onCancel() : onRun()));
  return {
    set(state) {
      running = state === "running";
      button.dataset.state = running ? "running" : "idle";
      label.textContent = running ? labels.running : labels.idle;
    },
  };
};
