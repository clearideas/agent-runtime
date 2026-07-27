import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import {
  agentManifestSchema,
  agentRunManifestSchema,
} from "../packages/contracts/dist/index.js";
import { agentRuntimeConfigSchema } from "../packages/runtime/dist/index.js";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const documentationDirectory = path.join(repository, "docs");

const requiredPages = [
  "README.md",
  "index.md",
  "quickstart.md",
  "concepts.md",
  "build-agents.md",
  "manifests.md",
  "models-and-providers.md",
  "connections-and-tools.md",
  "events-and-streaming.md",
  "embedding.md",
  "persistence-and-recovery.md",
  "local-execution.md",
  "remote-execution.md",
  "sandboxes-and-artifacts.md",
  "production.md",
  "reference.md",
];

const failures = [];
const assertReadable = async (file, label) => {
  try {
    await access(file);
  } catch {
    failures.push(
      `${label} does not exist: ${path.relative(repository, file)}`,
    );
  }
};

for (const page of requiredPages) {
  await assertReadable(
    path.join(documentationDirectory, page),
    "Required Agent Runtime documentation page",
  );
}

const pages = (await readdir(documentationDirectory))
  .filter((file) => file.endsWith(".md"))
  .map((file) => path.join(documentationDirectory, file));

const markdownLink = /\[[^\]]+\]\(([^)]+)\)/gu;
for (const page of pages) {
  const source = await readFile(page, "utf8");
  for (const match of source.matchAll(markdownLink)) {
    const rawTarget = match[1]?.trim();
    if (
      !rawTarget ||
      rawTarget.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)
    ) {
      continue;
    }
    const withoutTitle = rawTarget.split(/\s+["']/u)[0] ?? rawTarget;
    const target = decodeURIComponent(
      withoutTitle.split("#")[0] ?? withoutTitle,
    );
    await assertReadable(
      path.resolve(path.dirname(page), target),
      `Broken link in ${path.basename(page)}`,
    );
  }
}

const validateYaml = async (relativeFile, schema, label) => {
  const file = path.join(repository, relativeFile);
  const value = parseYaml(await readFile(file, "utf8"));
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    failures.push(
      `${label} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.success ? parsed.data : undefined;
};

const exampleDirectory = path.join(repository, "examples", "manifests");
const yamlExamples = (await readdir(exampleDirectory)).filter(
  (file) =>
    file.endsWith(".agent.yaml") ||
    file.endsWith(".run.yaml") ||
    file.endsWith(".config.yaml"),
);
const sourceAgentExamples = [
  path.join("examples", "interactive-web", "interactive-brief.agent.yaml"),
];

const rootName = (variablePath) => variablePath?.split(".")[0]?.trim();
const templateReference = /\{\{\s*([^}]+?)\s*\}\}/gu;
const expressionIdentifier =
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\b/gu;
const expressionKeywords = new Set([
  "and",
  "false",
  "in",
  "not",
  "null",
  "or",
  "true",
  "undefined",
]);

const templateReferences = (text) =>
  [...text.matchAll(templateReference)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);

const expressionReferences = (expression) => {
  const templatePaths = templateReferences(expression);
  const withoutTemplates = expression.replace(templateReference, " ");
  const withoutStrings = withoutTemplates.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu,
    " ",
  );
  const identifiers = [...withoutStrings.matchAll(expressionIdentifier)]
    .map((match) => match[0])
    .filter((identifier) => !expressionKeywords.has(identifier.toLowerCase()));
  return [...templatePaths, ...identifiers];
};

const validateReference = ({
  file,
  stepPath,
  field,
  reference,
  knownRoots,
}) => {
  const root = rootName(reference);
  if (!root || knownRoots.has(root)) return;
  failures.push(
    `Agent manifest ${file} uses undeclared variable "${reference}" in ${stepPath}.${field}`,
  );
};

const validateSteps = ({ file, steps, knownRoots, parentPath = "steps" }) => {
  for (const [index, step] of steps.entries()) {
    const stepPath = `${parentPath}[${index}](${step.id})`;

    for (const field of ["prompt", "systemPrompt"]) {
      if (typeof step[field] !== "string") continue;
      if (step[field].includes("\\n")) {
        failures.push(
          `Agent manifest ${file} contains a literal "\\n" in ${stepPath}.${field}; use a YAML block scalar for line breaks`,
        );
      }
      for (const reference of templateReferences(step[field])) {
        validateReference({ file, stepPath, field, reference, knownRoots });
      }
    }

    if (typeof step.when === "string") {
      for (const reference of expressionReferences(step.when)) {
        validateReference({
          file,
          stepPath,
          field: "when",
          reference,
          knownRoots,
        });
      }
    }

    if (step.type === "loop") {
      if (step.loop.source && !step.loop.source.includes("{{")) {
        validateReference({
          file,
          stepPath,
          field: "loop.source",
          reference: step.loop.source,
          knownRoots,
        });
      }

      for (const field of ["condition", "goal"]) {
        const expression = step.loop[field];
        if (typeof expression !== "string") continue;
        for (const reference of expressionReferences(expression)) {
          validateReference({
            file,
            stepPath,
            field: `loop.${field}`,
            reference,
            knownRoots,
          });
        }
      }

      const childRoots = new Set(knownRoots);
      childRoots.add(rootName(step.loop.itemVariable ?? "item"));
      childRoots.add(rootName(step.loop.indexVariable ?? "index"));
      childRoots.add("loop");
      validateSteps({
        file,
        steps: step.steps,
        knownRoots: childRoots,
        parentPath: `${stepPath}.steps`,
      });
    }

    const outputRoot = rootName(step.outputVariable);
    if (outputRoot) knownRoots.add(outputRoot);
    const resultRoot =
      step.type === "loop" ? rootName(step.loop.resultVariable) : undefined;
    if (resultRoot) knownRoots.add(resultRoot);
  }
};

for (const file of yamlExamples) {
  const agentManifest = file.endsWith(".agent.yaml");
  const agentRunManifest = file.endsWith(".run.yaml");
  const value = await validateYaml(
    path.join("examples", "manifests", file),
    agentManifest
      ? agentManifestSchema
      : agentRunManifest
        ? agentRunManifestSchema
        : agentRuntimeConfigSchema,
    `${agentManifest ? "Agent Manifest" : agentRunManifest ? "Agent Run Manifest" : "Host configuration"} ${file}`,
  );
  if (agentManifest && value) {
    const knownRoots = new Set(
      (value.variables ?? []).map((definition) => definition.key),
    );
    validateSteps({ file, steps: value.steps, knownRoots });
  }
  if (agentRunManifest && value) {
    await assertReadable(
      path.resolve(exampleDirectory, value.agent.ref),
      `Agent referenced by agent run manifest ${file}`,
    );
  }
}

for (const relativeFile of sourceAgentExamples) {
  const value = await validateYaml(
    relativeFile,
    agentManifestSchema,
    `Agent Manifest ${relativeFile}`,
  );
  if (value) {
    const knownRoots = new Set(
      (value.variables ?? []).map((definition) => definition.key),
    );
    validateSteps({ file: relativeFile, steps: value.steps, knownRoots });
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Agent Runtime docs OK: ${pages.length} pages, ${requiredPages.length} required pages, ${yamlExamples.length + sourceAgentExamples.length} schema- and reference-validated YAML examples.\n`,
  );
}
