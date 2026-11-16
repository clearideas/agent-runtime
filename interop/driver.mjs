#!/usr/bin/env node
/**
 * Scenario driver for the cross-language suite (TypeScript side).
 *
 * Reads a JSON array of scenarios from stdin and writes a JSON array of
 * reports. A scenario runs one manifest through a sequence of `runs` (new runs
 * and resumes) with a deterministic clock, sequential ids, and scripted host
 * adapters; the report contains every observable output: run results or
 * errors, events, checkpoints, and run-store records. `driver.py` implements
 * the same contract for the Python runtime, and the reports must be equal.
 */
import { readFileSync } from "node:fs";

import {
  AgentRuntime,
  RunSuspendedError,
  compilePromptTemplate,
} from "@clearideas/agent-runtime-core";
import {
  CollectingEventSink,
  MemoryRunStore,
  SequenceIdGenerator,
} from "@clearideas/agent-runtime-core/testing";
import { JexlConditionEvaluator } from "@clearideas/agent-runtime-condition-jexl";
import {
  DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
  PromptMessageHistoryCompactor,
  PromptStepExecutor,
} from "@clearideas/agent-runtime-step-prompt";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { AiSdkModelAdapter } from "@clearideas/agent-runtime-model-ai-sdk";
import { FileRunStore } from "@clearideas/agent-runtime-store-local";
import { SqliteRunStore } from "@clearideas/agent-runtime-store-sqlite";

process.removeAllListeners("warning");
process.on("warning", () => {});

/** Advances by `stepMs` on every read, starting at `start`. */
class TickingClock {
  #ms;
  #step;
  constructor(start = "2026-01-01T00:00:00.000Z", stepMs = 1) {
    this.#ms = Date.parse(start);
    this.#step = stepMs;
  }
  now() {
    const value = new Date(this.#ms);
    this.#ms += this.#step;
    return value;
  }
}

/**
 * The scripted "echo" executor: deterministic behaviour selected by
 * `step.extensions.test`: output, fail, suspendOnce, endRun, children.
 */
const echoExecutors = (types) => {
  const suspended = new Set();
  return types.map((type) => ({
    type,
    async execute(context) {
      const test = context.step.extensions?.test ?? {};
      const text = compilePromptTemplate(
        context.step.prompt ?? context.step.id,
        context.variables,
      );
      if (test.fail) {
        const error = new Error(test.fail);
        if (test.code) error.code = test.code;
        throw error;
      }
      if (test.suspendOnce && !context.resume && !suspended.has(context.step.id)) {
        suspended.add(context.step.id);
        await context.checkpoint?.({
          state: { ...context.variables },
          continuation: { phase: "waiting" },
        });
        throw new RunSuspendedError("approval", { stepId: context.step.id });
      }
      if (context.step.type === "loop" && context.executeChild) {
        let state = { ...context.variables };
        const outputs = [];
        for (const child of context.step.steps) {
          const result = await context.executeChild(
            child,
            state,
            `${context.stepPath}/${child.id}`,
          );
          state = { ...state, ...(result.statePatch?.set ?? {}) };
          outputs.push(result.output ?? null);
        }
        return { output: outputs, statePatch: { set: state } };
      }
      const output = test.output ?? `${context.step.id}: ${text}`;
      return {
        output,
        ...(context.step.outputVariable
          ? { statePatch: { set: { [context.step.outputVariable]: output } } }
          : {}),
        ...(test.usage
          ? {
              transcript: [
                {
                  id: `usage-${context.step.id}`,
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: String(output) }],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  usage: test.usage,
                },
              ],
            }
          : {}),
        ...(test.endRun ? { endRun: true } : {}),
      };
    },
  }));
};

/**
 * Deterministic host adapters for real step executors. `scenario.model`
 * scripts main-model responses in order; summarizer requests (recognized by
 * the built-in summarizer system prompt) get `summary`. `scenario.tools`
 * declares tools whose output is derived from the call input.
 */
const scriptedHost = (scenario) => {
  const spec = scenario.model ?? {};
  const script = [...(spec.script ?? [])];
  const modelRequests = [];
  const toolCalls = [];
  let callSequence = 0;
  let replySequence = 0;
  const isSummary = (request) =>
    request.messages.some(
      (message) =>
        message.role === "system" &&
        message.content.some(
          (part) =>
            part.type === "text" &&
            part.text === DEFAULT_SUMMARIZER_SYSTEM_PROMPT,
        ),
    );
  const respond = (request) => {
    const { signal: _signal, ...recorded } = request;
    modelRequests.push(JSON.parse(JSON.stringify(recorded)));
    let entry;
    if (isSummary(request)) {
      const summary = spec.summary ?? { text: "Summary of earlier material." };
      const words = /about (\d+) words/u.exec(JSON.stringify(request.messages));
      entry = {
        ...summary,
        text: summary.words
          ? "note ".repeat(Math.max(1, Number(words?.[1] ?? 1))).trim()
          : summary.text,
      };
    } else {
      entry = script.shift() ?? { text: spec.final ?? "final answer" };
    }
    if (entry.error) {
      const error = new Error(entry.error.message);
      for (const key of ["name", "code", "statusCode"])
        if (entry.error[key] !== undefined) error[key] = entry.error[key];
      throw error;
    }
    const calls = (entry.calls ?? []).map((call) => ({
      id: `call-${++callSequence}`,
      name: call.name,
      input: call.input ?? {},
    }));
    return {
      ...(entry.output !== undefined
        ? { output: entry.output }
        : entry.text !== undefined
          ? { output: entry.text }
          : {}),
      toolCalls: calls,
      finishReason: entry.finishReason ?? (calls.length ? "tool-calls" : "stop"),
      transcript: [
        {
          id: `reply-${++replySequence}`,
          type: "message",
          role: "assistant",
          content: [
            ...(entry.text ? [{ type: "text", text: entry.text }] : []),
            ...calls.map((call) => ({ type: "tool-call", call })),
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          ...(entry.usage ? { usage: entry.usage } : {}),
        },
      ],
    };
  };
  const model = {
    generate: async (request) => respond(request),
    ...(spec.stream
      ? {
          stream: async function* (request) {
            const result = respond(request);
            if (typeof result.output === "string" && result.output)
              yield { type: "text-delta", delta: result.output };
            yield { type: "completed", result };
          },
        }
      : {}),
    ...(spec.describe ? { describeModel: async () => spec.describe } : {}),
  };
  const declared = scenario.tools ?? [];
  const tools = {
    listTools: async () =>
      declared.map((tool) => ({
        name: tool.name,
        inputSchema: { type: "object" },
      })),
    executeTool: async (call, context) => {
      toolCalls.push({
        id: call.id,
        name: call.name,
        idempotencyKey: context.idempotencyKey,
      });
      const tool = declared.find((entry) => entry.name === call.name) ?? {};
      if (tool.error)
        return { callId: call.id, name: call.name, error: tool.error };
      return {
        callId: call.id,
        name: call.name,
        output:
          tool.output ??
          `${String(call.input.path ?? "file")}: ${"data ".repeat(Math.floor((tool.size ?? 50) / 5))}`,
      };
    },
  };
  let transcriptSequence = 0;
  let keySequence = 0;
  const options = {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    generateTranscriptId: () => `item-${++transcriptSequence}`,
    generateToolIdempotencyKey: () => `key-${++keySequence}`,
    sleep: async () => undefined,
  };
  return { model, tools, modelRequests, toolCalls, options };
};

/**
 * `scenario.provider` replaces the scripted model with `AiSdkModelAdapter` and
 * the AI SDK provider for `driver`, pointed at the suite's mock server.
 */
const providerModel = (spec, options) => {
  const common = {
    apiKey: "test-key",
    baseURL: spec.baseURL,
    headers: { "x-case": spec.caseId },
  };
  const factories = {
    openai: createOpenAI,
    anthropic: createAnthropic,
    google: createGoogleGenerativeAI,
    xai: createXai,
    groq: createGroq,
    cohere: createCohere,
  };
  const provider =
    spec.driver === "openai-compatible"
      ? createOpenAICompatible({ name: spec.name ?? "local", ...common })
      : factories[spec.driver](common);
  return new AiSdkModelAdapter({
    resolveModel: (model) => provider(model.slice(model.indexOf("/") + 1)),
    now: options.now,
    generateTranscriptId: options.generateTranscriptId,
  });
};

const errorReport = (error) => ({
  name: error?.name ?? "Error",
  message: error?.message ?? String(error),
  ...(typeof error?.code === "string" ? { code: error.code } : {}),
  ...(typeof error?.reason === "string" ? { reason: error.reason } : {}),
});

const openStore = (options) => {
  if (!options) return new MemoryRunStore();
  if (options.kind === "file") return new FileRunStore(options.path);
  if (options.kind === "sqlite") return new SqliteRunStore(options.path);
  throw new Error(`Unknown store kind: ${options.kind}`);
};

const runScenario = async (scenario) => {
  const store = openStore(scenario.store);
  const events = new CollectingEventSink();
  const ids = new SequenceIdGenerator();
  for (let index = 0; index < (scenario.idOffset ?? 0); index += 1)
    ids.generateId("run");
  const clock = new TickingClock(scenario.clock?.start, scenario.clock?.stepMs);
  const runs = [];
  const host = scriptedHost(scenario);
  const real = new Set(scenario.real ?? []);
  for (const run of scenario.runs) {
    const executors = echoExecutors(
      (scenario.executors ?? ["prompt", "loop"]).filter(
        (type) => !real.has(type),
      ),
    );
    if (real.has("prompt"))
      executors.push(new PromptStepExecutor(host.options));
    const runtime = new AgentRuntime({
      runStore: store,
      eventSinks: [events],
      idGenerator: ids,
      clock,
      conditionEvaluator: new JexlConditionEvaluator(),
      stepExecutors: executors,
      ...(real.size > 0
        ? {
            model: scenario.provider
              ? providerModel(scenario.provider, host.options)
              : host.model,
            tools: host.tools,
          }
        : {}),
      ...(scenario.policies ? { policies: scenario.policies } : {}),
      ...(scenario.compactor
        ? {
            messages: {
              compactor: new PromptMessageHistoryCompactor(host.options),
            },
          }
        : {}),
    });
    try {
      const result = await runtime.run({
        ...(run.resume ? {} : { manifest: scenario.manifest }),
        ...run.request,
      });
      runs.push({ ok: true, result });
    } catch (error) {
      runs.push({ ok: false, error: errorReport(error) });
    }
  }
  if (scenario.store) {
    const stored = {};
    for (const runId of scenario.storedRunIds ?? []) {
      stored[runId] = {
        record: await store.loadRun(runId),
        checkpoint: await store.loadLatestCheckpoint(runId),
      };
    }
    store.close?.();
    return {
      runs,
      events: events.events,
      stored,
      modelRequests: host.modelRequests,
      toolCalls: host.toolCalls,
    };
  }
  return {
    runs,
    modelRequests: host.modelRequests,
    toolCalls: host.toolCalls,
    events: events.events,
    checkpoints: Object.fromEntries(store.checkpoints),
    records: Object.fromEntries(store.runs),
    failures: Object.fromEntries(store.failures),
  };
};

const scenarios = JSON.parse(readFileSync(0, "utf8"));
const reports = [];
for (const scenario of scenarios) reports.push(await runScenario(scenario));
process.stdout.write(JSON.stringify(reports));
