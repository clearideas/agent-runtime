/**
 * Orchestration page: the manifest as a graph of execution waves. Nodes light
 * up from the event stream; loop nodes show their iterations; the engine strip
 * shows where the agent runs.
 */
import { createDemoPage } from "./lib/demo-page.js";
import { createTimer, selectedValue } from "./lib/page.js";
import { $, anchor, h, renderMarkdown, sendPacket } from "./lib/ui.js";

const resultBody = $("#result-body");
const timings = {};

// ─── The graph, from the manifest ────────────────────────────────────────────

const templateReads = (text = "") =>
  [...String(text).matchAll(/\{\{\s*([A-Za-z_][\w-]*)/gu)].map(
    (match) => match[1],
  );

/** Variables a step reads, including inside loops. */
const readsOf = (step) => [
  ...templateReads(step.prompt),
  ...templateReads(step.systemPrompt),
  ...templateReads(step.when),
  ...(step.loop?.source ? [step.loop.source] : []),
  ...templateReads(step.loop?.goal),
  ...(step.steps ?? []).flatMap(readsOf),
];

const writesOf = (step) => [
  ...(step.outputVariable ? [step.outputVariable] : []),
  ...(step.steps ?? []).flatMap(writesOf),
];

/**
 * Group steps into waves the way the runtime schedules them in parallel mode:
 * adjacent prompt steps without tools that do not read each other's outputs.
 */
export const executionWaves = (steps) => {
  const waves = [];
  let current = [];
  const flush = () => {
    if (current.length) waves.push(current);
    current = [];
  };
  for (const step of steps) {
    const parallelizable = step.type === "prompt" && !step.tools?.length;
    const dependsOnCurrent = current.some((other) =>
      writesOf(other).some((variable) => readsOf(step).includes(variable)),
    );
    if (!parallelizable) {
      flush();
      waves.push([step]);
    } else if (dependsOnCurrent) {
      flush();
      current = [step];
    } else current.push(step);
  }
  flush();
  return waves;
};

/** Edges from the step that writes a variable to each later step that reads it. */
const dependencyEdges = (steps) => {
  const edges = [];
  steps.forEach((step, index) => {
    const own = new Set(writesOf(step));
    for (const variable of new Set(readsOf(step))) {
      if (own.has(variable)) continue;
      const producer = steps
        .slice(0, index)
        .reverse()
        .find((candidate) => writesOf(candidate).includes(variable));
      if (
        producer &&
        !edges.some((edge) => edge.from === producer.id && edge.to === step.id)
      )
        edges.push({ from: producer.id, to: step.id });
    }
  });
  return edges;
};

const kindOf = (step) =>
  step.type === "loop"
    ? step.loop.goal
      ? `loop · until ${step.loop.goal.replace(/\s*==\s*true/u, "")}`
      : `loop · each ${step.loop.source.replace(/s$/u, "")}`
    : step.when
      ? `when ${step.when}`
      : "prompt";

// ─── Renderer ────────────────────────────────────────────────────────────────

const createGraph = (root) => {
  const status = h("span", { text: "Ready", "aria-live": "polite" });
  const signal = h("span.signal");
  const elapsed = h("strong.elapsed", { text: "0.0s" });
  const comparison = h("span.stage-extra");
  const engineStrip = h("div.engine-strip");
  const columns = h("div.graph-columns");
  const edgesSvg = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  edgesSvg.classList.add("graph-edges");
  const layer = h("div.flow-layer", { "aria-hidden": "true" });
  const graph = h("div.graph", {}, edgesSvg, columns, layer);
  root.classList.add("stage");
  root.replaceChildren(
    h(
      "div.stage-head",
      {},
      signal,
      status,
      h("span.spacer"),
      comparison,
      elapsed,
    ),
    h("div.graph-wrap", {}, engineStrip, graph),
  );

  const timer = createTimer(elapsed);
  const nodes = new Map();
  let edges = [];
  let state;
  let engineInfo;
  let lastPacket = 0;

  const drawEdges = () => {
    const frame = graph.getBoundingClientRect();
    edgesSvg.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
    edgesSvg.replaceChildren(
      ...edges.map((edge) => {
        const from = anchor(nodes.get(edge.from).card, graph, "right");
        const to = anchor(nodes.get(edge.to).card, graph, "left");
        const middle = (from.x + to.x) / 2;
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute(
          "d",
          `M ${from.x} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`,
        );
        const source = nodes.get(edge.from).card.dataset.state;
        const target = nodes.get(edge.to).card.dataset.state;
        path.dataset.state =
          source === "complete" && ["running", "streaming"].includes(target)
            ? "active"
            : source === "complete" && ["complete", "skipped"].includes(target)
              ? "done"
              : "idle";
        return path;
      }),
    );
  };

  const renderEngine = () => {
    const remote = engineInfo?.engine === "http-worker";
    const worker = engineInfo?.providerData;
    engineStrip.dataset.remote = String(remote);
    const parts = [
      h(
        "div.engine-box",
        {},
        h("strong", { text: "This server" }),
        h("small", {
          text: remote
            ? "ExecutionClient · control plane"
            : "ExecutionClient · in-process engine",
        }),
      ),
      remote
        ? h(
            "div.engine-link",
            {},
            h("span", { text: "invocation →" }),
            h("span", { text: "← events" }),
          )
        : null,
      remote
        ? h(
            "div.engine-box.worker",
            {},
            h("strong", {
              text: `Worker process${worker?.pid ? ` · pid ${worker.pid}` : ""}`,
            }),
            h("small", {
              text: worker?.worker ?? "separate process over HTTP",
            }),
          )
        : null,
    ];
    engineStrip.replaceChildren(...parts.filter(Boolean));
  };

  /** One packet per step-level event from the worker, never per text token. */
  const workerPacket = (event) => {
    if (engineInfo?.engine !== "http-worker") return;
    if (!/^(step|loop|run)\./u.test(event.type)) return;
    const now = performance.now();
    if (now - lastPacket < 120) return;
    lastPacket = now;
    const from = engineStrip.querySelector(".worker");
    const to = engineStrip.querySelector(".engine-box");
    if (from && to)
      sendPacket(
        layer,
        anchor(from, graph, "left"),
        anchor(to, graph, "right"),
        {
          tone: "violet",
          duration: 600,
        },
      );
  };

  const setNode = (stepId, nodeState, text) => {
    const node = nodes.get(stepId);
    if (!node) return;
    node.card.dataset.state = nodeState;
    if (text) node.activity.textContent = text;
    drawEdges();
  };

  const childOf = (stepPath = "") => stepPath.split("/")[0];

  return {
    setSandboxKind() {},
    setHostWorkspaces() {},
    clearLayer() {
      layer.replaceChildren();
      drawEdges();
    },
    status(text) {
      status.textContent = text;
    },
    setEngine(info) {
      engineInfo = info;
      renderEngine();
    },
    setComparison() {
      const parts = ["sequential", "parallel"]
        .filter((mode) => timings[mode])
        .map((mode) => `${mode} ${timings[mode].toFixed(1)}s`);
      comparison.textContent = parts.length
        ? `Last runs: ${parts.join(" · ")}`
        : "";
    },
    running() {
      signal.dataset.state = "running";
      status.textContent = "Submitting";
    },
    reset(manifest, runState) {
      state = runState;
      nodes.clear();
      const steps = manifest.steps;
      edges = dependencyEdges(steps);
      columns.replaceChildren(
        ...executionWaves(steps).map((wave) =>
          h(
            "div.graph-column",
            { dataset: { parallel: String(wave.length > 1) } },
            ...wave.map((step) => {
              const activity = h("div.node-activity", { text: "Waiting" });
              const progress = h("div.node-progress");
              if (step.type === "loop" && step.loop.source) {
                const items =
                  manifest.variables?.find(
                    (variable) => variable.key === step.loop.source,
                  )?.value ?? [];
                progress.replaceChildren(
                  ...items.map((item) =>
                    h("span.iteration", { title: item, text: item }),
                  ),
                );
              }
              const card = h(
                "article.node",
                { dataset: { state: "waiting", type: step.type } },
                h("strong", { text: step.name ?? step.id }),
                h("div.node-kind", { text: kindOf(step), title: kindOf(step) }),
                activity,
                progress,
              );
              nodes.set(step.id, { card, activity, progress, step, passes: 0 });
              return card;
            }),
          ),
        ),
      );
      layer.replaceChildren();
      engineInfo = undefined;
      renderEngine();
      timer.reset();
      requestAnimationFrame(drawEdges);
    },
    handle(effect) {
      const event = effect.event;
      switch (effect.type) {
        case "run-started":
          timer.start();
          status.textContent = "Running";
          break;
        case "step": {
          const entry = state.steps.get(effect.stepId);
          const node = nodes.get(effect.stepId);
          if (!node) break; // a child step inside a loop
          const text = {
            running: node.step.type === "loop" ? "Looping" : "Running",
            complete:
              node.step.type === "loop" && node.step.loop.goal
                ? `Done · goal met on pass ${node.passes}`
                : "Done",
            skipped: "Skipped: condition was false",
            failed: entry.error?.message ?? "Failed",
          }[entry.state];
          setNode(effect.stepId, entry.state, text);
          const running = [...nodes.values()].filter(
            (view) =>
              view.card.dataset.state === "running" ||
              view.card.dataset.state === "streaming",
          );
          if (running.length > 1)
            status.textContent = `${running.length} steps running in parallel`;
          else if (running.length === 1)
            status.textContent = running[0].step.name ?? running[0].step.id;
          break;
        }
        case "text": {
          if (nodes.has(effect.stepId)) {
            setNode(effect.stepId, "streaming", "Writing…");
          }
          break;
        }
        case "loop": {
          const node = nodes.get(effect.stepId);
          if (!node) break;
          const iteration = Number(effect.data.iteration ?? 0);
          if (effect.event === "loop.iteration.started") {
            node.passes = iteration;
            if (node.step.loop.source) {
              const dot = node.progress.children[iteration - 1];
              dot?.setAttribute("data-state", "running");
              node.activity.textContent = `Item ${iteration} of ${node.progress.children.length}`;
            } else {
              node.activity.textContent = `Pass ${iteration}`;
              node.progress.append(
                h("span.pass", {
                  text: String(iteration),
                  dataset: { state: "running" },
                }),
              );
            }
          }
          if (effect.event === "loop.iteration.completed") {
            const marker = node.step.loop.source
              ? node.progress.children[iteration - 1]
              : node.progress.lastElementChild;
            // A goal loop pass that did not meet the goal means another try.
            if (marker?.getAttribute("data-state") !== "goal")
              marker?.setAttribute(
                "data-state",
                node.step.loop.goal ? "retry" : "complete",
              );
          }
          if (effect.event === "loop.goal.met") {
            node.progress.lastElementChild?.setAttribute("data-state", "goal");
            node.activity.textContent = `Goal met on pass ${iteration}`;
          }
          break;
        }
        case "run-finished":
        case "error":
          timer.stop();
          signal.dataset.state = state.status;
          status.textContent =
            effect.type === "error"
              ? effect.message
              : state.status === "completed"
                ? "Done"
                : state.status;
          drawEdges();
          break;
        case "event": {
          workerPacket(event);
          // Children inside loops report their own step id and a stepPath.
          const parent = nodes.get(childOf(event.stepPath));
          if (
            parent &&
            event.stepId !== parent.step.id &&
            event.type === "step.started"
          ) {
            const child = parent.step.steps?.find(
              (candidate) => candidate.id === event.stepId,
            );
            if (child && parent.step.loop.goal)
              parent.activity.textContent = `Pass ${parent.passes}: ${child.name ?? child.id}`;
          }
          break;
        }
        default:
          break;
      }
    },
  };
};

// ─── Page ────────────────────────────────────────────────────────────────────

let graph;
let startedAt = 0;
const page = await createDemoPage({
  demoId: "orchestration",
  createRenderer: (root) => (graph = createGraph(root)),
  buildRequest: () => ({
    engine: selectedValue("engine"),
    scheduling: selectedValue("scheduling"),
    regulatedMarket: $("#regulated").checked,
  }),
  onMessage: (message) => {
    if (message.kind === "engine") graph.setEngine(message);
    if (message.kind === "accepted") startedAt = performance.now();
  },
  onReset: () => renderPlan(),
  onEffect: (effect, state) => {
    if (effect.type === "run-finished" && state.status === "completed") {
      timings[selectedValue("scheduling")] =
        (performance.now() - startedAt) / 1000;
      graph.setComparison();
    }
    if (effect.type === "result" || effect.type === "error") renderPlan();
  },
});

function renderPlan() {
  const { result, error } = page?.state ?? {};
  if (!result) {
    resultBody.replaceChildren(
      h("p.empty", { text: error ?? "Run the agent to see its launch plan." }),
    );
    return;
  }
  const markdown = h("div.markdown");
  renderMarkdown(markdown, result.output ?? "");
  resultBody.replaceChildren(markdown);
}
renderPlan();
