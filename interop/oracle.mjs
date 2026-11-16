#!/usr/bin/env node
/**
 * TypeScript oracle for the cross-language test suite.
 *
 * Reads one JSON request from stdin, `{ "op": string, "inputs": unknown[] }`,
 * evaluates every input with the built TypeScript packages, and writes
 * `{ "results": unknown[] }` to stdout. Each result is
 * `{ "ok": true, "value": ... }` or `{ "ok": false, "error": { name, message, code? } }`.
 *
 * The Python test suite sends the same inputs to the Python implementation and
 * requires identical results.
 */
import { readFileSync } from "node:fs";

const ops = {};
const op = (name, fn) => {
  ops[name] = fn;
};

const contracts = () => import("@clearideas/agent-runtime-contracts");
const core = () => import("@clearideas/agent-runtime-core");

// ─── Primitives ──────────────────────────────────────────────────────────────
op("stringify", (input) => JSON.stringify(input.value, null, input.indent));
op("stringifyParsed", (text) => JSON.stringify(JSON.parse(text)));
op("canonicalJson", async (value) => (await core()).canonicalJson(value));
op(
  "jsonByteLength",
  (value) => new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength,
);
op("localeSort", (keys) => [...keys].sort((a, b) => a.localeCompare(b)));
op("yamlParse", async (text) => {
  const { parse } = await import("yaml");
  return JSON.stringify(parse(text)) ?? "undefined";
});
op("url", (text) => {
  const url = new URL(text);
  return {
    href: url.href,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    username: url.username,
    password: url.password,
  };
});
op("isoString", (ms) => new Date(ms).toISOString());
op("dateParse", (text) => {
  const value = Date.parse(text);
  return Number.isNaN(value) ? "NaN" : value;
});
op("utf16", (text) => ({
  length: text.length,
  head: text.slice(0, 3),
  tail: text.slice(-3),
  lower: text.toLowerCase(),
  trim: text.trim(),
}));

// ─── Contracts ───────────────────────────────────────────────────────────────
op("safeParse", async ({ schema, value }) => {
  const module = await contracts();
  const target = module[schema];
  if (!target) throw new Error(`Unknown schema: ${schema}`);
  const result = target.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : {
        success: false,
        issues: result.error.issues,
        message: result.error.message,
      };
});

// ─── Conditions ──────────────────────────────────────────────────────────────
let jexlEvaluator;
const jexl = async () => {
  if (!jexlEvaluator) {
    const { JexlConditionEvaluator } =
      await import("@clearideas/agent-runtime-condition-jexl");
    jexlEvaluator = new JexlConditionEvaluator();
  }
  return jexlEvaluator;
};
op("condition", async ({ expression, variables }) => {
  const evaluator = await jexl();
  let invalid;
  try {
    evaluator.validate(expression);
  } catch (error) {
    invalid = { name: error.name, message: error.message };
  }
  const validity = invalid ? { valid: false, invalid } : { valid: true };
  try {
    return {
      ...validity,
      value: await evaluator.evaluate(expression, variables),
    };
  } catch (error) {
    return { ...validity, error: { name: error.name, message: error.message } };
  }
});

// ─── Runtime functions ───────────────────────────────────────────────────────
op("manifestHash", async (manifest) =>
  (await core()).defaultManifestHasher.hash(manifest),
);
op("compilePromptTemplate", async ({ template, variables }) =>
  (await core()).compilePromptTemplate(template, variables),
);

// ─── Prompt-step context management ──────────────────────────────────────────
// Context modules are internal (not package exports); load the built files.
const stepPrompt = (module) =>
  import(
    new URL(
      `../packages/step-prompt/dist/context/${module}.js`,
      import.meta.url,
    ).href
  );
op("pruneText", async ({ text, maxBytes, label }) =>
  (await stepPrompt("prune")).pruneText(text, maxBytes, label),
);
op("pruneJson", async ({ value, maxBytes }) =>
  (await stepPrompt("prune")).pruneJson(value, maxBytes),
);
op("stubToolResult", async ({ part, previewBytes }) =>
  (await stepPrompt("prune")).stubToolResultPart(part, previewBytes),
);
op("clipToolResult", async ({ part, maxBytes }) =>
  (await stepPrompt("prune")).clipToolResultPart(part, maxBytes),
);
op("splitIntoChunks", async ({ text, chunkBytes }) =>
  (await stepPrompt("summarize")).splitIntoChunks(text, chunkBytes),
);
op("fingerprint", async (text) =>
  (await stepPrompt("transcript")).fingerprint(text),
);
op("withinBytes", async ({ text, maxBytes }) => {
  const measure = await stepPrompt("measure");
  return {
    head: measure.headWithinBytes(text, maxBytes),
    tail: measure.tailWithinBytes(text, maxBytes),
    bytes: measure.jsonTextBytes(text),
  };
});
op("classifyError", async (error) => {
  const errors = await stepPrompt("errors");
  return {
    overflow: errors.isContextOverflowError(error),
    retryable: errors.isRetryableModelError(error),
    invalid: errors.isInvalidOutputError(error),
    summary: errors.errorSummary(error),
  };
});
op("compactedView", async (transcript) => {
  const module = await stepPrompt("transcript");
  const view = module.compactedView(transcript);
  return {
    view,
    rounds: module.deriveRounds(view).map((round) => ({
      kind: round.kind,
      ids: round.items.map((item) => item.id),
    })),
    text: module.renderItemsAsText(view),
  };
});

// ─── Host configuration ──────────────────────────────────────────────────────
const config = () => import("@clearideas/agent-runtime-config");
op("parseConfig", async (value) => {
  const result = (await config()).agentRuntimeConfigSchema.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : {
        success: false,
        issues: result.error.issues,
        message: result.error.message,
      };
});

op("mcpToolDigest", async (tool) => {
  const module = await config();
  return {
    canonical: module.canonicalizeMcpToolMetadata(tool),
    digest: module.computeMcpToolDigest(tool),
  };
});

// ─── Execution: sealed worker invocations ───────────────────────────────────
const execution = () => import("@clearideas/agent-runtime-execution");
op(
  "sealInvocation",
  async ({ keys, activeKeyId, invocation, binding, now }) => {
    const { AesGcmWorkerInvocationCodec } = await execution();
    return new AesGcmWorkerInvocationCodec({
      activeKeyId,
      keys,
      now: () => now,
    }).seal(invocation, binding);
  },
);
op("openInvocation", async ({ keys, activeKeyId, envelope, binding, now }) => {
  const { AesGcmWorkerInvocationCodec } = await execution();
  return new AesGcmWorkerInvocationCodec({
    activeKeyId,
    keys,
    now: () => now,
  }).open(envelope, binding);
});

op("runChildExecution", async ({ command, args, cwd, env, request }) => {
  const { ChildProcessExecutionEngine, ExecutionClient } = await execution();
  const client = new ExecutionClient(
    new ChildProcessExecutionEngine({ command, args, cwd, env }),
  );
  const events = [];
  const handle = await client.submit(request);
  const followed = await client.follow(handle, {
    onEvent: (event) => {
      events.push(event);
    },
  });
  return {
    status: followed.status.status,
    error: followed.status.error ?? null,
    result: followed.result ?? null,
    events,
  };
});

// ─── Sandbox policy ──────────────────────────────────────────────────────────
const sandbox = () => import("@clearideas/agent-runtime-sandbox");
const sandboxWorkspace = ({ binding, alias, mode, limits }) => ({
  binding,
  alias,
  mode,
  store: { mode, ...(limits ? { limits } : {}) },
});
op("resolveRunSandboxPolicy", async (input) =>
  (await sandbox()).resolveRunSandboxPolicy(input),
);
op("describeWorkspaceTools", async ({ policy, workspace }) => {
  const module = await sandbox();
  return module.describeWorkspaceTools(
    sandboxWorkspace(workspace),
    module.resolveRunSandboxPolicy(policy),
  );
});
op("admitCommand", async ({ policy, workspace, request, commandId }) => {
  const module = await sandbox();
  const admitted = module.admitCommand(request, {
    policy: module.resolveRunSandboxPolicy(policy),
    ...(workspace ? { workspace: sandboxWorkspace(workspace) } : {}),
    commandId,
    helperCommand: ["python3", "/workspace/bin/agent-fs"],
    codeProfile: (language) =>
      language === "python"
        ? { extension: "py", argv: (source) => ["python3", source] }
        : undefined,
  });
  return {
    ...admitted,
    stagedFiles: admitted.stagedFiles.map((file) => ({
      ...file,
      content:
        typeof file.content === "string"
          ? file.content
          : Buffer.from(file.content).toString("base64"),
    })),
  };
});

const results = async (name, inputs) => {
  const fn = ops[name];
  if (!fn) throw new Error(`Unknown oracle op: ${name}`);
  const out = [];
  for (const input of inputs) {
    try {
      out.push({ ok: true, value: await fn(input) });
    } catch (error) {
      out.push({
        ok: false,
        error: {
          name: error?.name ?? "Error",
          message: error?.message ?? String(error),
          ...(typeof error?.code === "string" ? { code: error.code } : {}),
        },
      });
    }
  }
  return out;
};

// ─── The public API ──────────────────────────────────────────────────────────
// The value exports of the umbrella package, with their kinds.
op("umbrellaExports", async () => {
  const exports = await import("@clearideas/agent-runtime");
  return Object.keys(exports)
    .sort()
    .map((name) => {
      const value = exports[name];
      const kind = typeof value;
      return ["string", "number", "boolean"].includes(kind)
        ? { name, kind, value }
        : { name, kind };
    });
});

// ─── MCP tools ───────────────────────────────────────────────────────────────
// Lists and calls tools on an MCP server through the configured adapter, as
// a prompt step would: `{ url, tools, calls: [{ name, input, idempotencyKey? }] }`.
op("mcpTools", async ({ url, tools, calls }) => {
  const { createConfiguredToolAdapter, parseAgentRuntimeConfig } =
    await config();
  const adapter = createConfiguredToolAdapter(
    {
      schemaVersion: "1.0",
      connections: [{ ref: "svc", alias: "svc", mode: "read_write", tools }],
      steps: [{ id: "s", type: "prompt", prompt: "p" }],
    },
    parseAgentRuntimeConfig({
      version: "1.0",
      connections: {
        svc: {
          driver: "mcp",
          transport: "streamable-http",
          url,
          mode: "read_write",
          tools,
        },
      },
    }),
    { environment: {} },
  );
  const listed = await adapter.listTools();
  const results = [];
  for (const [index, call] of calls.entries())
    results.push(
      await adapter.executeTool(
        { id: `call-${index}`, name: `svc__${call.name}`, input: call.input },
        {
          runId: "run",
          stepId: "step",
          variables: {},
          ...(call.idempotencyKey
            ? { idempotencyKey: call.idempotencyKey }
            : {}),
        },
      ),
    );
  return { listed, results };
});

// Suppress library warnings (for example unresolved YAML tags) on stderr noise.
process.removeAllListeners("warning");
process.on("warning", () => {});

const request = JSON.parse(readFileSync(0, "utf8"));
const batches = Array.isArray(request) ? request : [request];
const response = [];
for (const batch of batches) {
  response.push({ results: await results(batch.op, batch.inputs ?? []) });
}
process.stdout.write(
  JSON.stringify(Array.isArray(request) ? response : response[0]),
);
