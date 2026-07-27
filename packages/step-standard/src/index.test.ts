import type {
  ApprovalStep,
  CodeStep,
  JsonObject,
  RunEvent,
  AgentManifest,
  SubRunStep,
  WebhookStep,
} from "@clearideas/agent-runtime-contracts";
import type {
  ApprovalAdapter,
  SandboxAdapter,
  SandboxRequest,
  SubRunAdapter,
} from "@clearideas/agent-runtime-core/ports";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalRejectedError,
  ApprovalStepExecutor,
  ApprovalTimeoutError,
  CodeStepExecutor,
  type FetchLike,
  SandboxExecutionError,
  SandboxTimeoutError,
  SubRunStepExecutor,
  WebhookHttpError,
  WebhookResponseError,
  WebhookStepExecutor,
  WebhookTimeoutError,
} from "./index.js";

const manifestFor = (
  step: ApprovalStep | WebhookStep | CodeStep | SubRunStep,
): AgentManifest => ({
  schemaVersion: "1.0",
  steps: [step],
});

const eventCollector = (runId = "run-1") => {
  const events: RunEvent[] = [];
  return {
    events,
    emit: async (type: string, data?: JsonObject): Promise<RunEvent> => {
      const event: RunEvent = {
        id: `event-${events.length + 1}`,
        runId,
        sequence: events.length + 1,
        timestamp: "2026-07-22T00:00:00.000Z",
        type,
        ...(data ? { data } : {}),
      };
      events.push(event);
      return event;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalStepExecutor", () => {
  it("passes approval details to the adapter but keeps secrets out of events and metadata", async () => {
    const step: ApprovalStep = {
      id: "approval-1",
      type: "approval",
      prompt: "Approve secret acquisition?",
      metadata: { privateContext: "board-eyes-only" },
      outputVariable: "approval",
      action: "pause",
    };
    const requests: Parameters<ApprovalAdapter["requestApproval"]>[0][] = [];
    const approvals: ApprovalAdapter = {
      requestApproval: async (request) => {
        requests.push(structuredClone(request));
        return {
          approved: true,
          response: { comment: "private approval response" },
          respondedAt: "2026-07-22T00:01:00.000Z",
        };
      },
    };
    const collector = eventCollector();

    const result = await new ApprovalStepExecutor().execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      approvals,
      emit: collector.emit,
    });

    expect(requests).toEqual([
      {
        runId: "run-1",
        stepId: "approval-1",
        prompt: "Approve secret acquisition?",
        details: { privateContext: "board-eyes-only" },
      },
    ]);
    expect(result.output).toEqual({
      approved: true,
      response: { comment: "private approval response" },
      respondedAt: "2026-07-22T00:01:00.000Z",
    });
    expect(result.statePatch).toEqual({ set: { approval: result.output } });
    expect(JSON.stringify(collector.events)).not.toContain(
      "secret acquisition",
    );
    expect(JSON.stringify(collector.events)).not.toContain("board-eyes-only");
    expect(JSON.stringify(collector.events)).not.toContain(
      "private approval response",
    );
    expect(JSON.stringify(result.metadata)).not.toContain(
      "private approval response",
    );
  });

  it("stops the step when approval is rejected", async () => {
    const step: ApprovalStep = {
      id: "approval-rejected",
      type: "approval",
      prompt: "Continue?",
      action: "cancel",
    };
    const collector = eventCollector();
    const execution = new ApprovalStepExecutor().execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      approvals: {
        requestApproval: async () => ({
          approved: false,
          response: "private rejection reason",
          respondedAt: "2026-07-22T00:01:00.000Z",
        }),
      },
      emit: collector.emit,
    });

    await expect(execution).rejects.toMatchObject({
      name: ApprovalRejectedError.name,
      action: "cancel",
    });
    expect(JSON.stringify(collector.events)).not.toContain(
      "private rejection reason",
    );
  });

  it("enforces an optional wait timeout even when the adapter does not support signals", async () => {
    vi.useFakeTimers();
    const step: ApprovalStep = {
      id: "approval-timeout",
      type: "approval",
      prompt: "Continue?",
    };
    const execution = new ApprovalStepExecutor({ timeoutMs: 25 }).execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      approvals: { requestApproval: () => new Promise(() => undefined) },
      emit: eventCollector().emit,
    });
    const rejection =
      expect(execution).rejects.toBeInstanceOf(ApprovalTimeoutError);

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });
});

describe("WebhookStepExecutor", () => {
  it("requires an explicit destination policy unless the manifest is trusted locally", () => {
    expect(() => new WebhookStepExecutor()).toThrow("authorizeDestination");
    expect(
      () => new WebhookStepExecutor({ allowUnsafeDestinations: true }),
    ).not.toThrow();
  });

  it("authorizes the destination before issuing the request", async () => {
    const step: WebhookStep = {
      id: "webhook-policy",
      type: "webhook",
      url: "http://169.254.169.254/latest/meta-data/",
    };
    const fetch = vi.fn<FetchLike>();
    const execution = new WebhookStepExecutor({
      fetch,
      authorizeDestination: async (url) => {
        if (url.hostname === "169.254.169.254")
          throw new Error("Destination is not allowed.");
      },
    }).execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      emit: eventCollector().emit,
    });

    await expect(execution).rejects.toThrow("Destination is not allowed.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries sequentially with one stable idempotency key and redacted lifecycle data", async () => {
    const step: WebhookStep = {
      id: "webhook-1",
      type: "webhook",
      url: "https://hooks.example.test/private-token",
      method: "POST",
      headers: { Authorization: "Bearer private-token" },
      body: { document: "private-body" },
      retries: 2,
      idempotencyKey: "stable-secret-key",
      outputVariable: "webhookResult",
    };
    const requests: Array<{ headers: Headers; body?: BodyInit | null }> = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetch: FetchLike = async (_input, init) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      requests.push({
        headers: new Headers(init?.headers),
        ...(init?.body !== undefined ? { body: init.body } : {}),
      });
      activeRequests -= 1;
      if (requests.length === 1) {
        return new Response("private failure body", {
          status: 503,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({ received: "private response" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const delays: number[] = [];
    const collector = eventCollector();

    const result = await new WebhookStepExecutor({
      fetch,
      allowUnsafeDestinations: true,
      sleep: async (delay) => {
        delays.push(delay);
      },
    }).execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      emit: collector.emit,
    });

    expect(requests).toHaveLength(2);
    expect(maximumActiveRequests).toBe(1);
    expect(
      requests.map((request) => request.headers.get("idempotency-key")),
    ).toEqual(["stable-secret-key", "stable-secret-key"]);
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer private-token",
    );
    expect(requests[0]?.body).toBe('{"document":"private-body"}');
    expect(delays).toEqual([0]);
    expect(result.output).toEqual({ received: "private response" });
    expect(result.statePatch).toEqual({
      set: { webhookResult: { received: "private response" } },
    });
    const lifecycleData = JSON.stringify({
      events: collector.events,
      metadata: result.metadata,
    });
    expect(lifecycleData).not.toContain("private-token");
    expect(lifecycleData).not.toContain("private-body");
    expect(lifecycleData).not.toContain("private response");
    expect(lifecycleData).not.toContain("stable-secret-key");
  });

  it("does not retry non-retryable HTTP failures or expose their body", async () => {
    const step: WebhookStep = {
      id: "webhook-400",
      type: "webhook",
      url: "https://hooks.example.test/",
      retries: 3,
    };
    let attempts = 0;
    const execution = new WebhookStepExecutor({
      allowUnsafeDestinations: true,
      fetch: async () => {
        attempts += 1;
        return new Response("private validation details", { status: 400 });
      },
      sleep: async () => undefined,
    }).execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      emit: eventCollector().emit,
    });

    await expect(execution).rejects.toEqual(new WebhookHttpError(400, 1));
    expect(attempts).toBe(1);
  });

  it("aborts a timed-out request and reports no underlying network details", async () => {
    vi.useFakeTimers();
    const step: WebhookStep = {
      id: "webhook-timeout",
      type: "webhook",
      url: "https://hooks.example.test/",
      timeoutMs: 20,
    };
    let observedSignal: AbortSignal | undefined;
    const execution = new WebhookStepExecutor({
      allowUnsafeDestinations: true,
      fetch: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(new Error("private network diagnostics")),
            { once: true },
          );
        });
      },
    }).execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      emit: eventCollector().emit,
    });
    const rejection = expect(execution).rejects.toMatchObject({
      name: WebhookTimeoutError.name,
      message: expect.not.stringContaining("private network diagnostics"),
    });

    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("stops reading a response stream as soon as the byte limit is exceeded", async () => {
    const step: WebhookStep = {
      id: "webhook-response-limit",
      type: "webhook",
      url: "https://hooks.example.test/",
    };
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    });
    const execution = new WebhookStepExecutor({
      allowUnsafeDestinations: true,
      maximumResponseBytes: 10,
      fetch: async () => new Response(body, { status: 200 }),
    }).execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      emit: eventCollector().emit,
    });

    await expect(execution).rejects.toBeInstanceOf(WebhookResponseError);
    expect(cancelled).toBe(true);
  });
});

describe("CodeStepExecutor", () => {
  it("uses the sandbox port and persists only output, artifacts, and safe metrics", async () => {
    const step: CodeStep = {
      id: "code-1",
      type: "code",
      language: "python",
      code: 'print("private stdout")',
      outputVariable: "calculation",
      timeoutMs: 2_000,
    };
    const requests: SandboxRequest[] = [];
    const sandbox: SandboxAdapter = {
      execute: async (request) => {
        requests.push(structuredClone(request));
        return {
          exitCode: 0,
          stdout: "private stdout",
          stderr: "private warning",
          output: { answer: 42 },
          artifacts: [
            {
              id: "artifact-1",
              name: "result.json",
              mediaType: "application/json",
            },
          ],
        };
      },
    };
    const collector = eventCollector();

    const result = await new CodeStepExecutor().execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: { input: 21 },
      sandbox,
      emit: collector.emit,
    });

    expect(requests).toEqual([
      {
        runId: "run-1",
        stepId: "code-1",
        language: "python",
        code: 'print("private stdout")',
        variables: { input: 21 },
        timeoutMs: 2_000,
      },
    ]);
    expect(result.output).toEqual({ answer: 42 });
    expect(result.statePatch).toEqual({ set: { calculation: { answer: 42 } } });
    expect(result.artifacts).toHaveLength(1);
    const lifecycleData = JSON.stringify({
      events: collector.events,
      metadata: result.metadata,
    });
    expect(lifecycleData).not.toContain("private stdout");
    expect(lifecycleData).not.toContain("private warning");
  });

  it("forwards explicit environment values only to the sandbox", async () => {
    const step: CodeStep = {
      id: "code-environment",
      type: "code",
      language: "python",
      code: 'print("hello")',
      environment: { PRIVATE_TOKEN: "secret" },
    };
    const requests: SandboxRequest[] = [];
    const sandbox: SandboxAdapter = {
      execute: vi.fn(async (request) => {
        requests.push(structuredClone(request));
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    };
    const collector = eventCollector();

    await new CodeStepExecutor().execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      sandbox,
      emit: collector.emit,
    });
    expect(requests[0]?.environment).toEqual({ PRIVATE_TOKEN: "secret" });
    expect(JSON.stringify(collector.events)).not.toContain("PRIVATE_TOKEN");
    expect(JSON.stringify(collector.events)).not.toContain("secret");
  });

  it("rejects a non-zero exit without exposing stderr", async () => {
    const step: CodeStep = {
      id: "code-failed",
      type: "code",
      language: "python",
      code: 'raise RuntimeError("private")',
    };
    const collector = eventCollector();
    const execution = new CodeStepExecutor().execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      sandbox: {
        execute: async () => ({
          exitCode: 7,
          stdout: "",
          stderr: "private stack trace",
        }),
      },
      emit: collector.emit,
    });

    await expect(execution).rejects.toBeInstanceOf(SandboxExecutionError);
    expect(JSON.stringify(collector.events)).not.toContain(
      "private stack trace",
    );
  });

  it("enforces a timeout even when a sandbox ignores the abort signal", async () => {
    vi.useFakeTimers();
    const step: CodeStep = {
      id: "code-timeout",
      type: "code",
      language: "python",
      code: "while True: pass",
      timeoutMs: 10,
    };
    let observedSignal: AbortSignal | undefined;
    const execution = new CodeStepExecutor().execute({
      runId: "run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {},
      sandbox: {
        execute: (_request, options) => {
          observedSignal = options?.signal;
          return new Promise(() => undefined);
        },
      },
      emit: eventCollector().emit,
    });
    const rejection =
      expect(execution).rejects.toBeInstanceOf(SandboxTimeoutError);

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("SubRunStepExecutor", () => {
  it("maps selected parent variables and returns child output and artifacts", async () => {
    const step: SubRunStep = {
      id: "sub-run-1",
      type: "sub-run",
      manifestRef: "agent://review",
      variableMappings: {
        documentId: "document.id",
        audience: "Audience",
      },
      outputVariable: "review",
    };
    const requests: Parameters<SubRunAdapter["execute"]>[0][] = [];
    const subRuns: SubRunAdapter = {
      execute: async (request) => {
        requests.push(structuredClone(request));
        return {
          runId: "child-run-1",
          output: { accepted: true },
          artifacts: [
            {
              id: "artifact-1",
              name: "review.json",
              mediaType: "application/json",
            },
          ],
        };
      },
    };
    const collector = eventCollector();

    const result = await new SubRunStepExecutor().execute({
      runId: "parent-run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: {
        document: { id: "doc-1", privateText: "not forwarded" },
        audience: "board",
      },
      subRuns,
      emit: collector.emit,
    });

    expect(requests).toEqual([
      {
        parentRunId: "parent-run-1",
        stepId: "sub-run-1",
        manifestReference: "agent://review",
        variables: [
          { key: "documentId", value: "doc-1" },
          { key: "audience", value: "board" },
        ],
      },
    ]);
    expect(result.output).toEqual({ accepted: true });
    expect(result.statePatch).toEqual({ set: { review: { accepted: true } } });
    expect(result.artifacts).toHaveLength(1);
    expect(JSON.stringify(collector.events)).not.toContain("not forwarded");
  });

  it("checkpoints an asynchronous child and resumes without relaunching it", async () => {
    const step: SubRunStep = {
      id: "sub-run-1",
      type: "sub-run",
      manifestRef: "agent://review",
      outputVariable: "review",
    };
    const checkpoints: JsonObject[] = [];
    const requests: Parameters<SubRunAdapter["execute"]>[0][] = [];
    const subRuns: SubRunAdapter = {
      execute: async (request) => {
        requests.push(structuredClone(request));
        if (!request.continuation) {
          return {
            runId: "child-job-1",
            status: "suspended",
            continuation: { childWorkflowJobId: "child-job-1" },
          };
        }
        return {
          runId: "child-job-1",
          status: "completed",
          output: "child result",
        };
      },
    };
    const executor = new SubRunStepExecutor();
    const base = {
      runId: "parent-run-1",
      manifest: manifestFor(step),
      step,
      stepIndex: 0,
      variables: { accountName: "Acme" },
      subRuns,
      emit: eventCollector().emit,
      checkpoint: async (input: { continuation?: JsonObject }) => {
        if (input.continuation)
          checkpoints.push(structuredClone(input.continuation));
      },
    };

    await expect(executor.execute(base)).rejects.toMatchObject({
      name: "RunSuspendedError",
      code: "RUN_SUSPENDED",
      reason: "sub-run",
    });
    expect(checkpoints.at(-1)).toEqual({
      type: "sub-run",
      phase: "waiting",
      stepId: "sub-run-1",
      childRunId: "child-job-1",
      adapter: { childWorkflowJobId: "child-job-1" },
    });

    const resumed = await executor.execute({
      ...base,
      resume: {
        cursor: { stepIndex: 0, stepId: step.id },
        continuation: checkpoints.at(-1),
      },
    });
    expect(resumed.output).toBe("child result");
    expect(resumed.statePatch).toEqual({ set: { review: "child result" } });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.continuation).toEqual({
      childWorkflowJobId: "child-job-1",
    });
  });
});
