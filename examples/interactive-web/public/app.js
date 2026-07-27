const elements = {
  form: document.querySelector("#run-form"),
  topic: document.querySelector("#topic"),
  audience: document.querySelector("#audience"),
  libraryId: document.querySelector("#library-id"),
  documentationQuestion: document.querySelector("#documentation-question"),
  tone: document.querySelector("#tone"),
  maxWords: document.querySelector("#max-words"),
  maxWordsValue: document.querySelector("#max-words-value"),
  includeRisks: document.querySelector("#include-risks"),
  executionModes: [...document.querySelectorAll('input[name="execution"]')],
  schedulingModes: [...document.querySelectorAll('input[name="scheduling"]')],
  runButton: document.querySelector("#run-button"),
  cancelButton: document.querySelector("#cancel-button"),
  runtimeLabel: document.querySelector("#runtime-label"),
  modelValue: document.querySelector("#model-value"),
  executionValue: document.querySelector("#execution-value"),
  schedulingValue: document.querySelector("#scheduling-value"),
  streamValue: document.querySelector("#stream-value"),
  mcpValue: document.querySelector("#mcp-value"),
  telemetryValue: document.querySelector("#telemetry-value"),
  runStatus: document.querySelector("#run-status"),
  activeStep: document.querySelector("#active-step"),
  responseOutput: document.querySelector("#response-output"),
  finalOutputSection: document.querySelector("#final-output-section"),
  finalOutputVariable: document.querySelector("#final-output-variable"),
  finalOutputStatus: document.querySelector("#final-output-status"),
  stepOutputList: document.querySelector("#step-output-list"),
  runError: document.querySelector("#run-error"),
  runId: document.querySelector("#run-id"),
  tokenUsage: document.querySelector("#token-usage"),
  contractOutput: document.querySelector("#contract-output"),
  contractTabs: [...document.querySelectorAll("[data-contract]")],
  eventList: document.querySelector("#event-list"),
  eventCount: document.querySelector("#event-count"),
};

let agentManifest;
let latestAgentRunManifest;
let activeContract = "agent";
let abortController;
let eventTotal = 0;
let stepNames = new Map();
let stepDefinitions = new Map();
let stepNumbers = new Map();
let finalOutputStepIds = new Set();
const streamedByStep = new Map();
const stepOutputViews = new Map();
const pendingMarkdown = new Map();
let markdownFrame;

const pretty = (value) => JSON.stringify(value, null, 2);

const markdownSource = (value) =>
  typeof value === "string" ? value : `\`\`\`json\n${pretty(value)}\n\`\`\``;

const renderMarkdownNow = (element, source) => {
  const html = window.marked.parse(String(source ?? ""), {
    gfm: true,
    breaks: true,
  });
  element.innerHTML = window.DOMPurify.sanitize(html);
  for (const block of element.querySelectorAll("pre code")) {
    window.hljs.highlightElement(block);
  }
};

const renderMarkdown = (element, source) => {
  pendingMarkdown.set(element, source);
  if (markdownFrame) return;
  markdownFrame = requestAnimationFrame(() => {
    for (const [target, markdown] of pendingMarkdown)
      renderMarkdownNow(target, markdown);
    pendingMarkdown.clear();
    markdownFrame = undefined;
  });
};

const currentInput = () => ({
  execution:
    elements.executionModes.find((input) => input.checked)?.value === "remote"
      ? "remote"
      : "local",
  scheduling:
    elements.schedulingModes.find((input) => input.checked)?.value ===
    "sequential"
      ? "sequential"
      : "parallel",
  topic: elements.topic.value.trim(),
  audience: elements.audience.value.trim(),
  libraryId: elements.libraryId.value.trim(),
  documentationQuestion: elements.documentationQuestion.value.trim(),
  tone: elements.tone.value,
  maxWords: Number(elements.maxWords.value),
  includeRisks: elements.includeRisks.checked,
});

const selectedExecution = () =>
  elements.executionModes.find((input) => input.checked)?.value === "remote"
    ? "Remote"
    : "Local";

const selectedScheduling = () =>
  elements.schedulingModes.find((input) => input.checked)?.value ===
  "sequential"
    ? "Sequential"
    : "Parallel";

const previewAgentRunManifest = () => {
  const input = currentInput();
  return {
    schemaVersion: "1.0",
    agent: { ref: "interactive-brief.agent.yaml" },
    execution: {
      mode: input.scheduling,
      ...(input.scheduling === "parallel" ? { maxConcurrency: 4 } : {}),
    },
    variables: [
      { key: "topic", value: input.topic },
      { key: "audience", value: input.audience },
      { key: "libraryId", value: input.libraryId },
      { key: "documentationQuestion", value: input.documentationQuestion },
      { key: "includeRisks", value: input.includeRisks },
      {
        key: "style",
        value: { tone: input.tone, maxWords: input.maxWords },
      },
    ],
  };
};

const renderContract = () => {
  const value =
    activeContract === "agent"
      ? agentManifest
      : (latestAgentRunManifest ?? previewAgentRunManifest());
  elements.contractOutput.textContent = value ? pretty(value) : "Loading…";
};

const setStatus = (label, state) => {
  elements.runStatus.textContent = label;
  elements.runStatus.dataset.state = state;
};

const setFinalOutputStatus = (label, state) => {
  elements.finalOutputStatus.textContent = label;
  elements.finalOutputStatus.dataset.state = state;
};

const stepOutputView = (stepId) => {
  if (!stepId) return undefined;
  const existing = stepOutputViews.get(stepId);
  if (existing) return existing;

  if (stepOutputViews.size === 0) elements.stepOutputList.innerHTML = "";
  const definition = stepDefinitions.get(stepId);
  const card = document.createElement("article");
  const heading = document.createElement("div");
  const identity = document.createElement("div");
  const number = document.createElement("span");
  const title = document.createElement("div");
  const name = document.createElement("h4");
  const metadata = document.createElement("div");
  const variable = document.createElement("code");
  const finalOutputMarker = document.createElement("span");
  const status = document.createElement("span");
  const output = document.createElement("div");

  card.className = "step-output-card";
  card.dataset.state = "running";
  heading.className = "step-output-heading";
  identity.className = "step-output-identity";
  number.className = "step-output-number";
  number.textContent = String(
    stepNumbers.get(stepId) ?? stepOutputViews.size + 1,
  ).padStart(2, "0");
  name.textContent = definition?.name ?? stepNames.get(stepId) ?? stepId;
  metadata.className = "step-output-metadata";
  variable.textContent = definition?.outputVariable ?? "No output variable";
  finalOutputMarker.className = "final-output-marker";
  finalOutputMarker.textContent = "Contributes to final output";
  finalOutputMarker.hidden = !finalOutputStepIds.has(stepId);
  status.className = "step-output-status";
  status.dataset.state = "running";
  status.textContent = "Running";
  output.className = "step-output-content markdown-output";
  output.textContent = "Waiting for output…";
  metadata.append(variable, finalOutputMarker);
  title.append(name, metadata);
  identity.append(number, title);
  heading.append(identity, status);
  card.append(heading, output);
  elements.stepOutputList.append(card);

  const view = { card, status, output };
  stepOutputViews.set(stepId, view);
  return view;
};

const setStepOutputStatus = (stepId, label, state) => {
  const view = stepOutputView(stepId);
  if (!view) return;
  view.card.dataset.state = state;
  view.status.dataset.state = state;
  view.status.textContent = label;
};

const resetRunView = () => {
  eventTotal = 0;
  streamedByStep.clear();
  stepOutputViews.clear();
  pendingMarkdown.clear();
  if (markdownFrame) cancelAnimationFrame(markdownFrame);
  markdownFrame = undefined;
  elements.eventList.innerHTML =
    '<li class="empty-event">Waiting for the first event…</li>';
  elements.stepOutputList.innerHTML =
    '<p class="empty-output">Step outputs will appear here as the agent runs.</p>';
  elements.eventCount.textContent = "0 events";
  elements.finalOutputSection.hidden = true;
  elements.responseOutput.textContent = "";
  elements.runError.hidden = true;
  elements.runError.textContent = "";
  elements.runId.textContent = "Allocating run";
  elements.tokenUsage.textContent = "— tokens";
  elements.activeStep.textContent = "Starting";
};

const eventLabel = (type) =>
  ({
    "run.started": "Run started",
    "run.completed": "Run completed",
    "run.cancelled": "Run cancelled",
    "run.failed": "Run failed",
    "step.started": "Step started",
    "step.completed": "Step completed",
    "step.skipped": "Step skipped",
    "step.failed": "Step failed",
    "checkpoint.saved": "Checkpoint saved",
    "model.started": "Model started",
    "model.completed": "Model completed",
    "model.tool.requested": "Tool requested",
    "model.tool.started": "Tool started",
    "model.tool.completed": "Tool completed",
    "model.text.delta": "Text streamed",
  })[type] ?? type;

const addEvent = (event) => {
  eventTotal += 1;
  if (eventTotal === 1) elements.eventList.innerHTML = "";
  const item = document.createElement("li");
  const sequence = document.createElement("span");
  const name = document.createElement("span");
  const step = document.createElement("span");
  sequence.className = "event-sequence";
  name.className = "event-name";
  step.className = "event-step";
  sequence.textContent = `#${String(event.sequence).padStart(2, "0")}`;
  name.textContent = eventLabel(event.type);
  step.textContent =
    event.data?.toolName ??
    (event.stepId ? (stepNames.get(event.stepId) ?? event.stepId) : "run");
  item.append(sequence, name, step);
  elements.eventList.append(item);
  elements.eventList.scrollTop = elements.eventList.scrollHeight;
  elements.eventCount.textContent = `${eventTotal} ${eventTotal === 1 ? "event" : "events"}`;
};

const handleEvent = (event) => {
  if (event.type !== "model.text.delta") addEvent(event);

  const stepName = event.stepId
    ? (stepNames.get(event.stepId) ?? event.stepId)
    : undefined;
  if (event.type === "step.started" && stepName) {
    elements.activeStep.textContent = stepName;
    setStepOutputStatus(event.stepId, "Running", "running");
  }
  if (event.type === "model.tool.started") {
    elements.activeStep.textContent = `Calling ${event.data?.toolName ?? "tool"}`;
  }
  if (event.type === "model.text.delta") {
    const key = event.stepId ?? "model";
    const next = `${streamedByStep.get(key) ?? ""}${String(event.data?.delta ?? "")}`;
    streamedByStep.set(key, next);
    const view = stepOutputView(key);
    if (view) renderMarkdown(view.output, next);
  }
  if (event.type === "step.completed" && event.stepId) {
    setStepOutputStatus(event.stepId, "Complete", "complete");
  }
  if (event.type === "step.skipped" && stepName) {
    elements.activeStep.textContent = `${stepName} skipped`;
    const view = stepOutputView(event.stepId);
    if (view)
      view.output.textContent =
        "Skipped because its condition evaluated to false.";
    setStepOutputStatus(event.stepId, "Skipped", "skipped");
  }
  if (event.type === "step.failed" && event.stepId) {
    setStepOutputStatus(event.stepId, "Failed", "error");
  }
};

const handleMessage = (message) => {
  if (message.kind === "accepted") {
    latestAgentRunManifest = message.agentRunManifest;
    elements.runId.textContent = message.runId;
    elements.executionValue.textContent = message.execution;
    elements.schedulingValue.textContent =
      message.agentRunManifest.execution?.mode === "parallel"
        ? "Parallel"
        : "Sequential";
    renderContract();
    return;
  }
  if (message.kind === "event") {
    handleEvent(message.event);
    return;
  }
  if (message.kind === "result") {
    const output = message.result.output;
    for (const stepResult of message.result.stepResults ?? []) {
      const view = stepOutputView(stepResult.stepId);
      if (view && stepResult.output !== undefined) {
        renderMarkdown(view.output, markdownSource(stepResult.output));
      }
      setStepOutputStatus(stepResult.stepId, "Complete", "complete");
    }
    elements.finalOutputSection.hidden = false;
    renderMarkdown(elements.responseOutput, markdownSource(output));
    setFinalOutputStatus("Complete", "complete");
    const totalTokens = message.result.usage?.totalTokens;
    elements.tokenUsage.textContent =
      typeof totalTokens === "number"
        ? `${totalTokens} tokens`
        : "Usage unavailable";
    elements.activeStep.textContent = "Complete";
    setStatus("Complete", "complete");
    return;
  }
  if (message.kind === "error") {
    elements.runError.hidden = false;
    elements.runError.textContent = message.error.message;
    elements.activeStep.textContent = message.error.cancelled
      ? "Cancelled"
      : "Failed";
    setStatus(message.error.cancelled ? "Cancelled" : "Failed", "error");
  }
};

const readNdjson = async (response) => {
  if (!response.body)
    throw new Error("This browser did not expose a response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) handleMessage(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) handleMessage(JSON.parse(buffer));
};

const runAgent = async (event) => {
  event.preventDefault();
  abortController = new AbortController();
  resetRunView();
  setStatus("Running", "running");
  elements.runButton.disabled = true;
  elements.cancelButton.disabled = false;
  for (const input of elements.executionModes) input.disabled = true;
  for (const input of elements.schedulingModes) input.disabled = true;
  latestAgentRunManifest = previewAgentRunManifest();
  renderContract();

  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(currentInput()),
      signal: abortController.signal,
    });
    await readNdjson(response);
    if (!response.ok && elements.runStatus.dataset.state === "running") {
      throw new Error(`The server returned HTTP ${response.status}.`);
    }
  } catch (error) {
    const cancelled =
      error instanceof DOMException && error.name === "AbortError";
    elements.runError.hidden = false;
    elements.runError.textContent = cancelled
      ? "No final output was produced.\n\nThe browser cancelled this run."
      : error instanceof Error
        ? `No final output was produced.\n\n${error.message}`
        : `No final output was produced.\n\n${String(error)}`;
    elements.activeStep.textContent = cancelled ? "Cancelled" : "Failed";
    setStatus(cancelled ? "Cancelled" : "Failed", "error");
  } finally {
    abortController = undefined;
    elements.runButton.disabled = false;
    elements.cancelButton.disabled = true;
    for (const input of elements.executionModes) input.disabled = false;
    for (const input of elements.schedulingModes) input.disabled = false;
  }
};

const load = async () => {
  try {
    const [configResponse, agentResponse] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/agent"),
    ]);
    if (!configResponse.ok || !agentResponse.ok)
      throw new Error("Example server is not ready.");
    const config = await configResponse.json();
    agentManifest = await agentResponse.json();
    const steps = agentManifest.steps ?? [];
    stepNames = new Map(steps.map((step) => [step.id, step.name ?? step.id]));
    stepDefinitions = new Map(steps.map((step) => [step.id, step]));
    stepNumbers = new Map(steps.map((step, index) => [step.id, index + 1]));
    finalOutputStepIds = new Set(
      steps
        .filter((step) => step.includeInFinalOutput === true)
        .map((step) => step.id),
    );
    const finalVariables = steps
      .filter((step) => step.includeInFinalOutput === true)
      .map((step) => step.outputVariable)
      .filter(Boolean);
    elements.finalOutputVariable.textContent =
      finalVariables.length > 0 ? finalVariables.join(", ") : "Run output";
    elements.runtimeLabel.textContent = "Example server";
    elements.modelValue.textContent = `${config.provider}/${config.model}`;
    elements.executionValue.textContent = selectedExecution();
    elements.schedulingValue.textContent = selectedScheduling();
    elements.streamValue.textContent = config.streaming.toUpperCase();
    elements.mcpValue.textContent = config.mcp;
    elements.telemetryValue.textContent = config.telemetry;
    renderContract();
  } catch (error) {
    elements.runtimeLabel.textContent =
      error instanceof Error ? error.message : "Example server unavailable";
    setStatus("Unavailable", "error");
  }
};

elements.form.addEventListener("submit", runAgent);
elements.cancelButton.addEventListener("click", () => abortController?.abort());
elements.maxWords.addEventListener("input", () => {
  elements.maxWordsValue.value = elements.maxWords.value;
  renderContract();
});
for (const input of [
  elements.topic,
  elements.audience,
  elements.libraryId,
  elements.documentationQuestion,
  elements.tone,
  elements.includeRisks,
]) {
  input.addEventListener("input", renderContract);
}
for (const input of elements.executionModes) {
  input.addEventListener("change", () => {
    elements.executionValue.textContent = selectedExecution();
  });
}
for (const input of elements.schedulingModes) {
  input.addEventListener("change", () => {
    elements.schedulingValue.textContent = selectedScheduling();
    renderContract();
  });
}
for (const tab of elements.contractTabs) {
  tab.addEventListener("click", () => {
    activeContract = tab.dataset.contract;
    for (const candidate of elements.contractTabs) {
      candidate.setAttribute("aria-selected", String(candidate === tab));
    }
    renderContract();
  });
}

await load();
