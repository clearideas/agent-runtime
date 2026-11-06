/**
 * Turns the showcase NDJSON stream into view state, without touching the DOM.
 *
 * `applyMessage` updates the state and returns semantic "effects" the page
 * animates (a tool call dispatched, a command admitted, files synced back).
 * Keeping this logic DOM-free lets the same module run in Node tests.
 *
 * Unknown event types are ignored, as Agent Runtime recommends for clients.
 */

export const createRunState = () => ({
  runId: null,
  attempt: 1,
  suspension: null,
  status: "idle",
  mode: null,
  sandboxKind: null,
  error: null,
  result: null,
  steps: new Map(),
  tools: new Map(),
  commands: new Map(),
  workspaces: [],
  sandbox: {
    state: "idle",
    id: null,
    provider: null,
    mounts: [],
    reason: null,
    commandsUsed: 0,
    secondsUsed: 0,
  },
  budget: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  checkpoints: 0,
  admitted: 0,
  denied: 0,
  eventCount: 0,
});

const step = (state, stepId) => {
  let entry = state.steps.get(stepId);
  if (!entry) {
    entry = { id: stepId, state: "waiting", text: "", modelCalls: 0 };
    state.steps.set(stepId, entry);
  }
  return entry;
};

const flagValue = (argv, flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

/**
 * Describe a sandbox command for people. Built-in file operations run the
 * runtime's helper (`agent-fs <op> --path …`); other kinds run their argv.
 */
export const describeCommand = (kind, name, argv = []) => {
  if (kind === "builtin") {
    const helperIndex = argv.findIndex((value) => value.endsWith("agent-fs"));
    const op = helperIndex >= 0 ? argv[helperIndex + 1] : name;
    const path = flagValue(argv, "--path");
    const query = flagValue(argv, "--query");
    const glob = flagValue(argv, "--glob");
    const target = path ?? (query ? `"${query}"` : "");
    return {
      op,
      path,
      query,
      display: ["agent-fs", op, target, glob ? `--glob ${glob}` : ""]
        .filter(Boolean)
        .join(" "),
    };
  }
  return {
    op: kind,
    display: argv
      .map((value) => (/\s/u.test(value) ? JSON.stringify(value) : value))
      .join(" "),
  };
};

const finish = (state, status) => {
  state.status = status;
  for (const entry of state.steps.values()) {
    if (entry.state === "running" || entry.state === "streaming") {
      entry.state =
        status === "completed"
          ? "complete"
          : status === "suspended"
            ? "paused"
            : "failed";
    }
  }
};

const applyEvent = (state, event, effects) => {
  const data = event.data ?? {};
  const stepId = event.stepId;
  state.eventCount += 1;
  switch (event.type) {
    case "run.started":
    case "run.resumed":
      state.status = "running";
      state.attempt = event.attempt ?? 1;
      state.suspension = null;
      effects.push({
        type: "run-started",
        resumed: event.type === "run.resumed",
      });
      break;
    case "approval.requested":
      effects.push({ type: "approval-requested", stepId });
      break;
    case "approval.resolved":
      effects.push({
        type: "approval-resolved",
        stepId,
        approved: Boolean(data.approved),
      });
      break;
    case "loop.iteration.started":
    case "loop.iteration.completed":
    case "loop.iteration.skipped":
    case "loop.goal.met": {
      const loop = step(state, stepId);
      loop.iterations ??= 0;
      if (event.type === "loop.iteration.started") loop.iterations += 1;
      if (event.type === "loop.goal.met") loop.goalMet = true;
      effects.push({ type: "loop", stepId, event: event.type, data });
      break;
    }
    case "workspace.bound":
      state.workspaces.push(data);
      effects.push({ type: "workspace-bound", workspace: data });
      break;
    case "step.started":
      step(state, stepId).state = "running";
      effects.push({ type: "step", stepId });
      break;
    case "step.completed":
      step(state, stepId).state = "complete";
      effects.push({ type: "step", stepId });
      break;
    case "step.skipped":
      step(state, stepId).state = "skipped";
      effects.push({ type: "step", stepId });
      break;
    case "step.failed":
      step(state, stepId).state = "failed";
      step(state, stepId).error = data.error ?? null;
      effects.push({ type: "step", stepId });
      break;
    case "model.started": {
      const entry = step(state, stepId);
      entry.modelCalls += 1;
      entry.state = "running";
      entry.thinking = true;
      effects.push({ type: "model-started", stepId });
      break;
    }
    case "model.text.delta": {
      const entry = step(state, stepId);
      const delta = String(data.delta ?? "");
      if (entry.thinking) {
        entry.thinking = false;
        entry.text = "";
      }
      entry.text += delta;
      entry.state = "streaming";
      effects.push({ type: "text", stepId, delta });
      break;
    }
    case "model.usage": {
      const usage = data.usage ?? {};
      state.usage.inputTokens += Number(usage.inputTokens ?? 0);
      state.usage.outputTokens += Number(usage.outputTokens ?? 0);
      state.usage.totalTokens += Number(
        usage.totalTokens ??
          Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0),
      );
      effects.push({ type: "usage" });
      break;
    }
    case "model.completed": {
      const entry = step(state, stepId);
      entry.thinking = false;
      if (entry.state === "streaming") entry.state = "running";
      effects.push({ type: "model-completed", stepId });
      break;
    }
    case "model.tool.requested":
    case "model.tool.started": {
      const existing = state.tools.get(data.toolCallId);
      if (!existing) {
        state.tools.set(data.toolCallId, {
          id: data.toolCallId,
          stepId,
          name: data.toolName,
          state: "running",
        });
        effects.push({
          type: "tool-dispatched",
          toolCallId: data.toolCallId,
          stepId,
          name: data.toolName,
        });
      }
      break;
    }
    case "model.tool.completed": {
      const tool = state.tools.get(data.toolCallId) ?? {
        id: data.toolCallId,
        stepId,
        name: data.toolName,
      };
      tool.errorCode = data.errorCode;
      // A failed call that never became a sandbox command was refused at the
      // boundary: by host policy, the command policy, or the path rules.
      const refused = Boolean(data.failed) && !tool.commandId;
      tool.state = refused ? "denied" : data.failed ? "failed" : "complete";
      state.tools.set(tool.id, tool);
      if (refused) state.denied += 1;
      effects.push({
        type: refused ? "tool-denied" : "tool-completed",
        toolCallId: tool.id,
        stepId,
        failed: Boolean(data.failed),
        errorCode: data.errorCode,
      });
      break;
    }
    case "sandbox.opened":
      Object.assign(state.sandbox, {
        state: "open",
        id: data.sandboxId,
        provider: data.provider,
        mounts: data.mounts ?? [],
        reason: null,
      });
      effects.push({ type: "sandbox-opened" });
      break;
    case "sandbox.command.started": {
      const described = describeCommand(data.kind, data.name, data.argv);
      state.commands.set(data.commandId, {
        id: data.commandId,
        stepId,
        toolCallId: data.toolCallId,
        kind: data.kind,
        name: data.name,
        alias: data.alias,
        argv: data.argv ?? [],
        cwd: data.cwd,
        state: "running",
        ...described,
      });
      state.admitted += 1;
      const tool = data.toolCallId
        ? state.tools.get(data.toolCallId)
        : undefined;
      if (tool) tool.commandId = data.commandId;
      effects.push({
        type: "command-started",
        commandId: data.commandId,
        toolCallId: data.toolCallId,
        stepId,
      });
      break;
    }
    case "sandbox.command.completed": {
      const command = state.commands.get(data.id) ?? {
        id: data.id,
        ...describeCommand(data.kind, data.name, data.argv),
      };
      Object.assign(command, {
        state: data.exitCode === 0 && !data.timedOut ? "ok" : "failed",
        exitCode: data.exitCode,
        timedOut: data.timedOut,
        durationMs: data.durationMs,
        filesChanged: data.filesChanged ?? [],
        ignoredPaths: data.ignoredPaths ?? [],
        budget: data.budget,
        record: data,
      });
      state.commands.set(command.id, command);
      if (data.budget) {
        state.budget = data.budget;
        state.sandbox.commandsUsed = data.budget.commandsUsed;
        state.sandbox.secondsUsed = data.budget.sandboxSecondsUsed;
      }
      effects.push({ type: "command-completed", commandId: command.id });
      if (command.filesChanged.length > 0) {
        effects.push({
          type: "sync-back",
          commandId: command.id,
          files: command.filesChanged,
        });
      }
      break;
    }
    case "sandbox.closed":
      Object.assign(state.sandbox, {
        state: "closed",
        reason: data.reason,
        commandsUsed: data.commandsUsed ?? state.sandbox.commandsUsed,
        secondsUsed: data.sandboxSecondsUsed ?? state.sandbox.secondsUsed,
      });
      effects.push({ type: "sandbox-closed", reason: data.reason });
      break;
    case "checkpoint.saved":
      state.checkpoints += 1;
      effects.push({ type: "checkpoint" });
      break;
    case "run.completed":
      finish(state, "completed");
      effects.push({ type: "run-finished", status: "completed" });
      break;
    case "run.failed":
      finish(state, "failed");
      state.error = data.error?.message ?? "Run failed.";
      effects.push({ type: "run-finished", status: "failed" });
      break;
    case "run.cancelled":
      finish(state, "cancelled");
      effects.push({ type: "run-finished", status: "cancelled" });
      break;
    case "run.suspended":
      state.suspension = { reason: data.reason, details: data.details ?? {} };
      finish(state, "suspended");
      effects.push({ type: "run-finished", status: "suspended" });
      break;
    default:
      break;
  }
};

/** Apply one stream message. Returns the effects to animate, in order. */
export const applyMessage = (state, message) => {
  const effects = [];
  switch (message.kind) {
    case "accepted":
      state.runId = message.runId;
      state.mode = message.mode;
      state.sandboxKind = message.sandbox;
      state.status = "running";
      effects.push({ type: "accepted" });
      break;
    case "event":
      applyEvent(state, message.event, effects);
      effects.push({ type: "event", event: message.event });
      break;
    case "tool-io": {
      const tool = state.tools.get(message.toolCallId) ?? {
        id: message.toolCallId,
        stepId: message.stepId,
        name: message.name,
        state: "running",
      };
      tool.input = message.input;
      tool.output = message.output;
      tool.error = message.error;
      state.tools.set(tool.id, tool);
      effects.push({ type: "tool-io", toolCallId: tool.id });
      break;
    }
    case "result":
      state.result = message.result;
      if (state.status === "running") finish(state, "completed");
      effects.push({ type: "result" });
      break;
    case "error":
      state.error = message.error.message;
      if (!["completed", "suspended"].includes(state.status)) {
        finish(state, message.error.cancelled ? "cancelled" : "failed");
      }
      effects.push({ type: "error", message: message.error.message });
      break;
    default:
      break;
  }
  return effects;
};
