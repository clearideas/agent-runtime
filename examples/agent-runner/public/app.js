const element = (id) => document.querySelector(`#${id}`);

// Ace provides YAML and JSON highlighting without adding a frontend build.
const ace = globalThis.ace;
ace.config.set("basePath", "/vendor");
const manifestEditor = ace.edit("manifest-source");
manifestEditor.setTheme("ace/theme/textmate");
manifestEditor.setOptions({
  fontSize: "0.85rem",
  showPrintMargin: false,
  tabSize: 2,
  useSoftTabs: true,
});
// Syntax checking workers are not needed for this example.
manifestEditor.session.setUseWorker(false);

let manifestMode;
const updateManifestMode = () => {
  const nextMode = manifestEditor.getValue().trimStart().startsWith("{")
    ? "json"
    : "yaml";
  if (nextMode === manifestMode) return;
  manifestMode = nextMode;
  manifestEditor.session.setMode(`ace/mode/${nextMode}`);
};

const setManifestSource = (source) => {
  manifestEditor.setValue(source, -1);
  updateManifestMode();
};

manifestEditor.session.on("change", updateManifestMode);

const ui = {
  manifestSelect: element("manifest-select"),
  manifestMessage: element("manifest-message"),
  newManifestButton: element("new-manifest-button"),
  saveManifestButton: element("save-manifest-button"),
  manifestName: element("manifest-name"),
  manifestDescription: element("manifest-description"),
  variableFields: element("variable-fields"),
  runForm: element("run-form"),
  runButton: element("run-button"),
  runStatus: element("run-status"),
  stepList: element("step-list"),
  runOutput: element("run-output"),
  runError: element("run-error"),
  resumeButton: element("resume-button"),
  runList: element("run-list"),
};

const newManifest = `schemaVersion: "1.0"
id: hello
name: Hello

model:
  ref: default

variables:
  - key: topic
    type: string
    value: durable checkpoints

steps:
  - id: explain
    type: prompt
    prompt: Explain {{ topic }} in three sentences.
    includeInFinalOutput: true
`;

const state = {
  manifests: [],
  selectedManifestId: null,
  selectedRunId: null,
  stepElements: new Map(),
};

const selectedManifest = () =>
  state.manifests.find((item) => item.id === state.selectedManifestId);

const requestJson = async (url, options) => {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed.`);
  return value;
};

const outputText = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

const runLabel = (run) => {
  const timestamp =
    run.status === "completed"
      ? ` — ${new Date(run.updatedAt).toLocaleString()}`
      : "";
  return `${run.agentName} — ${run.status}${timestamp}`;
};

const showError = (message = "") => {
  ui.runError.textContent = message;
  ui.runError.hidden = !message;
};

const renderManifestSelect = () => {
  ui.manifestSelect.replaceChildren(
    ...state.manifests.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.manifest.name ?? item.manifest.id ?? "Untitled";
      option.selected = item.id === state.selectedManifestId;
      return option;
    }),
  );
};

const inputFor = (definition) => {
  const label = document.createElement("label");
  label.textContent = `${definition.key} (${definition.type})`;

  let input;
  if (definition.type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = definition.value === true;
  } else if (definition.type === "number") {
    input = document.createElement("input");
    input.type = "number";
    input.value = definition.value ?? "";
  } else if (["object", "array", "json"].includes(definition.type)) {
    input = document.createElement("textarea");
    input.rows = 3;
    input.value = JSON.stringify(
      definition.value ?? (definition.type === "array" ? [] : {}),
      null,
      2,
    );
  } else {
    input = document.createElement("input");
    input.value = definition.value ?? "";
  }

  input.dataset.key = definition.key;
  input.dataset.type = definition.type;
  label.append(input);
  return label;
};

const renderSteps = (steps) => {
  state.stepElements.clear();
  ui.stepList.replaceChildren(
    ...steps.map((step) => {
      const item = document.createElement("li");
      const status = document.createElement("div");
      status.textContent = `${step.name ?? step.id} — waiting`;
      const output = document.createElement("pre");
      output.className = "step-output";
      output.hidden = true;
      item.append(status, output);
      state.stepElements.set(step.id, {
        item,
        status,
        output,
        label: step.name ?? step.id,
      });
      return item;
    }),
  );
};

const updateStep = (stepId, status) => {
  const step = state.stepElements.get(stepId);
  if (!step) return;
  step.status.textContent = `${step.label} — ${status}`;
  step.item.dataset.status = status;
};

const showStepResults = (results, runCompleted = false) => {
  const completed = new Set();
  for (const result of results) {
    completed.add(result.stepId);
    updateStep(result.stepId, "completed");
    const step = state.stepElements.get(result.stepId);
    if (step && result.output !== undefined) {
      step.output.textContent = outputText(result.output);
      step.output.hidden = false;
    }
  }
  if (runCompleted) {
    for (const stepId of state.stepElements.keys()) {
      if (!completed.has(stepId)) updateStep(stepId, "skipped");
    }
  }
};

const renderManifest = () => {
  const selected = selectedManifest();
  if (!selected) return;
  setManifestSource(selected.source);
  ui.manifestName.textContent = selected.manifest.name ?? "Run agent";
  ui.manifestDescription.textContent = selected.manifest.description ?? "";
  ui.variableFields.replaceChildren(
    ...(selected.manifest.variables ?? []).map(inputFor),
  );
  renderSteps(selected.manifest.steps);
  ui.runOutput.textContent = "Run the agent to see its output.";
  ui.runStatus.textContent = "Ready";
  ui.resumeButton.hidden = true;
  state.selectedRunId = null;
  showError();
};

const renderRuns = (runs) => {
  ui.runList.replaceChildren(
    ...(runs.length
      ? runs.map((run) => {
          const button = document.createElement("button");
          button.textContent = runLabel(run);
          button.addEventListener("click", () => showRun(run));
          return button;
        })
      : [document.createTextNode("No runs yet.")]),
  );
};

const refreshRuns = async () => renderRuns(await requestJson("/api/runs"));

const showRun = (run) => {
  const manifest = state.manifests.find(
    (item) => item.manifest.id === run.agentId,
  );
  if (manifest) {
    state.selectedManifestId = manifest.id;
    renderManifestSelect();
    renderManifest();
  }
  state.selectedRunId = run.runId;
  ui.runStatus.textContent = run.status;
  ui.runOutput.textContent =
    run.output == null ? "No final output." : outputText(run.output);
  showStepResults(run.stepResults, run.status === "completed");
  ui.resumeButton.hidden = !["failed", "suspended"].includes(run.status);
  showError(run.error?.message);
};

const variableValues = () =>
  [...ui.variableFields.querySelectorAll("[data-key]")].map((input) => {
    let value = input.value;
    if (input.dataset.type === "boolean") value = input.checked;
    if (input.dataset.type === "number") value = Number(input.value);
    if (["object", "array", "json"].includes(input.dataset.type)) {
      value = JSON.parse(input.value);
    }
    return { key: input.dataset.key, value };
  });

const processMessage = (message) => {
  if (message.kind === "accepted") {
    ui.runStatus.textContent = message.runId;
  } else if (message.kind === "event") {
    const event = message.event;
    if (event.type === "run.resumed") {
      const completed = Number(event.data?.startStepIndex ?? 0);
      [...state.stepElements.keys()]
        .slice(0, completed)
        .forEach((stepId) => updateStep(stepId, "restored"));
    }
    if (event.type === "step.started") updateStep(event.stepId, "running");
    if (event.type === "step.completed") updateStep(event.stepId, "completed");
    if (event.type === "step.skipped") updateStep(event.stepId, "skipped");
    if (event.type === "step.failed") updateStep(event.stepId, "failed");
    if (event.type === "model.started") ui.runOutput.textContent = "";
    if (event.type === "model.text.delta") {
      ui.runOutput.textContent += String(event.data?.delta ?? "");
    }
  } else if (message.kind === "result") {
    ui.runStatus.textContent = "completed";
    ui.runOutput.textContent = outputText(message.result.output);
    showStepResults(message.result.stepResults, true);
  } else if (message.kind === "error") {
    throw new Error(message.error.message);
  }
};

const streamRun = async (body) => {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.body) throw new Error("The server did not return a stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line) processMessage(JSON.parse(line));
    if (done) break;
  }
  if (buffer) processMessage(JSON.parse(buffer));
};

const run = async (body) => {
  showError();
  ui.runStatus.textContent = "running";
  ui.runOutput.textContent = "";
  ui.runButton.disabled = true;
  ui.resumeButton.hidden = true;
  try {
    await streamRun(body);
  } catch (error) {
    ui.runStatus.textContent = "failed";
    showError(error.message);
  } finally {
    ui.runButton.disabled = false;
    await refreshRuns();
  }
};

ui.manifestSelect.addEventListener("change", () => {
  state.selectedManifestId = ui.manifestSelect.value;
  renderManifest();
});

ui.newManifestButton.addEventListener("click", () => {
  state.selectedManifestId = null;
  ui.manifestSelect.selectedIndex = -1;
  setManifestSource(newManifest);
  ui.manifestName.textContent = "Save this manifest to run it";
  ui.manifestDescription.textContent = "";
  ui.variableFields.replaceChildren();
  renderSteps([]);
  ui.manifestMessage.textContent = "Edit the template, then save it.";
});

ui.saveManifestButton.addEventListener("click", async () => {
  try {
    const saved = await requestJson("/api/manifests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: manifestEditor.getValue(),
        ...(state.selectedManifestId ? { id: state.selectedManifestId } : {}),
      }),
    });
    const index = state.manifests.findIndex((item) => item.id === saved.id);
    if (index === -1) state.manifests.push(saved);
    else state.manifests[index] = saved;
    state.selectedManifestId = saved.id;
    renderManifestSelect();
    renderManifest();
    ui.manifestMessage.textContent = "Saved.";
  } catch (error) {
    ui.manifestMessage.textContent = error.message;
  }
});

ui.runForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = selectedManifest();
  if (!selected) return;
  renderSteps(selected.manifest.steps);
  await run({ manifestId: selected.id, variables: variableValues() });
});

ui.resumeButton.addEventListener("click", async () => {
  if (!state.selectedRunId) return;
  await run({ runId: state.selectedRunId });
});

const [manifests, runs] = await Promise.all([
  requestJson("/api/manifests"),
  requestJson("/api/runs"),
]);
state.manifests = manifests;
state.selectedManifestId = manifests[0]?.id ?? null;
renderManifestSelect();
renderManifest();
renderRuns(runs);
