/**
 * The shared stage: agent steps → host policy → sandbox (and MCP services)
 * → host files. It renders from the manifest and animates run effects from
 * run-state.js. Pages add their own pieces around it.
 */
import { anchor, flash, h, sendPacket } from "./ui.js";
import { createTimer } from "./page.js";

const shortTool = (name) => name.split("__").pop();
const aliasOf = (name) =>
  name.includes("__") ? name.split("__")[0] : undefined;
const fileKey = (alias, path) => `${alias}:${path}`;

const testSummary = (output) => {
  const text = `${output?.stdout ?? ""}\n${output?.stderr ?? ""}`;
  const ran = Number(/Ran (\d+) tests?/u.exec(text)?.[1] ?? 0);
  const failing = [...text.matchAll(/^(?:FAIL|ERROR): (\w+)/gmu)].length;
  if (!ran) return `exit ${output?.exitCode ?? "?"}`;
  return failing ? `${failing} of ${ran} tests failed` : `${ran} tests passed`;
};

/** One short result per tool call, shown at the end of its terminal line. */
export const defaultResultText = (tool) => {
  if (tool.error) return tool.error.code;
  const output = tool.output ?? {};
  switch (shortTool(tool.name)) {
    case "list_files":
      return `${output.files?.length ?? 0} files`;
    case "search_files":
      return `${output.matches?.length ?? 0} matches`;
    case "read_file":
      return output.encoding === "binary"
        ? `binary · ${output.mediaType ?? "file"}`
        : `${output.totalLines ?? "?"} lines`;
    case "write_file":
      return "written";
    case "delete_file":
      return "deleted";
    default:
      return "exitCode" in output ? testSummary(output) : "done";
  }
};

const friendlyCommand = (command) =>
  command.kind === "code"
    ? `code step “${command.name}”`
    : command.kind === "builtin"
      ? `${command.display.replace(/^agent-fs /u, "")}`
      : command.name;

/**
 * @param {HTMLElement} root  container element for the stage
 * @param {object} options
 * @param {Array<{alias: string, title: string, subtitle?: string}>} [options.services]
 *   MCP connection aliases that get their own box instead of the sandbox
 * @param {(tool) => string} [options.resultText]
 * @param {() => Promise<void>} [options.onSynced] called after a sync-back lands
 */
export const createStage = (root, options = {}) => {
  const resultText = options.resultText ?? defaultResultText;
  const services = options.services ?? [];

  const status = h("span", { text: "Ready", "aria-live": "polite" });
  const signal = h("span.signal");
  const elapsed = h("strong.elapsed", { text: "0.0s" });
  const headExtra = h("span.stage-extra");
  const top = h("div.stage-top");
  const layer = h("div.flow-layer", { "aria-hidden": "true" });
  const steps = h("ol.step-list");
  const shield = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  shield.setAttribute("viewBox", "0 0 96 112");
  shield.setAttribute("aria-hidden", "true");
  shield.innerHTML =
    '<path class="shield-fill" d="M48 4 L90 18 L84 70 Q76 96 48 108 Q20 96 12 70 L6 18 Z"/>';
  const gate = h(
    "div.gate",
    {},
    shield,
    h("div.gate-label", {}, "Host", h("br"), "policy"),
  );
  const gateStats = h("div.gate-stats");
  const sandboxKind = h("span.lane-note");
  const sandboxState = h("span", { text: "Opens on the first tool call" });
  const sandboxFiles = h("div.file-tree");
  const terminal = h("div.terminal", { "aria-live": "polite" });
  const sandboxBox = h(
    "div.sandbox-box",
    { dataset: { state: "idle" } },
    h("div.sandbox-head", {}, sandboxState),
    h("div.sandbox-body", {}, sandboxFiles, terminal),
  );
  const serviceViews = new Map(
    services.map((service) => {
      const log = h("div.service-log");
      const box = h(
        "div.service-box",
        {},
        h(
          "div.service-head",
          {},
          h("strong", { text: service.title }),
          " ",
          h("small", { text: service.subtitle ?? "MCP server" }),
        ),
        log,
      );
      return [service.alias, { box, log }];
    }),
  );
  const syncLane = h(
    "div.sync-arrow",
    { "aria-hidden": "true" },
    h("span", { text: "sync back" }),
  );
  const hostGroups = h("div.host-groups");
  const grid = h(
    "div.stage-grid",
    {},
    layer,
    h(
      "section",
      { "aria-label": "Agent" },
      h("div.lane-title", { text: "Agent" }),
      steps,
    ),
    h("section.relay", { "aria-label": "Host policy" }, gate, gateStats),
    h(
      "section",
      { "aria-label": "Sandbox" },
      h("div.lane-title", {}, "Sandbox ", sandboxKind),
      sandboxBox,
      ...[...serviceViews.values()].map((view) => view.box),
      syncLane,
      h(
        "div.host-store",
        {},
        h("div.lane-title", { text: "Host files" }),
        hostGroups,
      ),
    ),
  );
  root.classList.add("stage");
  root.replaceChildren(
    h(
      "div.stage-head",
      {},
      signal,
      status,
      h("span.spacer"),
      headExtra,
      elapsed,
    ),
    top,
    grid,
  );

  const timer = createTimer(elapsed);
  const stepViews = new Map();
  const fileRows = new Map();
  const hostChips = new Map();
  const termLines = new Map();
  const arrivals = new Map();
  const ingress = new Map();
  let hostWorkspaces = [];
  let serviceCalls = 0;
  let state;

  // ─── Rendering ─────────────────────────────────────────────────────────────

  const renderSteps = (manifest) => {
    stepViews.clear();
    steps.replaceChildren(
      ...manifest.steps.map((step, index) => {
        const activity = h("div.activity", { text: "Waiting" });
        const speech = h("div.speech");
        const card = h(
          "li.step-card",
          { dataset: { state: "waiting" } },
          h("span.num", { text: index + 1 }),
          h(
            "div",
            {},
            h("strong", { text: step.name ?? step.id }),
            activity,
            speech,
          ),
        );
        stepViews.set(step.id, { card, activity, speech, step, tools: 0 });
        return card;
      }),
    );
  };

  const renderHost = () => {
    hostChips.clear();
    hostGroups.replaceChildren(
      ...hostWorkspaces.map((workspace) =>
        h(
          "div.host-group",
          {},
          hostWorkspaces.length > 1
            ? h("span.host-group-label", {
                text: `${workspace.alias} · ${workspace.mode === "read" ? "read-only" : "read-write"}`,
              })
            : null,
          h(
            "ul.host-files",
            {},
            workspace.files.map((file) => {
              const chip = h("li.host-file", {
                text: file.path,
                title: file.visible
                  ? file.path
                  : `Never shown to the agent: ${file.hiddenReason}`,
                dataset: { visible: String(file.visible), status: file.status },
              });
              hostChips.set(fileKey(workspace.alias, file.path), chip);
              return chip;
            }),
          ),
        ),
      ),
    );
  };

  const setActivity = (stepId, text) => {
    const view = stepViews.get(stepId);
    const entry = state?.steps.get(stepId);
    if (!view || !entry) return;
    view.card.dataset.state = entry.state;
    if (text) view.activity.textContent = text;
  };

  const doneText = (stepId) => {
    const view = stepViews.get(stepId);
    if (!view || view.step.type !== "prompt" || !view.tools) return "Done";
    return `Done · ${view.tools} tool call${view.tools === 1 ? "" : "s"}`;
  };

  const showSpeech = (stepId) => {
    const view = stepViews.get(stepId);
    const entry = state?.steps.get(stepId);
    if (!view || !entry) return;
    const text = entry.text.trimStart().startsWith("{")
      ? "Writing a structured answer…"
      : entry.text;
    view.speech.replaceChildren(text, h("span.caret"));
    view.card.dataset.speaking = "true";
  };

  const hideSpeech = (stepId) => {
    const view = stepViews.get(stepId);
    if (view) view.card.dataset.speaking = "false";
  };

  const mountGroup = (alias) => {
    let group = sandboxFiles.querySelector(`[data-alias="${alias}"]`);
    if (!group) {
      group = h("div.mount-group", { dataset: { alias } });
      const mount = state?.sandbox.mounts.find(
        (entry) => entry.alias === alias,
      );
      if ((state?.sandbox.mounts.length ?? 0) > 1)
        group.append(
          h("div.mount-label", {
            text: `${alias} · ${mount?.mode === "read" ? "read-only" : "read-write"}`,
          }),
        );
      group.append(h("ul.file-list"));
      sandboxFiles.append(group);
    }
    return group.querySelector("ul");
  };

  const ensureFileRow = (alias, path) => {
    const key = fileKey(alias, path);
    let row = fileRows.get(key);
    if (!row) {
      // Long paths keep their most informative end: the file name.
      const segments = path.split("/");
      const label =
        path.length > 26 && segments.length > 2
          ? `…/${segments.slice(-2).join("/")}`
          : path;
      row = h("li.file-row", { title: path }, h("span.name", { text: label }));
      fileRows.set(key, row);
      mountGroup(alias).append(row);
    }
    return row;
  };

  const stageFiles = () => {
    sandboxFiles.replaceChildren();
    fileRows.clear();
    let index = 0;
    for (const mount of state.sandbox.mounts) {
      mountGroup(mount.alias);
      const workspace = hostWorkspaces.find(
        (entry) => entry.alias === mount.alias,
      );
      for (const file of workspace?.files.filter((entry) => entry.visible) ??
        []) {
        const row = ensureFileRow(mount.alias, file.path);
        const delay = index++ * 90;
        row.style.animationDelay = `${delay}ms`;
        const chip = hostChips.get(fileKey(mount.alias, file.path));
        if (chip)
          setTimeout(
            () =>
              sendPacket(layer, anchor(chip, grid), anchor(row, grid, "left"), {
                duration: 700,
              }),
            delay,
          );
      }
    }
  };

  const touchFiles = (command) => {
    if (
      command.kind !== "builtin" ||
      command.op === "list" ||
      command.op === "search"
    ) {
      const rows = [...fileRows.entries()]
        .filter(
          ([key]) => !command.alias || key.startsWith(`${command.alias}:`),
        )
        .map(([, row]) => row);
      rows.forEach((row, index) =>
        setTimeout(() => flash(row, "fx-read"), index * 50),
      );
      return;
    }
    if (command.path)
      flash(
        ensureFileRow(command.alias, command.path),
        command.op === "write" || command.op === "delete"
          ? "fx-write"
          : "fx-read",
        1400,
      );
  };

  const cardPoint = (stepId) => {
    const view = stepViews.get(stepId);
    return view
      ? anchor(view.card, grid, "right")
      : anchor(steps, grid, "right");
  };
  const gateIn = () => anchor(gate, grid, "left");
  const gateOut = () => anchor(gate, grid, "right");
  const targetPoint = (tool, command) => {
    const service = tool ? serviceViews.get(aliasOf(tool.name)) : undefined;
    if (service) return anchor(service.box, grid, "left");
    const row = command?.path
      ? fileRows.get(fileKey(command.alias, command.path))
      : undefined;
    return anchor(row ?? terminal, grid, "left");
  };

  const updateGateStats = () => {
    gateStats.replaceChildren(
      h("span.ok", { text: `✓ ${(state?.admitted ?? 0) + serviceCalls}` }),
      h("span.no", { text: `✕ ${state?.denied ?? 0}` }),
    );
  };

  const updateSandboxHead = () => {
    const count = state?.commands.size ?? 0;
    const commands = `${count} command${count === 1 ? "" : "s"}`;
    const sandbox = state?.sandbox.state;
    sandboxState.textContent =
      sandbox === "open"
        ? `Open · ${commands}`
        : sandbox === "closed"
          ? `Closed${state.sandbox.reason === "suspended" ? " while the run waits" : ""} · ${commands}`
          : "Opens on the first tool call";
  };

  const logLine = (container, lineState, text) => {
    const result = h("span.result", { text: "…" });
    const line = h(
      "div.term-line",
      { dataset: { state: lineState } },
      h("span.prompt", { text: "$" }),
      h("span.cmd", { text }),
      result,
    );
    container.append(line);
    container.scrollTop = container.scrollHeight;
    return { line, result };
  };

  /**
   * A muted line under a terminal entry that says why it failed, in the
   * runtime's own words (the code alone rarely says what to fix).
   */
  const addNote = (entry, text) => {
    if (!entry || !text || entry.note) return;
    entry.note = h("div.term-note", {
      text: text.length > 240 ? `${text.slice(0, 239)}…` : text,
    });
    entry.line.after(entry.note);
    entry.line.parentElement?.scrollTo({ top: 1e6 });
  };

  // ─── Effects ───────────────────────────────────────────────────────────────

  const handle = (effect) => {
    switch (effect.type) {
      case "run-started":
        timer.start();
        signal.dataset.state = "running";
        status.textContent =
          state.attempt > 1 ? `Resumed · attempt ${state.attempt}` : "Running";
        break;
      case "step": {
        const entry = state.steps.get(effect.stepId);
        const view = stepViews.get(effect.stepId);
        if (!entry || !view) break;
        if (entry.state === "running") {
          setActivity(effect.stepId, "Starting");
          status.textContent = view.step.name ?? effect.stepId;
        } else if (entry.state === "complete") {
          setActivity(effect.stepId, doneText(effect.stepId));
          hideSpeech(effect.stepId);
        } else if (entry.state === "skipped") {
          setActivity(
            effect.stepId,
            options.skippedText?.(view.step) ?? "Skipped: condition was false",
          );
        } else if (entry.state === "failed") {
          setActivity(effect.stepId, entry.error?.message ?? "Failed");
          hideSpeech(effect.stepId);
        }
        break;
      }
      case "model-started":
        setActivity(effect.stepId, "Thinking");
        break;
      case "text":
        setActivity(effect.stepId, "Thinking");
        showSpeech(effect.stepId);
        break;
      case "tool-dispatched": {
        const view = stepViews.get(effect.stepId);
        if (view) view.tools += 1;
        setActivity(effect.stepId, `Calling ${shortTool(effect.name)}`);
        arrivals.set(
          effect.toolCallId,
          sendPacket(layer, cardPoint(effect.stepId), gateIn(), {
            label: shortTool(effect.name),
            duration: 520,
          }),
        );
        break;
      }
      case "command-started": {
        const command = state.commands.get(effect.commandId);
        const arrival = effect.toolCallId
          ? (arrivals.get(effect.toolCallId) ?? Promise.resolve())
          : sendPacket(layer, cardPoint(effect.stepId), gateIn(), {
              tone: "violet",
              label: "code",
              duration: 520,
            });
        termLines.set(
          command.id,
          logLine(terminal, "running", friendlyCommand(command)),
        );
        updateSandboxHead();
        const entered = arrival.then(() => {
          flash(gate, "admit", 700);
          updateGateStats();
          touchFiles(command);
          return sendPacket(layer, gateOut(), targetPoint(undefined, command), {
            tone:
              command.op === "write"
                ? "amber"
                : command.kind === "builtin"
                  ? "blue"
                  : "violet",
            duration: 520,
          });
        });
        if (effect.toolCallId) ingress.set(effect.toolCallId, entered);
        break;
      }
      case "tool-denied": {
        const tool = state.tools.get(effect.toolCallId);
        const byHost = effect.errorCode === "tool_not_authorized";
        const { result } = logLine(
          serviceViews.get(aliasOf(tool.name))?.log ?? terminal,
          "denied",
          `${shortTool(tool.name)} ${tool.input?.path ?? ""}`,
        );
        termLines.set(tool.id, { line: result.parentElement, result });
        result.textContent = byHost
          ? "blocked by host policy"
          : (effect.errorCode ?? "refused");
        // The mirrored error usually arrives before this event.
        addNote(termLines.get(tool.id), tool.error?.message);
        status.textContent = `${byHost ? "Host policy" : "The boundary"} refused ${shortTool(tool.name)}`;
        (arrivals.get(effect.toolCallId) ?? Promise.resolve()).then(() => {
          flash(gate, "deny", 700);
          updateGateStats();
          return sendPacket(layer, gateIn(), cardPoint(effect.stepId), {
            tone: "red",
            label: byHost ? "blocked" : effect.errorCode,
            duration: 600,
          });
        });
        break;
      }
      case "tool-completed": {
        const tool = state.tools.get(effect.toolCallId);
        const service = serviceViews.get(aliasOf(tool?.name ?? ""));
        const command = tool?.commandId
          ? state.commands.get(tool.commandId)
          : undefined;
        if (service && !effect.failed) {
          // MCP tools pass the policy gate but never enter the sandbox.
          const line = logLine(service.log, "ok", `${shortTool(tool.name)}`);
          // The mirrored output usually arrives before this event.
          if (tool.output !== undefined)
            line.result.textContent = resultText(tool);
          termLines.set(tool.id, line);
          (arrivals.get(tool.id) ?? Promise.resolve())
            .then(() => {
              flash(gate, "admit", 700);
              serviceCalls += 1;
              updateGateStats();
              return sendPacket(
                layer,
                gateOut(),
                anchor(service.box, grid, "left"),
                { duration: 520 },
              );
            })
            .then(() => {
              flash(service.box, "fx-read", 1000);
              return sendPacket(
                layer,
                anchor(service.box, grid, "left"),
                cardPoint(effect.stepId),
                {
                  tone: "green",
                  duration: 620,
                },
              );
            });
          break;
        }
        (ingress.get(effect.toolCallId) ?? Promise.resolve()).then(() =>
          sendPacket(
            layer,
            targetPoint(tool, command),
            cardPoint(effect.stepId),
            {
              tone: effect.failed ? "red" : "green",
              duration: 620,
            },
          ),
        );
        break;
      }
      case "tool-io": {
        const tool = state.tools.get(effect.toolCallId);
        const line = termLines.get(tool?.commandId) ?? termLines.get(tool?.id);
        if (line && tool.state !== "denied")
          line.result.textContent = resultText(tool);
        addNote(line, tool?.error?.message);
        break;
      }
      case "command-completed": {
        const command = state.commands.get(effect.commandId);
        const line = termLines.get(command.id);
        if (line) line.line.dataset.state = command.state;
        // A change the host store refused to save never reaches the host.
        const unsaved = command.ignoredPaths.filter((item) =>
          String(item.reason).startsWith("store:"),
        );
        if (line && unsaved.length)
          addNote(
            line,
            `Not saved to the host: ${unsaved.map((item) => `${item.path} (${item.reason.slice(6).trim()})`).join("; ")}`,
          );
        updateSandboxHead();
        break;
      }
      case "sync-back":
        flash(syncLane, "active", 1600);
        for (const file of effect.files) {
          const row = ensureFileRow(file.alias, file.path);
          row.dataset.status = file.action;
          const chip = hostChips.get(fileKey(file.alias, file.path));
          setTimeout(async () => {
            await sendPacket(
              layer,
              anchor(row, grid),
              anchor(chip ?? hostGroups, grid),
              {
                tone: "amber",
                label: file.path,
                duration: 850,
              },
            );
            if (chip) {
              chip.dataset.status = file.action;
              flash(chip, "fx-synced", 1600);
            }
            await options.onSynced?.();
          }, 200);
        }
        status.textContent = `Synced ${effect.files.map((file) => file.path).join(", ")} to the host`;
        break;
      case "sandbox-opened":
        sandboxBox.dataset.state = "open";
        updateSandboxHead();
        stageFiles();
        break;
      case "sandbox-closed":
        sandboxBox.dataset.state = "closed";
        updateSandboxHead();
        break;
      case "run-finished":
        finish(effect.status);
        break;
      case "error":
        status.textContent = effect.message;
        finish(state.status);
        break;
      default:
        break;
    }
  };

  const finish = (runStatus) => {
    timer.stop();
    signal.dataset.state = runStatus;
    for (const [stepId, view] of stepViews) {
      const entry = state.steps.get(stepId);
      if (!entry) continue;
      view.card.dataset.state = entry.state;
      hideSpeech(stepId);
    }
    const labels = {
      completed: "Done",
      failed: `Failed${state.error ? `: ${state.error}` : ""}`,
      cancelled: "Cancelled",
      suspended: "Paused · the run is saved and waiting",
    };
    status.textContent = labels[runStatus] ?? runStatus;
  };

  return {
    grid,
    top,
    headExtra,
    stepViews,
    termLines,
    status: (text) => {
      status.textContent = text;
    },
    setSandboxKind(environment) {
      sandboxKind.textContent =
        environment.sandbox.kind === "unisolated"
          ? "not isolated"
          : environment.sandbox.kind;
      sandboxKind.dataset.isolated = String(environment.sandbox.isolated);
    },
    setHostWorkspaces(workspaces) {
      hostWorkspaces = workspaces;
      renderHost();
    },
    /** Start a fresh view. Keep the timer and files when continuing an attempt. */
    reset(manifest, runState, { keepSteps = false } = {}) {
      state = runState;
      arrivals.clear();
      ingress.clear();
      termLines.clear();
      serviceCalls = 0;
      if (!keepSteps) {
        renderSteps(manifest);
        terminal.replaceChildren();
        for (const view of serviceViews.values()) view.log.replaceChildren();
        timer.reset();
      }
      layer.replaceChildren();
      sandboxBox.dataset.state = "idle";
      sandboxFiles.replaceChildren();
      fileRows.clear();
      updateGateStats();
      updateSandboxHead();
    },
    bind(runState) {
      state = runState;
    },
    /** A labelled separator in the sandbox terminal, e.g. between attempts. */
    divider(text) {
      terminal.append(h("div.term-divider", { text }));
      terminal.scrollTop = terminal.scrollHeight;
    },
    handle,
    setActivity,
    running() {
      signal.dataset.state = "running";
      status.textContent = "Starting";
    },
    clearLayer() {
      layer.replaceChildren();
    },
  };
};
