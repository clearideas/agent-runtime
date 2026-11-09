/**
 * Wiring shared by every demo page: environment, run button, streaming,
 * host-file refresh, and the "Under the hood" panel. Pages supply what makes
 * them different: the request body, extra effects, and how to show results.
 */
import {
  applyEnvironment,
  createEventLog,
  createRunButton,
  createSourceViewer,
  getJson,
  selectedValue,
  setupTabs,
} from "./page.js";
import { applyMessage, createRunState } from "./run-state.js";
import { createStage } from "./stage.js";
import { streamRun } from "./stream.js";
import { $, formatDuration, h } from "./ui.js";

export const createDemoPage = async ({
  demoId,
  stageOptions = {},
  buildRequest,
  onEffect = () => {},
  onReset = () => {},
  /** Replace the shared stage with a page-specific view (same interface). */
  createRenderer,
  /** Every raw stream message, including host-specific kinds. */
  onMessage = () => {},
  /** The element scrolled into view when a run starts. */
  scrollTarget = "#stage",
  /** Run button labels, for pages where "Run agent" does not fit. */
  runLabels,
  /** Query string for the host-state request, such as "?conversation=…". */
  stateQuery = () => "",
}) => {
  const [environment, demo] = await Promise.all([
    getJson("/api/environment"),
    getJson(`/api/demos/${demoId}`),
  ]);
  applyEnvironment(environment);

  let hostState = {};
  const refreshHost = async () => {
    hostState = await getJson(`/api/demos/${demoId}/state${stateQuery()}`);
    stage.setHostWorkspaces(hostState.workspaces ?? []);
    return hostState;
  };

  const stage = (createRenderer ?? createStage)($("#stage"), {
    ...stageOptions,
    onSynced: () => refreshHost(),
  });
  stage.setSandboxKind(environment);

  const auditRows = $("#audit-rows");
  const eventLog = createEventLog($("#events"));
  const addAuditRow = (command) =>
    auditRows?.append(
      h(
        "tr",
        {},
        h("td.mono", { text: command.id }),
        h("td", { text: command.stepId ?? "" }),
        h("td.mono", { text: command.name }),
        h("td.mono.argv", {
          text: command.argv.join(" "),
          title: command.argv.join(" "),
        }),
        h(`td.mono.${command.exitCode === 0 ? "exit-ok" : "exit-bad"}`, {
          text: command.exitCode,
        }),
        h("td.mono", { text: formatDuration(command.durationMs ?? 0) }),
        h("td.mono", {
          text:
            command.filesChanged
              .map((file) => `${file.action} ${file.path}`)
              .join(", ") || "—",
        }),
      ),
    );

  let state = createRunState();
  let controller;
  const runButton = createRunButton($("#run-button"), $("#run-label"), {
    onRun: () => page.start(),
    onCancel: () => controller?.abort(),
    ...(runLabels ? { labels: runLabels } : {}),
  });

  const dispatch = (message) => {
    onMessage(message, state);
    for (const effect of applyMessage(state, message)) {
      stage.handle(effect);
      if (effect.type === "event") eventLog.add(effect.event);
      if (effect.type === "command-completed")
        addAuditRow(state.commands.get(effect.commandId));
      onEffect(effect, state, message);
    }
  };

  const page = {
    environment,
    demo,
    stage,
    get state() {
      return state;
    },
    get hostState() {
      return hostState;
    },
    refreshHost,
    /** Stream one attempt. `continueRun` keeps the stage for a resumed run. */
    async stream(url, body, { continueRun = false } = {}) {
      if (!continueRun) {
        state = createRunState();
        stage.reset(demo.manifest, state);
        auditRows?.replaceChildren();
        eventLog.reset();
        onReset();
      } else {
        const previous = state;
        state = createRunState();
        state.steps = previous.steps;
        state.admitted = previous.admitted;
        state.denied = previous.denied;
        stage.reset(demo.manifest, state, { keepSteps: true });
      }
      runButton.set("running");
      stage.running();
      $(scrollTarget).scrollIntoView({ behavior: "smooth", block: "start" });
      controller = new AbortController();
      try {
        await streamRun(url, body, dispatch, controller.signal);
        if (state.status === "running")
          dispatch({ kind: "result", result: null });
      } catch (error) {
        const cancelled = controller.signal.aborted;
        dispatch({
          kind: "error",
          error: {
            message: cancelled ? "Cancelled" : error.message,
            cancelled,
          },
        });
      } finally {
        controller = undefined;
        runButton.set("idle");
      }
      return state;
    },
    start() {
      return page.stream(`/api/demos/${demoId}/runs`, {
        mode: selectedValue("mode") ?? "scripted",
        pace: Number(selectedValue("pace") ?? 2),
        options: buildRequest?.() ?? {},
      });
    },
  };

  if (environment.sandbox.kind === "none" && demo.needsSandbox !== false) {
    $("#run-button").disabled = true;
    stage.status("No sandbox is available on this machine.");
  }
  stage.reset(demo.manifest, state);
  await refreshHost();
  setupTabs("hood", "data-hood-panel");
  await createSourceViewer(demoId, demo.sources);
  window.addEventListener("resize", () => stage.clearLayer());
  return page;
};
