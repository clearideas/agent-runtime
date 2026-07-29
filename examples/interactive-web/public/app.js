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
  runButtonLabel: document.querySelector("#run-button-label"),
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
  executionStage: document.querySelector("#execution-stage"),
  executionGraph: document.querySelector("#execution-graph"),
  executionConnections: document.querySelector("#execution-connections"),
  visualizationStatus: document.querySelector("#visualization-status"),
  visualizationSignal: document.querySelector("#visualization-signal"),
  executionVariableList: document.querySelector("#execution-variable-list"),
  executionTimer: document.querySelector("#execution-timer"),
  executionElapsed: document.querySelector("#execution-elapsed"),
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
const executionNodes = new Map();
const executionVariableNodes = new Map();
const executionEdges = [];
const activeModelSteps = new Set();
const activeToolSteps = new Set();
const streamingModelSteps = new Set();
const toolResponseSteps = new Set();
const activeVariableReads = new Map();
const streamedCharacters = new Map();
const completedModelCalls = new Map();
let visualizationFrame;
let runTimerStartedAt;
let runTimerInterval;
let configuredModel = "AI model";
let configuredTool = "MCP tool";

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

const formatElapsed = (milliseconds) => {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
};

const renderElapsed = () => {
  if (!elements.executionElapsed || runTimerStartedAt === undefined) return;
  elements.executionElapsed.textContent = formatElapsed(
    performance.now() - runTimerStartedAt,
  );
};

const resetRunTimer = () => {
  if (runTimerInterval) clearInterval(runTimerInterval);
  runTimerInterval = undefined;
  runTimerStartedAt = undefined;
  if (!elements.executionTimer || !elements.executionElapsed) return;
  elements.executionElapsed.textContent = "0.0s";
  elements.executionTimer.dataset.state = "idle";
};

const startRunTimer = () => {
  if (!elements.executionTimer || !elements.executionElapsed) return;
  if (runTimerInterval) clearInterval(runTimerInterval);
  runTimerStartedAt = performance.now();
  elements.executionTimer.dataset.state = "running";
  renderElapsed();
  runTimerInterval = setInterval(renderElapsed, 100);
};

const stopRunTimer = (state = "complete") => {
  if (!elements.executionTimer) return;
  if (runTimerStartedAt !== undefined) renderElapsed();
  if (runTimerInterval) clearInterval(runTimerInterval);
  runTimerInterval = undefined;
  runTimerStartedAt = undefined;
  elements.executionTimer.dataset.state = state;
};

const referencedVariables = (step) => {
  const templates = [step.systemPrompt, step.prompt, step.when]
    .filter((value) => typeof value === "string")
    .join("\n");
  const references = new Set();
  for (const match of templates.matchAll(/\{\{\s*([^}\s]+)[^}]*\}\}/g)) {
    references.add(match[1].split(".")[0]);
  }
  for (const match of templates.matchAll(
    /(?:^|[^.\w])([A-Za-z_][\w]*)\s*(?:==|!=|>=|<=|>|<)/g,
  )) {
    references.add(match[1]);
  }
  return references;
};

const dependencyGraph = (steps) => {
  const outputOwners = new Map(
    steps
      .filter((step) => step.outputVariable)
      .map((step) => [step.outputVariable, step.id]),
  );
  return steps.flatMap((step) =>
    [...referencedVariables(step)]
      .filter((variable) => outputOwners.has(variable))
      .map((variable) => ({
        source: outputOwners.get(variable),
        target: step.id,
        variable,
      })),
  );
};

const executionLayout = (steps, dependencies) => {
  const levelByStep = new Map();
  const visit = (stepId, seen = new Set()) => {
    if (levelByStep.has(stepId)) return levelByStep.get(stepId);
    if (seen.has(stepId)) return 0;
    seen.add(stepId);
    const parents = dependencies
      .filter((edge) => edge.target === stepId)
      .map((edge) => edge.source);
    const level =
      parents.length === 0
        ? 1
        : Math.max(...parents.map((parent) => visit(parent, seen))) + 1;
    levelByStep.set(stepId, level);
    return level;
  };
  for (const step of steps) visit(step.id);
  const levels = new Map();
  for (const step of steps) {
    const level = levelByStep.get(step.id) ?? 1;
    const group = levels.get(level) ?? [];
    group.push(step.id);
    levels.set(level, group);
  }
  return { levelByStep, levels };
};

const createExecutionNode = ({
  id,
  kind,
  eyebrow,
  name,
  detail,
  outputVariable,
  column,
  row,
}) => {
  const node = document.createElement("article");
  const nodeEyebrow = document.createElement("span");
  const nodeName = document.createElement("strong");
  const nodeDetail = document.createElement("span");
  const activity = document.createElement("span");
  const activityDots = document.createElement("span");
  const activityLabel = document.createElement("span");
  const outputVariablePill = document.createElement("span");

  node.className = `execution-node execution-node-${kind}`;
  node.dataset.nodeId = id;
  node.dataset.kind = kind;
  node.dataset.state = "waiting";
  node.style.gridColumn = String(column);
  node.style.gridRow = String(row);
  nodeEyebrow.className = "execution-node-eyebrow";
  nodeEyebrow.textContent = eyebrow;
  nodeName.className = "execution-node-name";
  nodeName.textContent = name;
  nodeDetail.className = "execution-node-detail";
  nodeDetail.textContent = detail;
  activity.className = "execution-node-activity";
  activityDots.className = "execution-activity-dots";
  activityDots.innerHTML = "<i></i><i></i><i></i>";
  activityLabel.className = "execution-activity-label";
  activityLabel.textContent = kind === "service" ? "Idle" : "Waiting";
  activity.append(activityDots, activityLabel);
  node.append(nodeEyebrow, nodeName, nodeDetail, activity);
  if (outputVariable) {
    outputVariablePill.className = "execution-output-variable";
    outputVariablePill.textContent = outputVariable;
    outputVariablePill.title = `Writes ${outputVariable}`;
    node.append(outputVariablePill);
  }
  elements.executionGraph.append(node);

  const view = {
    node,
    detail: nodeDetail,
    activity: activityLabel,
    defaultDetail: detail,
  };
  executionNodes.set(id, view);
  return view;
};

const setExecutionNode = (id, state, activity, detail, redraw = true) => {
  const view = executionNodes.get(id);
  if (!view) return;
  view.node.dataset.state = state;
  if (activity) view.activity.textContent = activity;
  if (detail !== undefined) view.detail.textContent = detail;
  if (redraw) scheduleConnections();
};

const renderVariableList = () => {
  if (!elements.executionVariableList) return;
  executionVariableNodes.clear();
  elements.executionVariableList.innerHTML = "";
  for (const variable of agentManifest?.variables ?? []) {
    const chip = document.createElement("span");
    const name = document.createElement("strong");
    const type = document.createElement("small");
    chip.className = "execution-variable";
    chip.dataset.variable = variable.key;
    name.textContent = variable.key;
    type.textContent = variable.type ?? "value";
    chip.append(name, type);
    elements.executionVariableList.append(chip);
    executionVariableNodes.set(variable.key, chip);
  }
};

const runtimeVariablesForStep = (stepId) => {
  const step = stepDefinitions.get(stepId);
  if (!step) return [];
  const runtimeVariables = new Set(
    (agentManifest?.variables ?? []).map((variable) => variable.key),
  );
  return [...referencedVariables(step)].filter((variable) =>
    runtimeVariables.has(variable),
  );
};

const renderExecutionGraph = () => {
  if (!agentManifest || !elements.executionGraph) return;
  executionNodes.clear();
  executionEdges.length = 0;
  elements.executionGraph.innerHTML = "";
  const steps = agentManifest.steps ?? [];
  const dependencies = dependencyGraph(steps);
  const { levelByStep, levels } = executionLayout(steps, dependencies);
  const maxLevel = Math.max(1, ...levelByStep.values());
  const stepColumns = maxLevel + 1;
  elements.executionGraph.style.setProperty(
    "--execution-columns",
    String(stepColumns),
  );

  for (const step of steps) {
    const level = levelByStep.get(step.id) ?? 1;
    const siblings = levels.get(level) ?? [step.id];
    const siblingIndex = siblings.indexOf(step.id);
    const row = siblings.length === 1 ? 2 : siblingIndex % 2 === 0 ? 1 : 3;
    createExecutionNode({
      id: step.id,
      kind: "step",
      eyebrow: `Step ${stepNumbers.get(step.id) ?? siblingIndex + 1}`,
      name: step.name ?? step.id,
      detail: step.type === "prompt" ? "Model response" : step.type,
      outputVariable: step.outputVariable,
      column: level,
      row,
    });
  }

  createExecutionNode({
    id: "run-output",
    kind: "terminal",
    eyebrow: "Agent result",
    name: "Final output",
    detail: "Waiting",
    column: stepColumns,
    row: 2,
  });
  createExecutionNode({
    id: "service-model",
    kind: "service",
    eyebrow: "Third-party AI",
    name: configuredModel,
    detail: "Model API",
    column: Math.max(2, stepColumns - 2),
    row: 4,
  });
  createExecutionNode({
    id: "service-tool",
    kind: "service",
    eyebrow: "Third-party tool",
    name: configuredTool,
    detail: "MCP connection",
    column: 2,
    row: 4,
  });

  const finalSteps = steps.filter(
    (step) => !dependencies.some((edge) => edge.source === step.id),
  );
  executionEdges.push(
    ...dependencies.map((edge) => ({
      ...edge,
      kind: "flow",
    })),
    ...finalSteps.map((step) => ({
      source: step.id,
      target: "run-output",
      kind: "flow",
    })),
  );
  renderVariableList();
  scheduleConnections();
};

const nodeCenter = (id) => {
  const element = id.startsWith("variable:")
    ? executionVariableNodes.get(id.slice("variable:".length))
    : executionNodes.get(id)?.node;
  if (!element) return undefined;
  const stage = elements.executionStage.getBoundingClientRect();
  const node = element.getBoundingClientRect();
  return {
    left: node.left - stage.left,
    right: node.right - stage.left,
    top: node.top - stage.top,
    bottom: node.bottom - stage.top,
    x: node.left - stage.left + node.width / 2,
    y: node.top - stage.top + node.height / 2,
  };
};

const connectionPath = (source, target, service = false) => {
  if (service) {
    const travelsDown = source.y < target.y;
    const startY = travelsDown ? source.bottom : source.top;
    const endY = travelsDown ? target.top : target.bottom;
    const bend = startY + (endY - startY) * 0.5;
    return `M ${source.x} ${startY} C ${source.x} ${bend}, ${target.x} ${bend}, ${target.x} ${endY}`;
  }
  const startX = source.right;
  const endX = target.left;
  const bend = startX + (endX - startX) * 0.5;
  return `M ${startX} ${source.y} C ${bend} ${source.y}, ${bend} ${target.y}, ${endX} ${target.y}`;
};

const drawConnections = () => {
  visualizationFrame = undefined;
  if (
    !elements.executionStage ||
    !elements.executionGraph ||
    !elements.executionConnections
  )
    return;
  const width = Math.max(
    elements.executionStage.clientWidth,
    elements.executionGraph.scrollWidth,
  );
  const height = elements.executionStage.clientHeight;
  elements.executionConnections.style.width = `${width}px`;
  elements.executionConnections.setAttribute(
    "viewBox",
    `0 0 ${width} ${height}`,
  );
  elements.executionConnections.innerHTML = "";
  const definitions = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "defs",
  );
  for (const [id, color] of [
    ["model", "#60a5fa"],
    ["tool", "#c084fc"],
    ["variable", "#7ea6ff"],
  ]) {
    const marker = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "marker",
    );
    const arrow = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    marker.setAttribute("id", `execution-arrow-${id}`);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("orient", "auto-start-reverse");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", color);
    marker.append(arrow);
    definitions.append(marker);
  }
  elements.executionConnections.append(definitions);
  const links = [
    ...executionEdges,
    ...[...activeModelSteps].map((stepId) => ({
      source: streamingModelSteps.has(stepId) ? "service-model" : stepId,
      target: streamingModelSteps.has(stepId) ? stepId : "service-model",
      kind: `service model ${streamingModelSteps.has(stepId) ? "response" : "request"}`,
    })),
    ...[...activeToolSteps].map((stepId) => ({
      source: stepId,
      target: "service-tool",
      kind: "service tool request",
    })),
    ...[...toolResponseSteps].map((stepId) => ({
      source: "service-tool",
      target: stepId,
      kind: "service tool response",
    })),
    ...[...activeVariableReads].flatMap(([stepId, variables]) =>
      variables.map((variable) => ({
        source: `variable:${variable}`,
        target: stepId,
        kind: "variable-read",
      })),
    ),
  ];
  links.forEach((edge, index) => {
    const source = nodeCenter(edge.source);
    const target = nodeCenter(edge.target);
    if (!source || !target) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const pathId = `execution-path-${index}`;
    path.setAttribute("id", pathId);
    path.setAttribute(
      "d",
      connectionPath(
        source,
        target,
        edge.kind.includes("service") || edge.kind === "variable-read",
      ),
    );
    path.setAttribute("class", `execution-connection ${edge.kind}`);
    if (edge.kind.includes("service") || edge.kind === "variable-read") {
      const marker =
        edge.kind === "variable-read"
          ? "variable"
          : edge.kind.includes("tool")
            ? "tool"
            : "model";
      path.setAttribute("marker-end", `url(#execution-arrow-${marker})`);
    }
    if (edge.kind === "flow") {
      const sourceState = executionNodes.get(edge.source)?.node.dataset.state;
      const targetState = executionNodes.get(edge.target)?.node.dataset.state;
      const responseIsStreaming = targetState === "streaming";
      if (sourceState === "complete" && !responseIsStreaming)
        path.classList.add("ready");
      if (targetState === "running") path.classList.add("transmitting");
      if (targetState === "complete") path.classList.add("complete");
    }
    elements.executionConnections.append(path);
  });
};

const scheduleConnections = () => {
  if (!elements.executionConnections || visualizationFrame) return;
  visualizationFrame = requestAnimationFrame(drawConnections);
};

const resetExecutionGraph = () => {
  activeModelSteps.clear();
  activeToolSteps.clear();
  streamingModelSteps.clear();
  toolResponseSteps.clear();
  activeVariableReads.clear();
  streamedCharacters.clear();
  completedModelCalls.clear();
  if (!elements.executionStage) return;
  for (const [id, view] of executionNodes) {
    view.node.dataset.state = "waiting";
    view.detail.textContent = view.defaultDetail;
    view.activity.textContent = id.startsWith("service-") ? "Idle" : "Waiting";
  }
  elements.executionStage.dataset.state = "idle";
  elements.executionVariableList.dataset.state = "waiting";
  elements.visualizationStatus.textContent = "Starting run";
  elements.visualizationSignal.dataset.state = "running";
  scheduleConnections();
};

const handleExecutionEvent = (event) => {
  if (!elements.executionStage) return;
  const stepId = event.stepId;
  if (event.type === "run.started") {
    startRunTimer();
    elements.executionStage.dataset.state = "running";
    elements.visualizationStatus.textContent = "Run started";
  }
  if (event.type === "step.started" && stepId) {
    activeVariableReads.set(stepId, runtimeVariablesForStep(stepId));
    setExecutionNode(stepId, "running", "Running", "Preparing model call");
    elements.visualizationStatus.textContent = `${stepNames.get(stepId) ?? stepId} started`;
  }
  if (event.type === "model.started" && stepId) {
    toolResponseSteps.delete(stepId);
    activeModelSteps.add(stepId);
    streamingModelSteps.delete(stepId);
    const count = (completedModelCalls.get(stepId) ?? 0) + 1;
    setExecutionNode(stepId, "running", "Calling AI", `Model call ${count}`);
    setExecutionNode(
      "service-model",
      "running",
      activeModelSteps.size > 1
        ? `${activeModelSteps.size} calls`
        : "Request received",
      "Streaming model API",
    );
  }
  if (event.type === "model.text.delta" && stepId) {
    const beganStreaming = !streamingModelSteps.has(stepId);
    streamingModelSteps.add(stepId);
    if (beganStreaming) activeVariableReads.delete(stepId);
    const characters =
      (streamedCharacters.get(stepId) ?? 0) +
      String(event.data?.delta ?? "").length;
    streamedCharacters.set(stepId, characters);
    setExecutionNode(
      stepId,
      "streaming",
      "Streaming response",
      `${characters.toLocaleString()} characters`,
      beganStreaming,
    );
    elements.visualizationStatus.textContent =
      activeModelSteps.size > 1
        ? `${activeModelSteps.size} responses streaming`
        : `${stepNames.get(stepId) ?? stepId} streaming`;
  }
  if (event.type === "model.completed" && stepId) {
    activeModelSteps.delete(stepId);
    streamingModelSteps.delete(stepId);
    completedModelCalls.set(stepId, (completedModelCalls.get(stepId) ?? 0) + 1);
    setExecutionNode(
      stepId,
      "running",
      "Response received",
      `${(streamedCharacters.get(stepId) ?? 0).toLocaleString()} characters`,
    );
    setExecutionNode(
      "service-model",
      activeModelSteps.size > 0 ? "running" : "complete",
      activeModelSteps.size > 0
        ? `${activeModelSteps.size} active`
        : "Response sent",
      activeModelSteps.size > 0 ? "Streaming model API" : "Model API",
    );
  }
  if (event.type === "model.tool.requested" && stepId) {
    setExecutionNode(stepId, "running", "Tool requested", "Waiting for MCP");
  }
  if (event.type === "model.tool.started" && stepId) {
    toolResponseSteps.delete(stepId);
    activeToolSteps.add(stepId);
    setExecutionNode(
      stepId,
      "running",
      "Calling tool",
      event.data?.toolName ?? "MCP tool",
    );
    setExecutionNode(
      "service-tool",
      "running",
      "Request received",
      event.data?.toolName ?? "MCP connection",
    );
    elements.visualizationStatus.textContent = `Calling ${configuredTool}`;
  }
  if (event.type === "model.tool.completed" && stepId) {
    activeToolSteps.delete(stepId);
    toolResponseSteps.add(stepId);
    setExecutionNode(
      stepId,
      "running",
      "Tool result received",
      "Returning to model",
    );
    setExecutionNode(
      "service-tool",
      event.data?.failed ? "error" : "complete",
      event.data?.failed ? "Failed" : "Result sent",
      event.data?.toolName ?? "MCP connection",
    );
  }
  if (event.type === "step.completed" && stepId) {
    activeModelSteps.delete(stepId);
    activeToolSteps.delete(stepId);
    streamingModelSteps.delete(stepId);
    toolResponseSteps.delete(stepId);
    activeVariableReads.delete(stepId);
    setExecutionNode(
      stepId,
      "complete",
      "Complete",
      `${(streamedCharacters.get(stepId) ?? 0).toLocaleString()} characters`,
    );
  }
  if (event.type === "step.skipped" && stepId) {
    activeVariableReads.delete(stepId);
    setExecutionNode(stepId, "skipped", "Skipped", "Condition was false");
  }
  if (event.type === "step.failed" && stepId) {
    activeVariableReads.delete(stepId);
    setExecutionNode(stepId, "error", "Failed", "Step error");
  }
  if (event.type === "run.completed") {
    stopRunTimer("complete");
    elements.executionStage.dataset.state = "complete";
    elements.visualizationStatus.textContent = "Run complete";
    elements.visualizationSignal.dataset.state = "complete";
    setExecutionNode(
      "run-output",
      "complete",
      "Ready",
      "Final output assembled",
    );
  }
  if (event.type === "run.failed" || event.type === "run.cancelled") {
    stopRunTimer("error");
    elements.executionStage.dataset.state = "error";
    elements.visualizationStatus.textContent =
      event.type === "run.cancelled" ? "Run cancelled" : "Run failed";
    elements.visualizationSignal.dataset.state = "error";
    setExecutionNode(
      "run-output",
      "error",
      event.type === "run.cancelled" ? "Cancelled" : "Failed",
      "No final output",
    );
  }
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
  resetRunTimer();
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
  resetExecutionGraph();
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
  handleExecutionEvent(event);
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
    elements.executionVariableList.dataset.state = "active";
    renderContract();
    return;
  }
  if (message.kind === "event") {
    handleEvent(message.event);
    return;
  }
  if (message.kind === "result") {
    stopRunTimer("complete");
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
    elements.executionVariableList.dataset.state = "complete";
    setExecutionNode(
      "run-output",
      "complete",
      "Ready",
      "Final output assembled",
    );
    return;
  }
  if (message.kind === "error") {
    stopRunTimer("error");
    elements.runError.hidden = false;
    elements.runError.textContent = message.error.message;
    elements.activeStep.textContent = message.error.cancelled
      ? "Cancelled"
      : "Failed";
    setStatus(message.error.cancelled ? "Cancelled" : "Failed", "error");
    elements.executionVariableList.dataset.state = "error";
    elements.executionStage.dataset.state = "error";
    elements.visualizationStatus.textContent = message.error.cancelled
      ? "Run cancelled"
      : "Run failed";
    elements.visualizationSignal.dataset.state = "error";
    setExecutionNode(
      "run-output",
      "error",
      message.error.cancelled ? "Cancelled" : "Failed",
      "No final output",
    );
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
  elements.runButton.dataset.state = "running";
  elements.runButtonLabel.textContent = "Cancel run";
  elements.runButton.setAttribute("aria-label", "Cancel active agent run");
  elements.runButton.setAttribute("aria-busy", "true");
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
    stopRunTimer("error");
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
    elements.executionVariableList.dataset.state = "error";
    elements.executionStage.dataset.state = "error";
    elements.visualizationStatus.textContent = cancelled
      ? "Run cancelled"
      : "Run failed";
    elements.visualizationSignal.dataset.state = "error";
    setExecutionNode(
      "run-output",
      "error",
      cancelled ? "Cancelled" : "Failed",
      "No final output",
    );
  } finally {
    abortController = undefined;
    elements.runButton.dataset.state = "idle";
    elements.runButtonLabel.textContent = "Run agent";
    elements.runButton.setAttribute("aria-label", "Run agent");
    elements.runButton.setAttribute("aria-busy", "false");
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
    configuredModel = `${config.provider}/${config.model}`;
    configuredTool = config.mcp;
    renderExecutionGraph();
    renderContract();
  } catch (error) {
    elements.runtimeLabel.textContent =
      error instanceof Error ? error.message : "Example server unavailable";
    setStatus("Unavailable", "error");
  }
};

elements.form.addEventListener("submit", runAgent);
elements.runButton.setAttribute(
  "aria-keyshortcuts",
  "Meta+Enter Control+Enter",
);
elements.runButton.title = "Run or cancel agent (⌘+Enter / Ctrl+Enter)";
elements.runButton.addEventListener("click", () => {
  if (abortController) abortController.abort();
  else elements.form.requestSubmit();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.repeat
  ) {
    event.preventDefault();
    elements.runButton.click();
  }
});
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

window.addEventListener("resize", scheduleConnections);

await load();
